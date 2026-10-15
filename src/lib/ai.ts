import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_VARIATIONS, describeAllotment, toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { describeMeta } from "@/lib/context/meta";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Claude for the request form (suggestions, pre-submit review) and the twice-daily client briefings.
// Every call is optional. Without ANTHROPIC_API_KEY the form still works, just without suggestions.

// Each AI function is an agent whose model, effort, instructions, knowledge and data sources execs set in
// Settings → AI agents (table ai_agents). These defaults apply until the table says otherwise.
export const MODEL_IDS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;
export type ModelKey = keyof typeof MODEL_IDS;
export type Effort = "low" | "medium" | "high";
export type AgentKey = "suggest" | "review" | "briefing" | "copy" | "launcher" | "fatigue" | "scripts" | "brandbible" | "coach";
export const SOURCE_KEYS = ["meta", "briefing", "recent_messages", "memory", "angles", "recent_requests", "allotment"] as const;
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
}: {
  agent: AgentKey;
  label: string; // for the timing log
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  if (!aiEnabled()) throw new AiUnavailable("AI isn't connected yet.");
  const cfg = await getAgent(agent);
  const started = Date.now();
  const request = {
    model: MODEL_IDS[cfg.model],
    max_tokens: 16000,
    system: withAgent(system, cfg),
    output_config: { effort: cfg.effort, format: { type: "json_schema" as const, schema } },
    messages: [{ role: "user" as const, content: prompt }],
  };
  const run = { agent_key: agent, label, model: cfg.model, effort: cfg.effort };
  try {
    let res;
    if (cfg.model === "haiku") {
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
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new AiUnavailable("The AI didn't answer. Try again.");
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
  adAccountConnected: boolean;
  allotment: Allotment | null;
  digest: Digest | null; // from the twice-daily briefing: Slack, email and Drive, already summarized
  meta: string | null; // the latest Meta ad performance, in readable lines
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
    supabase.from("clients").select("name, website, meta_ad_account_id").eq("id", clientId).maybeSingle(),
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
    sinceBriefing: (newer ?? []).map((i) => ({ source: i.source, at: i.occurred_at, author: i.author, title: i.title, body: i.body?.slice(0, 800) ?? null })),
    name: c.name,
    website: c.website,
    adAccountConnected: Boolean(c.meta_ad_account_id),
    allotment: usage ? toAllotment(usage as UsageRow) : null,
    digest: briefing?.digest && Object.keys(briefing.digest).length ? (briefing.digest as Digest) : null,
    meta: snap ? describeMeta(snap as Parameters<typeof describeMeta>[0]) : null,
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
  if (!on("meta")) lines.push("(Ad performance isn't part of this task.)");
  else if (ctx.meta) lines.push("<meta_ads_performance>", ctx.meta, "</meta_ads_performance>");
  else lines.push(ctx.adAccountConnected ? "Meta ad account linked, but no performance pulled yet. Don't invent metrics." : "No Meta ad account linked yet. Don't invent metrics.");
  if (ctx.digest) lines.push("<briefing from Slack, email and Drive>", describeDigest(ctx.digest), "</briefing>");
  if (ctx.sinceBriefing.length)
    lines.push(
      "<newer_than_the_briefing>",
      "Messages that arrived after the briefing was written. Where they change something, they win.",
      ...ctx.sinceBriefing
        .slice()
        .reverse()
        .map((i) => `- ${i.at.slice(0, 16).replace("T", " ")} · ${i.source === "gmail" ? "Email" : i.source === "slack_internal" ? "Slack (internal)" : "Slack (with client)"}${i.author ? ` · ${i.author}` : ""}${i.title ? ` · "${i.title}"` : ""}${i.body ? `
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

export type DraftPatch = { title: string; angle: string; audience: string; brief: string; changed: string[]; note: string };
export const PATCH_SCHEMA = obj({ title: str, angle: str, audience: str, brief: str, changed: strArr, note: str });
