import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_VARIATIONS, describeAllotment, toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { describeMeta } from "@/lib/context/meta";
import { describeKpis, loadClientKpis } from "@/lib/kpi/client";
import { describeFatigue } from "@/lib/fatigue";
import { describeIntake, type IntakeSummary } from "@/lib/intake-format";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Claude for the request form (suggestions, pre-submit review) and the twice-daily client briefings.
// Every call is optional. Without ANTHROPIC_API_KEY the form still works, just without suggestions.

// Each AI function is an agent whose model, effort, instructions, knowledge and data sources execs set in
// Settings → AI agents (table ai_agents). These defaults apply until the table says otherwise.
export const MODEL_IDS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;
export type ModelKey = keyof typeof MODEL_IDS;
export type Effort = "low" | "medium" | "high";
export type AgentKey = "suggest" | "review" | "briefing" | "copy" | "launcher" | "fatigue" | "scripts" | "brandbible" | "creativecheck" | "creativereview" | "coach" | "strategist" | "lab" | "industry" | "calls";
export const SOURCE_KEYS = ["meta", "briefing", "recent_messages", "memory", "angles", "recent_requests", "allotment", "kpis"] as const;
export type Sources = Partial<Record<(typeof SOURCE_KEYS)[number], boolean>>;

export type AgentConfig = {
  key: AgentKey;
  model: ModelKey;
  effort: Effort;
  instructions: string;
  sources: Sources;
  knowledge: { kind: string; title: string; body: string }[];
};

const DEFAULTS: Record<AgentKey, Pick<AgentConfig, "model" | "effort">> = {
  suggest: { model: "sonnet", effort: "low" }, // someone is waiting on it
  review: { model: "opus", effort: "medium" }, // judgement matters
  briefing: { model: "haiku", effort: "low" }, // gathering and summarizing
  copy: { model: "sonnet", effort: "medium" },
  launcher: { model: "opus", effort: "high" },
  fatigue: { model: "haiku", effort: "low" },
  scripts: { model: "opus", effort: "medium" },
  brandbible: { model: "opus", effort: "high" },
  creativecheck: { model: "sonnet", effort: "low" }, // runs while the upload is staged, someone is waiting
  creativereview: { model: "opus", effort: "medium" }, // reads small text in images; judgement matters
  lab: { model: "opus", effort: "high" }, // the Ads Lab round table
  calls: { model: "sonnet", effort: "low" }, // reads call notes and watches what was promised
  industry: { model: "sonnet", effort: "low" }, // sorts clients into industries from everything known about them
  strategist: { model: "opus", effort: "medium" }, // suggests briefs to execs and leads from the data
  coach: { model: "opus", effort: "medium" }, // edits other agents' playbooks from feedback (Settings → AI agents → Coach)
};

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
// Org-level keys need to name the workspace their usage belongs to
const anthropic = () =>
  (client ??= new Anthropic(
    process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {},
  ));

// Settings are read with the server's rights and kept for a minute, so a change in Settings applies within a minute
const cache = new Map<AgentKey, { at: number; config: AgentConfig }>();
export const forgetAgent = (key?: AgentKey) => (key ? cache.delete(key) : cache.clear());

export async function getAgent(key: AgentKey): Promise<AgentConfig> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.config;
  const config: AgentConfig = { key, ...DEFAULTS[key], instructions: "", sources: {}, knowledge: [] };
  if (adminConfigured()) {
    const admin = createAdminClient();
    const [{ data: a }, { data: k }] = await Promise.all([
      admin.from("ai_agents").select("model, effort, instructions, sources").eq("key", key).maybeSingle(),
      admin.from("ai_knowledge").select("kind, title, body").eq("active", true).or(`agent_key.eq.${key},agent_key.is.null`).order("created_at"),
    ]);
    if (a) Object.assign(config, { model: a.model, effort: a.effort, instructions: a.instructions ?? "", sources: (a.sources ?? {}) as Sources });
    config.knowledge = (k ?? []).map((x) => ({ kind: x.kind, title: x.title, body: x.body }));
  }
  cache.set(key, { at: Date.now(), config });
  return config;
}

/** The agent's own instructions, skills, knowledge and examples, added after the shared system prompt. */
export function withAgent(system: string, a: Pick<AgentConfig, "instructions" | "knowledge">) {
  const parts = [system];
  if (a.instructions.trim()) parts.push(`<agency_instructions>\n${a.instructions.trim()}\n</agency_instructions>`);
  for (const kind of ["skill", "knowledge", "example"] as const) {
    const items = a.knowledge.filter((k) => k.kind === kind);
    if (items.length)
      parts.push(`<${kind}s>\n${items.map((k) => `<${kind} title="${k.title.replace(/"/g, "'")}">\n${k.body.trim()}\n</${kind}>`).join("\n")}\n</${kind}s>`);
  }
  return parts.join("\n\n");
}

function logRun(row: Record<string, unknown>) {
  if (!adminConfigured()) return;
  void createAdminClient()
    .from("ai_runs")
    .insert(row)
    .then(({ error }) => error && console.error("[ai] couldn't log run:", error.message));
}

export class AiUnavailable extends Error {}

