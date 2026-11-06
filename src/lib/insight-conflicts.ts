import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, type AgentKey } from "@/lib/ai";
import { clock } from "@/lib/loom";
import { GOOGLE_AGENTS, MARK, META_AGENTS, rewriteBuyerSkills } from "@/lib/buying-insights";
import { canRebut, platformOf, type RebutProfile } from "@/lib/rebut-permission";

// Contradictions in the senior buyer's teachings, settled by the people who rule on audits (profiles.can_rebut_audits)
// and the head of the teaching's platform: a Google one goes to the Head of Google too (src/lib/rebut-permission.ts).
// Consolidation flags one when a new point gives the opposite advice to another point (or to a skill the agency wrote);
// it isn't taught until someone rules. They hear it in the bell, open a review sheet with both sides and their sources,
// and either rule at once (teach this one, both hold, don't teach it) or talk it through with the Media Buyer (Meta) or
// the Google Ads Buyer (Google): it explains both, asks what situation decides it, and once he's made the call
// proposes the refined rule; teaching it saves a new point that settles both and feeds the skill rewrite.

type Admin = SupabaseClient;

const OPEN = "conflict_with.not.is.null,conflict_skill.not.is.null";
export const TITLE = "Need more clarity on a contradiction in a media buying tactic";
export const conflictHref = (id: string) => `/settings?tab=agents&section=knowledge&kn=buyer&conflict=${id}`;

/** Everyone who could rule on some contradiction: the permission, and the heads of Meta and Google */
async function rulers(admin: Admin) {
  const { data } = await admin.from("profiles").select("id, can_rebut_audits, role").eq("is_active", true).or("can_rebut_audits.eq.true,role.in.(head_of_google,head_of_meta)");
  return (data ?? []).map((p) => ({ id: p.id as string, profile: { can_rebut_audits: Boolean(p.can_rebut_audits), role: (p.role as string | null) ?? null } satisfies RebutProfile }));
}

/** Whether this person rules on a teaching of this platform (meta, google, both or none) */
export const rulesOn = (p: RebutProfile, platform: string | null | undefined) => canRebut(p, platformOf(platform));

/**
 * Contradictions nobody was told about yet, into the bell of everyone who can rule: one alert each when there are a
 * few, one alert for the lot when consolidation (or the first run, with the backlog) flags many at once.
 */
export async function notifyContradictions(admin: Admin) {
  const { data } = await admin
    .from("media_buying_insights")
    .select("id, body, platform, conflict_skill, other:conflict_with(body)")
    .is("ruling", null)
    .eq("excluded", false)
    .is("merged_into", null)
    .is("notified_at", null)
    .or(OPEN)
    .order("created_at")
    .limit(1000);
  const fresh = data ?? [];
  if (!fresh.length) return { notified: 0 };
  const people = await rulers(admin);
  if (!people.length) return { notified: 0 };
  // Each one to the people who can rule on its platform; the batch alert to anyone who can rule on at least one
  const rows =
    fresh.length <= 3
      ? fresh.flatMap((c) =>
          people.filter((p) => rulesOn(p.profile, c.platform as string)).map((p) => ({
            profile_id: p.id,
            kind: "contradiction",
            title: TITLE,
            body: `"${String(c.body).slice(0, 220)}" disagrees with ${c.conflict_skill ? `the written skill "${c.conflict_skill}"` : `"${String((c.other as unknown as { body: string } | null)?.body ?? "another point").slice(0, 200)}"`}. Your call decides what the buyers are taught.`.slice(0, 1000),
            href: conflictHref(c.id as string),
            key: `contradiction:${c.id}`,
            priority: "normal",
          })),
        )
      : people.flatMap((p) => {
          const mine = fresh.filter((c) => rulesOn(p.profile, c.platform as string));
          return mine.length ? [{ p, mine }] : [];
        }).map(({ p, mine }) => ({
          profile_id: p.id,
          kind: "contradiction",
          title: `Need more clarity on ${mine.length} contradiction${mine.length === 1 ? "" : "s"} in media buying tactics`,
          body: `The senior buyer's Looms disagree with each other (or with a written skill) in ${mine.length} place${mine.length === 1 ? "" : "s"}. None of them is taught until it's ruled on: open the first and go one by one.`,
          href: conflictHref(mine[0].id as string),
          key: `contradictions:${mine[0].id}`,
          priority: "normal",
        }));
  await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true });
  const now = new Date().toISOString();
  const ids = fresh.map((c) => c.id as string);
  for (let i = 0; i < ids.length; i += 200) await admin.from("media_buying_insights").update({ notified_at: now }).in("id", ids.slice(i, i + 200));
  return { notified: ids.length };
}

