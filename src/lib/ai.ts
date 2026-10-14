import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_VARIATIONS, describeAllotment, toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { describeMeta } from "@/lib/context/meta";

// Claude for the request form (suggestions, pre-submit review) and the twice-daily client briefings.
// Every call is optional. Without ANTHROPIC_API_KEY the form still works, just without suggestions.

// deep: briefings and the request review, where judgement matters. fast: live suggestions someone is waiting on.
const MODELS = { deep: "claude-opus-5-5", fast: "claude-sonnet-5-5" } as const;

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
// Org-level keys need to name the workspace their usage belongs to
const anthropic = () =>
  (client ??= new Anthropic(
    process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {},
  ));

export class AiUnavailable extends Error {}

/** One structured call. Returns the parsed JSON or throws AiUnavailable with a message the UI can show. */
export async function askJson<T>({
  label,
  system,
  prompt,
  schema,
  effort,
  model = "deep",
}: {
  label: string; // for the timing log
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  model?: keyof typeof MODELS;
}): Promise<T> {
  if (!aiEnabled()) throw new AiUnavailable("AI isn't connected yet.");
  const started = Date.now();
  const request = {
    model: MODELS[model],
    max_tokens: 16000,
    system,
    output_config: { effort, format: { type: "json_schema" as const, schema } },
    messages: [{ role: "user" as const, content: prompt }],
  };
  try {
    let res;
    try {
      // With a server-side fallback model in case the main one declines
      res = await anthropic().beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      console.error("[ai] request with fallbacks rejected, retrying without:", e.message);
      res = await anthropic().messages.create(request);
    }
    console.log(`[ai] ${label} · ${res.model} · ${Date.now() - started}ms · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
    if (res.stop_reason === "refusal") throw new AiUnavailable("The AI couldn't help with this one.");
    if (res.stop_reason === "max_tokens") throw new AiUnavailable("The AI ran out of room. Try again.");
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new AiUnavailable("The AI didn't answer. Try again.");
    return JSON.parse(text.text) as T;
  } catch (e) {
    if (e instanceof AiUnavailable) throw e;
    console.error("[ai] request failed:", e instanceof Error ? e.message : e);
    if (e instanceof Anthropic.RateLimitError) throw new AiUnavailable("The AI is busy. Try again in a moment.");
    if (e instanceof Anthropic.AuthenticationError) throw new AiUnavailable("The AI key isn't valid.");
    if (e instanceof Anthropic.BadRequestError) throw new AiUnavailable(`The AI rejected the request: ${apiMessage(e)}`);
    if (e instanceof Anthropic.APIError) throw new AiUnavailable(`The AI had a problem (${e.status ?? "network"}). Try again.`);
    throw new AiUnavailable("The AI had a problem. Try again.");
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
    supabase.from("client_briefings").select("digest").eq("client_id", clientId).maybeSingle(),
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
  return {
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

export function contextBlock(ctx: ClientContext, request?: { images: number; videos: number }) {
  const lines: string[] = [`<client name="${ctx.name}"${ctx.website ? ` website="${ctx.website}"` : ""}>`];
  if (ctx.meta) lines.push("<meta_ads_performance>", ctx.meta, "</meta_ads_performance>");
  else lines.push(ctx.adAccountConnected ? "Meta ad account linked, but no performance pulled yet. Don't invent metrics." : "No Meta ad account linked yet. Don't invent metrics.");
  if (ctx.digest) lines.push("<briefing from Slack, email and Drive>", describeDigest(ctx.digest), "</briefing>");
  lines.push("<allotment_this_month>", describeAllotment(ctx.allotment, request), "</allotment_this_month>");
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
export type Review = { verdict: "clear" | "check"; summary: string; issues: ReviewIssue[] };

export const REVIEW_SCHEMA = obj({
  verdict: { type: "string", enum: ["clear", "check"] },
  summary: str,
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