/** One structured call by an agent. Returns the parsed JSON or throws AiUnavailable with a message the UI can show. */
export async function askJson<T>({
  agent,
  label,
  system,
  prompt,
  schema,
  images = [],
  onText,
}: {
  agent: AgentKey;
  label: string; // for the timing log
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  /** Pictures the AI should look at (reference images), sent before the text */
  images?: { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }[];
  /** Streams the answer and calls this with everything written so far (for real progress). */
  onText?: (soFar: string) => void;
}): Promise<T> {
  if (!aiEnabled()) throw new AiUnavailable("AI isn't connected yet.");
  const cfg = await getAgent(agent);
  const started = Date.now();
  const request = {
    model: MODEL_IDS[cfg.model],
    max_tokens: 16000,
    system: withAgent(system, cfg),
    output_config: { effort: cfg.effort, format: { type: "json_schema" as const, schema } },
    messages: [
      {
        role: "user" as const,
        content: images.length
          ? [
              ...images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
              { type: "text" as const, text: prompt },
            ]
          : prompt,
      },
    ],
  };
  const run = { agent_key: agent, label, model: cfg.model, effort: cfg.effort };
  try {
    let res;
    if (onText) {
      // Streamed, so the caller can show what's been written so far
      const stream = anthropic().messages.stream(request);
      stream.on("text", (_delta, soFar) => onText(soFar));
      res = await stream.finalMessage();
    } else if (cfg.model === "haiku") {
      // Haiku has no server-side fallback model, so it's a plain request
      res = await anthropic().messages.create(request);
    } else
      try {
        // With a server-side fallback model in case the main one declines
        res = await anthropic().beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        console.error("[ai] request with fallbacks rejected, retrying without:", e.message);
        res = await anthropic().messages.create(request);
      }
    const ms = Date.now() - started;
    const bad = res.stop_reason === "refusal" || res.stop_reason === "max_tokens";
    console.log(`[ai] ${label} · ${res.model} · ${ms}ms · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
    logRun({ ...run, ms, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, ok: !bad, error: bad ? res.stop_reason : null });
    if (res.stop_reason === "refusal") throw new AiUnavailable("The AI couldn't help with this one.");
    if (res.stop_reason === "max_tokens") throw new AiUnavailable("The AI ran out of room. Try again.");
    const text = (res.content as { type: string; text?: string }[]).find((b) => b.type === "text");
    if (!text?.text) throw new AiUnavailable("The AI didn't answer. Try again.");
    return JSON.parse(text.text) as T;
  } catch (e) {
    if (e instanceof AiUnavailable) throw e;
    console.error("[ai] request failed:", e instanceof Error ? e.message : e);
    logRun({ ...run, ms: Date.now() - started, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    if (e instanceof Anthropic.RateLimitError) throw new AiUnavailable("The AI is busy. Try again in a moment.");
    if (e instanceof Anthropic.AuthenticationError) throw new AiUnavailable("The AI key isn't valid.");
    if (e instanceof Anthropic.BadRequestError) throw new AiUnavailable(`The AI rejected the request: ${apiMessage(e)}`);
    if (e instanceof Anthropic.APIError) throw new AiUnavailable(`The AI had a problem (${e.status ?? "network"}). Try again.`);
    throw new AiUnavailable("The AI had a problem. Try again.");
  }
}

/**
 * Web research by an agent: searches and reads pages, then returns plain-text notes with sources.
 * Server tools can pause a long turn ("pause_turn"); the paused turn is sent back to continue.
 */
export async function researchWeb({ agent, label, system, prompt, maxSearches = 8, maxFetches = 10 }: {
  agent: AgentKey;
  label: string;
  system: string;
  prompt: string;
  maxSearches?: number;
  maxFetches?: number;
}): Promise<string> {
  if (!aiEnabled()) throw new AiUnavailable("AI isn't connected yet.");
  const cfg = await getAgent(agent);
  const started = Date.now();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const run = { agent_key: agent, label, model: cfg.model, effort: cfg.effort };
  let inTok = 0;
  let outTok = 0;
  try {
    for (let turn = 0; turn < 6; turn++) {
      const res = await anthropic().messages.create({
        model: MODEL_IDS[cfg.model],
        max_tokens: 16000,
        system: withAgent(system, cfg),
        output_config: { effort: cfg.effort },
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: maxSearches },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: maxFetches },
        ],
        messages,
      });
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;
      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content });
        continue;
      }
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      logRun({ ...run, ms: Date.now() - started, input_tokens: inTok, output_tokens: outTok, ok: Boolean(text), error: text ? null : res.stop_reason });
      return text;
    }
    throw new AiUnavailable("The research took too many steps. Try again.");
  } catch (e) {
    if (e instanceof AiUnavailable) throw e;
    console.error("[ai] research failed:", e instanceof Error ? e.message : e);
    logRun({ ...run, ms: Date.now() - started, input_tokens: inTok, output_tokens: outTok, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    if (e instanceof Anthropic.BadRequestError) throw new AiUnavailable(`The AI rejected the research request: ${apiMessage(e)}`);
    throw new AiUnavailable("The research didn't finish. Try again.");
  }
}

/** The API's own explanation, without the status prefix the SDK adds. */
function apiMessage(e: InstanceType<typeof Anthropic.APIError>) {
  const err = (e.error as { error?: { message?: string } } | undefined)?.error?.message;
  return (err ?? e.message).slice(0, 220);
}

// ─── Client context ─────────────────────────────────────────────────────────

export type ClientContext = {
  name: string;
  website: string | null;
  industry?: string | null; // e.g. "restaurant"
  industryDetail?: string | null; // e.g. "Pizza restaurant"
  winners?: string; // what's working for other clients in the same industry, ready for the prompt
  adAccountConnected: boolean;
  allotment: Allotment | null;
  digest: Digest | null; // from the twice-daily briefing: Slack, email and Drive, already summarized
  meta: string | null; // the latest Meta ad performance, in readable lines
  tiring?: string; // ads the fatigue watcher flagged, in lines
  intake?: string; // the marketing intake form, as the AI read it
  kpis?: string | null; // the KPI targets and how each account is doing against them (refreshed every 2 hours)
  brandBible: string | null; // "Read this first" from a Brand Bible the head of creative reviewed
  sinceBriefing: { source: string; at: string; author: string | null; title: string | null; body: string | null }[]; // newer than the briefing
  angles: { name: string; kind: string; description: string | null }[];
  memory: { kind: "avoid" | "prefer" | "note"; body: string; source: string }[];
  recent: {
    title: string;
    format: string;
    angle: string | null;
    audience: string | null;
    brief: string | null;
    stage: string;
    newCount: number;
    variationCount: number;
    createdAt: string;
  }[];
};

/** Everything the AI should know about a client. Reads through the caller's RLS. */
export async function clientContext(supabase: SupabaseClient, clientId: string): Promise<ClientContext | null> {
  const [{ data: c }, { data: usage }, { data: briefing }, { data: snap }, { data: angles }, { data: memory }, { data: recent }] = await Promise.all([
    supabase.from("clients").select("name, website, meta_ad_account_id, industry, industry_detail").eq("id", clientId).maybeSingle(),
    supabase.from("client_allotment_usage").select("*").eq("client_id", clientId).maybeSingle(),
    supabase.from("client_briefings").select("digest, generated_at").eq("client_id", clientId).maybeSingle(),
    supabase.from("meta_snapshots").select("date_start, date_stop, summary, weekly, ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("angles").select("name, kind, description").eq("client_id", clientId).eq("status", "active").order("name").limit(40),
    supabase.from("client_memory").select("kind, body, source").eq("client_id", clientId).eq("status", "active").order("created_at", { ascending: false }).limit(60),
    supabase
      .from("board_requests")
      .select("title, format, angle_name, audience, brief, stage, new_count, variation_count, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  if (!c) return null;
  const { data: bible } = await supabase.from("client_brand_bibles").select("read_this_first, version").eq("client_id", clientId).eq("status", "reviewed").maybeSingle();
  // Slack and email that came in after the briefing was written, so suggestions and the review are current
  const { data: newer } = await supabase
    .from("context_items")
    .select("source, occurred_at, author, title, body")
    .eq("client_id", clientId)
    .neq("source", "drive")
    .gt("created_at", briefing?.generated_at ?? new Date(Date.now() - 2 * 86_400_000).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(40);
  return {
    brandBible: bible?.read_this_first ? `${bible.read_this_first}\n(Brand Bible ${bible.version}, reviewed by Kaizen)` : null,
    industry: c.industry,
    industryDetail: c.industry_detail,
    winners: await (async () => {
      if (!c.industry || c.industry === "other") return "";
      // Loaded here, not at the top: the industry module uses this one
      const { industryWinners, winnersBlock } = await import("@/lib/industry");
      return winnersBlock(c.industry, c.industry_detail, await industryWinners(supabase, c.industry, clientId, 5));
    })(),
    sinceBriefing: (newer ?? []).map((i) => ({ source: i.source, at: i.occurred_at, author: i.author, title: i.title, body: i.body?.slice(0, 800) ?? null })),
    name: c.name,
    website: c.website,
    adAccountConnected: Boolean(c.meta_ad_account_id),
    allotment: usage ? toAllotment(usage as UsageRow) : null,
    digest: briefing?.digest && Object.keys(briefing.digest).length ? (briefing.digest as Digest) : null,
    meta: snap ? describeMeta(snap as Parameters<typeof describeMeta>[0]) : null,
    kpis: await loadClientKpis(supabase, clientId).then((k) => (k.length ? describeKpis(k) : null)),
    intake: await supabase
      .from("client_intakes")
      .select("summary")
      .eq("client_id", clientId)
      .not("summary", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => (data?.summary ? describeIntake(data.summary as IntakeSummary) : undefined)),
    tiring: await supabase
      .from("ad_fatigue")
      .select("ad_name, headline, severity, signals")
      .eq("client_id", clientId)
      .in("state", ["open", "refreshing"])
      .order("severity", { ascending: false })
      .limit(8)
      .then(({ data }) => describeFatigue((data ?? []) as Parameters<typeof describeFatigue>[0])),
    angles: angles ?? [],
    memory: (memory ?? []) as ClientContext["memory"],
    recent: (recent ?? []).map((r) => ({
      title: r.title,
      format: r.format,
      angle: r.angle_name,
      audience: r.audience,
      brief: r.brief ? r.brief.slice(0, 600) : null,
      stage: r.stage,
      newCount: r.new_count,
      variationCount: r.variation_count,
      createdAt: r.created_at.slice(0, 10),
    })),
  };
}

/** What an agent reads about a client. `sources` (from the agent's settings) can leave parts out; missing = included. */
export function contextBlock(ctx: ClientContext, request?: { images: number; videos: number }, sources: Sources = {}) {
  const on = (k: keyof Sources) => sources[k] !== false;
  ctx = {
    ...ctx,
    meta: on("meta") ? ctx.meta : null,
    digest: on("briefing") ? ctx.digest : null,
    sinceBriefing: on("recent_messages") ? ctx.sinceBriefing : [],
    memory: on("memory") ? ctx.memory : [],
    angles: on("angles") ? ctx.angles : [],
    recent: on("recent_requests") ? ctx.recent : [],
  };
  const lines: string[] = [`<client name="${ctx.name}"${ctx.website ? ` website="${ctx.website}"` : ""}>`];
  if (ctx.brandBible) lines.push("<brand_bible_read_this_first>", "The client's reviewed Brand Bible. Its audience profiles, banned claims and rules are hard limits.", ctx.brandBible, "</brand_bible_read_this_first>");
  if (ctx.intake)
    lines.push("<marketing_intake>", "What the client told us in their marketing intake form. Their offer, audience, voice and what to avoid are hard rules.", ctx.intake, "</marketing_intake>");
  if (!on("meta")) lines.push("(Ad performance isn't part of this task.)");
  else if (ctx.meta) lines.push("<meta_ads_performance>", ctx.meta, "</meta_ads_performance>");
  else lines.push(ctx.adAccountConnected ? "Meta ad account linked, but no performance pulled yet. Don't invent metrics." : "No Meta ad account linked yet. Don't invent metrics.");
  if (on("meta") && ctx.tiring)
    lines.push(
      "<tiring_ads>",
      "Ads the fatigue watcher flagged against their own last three weeks. Don't build on them as they are: a refresh keeps what made them work (the angle, the offer) and changes what people are tired of (the visual, the hook, the first seconds).",
      ctx.tiring,
      "</tiring_ads>",
    );
  if (on("kpis") && ctx.kpis)
    lines.push(
      "<kpi_targets>",
      "How each ad account is doing against the target Kaizen or the client set. When an account is off target or slipping, the creative should answer it: say how in the brief, and don't repeat what isn't working.",
      ctx.kpis,
      "</kpi_targets>",
    );
  if (ctx.digest) lines.push("<briefing from Slack, email and Drive>", describeDigest(ctx.digest), "</briefing>");
  if (ctx.sinceBriefing.length)
    lines.push(
      "<newer_than_the_briefing>",
      "Messages that arrived after the briefing was written. Where they change something, they win.",
      ...ctx.sinceBriefing
        .slice()
        .reverse()
        .map((i) => `- ${i.at.slice(0, 16).replace("T", " ")} · ${i.source === "gmail" ? "Email" : i.source === "call" ? "Call" : i.source === "slack_internal" ? "Slack (internal)" : "Slack (with client)"}${i.author ? ` · ${i.author}` : ""}${i.title ? ` · "${i.title}"` : ""}${i.body ? `
  ${i.body.replace(/\s+/g, " ")}` : ""}`),
      "</newer_than_the_briefing>",
    );
  if (on("allotment")) lines.push("<allotment_this_month>", describeAllotment(ctx.allotment, request), "</allotment_this_month>");
  lines.push("<client_memory>");
  if (ctx.memory.length === 0) lines.push("Nothing recorded yet.");
  for (const m of ctx.memory) lines.push(`- [${m.kind}${m.source !== "team" ? `, from ${m.source}` : ""}] ${m.body}`);
  lines.push("</client_memory>");
  lines.push("<angles>");
  if (ctx.angles.length === 0) lines.push("None yet.");
  for (const a of ctx.angles) lines.push(`- ${a.name} (${a.kind})${a.description ? `: ${a.description}` : ""}`);
  lines.push("</angles>");
  lines.push("<recent_requests>");
  if (ctx.recent.length === 0) lines.push("No previous requests in this app.");
  for (const r of ctx.recent)
    lines.push(
      `- ${r.createdAt} · ${r.format} · "${r.title}"${r.angle ? ` · angle: ${r.angle}` : ""} · ${r.newCount} new + ${r.variationCount} variations · stage: ${r.stage}` +
        `${r.audience ? `\n  audience: ${r.audience}` : ""}${r.brief ? `\n  brief: ${r.brief.replace(/\s+/g, " ")}` : ""}`,
    );
  lines.push("</recent_requests>");
  if (ctx.industry) lines.push(`Industry: ${ctx.industryDetail ?? ctx.industry}`);
  if (ctx.winners) lines.push(ctx.winners);
  lines.push("</client>");
  return lines.join("\n");
}

export function describeDigest(d: Digest) {
  const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((x) => `- ${x}`).join("\n")}` : null);
  return [
    d.summary,
    d.direction && `Campaign direction: ${d.direction}`,
    d.performance && `Ad performance: ${d.performance}`,
    list("Recent asks from the client or team", d.asks),
    list("Avoid", d.avoid),
    list("Works for them", d.works),
    list("New assets not used in a request yet", d.newAssets.map((a) => `${a.name}${a.note ? ` (${a.note})` : ""}${a.url ? ` ${a.url}` : ""}`)),
    list("Open questions", d.openQuestions),
  ]
    .filter(Boolean)
    .join("\n");
}

export const AGENCY_SYSTEM = `You help Kaizen Marketing, a paid social agency, write creative requests for Meta ads.
A request goes to a graphic designer (images, carousels) or a video editor (videos). One request can cover several formats; each format becomes its own ticket.
A "net new" creative is a distinct design. A "variation" reuses the same design and tests copy, title, CTA or layout; it doesn't count as a new deliverable. A carousel counts as one deliverable. Sizes of one design count as one.
Sizes are 1:1, 4:5 (feed) and 9:16 (stories, reels).
The client pays for a monthly allotment of net new images (carousels count here too) and net new videos. Variations don't use it. Never suggest more net new than what's left; if nothing is left, suggest variations or say an upgrade is needed.
Client memory holds what the team has learned about the client. Items marked "avoid" are things the client asked us not to do or that failed before; never suggest them. Items marked "prefer" are what works for them.
Base everything on the client context you're given. When there's little context, keep suggestions sensible and generic rather than inventing facts about the business (prices, offers, locations, claims).
Write plainly, like a sharp media buyer briefing a designer. No hype, no emojis.`;

// ─── Schemas ────────────────────────────────────────────────────────────────

const str = { type: "string" };
const strArr = { type: "array", items: str };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export type Suggestions = {
  titles: string[];
  angles: { name: string; why: string }[];
  audiences: string[];
  mix: { format: "image" | "video" | "carousel"; new: number; variations: number }[];
  mixWhy: string;
  sizes: ("1x1" | "4x5" | "9x16")[];
  brief: string;
  hooks: string[];
  watchouts: string[];
};

export const SUGGESTIONS_SCHEMA = obj({
  titles: strArr,
  angles: { type: "array", items: obj({ name: str, why: str }) },
  audiences: strArr,
  mix: {
    type: "array",
    items: obj({ format: { type: "string", enum: ["image", "video", "carousel"] }, new: { type: "integer" }, variations: { type: "integer" } }),
  },
  mixWhy: str,
  sizes: { type: "array", items: { type: "string", enum: ["1x1", "4x5", "9x16"] } },
  brief: str,
  hooks: strArr,
  watchouts: strArr,
});

export type ReviewIssue = {
  severity: "block" | "warn";
  field: "title" | "angle" | "audience" | "brief" | "formats" | "sizes" | "references";
  issue: string;
  fix: string;
};
export type SimilarTicket = { number: number; overlap: "same" | "close"; why: string };
export type Review = {
  verdict: "clear" | "check";
  summary: string;
  issues: ReviewIssue[];
  /** The brief, fleshed out from everything known about the client; empty when the brief is already strong. */
  strongerBrief: string;
  /** Recent tickets for this client that ask for the same or nearly the same thing. */
  similar: SimilarTicket[];
};

export const REVIEW_SCHEMA = obj({
  verdict: { type: "string", enum: ["clear", "check"] },
  summary: str,
  strongerBrief: str,
  similar: { type: "array", items: obj({ number: { type: "integer" }, overlap: { type: "string", enum: ["same", "close"] }, why: str }) },
  issues: {
    type: "array",
    items: obj({
      severity: { type: "string", enum: ["block", "warn"] },
      field: { type: "string", enum: ["title", "angle", "audience", "brief", "formats", "sizes", "references"] },
      issue: str,
      fix: str,
    }),
  },
});

export type Digest = {
  summary: string;
  direction: string;
  performance?: string; // what the Meta numbers say is working or tiring; older briefings don't have it
  asks: string[];
  avoid: string[];
  works: string[];
  newAssets: { name: string; url: string; note: string }[];
  openQuestions: string[];
};

export const DIGEST_SCHEMA = obj({
  summary: str,
  direction: str,
  performance: str,
  asks: strArr,
  avoid: strArr,
  works: strArr,
  newAssets: { type: "array", items: obj({ name: str, url: str, note: str }) },
  openQuestions: strArr,
});

/** What each suggestion field should hold. Shared by live suggestions and the twice-daily briefing. */
export const SUGGEST_FIELDS = `Suggest values for this request. Build on what's already filled in; don't contradict it.
- titles: 3 short ticket titles (under 50 characters), in the style of the recent requests if there are any.
- angles: up to 3. Prefer existing angles that fit; a new one only when it's clearly better. "why" is one short sentence.
- audiences: up to 3 short audience descriptions.
- mix: the formats and counts you'd make for this request, with 1 to 6 net new per format and variations (0 to 5 per format) only when testing copy or hooks makes sense. The net new total must fit what's left of the allotment (images and carousels share the image pool). mixWhy: one sentence, mentioning the allotment when it limited the mix.
- sizes: the sizes to deliver.
- brief: a ready-to-use brief for the designer or editor, 4 to 8 lines: what to show, what to say, the hook, on-image text limits, and what to avoid from client memory.
- hooks: up to 4 opening hooks or headlines to try.
- watchouts: client memory items that matter for this request, rephrased as short reminders. Empty if none.`;

const count = (n: unknown) => Math.min(100, Math.max(0, Math.floor(Number(n) || 0)));

/** Keep the model's output inside what the form accepts. */
export function cleanSuggestions(raw: Suggestions): Suggestions {
  return {
    ...raw,
    titles: raw.titles.slice(0, 3),
    angles: raw.angles.slice(0, 3),
    audiences: raw.audiences.slice(0, 3),
    hooks: raw.hooks.slice(0, 4),
    watchouts: raw.watchouts.slice(0, 4),
    mix: raw.mix
      .filter((m, i, all) => ["image", "video", "carousel"].includes(m.format) && all.findIndex((x) => x.format === m.format) === i)
      .map((m) => ({ ...m, new: count(m.new), variations: Math.min(count(m.variations), MAX_VARIATIONS) }))
      .filter((m) => m.new + m.variations > 0),
    sizes: raw.sizes.filter((z) => ["1x1", "4x5", "9x16"].includes(z)),
  };
}

// ─── Video scripts ──────────────────────────────────────────────────────────

export type Script = {
  framework: string;
  style: string;
  why: string;
  hooks: { type: string; onScreen: string; spoken: string }[];
  title: string;
  placement: string;
  objective: string;
  lengthSeconds: number;
  beats: { time: string; shot: string; onScreen: string; voiceover: string; sound: string }[];
  cta: string;
  filming: string[];
  testPlan: string;
  watchouts: string[];
};

export const SCRIPT_SCHEMA = obj({
  framework: str,
  style: str,
  why: str,
  hooks: { type: "array", items: obj({ type: str, onScreen: str, spoken: str }) },
  title: str,
  placement: str,
  objective: str,
  lengthSeconds: { type: "integer" },
  beats: { type: "array", items: obj({ time: str, shot: str, onScreen: str, voiceover: str, sound: str }) },
  cta: str,
  filming: strArr,
  testPlan: str,
  watchouts: strArr,
});

// ─── Brand Bible ────────────────────────────────────────────────────────────

export type BrandBibleOut = {
  markdown: string;
  readThisFirst: string;
  teamNotes: string[];
  openQuestions: { question: string; who: string }[];
};

export const BRAND_BIBLE_SCHEMA = obj({
  markdown: str,
  readThisFirst: str,
  teamNotes: strArr,
  openQuestions: { type: "array", items: obj({ question: str, who: str }) },
});

// ─── Copy (Kaizen's copy standard) ──────────────────────────────────────────

export const COPY_SCHEMA = obj({
  ads: {
    type: "array",
    items: obj({
      kind: { type: "string", enum: ["short", "long"] },
      formula: str,
      angle: str,
      primaryText: str,
      headline: str,
      linkDescription: str,
      cta: str,
    }),
  },
  notes: str,
});

// ─── Applying a review fix ──────────────────────────────────────────────────

export type DraftPatch = {
  title: string;
  angle: string;
  audience: string;
  brief: string;
  refs: string; // reference links, one per line
  sizes: ("1x1" | "4x5" | "9x16")[];
  formats: { format: "image" | "video" | "carousel"; new: number; variations: number }[];
  changed: string[];
  note: string;
};
export const PATCH_SCHEMA = obj({
  title: str,
  angle: str,
  audience: str,
  brief: str,
  refs: str,
  sizes: { type: "array", items: { type: "string", enum: ["1x1", "4x5", "9x16"] } },
  formats: { type: "array", items: obj({ format: { type: "string", enum: ["image", "video", "carousel"] }, new: { type: "integer" }, variations: { type: "integer" } }) },
  changed: strArr,
  note: str,
});

// ─── Creative check (on upload) ─────────────────────────────────────────────

/**
 * What the AI makes of a batch of creative before it uploads. Designs are referred to as S1, S2… (in this upload)
 * and D1, D2… (already on the ticket). same_design: the same creative in another size, so its files belong with `of`.
 */
export type CreativeCheck = {
  designs: { ref: string; kind: "new" | "variation" | "same_design"; of: string; reason: string }[];
  summary: string;
};
export const CREATIVE_CHECK_SCHEMA = obj({
  designs: {
    type: "array",
    items: obj({ ref: str, kind: { type: "string", enum: ["new", "variation", "same_design"] }, of: str, reason: str }),
  },
  summary: str,
});

export const CREATIVE_CHECK_SYSTEM = `You check ad creative for Kaizen, a performance creative agency, as a designer or video editor uploads it to a ticket.

Each ticket asks for a number of net new designs and a number of variations. Net new designs count toward the client's monthly allotment; variations don't.
- Net new: a different concept or layout. A different main visual, composition or idea, even for the same offer.
- Variation: the same design with a small change for testing: a different headline or hook, copy, colour, CTA, background or product shot swapped into the same layout.
- Same design: the same creative resized or reframed for another placement (1:1, 4:5, 9:16). It is not a separate design at all; its files belong with the other one.

You get one picture per design (S1, S2… are in this upload; D1, D2… are already on the ticket). For every S design, say whether it is new, a variation (of which S or D design) or the same design as another (which one). A design can only be a variation of, or the same as, a design that is itself new, and an S design should point at an earlier S or at a D. When in doubt between new and variation, look at the layout: same layout = variation.
reason: one short sentence a designer would agree with, about what's the same and what's different ("Same layout and photo, only the headline changes").
summary: one sentence on the batch as a whole, plain and specific.`;

// ─── Creative review notes (for the reviewer) ───────────────────────────────

export type CreativeNote = { severity: "fix" | "watch" | "good"; design: string; size: string; area: string; note: string };
export type CreativeNotes = { verdict: "ready" | "minor" | "fix"; headline: string; notes: CreativeNote[] };
/** One design's notes (the review runs design by design, so progress is real). */
export const DESIGN_NOTES_SCHEMA = obj({
  notes: {
    type: "array",
    items: obj({ severity: { type: "string", enum: ["fix", "watch", "good"] }, size: str, area: str, note: str }),
  },
});

export const CREATIVE_REVIEW_SYSTEM = `You are a senior creative reviewer at Kaizen Marketing, a paid social agency. Before ad creative goes to the Head of Creative, you look it over and leave notes: mistakes to fix before it goes to the client, things to keep an eye on, and what works.

Go through every picture carefully. Read all the text on it, word by word.
- Text: spelling, grammar and typos; brand and product names spelled the same way everywhere; leftover placeholder text (lorem ipsum, "headline here", "XX%").
- Facts: offer, prices, discounts, dates, phone numbers, URLs and codes must match the brief and the client context exactly. Flag anything stated on the creative that isn't in the brief or the client context (a claim, a number, an offer); it may be invented.
- Brief: does it deliver the angle, audience and the specific things the brief asks for (first look, on-image text, CTA, product shown)?
- Client: the brand bible (colours, logo, tone, rules) and client memory. Anything marked "avoid" is something the client asked us not to do or that failed before; treat it as a fix.
- Placement: 9:16 is for Stories and Reels: keep text, logo and CTA out of the top ~14% and bottom ~35% and away from the side edges, where Meta's interface covers them. 4:5 and 1:1 are feed: check nothing is cut off or crammed. Text must be readable on a phone; flag text-heavy designs, weak contrast and a missing or buried CTA.
- Sizes and variations: sizes of the same design should carry the same message with nothing cropped; variations should differ only in what they test.
- Craft: blurry or pixelated images, compression artefacts, bad cut-outs, misaligned elements, stock watermarks, odd AI-generated details (hands, text, faces).
- Policy: Meta ad policy risks: before-and-after images, calling out personal attributes ("Struggling with your weight?"), unrealistic results or guarantees, health or financial claims.

You review one design at a time: every size of it. For a variation you also see the design it varies, only for comparison: review the variation, and check it differs only in what it's testing.
Severity: fix = a mistake that shouldn't reach the client; watch = a judgement call or risk to decide on; good = what's working (at most 1).
Be specific and useful: say where on the design (top headline, price badge, CTA button) and quote the text. One point per note, one or two sentences. Don't invent problems to have something to say: if the design is clean, say so in a good note. Don't repeat a note for every size; say it once and name the sizes in size.
For a video you only see one frame: don't judge motion, pacing or sound.
size: "4:5", "9:16"… or "4:5, 9:16" (or "" when it applies to every size). area: one or two words (Text, Offer, Brand, Placement, Brief, Craft, Policy, Sizes).
Your notes go first to the designer or editor who made it, so they can fix it before the Head of Creative sees it: write so they know exactly what to change.`;

// ─── Copy: what copy review teaches the Copywriter ──────────────────────────

export type CopyLesson = { kind: "prefer" | "avoid"; body: string };
const LESSONS = { type: "array", items: obj({ kind: { type: "string", enum: ["prefer", "avoid"] }, body: str }) };
export const COPY_LESSONS_SCHEMA = obj({ lessons: LESSONS });
export const COPY_CHAT_SCHEMA = obj({ reply: str, rewrite: { type: "boolean" }, instructions: str, lessons: LESSONS });

export const COPY_LESSONS_SYSTEM = `You help Kaizen Marketing's AI copywriter learn from copy review. You get the ads the AI wrote and the ads copy review approved after editing them.
Find what the edits say about how this client's copy should be written, as lasting rules: voice, words to use or avoid, claims, how offers are stated, length, structure, CTA. Each lesson is one plain sentence a copywriter could follow next time ("Say 'members', never 'customers'", "Lead with the price in the first line").
kind: prefer (do this) or avoid (don't do this). Skip one-off fixes that only apply to this ad (a typo, a date), and anything already in the client memory you're given. Return 0 to 3 lessons; return none when the edits were small.`;

export const COPY_CHAT_SYSTEM = `You are Kaizen Marketing's AI copywriter, talking with the person who reviews your copy. They tell you what's wrong with the set you wrote, or what they want instead. Answer briefly and plainly, like a colleague: say what you understood and what you'll change. No emojis, no apologies.
rewrite: true when they want the set changed (or you should change it to do what they say); false when they're only asking a question or you need something clarified first.
instructions: when rewriting, everything the rewrite must do, written as instructions to yourself: complete enough on its own (it's all the rewrite gets from this conversation). "" when not rewriting.
lessons: only rules they state that should apply to this client's copy from now on, not just this set ("never mention delivery", "they say 'classes', not 'lessons'"). One sentence each; kind prefer or avoid. Usually none.`;

export type CopyViolation = { ad: number; field: string; quote: string; rule: string };
export const COPY_GUARD_SCHEMA = obj({
  violations: { type: "array", items: obj({ ad: { type: "integer" }, field: str, quote: str, rule: str }) },
});
export const COPY_GUARD_SYSTEM = `You check ad copy right before it's approved, against what the client has explicitly told the agency: the client memory items marked "avoid" (things the client asked us not to do, or that went wrong before) and any hard rules in their brand bible.
Flag only clear contradictions that would embarrass the agency in front of the client: a word, claim, offer or phrasing they told us not to use, said anyway. Not style preferences, not things that are merely close, not rules you infer yourself. When in doubt, don't flag.
For each: ad (1-5), field (primaryText, headline, linkDescription or cta), quote (the exact words in the copy), rule (the client's rule it breaks, in a few words). Usually there are none.`;

// ─── Client revisions ───────────────────────────────────────────────────────

export type CopyAmend = { scope: "amend" | "rewrite"; ads: { kind: "short" | "long"; formula: string; angle: string; primaryText: string; headline: string; linkDescription: string; cta: string }[]; changes: { ad: number; what: string }[]; notes: string };
export const COPY_AMEND_SCHEMA = obj({
  scope: { type: "string", enum: ["amend", "rewrite"] },
  ads: {
    type: "array",
    items: obj({ kind: { type: "string", enum: ["short", "long"] }, formula: str, angle: str, primaryText: str, headline: str, linkDescription: str, cta: str }),
  },
  changes: { type: "array", items: obj({ ad: { type: "integer" }, what: str }) },
  notes: str,
});
export const COPY_AMEND_SYSTEM = `You are Kaizen Marketing's AI copywriter. The client reviewed the copy set and asked for changes. Make exactly the changes they asked for, and nothing else.
- Amend by default: keep every ad as it is except where the client's notes apply. If they say don't use a word, remove it everywhere and fix the sentence around it; if they ask for emojis, add them where they fit; if they name one ad or one headline, change only that.
- Rewrite only when the client clearly rejects the copy as a whole ("we don't like this copy", "start over", "this isn't our voice at all"). Then scope is "rewrite" and you write a new set to the same standard (3 short, 2 long, same order).
- Keep Kaizen's standard: short-form primary text up to 125 characters before "See more", long-form 300-800 words, headline up to 40 characters, link description up to 30, an official Meta CTA.
- Return all 5 ads, changed or not, in the same order. changes: one line per change, saying which ad and what you changed and why ("Ad 2 headline: removed 'cheap', the client doesn't use it"). notes: one or two sentences for copy review.`;

export const CLIENT_LESSONS_SYSTEM = `You help Kaizen Marketing learn from a client's revision notes on their ads. Find what the notes say about how this client's ads should be made from now on: words, claims, offers, tone, visuals, logos, colours, layouts, music or pacing they want or don't want.
Each lesson is one plain sentence anyone at Kaizen could follow next time ("Never show the product next to competitors", "They want emojis in short-form copy"). kind: prefer or avoid.
Skip one-off fixes that only apply to this ad (move this text up, fix this typo) and anything already in the client memory. Return 0 to 3 lessons; usually 0 or 1.`;

export const REVISION_SUMMARY_SCHEMA = obj({ items: { type: "array", items: obj({ asked: str, changed: str }) } });
export const REVISION_SUMMARY_SYSTEM = `You write the "what we changed" note a client sees when their revised ad comes back to them. You get what they asked for and what the team and the AI changed.
Return one item per thing they asked: asked = their request in a few words, in their terms; changed = what we did, plainly and specifically, in the agency's voice ("Moved the price above the fold", "Removed 'cheap' from every ad"). Warm, confident, no fluff, no emojis. If something they asked couldn't be done, say so honestly in changed.
Only describe changes that are in what_changed. Never invent or assume a change (a new colour, a moved element) that isn't written there; if an ask has nothing in what_changed, say plainly that the updated version is ready for them to look at.`;

// ─── What the client reads before reviewing ─────────────────────────────────

export type ClientSummary = { why: string; audience: string; strategy: string };
export const CLIENT_SUMMARY_SCHEMA = obj({ why: str, audience: str, strategy: str });
export const CLIENT_SUMMARY_SYSTEM = `You write the short intro a client reads before reviewing the ads Kaizen Marketing made for them. It's written to the client, in Kaizen's voice: confident, warm, plain, no jargon, no emojis, no internal details (no allotments, no team names, no prices of our services).
- why: one or two sentences on why we made these ads now: the goal, the offer or the moment.
- audience: one sentence on who they're for.
- strategy: one or two sentences on the approach: the angle, what the creative leads with, and what we want people to do.
Use only what's in the brief and the client context; don't invent offers, numbers or claims.`;