/** A contradiction settled: its alert is read for everyone, and a batch alert too once nothing is left to rule on */
export async function settleNotices(admin: Admin, id: string) {
  const now = new Date().toISOString();
  await admin.from("notifications").update({ read_at: now }).eq("key", `contradiction:${id}`).is("read_at", null);
  const { count } = await admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("ruling", null).eq("excluded", false).is("merged_into", null).or(OPEN);
  if (!count) await admin.from("notifications").update({ read_at: now }).like("key", "contradictions:%").is("read_at", null);
}

// ─── The review sheet ───────────────────────────────────────────────────────

export type ConflictPoint = { kind: "point"; id: string; layer: string; body: string; quote: string | null; at: string | null; url: string | null; video: string | null; platform: string; support: number };
export type ConflictSkill = { kind: "skill"; title: string; body: string };
export type ConflictMessage = { id: string; role: "person" | "agent"; body: string; by: string | null; at: string; proposal: string | null; taught: boolean };
export type ConflictDetail = {
  id: string;
  layer: string;
  platform: string;
  note: string | null;
  ruling: string | null;
  mine: ConflictPoint;
  other: ConflictPoint | ConflictSkill | null;
  messages: ConflictMessage[];
  agentName: string;
  /** The next contradiction still to rule on (after this one), and how many are left */
  next: string | null;
  open: number;
};

const agentFor = (platform: string): { key: AgentKey; name: string } => (platform === "google" ? { key: "google_auditor", name: "Google Ads Buyer" } : { key: "auditor", name: "Media Buyer" });

type PointRow = { id: string; layer: string; body: string; quote: string | null; at_seconds: number | null; loom_id: string | null; platform: string; confidence: number; loom_videos: { title: string | null } | null };
const POINT = "id, layer, body, quote, at_seconds, loom_id, platform, confidence, loom_videos(title)";
const point = (r: PointRow): ConflictPoint => ({
  kind: "point",
  id: r.id,
  layer: r.layer,
  body: r.body,
  quote: r.quote,
  at: r.at_seconds == null ? null : clock(r.at_seconds),
  url: r.loom_id ? `https://www.loom.com/share/${r.loom_id}${r.at_seconds ? `?t=${r.at_seconds}` : ""}` : null,
  video: r.loom_videos?.title ?? null,
  platform: r.platform,
  support: r.confidence,
});

export async function conflictThread(admin: Admin, id: string): Promise<ConflictMessage[]> {
  const { data } = await admin.from("insight_conflict_messages").select("id, role, body, proposal, taught_at, created_at, profiles!insight_conflict_messages_author_id_fkey(full_name)").eq("insight_id", id).order("created_at").limit(200);
  return (data ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as ConflictMessage["role"],
    body: m.body as string,
    by: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    at: m.created_at as string,
    proposal: (m.proposal as string | null) || null,
    taught: Boolean(m.taught_at),
  }));
}

