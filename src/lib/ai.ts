import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

// Claude for the request form: field suggestions and the pre-submit review.
// Every call is optional. Without ANTHROPIC_API_KEY the form still works, just without suggestions.

const MODEL = "claude-opus-5-5";

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export class AiUnavailable extends Error {}

/** One structured call. Returns the parsed JSON or throws AiUnavailable with a message the UI can show. */
export async function askJson<T>({
  system,
  prompt,
  schema,
  effort,
}: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
}): Promise<T> {
  if (!aiEnabled()) throw new AiUnavailable("AI isn't connected yet.");
  try {
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      output_config: { effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new AiUnavailable("The AI couldn't help with this one.");
    if (res.stop_reason === "max_tokens") throw new AiUnavailable("The AI ran out of room. Try again.");
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new AiUnavailable("The AI didn't answer. Try again.");
    return JSON.parse(text.text) as T;
  } catch (e) {
    if (e instanceof AiUnavailable) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new AiUnavailable("The AI is busy. Try again in a moment.");
    if (e instanceof Anthropic.AuthenticationError) throw new AiUnavailable("The AI key isn't valid.");
    if (e instanceof Anthropic.APIError) throw new AiUnavailable(`The AI had a problem (${e.status ?? "network"}).`);
    throw new AiUnavailable("The AI had a problem. Try again.");
  }
}

// ─── Client context ─────────────────────────────────────────────────────────

export type ClientContext = {
  name: string;
  website: string | null;
  adAccountConnected: boolean;
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
  const [{ data: c }, { data: angles }, { data: memory }, { data: recent }] = await Promise.all([
    supabase.from("clients").select("name, website, meta_ad_account_id").eq("id", clientId).maybeSingle(),
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

export function contextBlock(ctx: ClientContext) {
  const lines: string[] = [`<client name="${ctx.name}"${ctx.website ? ` website="${ctx.website}"` : ""}>`];
  lines.push(
    ctx.adAccountConnected
      ? "Meta ad account is linked, but performance data isn't synced into this app yet. Don't invent metrics."
      : "No Meta ad account linked yet. Don't invent metrics.",
  );
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

export const AGENCY_SYSTEM = `You help Kaizen Marketing, a paid social agency, write creative requests for Meta ads.
A request goes to a graphic designer (images, carousels) or a video editor (videos). One request can cover several formats; each format becomes its own ticket.
A "net new" creative is a distinct design. A "variation" reuses the same design and tests copy, title, CTA or layout; it doesn't count as a new deliverable. A carousel counts as one deliverable. Sizes of one design count as one.
Sizes are 1:1, 4:5 (feed) and 9:16 (stories, reels).
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