export async function conflictDetail(admin: Admin, id: string): Promise<ConflictDetail | null> {
  const { data: r } = await admin.from("media_buying_insights").select(`${POINT}, conflict_with, conflict_skill, conflict_note, ruling, created_at`).eq("id", id).maybeSingle();
  if (!r) return null;
  let other: ConflictDetail["other"] = null;
  if (r.conflict_with) {
    const { data: o } = await admin.from("media_buying_insights").select(POINT).eq("id", r.conflict_with).maybeSingle();
    if (o) other = point(o as unknown as PointRow);
  } else if (r.conflict_skill) {
    const { data: s } = await admin.from("ai_knowledge").select("title, body, file_name").in("agent_key", [...META_AGENTS, ...GOOGLE_AGENTS]).eq("title", r.conflict_skill).limit(5);
    const hand = (s ?? []).find((x) => !String(x.file_name ?? "").startsWith(MARK));
    other = { kind: "skill", title: r.conflict_skill as string, body: ((hand?.body as string | undefined) ?? "").slice(0, 2400) };
  }
  // The queue: what's still open, oldest first, so ruling one moves to the next
  const { data: open } = await admin.from("media_buying_insights").select("id").is("ruling", null).eq("excluded", false).is("merged_into", null).or(OPEN).order("created_at").limit(1000);
  const ids = (open ?? []).map((x) => x.id as string);
  const at = ids.indexOf(id);
  const next = ids.length ? (at >= 0 ? (ids[at + 1] ?? ids.find((x) => x !== id) ?? null) : ids[0]) : null;
  return {
    id,
    layer: r.layer as string,
    platform: r.platform as string,
    note: (r.conflict_note as string | null) ?? null,
    ruling: (r.ruling as string | null) ?? null,
    mine: point(r as unknown as PointRow),
    other,
    messages: await conflictThread(admin, id),
    agentName: agentFor(r.platform as string).name,
    next: next === id ? null : next,
    open: ids.length,
  };
}

const SYSTEM = `You are Kaizen's AI media buyer, built from the Loom audits of Kaizen's senior buyer. Two of his teachings give opposite advice for what looks like the same situation (or one of them disagrees with a skill the agency wrote), so neither is taught until it's settled. You're talking it through with the person who rules on it: the senior buyer himself or an exec.
Your job: lay out both positions fairly and briefly, each with where it came from (the Loom and the moment, or the written skill), say what you think the real difference is (the situation, platform, objective, budget, account stage, business model or metric where each one holds), and ask the one question whose answer decides it. Don't decide for him and don't argue for a side unless asked.
When he has made the call (which one holds, or in which situation each holds), set decided true and write refined_rule: one rule in his terms, conditional when it depends on the situation ("When X, do A; when Y, do B"), with his thresholds if he gave any, true for any account it covers, no client names, no people's names. Until then decided false and refined_rule empty. If he changes his mind, write the new rule.
Keep it short: 2 to 6 sentences, plain and direct, to a senior media buyer. Refer to people by role, never by name. No em dashes.`;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, decided: { type: "boolean" }, refined_rule: { type: "string" } },
  required: ["answer", "decided", "refined_rule"],
  additionalProperties: false,
};

const side = (s: ConflictPoint | ConflictSkill | null) =>
  !s
    ? "(the other side wasn't kept)"
    : s.kind === "skill"
      ? `The agency's written skill "${s.title}":\n${s.body || "(its text wasn't found)"}`
      : `${s.body}${s.quote ? `\nIn his words${s.at ? ` at ${s.at}` : ""}: "${s.quote}"` : ""}${s.video ? `\nFrom the Loom "${s.video}"` : ""} (said in ${s.support} video${s.support === 1 ? "" : "s"}, platform ${s.platform})`;

/** One turn of the review chat: the person's message (none to open it) and the agent's answer, both kept */
export async function askConflict(admin: Admin, id: string, text: string, by: string) {
  const d = await conflictDetail(admin, id);
  if (!d) throw new Error("Not found.");
  const said = text.trim().slice(0, 3000);
  if (said) await admin.from("insight_conflict_messages").insert({ insight_id: id, role: "person", body: said, author_id: by });
  const history = said ? [...d.messages, { role: "person", body: said }] : d.messages;
  const agent = agentFor(d.platform);
  const out = await askJson<{ answer: string; decided: boolean; refined_rule: string }>({
    agent: agent.key,
    label: "contradiction chat",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 5000,
    override: { effort: "medium" },
    prompt: `<teaching_a layer="${d.layer}" platform="${d.platform}">\n${side(d.mine)}\n</teaching_a>\n\n<teaching_b>\n${side(d.other)}\n</teaching_b>\n${d.note ? `\nHow consolidation saw the difference: ${d.note}\n` : ""}${history.length ? `\n<the_thread_so_far>\n${history.map((m) => `${m.role === "agent" ? "You" : "Them"}: ${m.body}`).join("\n\n")}\n</the_thread_so_far>\n` : "\nOpen the conversation: lay out both and ask your question.\n"}`,
  });
  const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").trim();
  const proposal = out.decided ? clean(out.refined_rule).slice(0, 1200) : "";
  const { data } = await admin.from("insight_conflict_messages").insert({ insight_id: id, role: "agent", body: clean(out.answer).slice(0, 6000), proposal: proposal || null }).select("id, created_at").single();
  return { id: (data?.id as string | undefined) ?? `a-${Date.now()}`, role: "agent" as const, body: clean(out.answer), by: agent.name, at: (data?.created_at as string | undefined) ?? new Date().toISOString(), proposal: proposal || null, taught: false };
}

/**
 * "Teach this refined rule": a new point in the senior buyer's words that settles the contradiction. Both sides are
 * folded into it (the other side only when it's a point, never a written skill), it carries their videos as support,
 * and the generated skills are rewritten.
 */
export async function teachRefined(admin: Admin, messageId: string, by: string) {
  const { data: m } = await admin.from("insight_conflict_messages").select("id, insight_id, proposal, taught_at").eq("id", messageId).single();
  if (!m?.proposal) throw new Error("There's no rule to teach on that message.");
  if (m.taught_at) return { id: null };
  const { data: a } = await admin.from("media_buying_insights").select("id, layer, platform, videos, scope, vertical_id, business_model, industry, conflict_with").eq("id", m.insight_id).single();
  if (!a) throw new Error("Not found.");
  const { data: b } = a.conflict_with ? await admin.from("media_buying_insights").select("id, videos").eq("id", a.conflict_with).maybeSingle() : { data: null };
  const videos = [...new Set([...((a.videos as string[] | null) ?? []), ...((b?.videos as string[] | null) ?? [])])];
  const now = new Date().toISOString();
  const { data: made, error } = await admin
    .from("media_buying_insights")
    .insert({
      layer: a.layer,
      body: String(m.proposal).slice(0, 1500),
      platform: a.platform,
      tags: { refined: true },
      videos,
      confidence: Math.max(1, videos.length),
      scope: a.scope ?? "general",
      vertical_id: a.vertical_id,
      business_model: a.business_model,
      industry: a.industry,
      consolidated_at: now,
      attributed_at: now,
      scoped_at: now,
      notified_at: now,
      ruling: "keep",
      ruled_by: by,
      ruled_at: now,
      refined_from: [a.id, ...(b ? [b.id] : [])],
    })
    .select("id")
    .single();
  if (error || !made) throw new Error(error?.message ?? "Couldn't save the rule.");
  // Both sides fold into the refined rule (nothing deleted: they point at it)
  for (const x of [a.id, ...(b ? [b.id] : [])]) await admin.from("media_buying_insights").update({ merged_into: made.id, ruling: "drop", ruled_by: by, ruled_at: now, updated_at: now }).eq("id", x);
  await admin.from("insight_conflict_messages").update({ taught_at: now, taught_by: by }).eq("id", messageId);
  await settleNotices(admin, a.id as string);
  await rewriteBuyerSkills(admin);
  return { id: made.id as string };
}
