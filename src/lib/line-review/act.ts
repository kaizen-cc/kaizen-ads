import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { postAsUser } from "@/lib/slack-user";
import { HEAD_LINE, LINE_HEAD, REVIEW_LINE_LABEL, slackIssues, weekStartOf, type Review, type ReviewLine, type Teammate } from "./core";
import { nyDay } from "./build";

// What a head (or an exec) does with a weekly review: edit the message, approve and send it, or skip it. Shared by the
// /reviews page and the assistant's tools, so the rules are checked in one place:
//   - only the line's head or an exec, never while viewing as someone
//   - only to the client's INTERNAL Slack channel, posted as the person approving it; never a client channel
//   - the client must still be live (archived or inactive clients get nothing)
//   - the text must pass every Slack rule (no fees or Stripe, no departed teammates, no unverified churn)

export type ActResult = { ok: true; message?: string; permalink?: string } | { ok: false; error: string; issues?: string[]; needsConnect?: boolean };

/** Whether this person runs this line's review: its head, or an exec */
export const runsLine = (me: Pick<Staff, "isExec" | "role">, line: ReviewLine) => me.isExec || me.role === LINE_HEAD[line];
/** The lines someone reviews (execs all four) */
export const myLines = (me: Pick<Staff, "isExec" | "role">): ReviewLine[] => (me.isExec ? ["meta", "google", "email", "social"] : HEAD_LINE[me.role] ? [HEAD_LINE[me.role]] : []);

async function loadOwn(admin: SupabaseClient, me: Staff, id: string) {
  if (me.viewAs) return { error: `You're viewing as ${me.viewAs.label}: exit to make changes.` } as const;
  const { data: row } = await admin.from("line_reviews").select("id, client_id, line, week_start, status, message, review").eq("id", id).maybeSingle();
  if (!row) return { error: "That review isn't there anymore." } as const;
  if (!runsLine(me, row.line as ReviewLine)) return { error: `The ${REVIEW_LINE_LABEL[row.line as ReviewLine]} review is the line head's (or an exec's).` } as const;
  return { row } as const;
}

async function teamOf(admin: SupabaseClient): Promise<Teammate[]> {
  const { data } = await admin.from("profiles").select("id, full_name, display_name, is_active, slack_user_id");
  return (data ?? []) as Teammate[];
}

/** Save the head's edits (kept when the numbers refresh). Returns what would stop it going to Slack, so they can fix it. */
export async function editReview(admin: SupabaseClient, me: Staff, id: string, message: string): Promise<ActResult> {
  const own = await loadOwn(admin, me, id);
  if ("error" in own) return { ok: false, error: own.error! };
  if (own.row.status !== "draft") return { ok: false, error: `It was already ${own.row.status}.` };
  const text = String(message ?? "").trim().slice(0, 12_000);
  if (!text) return { ok: false, error: "The message is empty." };
  await admin.from("line_reviews").update({ message: text, edited_by: me.id, edited_at: new Date().toISOString() }).eq("id", id);
  const { data: c } = await admin.from("clients").select("status").eq("id", own.row.client_id).maybeSingle();
  const issues = slackIssues(text, { status: (c?.status as string) ?? null, team: await teamOf(admin) });
  return issues.length ? { ok: true, message: `Saved. Before it can go out: ${issues.join(" ")}` } : { ok: true, message: "Saved." };
}

/** Approve and send: posted as this person to the client's internal channel, after every rule passes */
export async function sendReview(admin: SupabaseClient, me: Staff, id: string, message?: string | null): Promise<ActResult> {
  const own = await loadOwn(admin, me, id);
  if ("error" in own) return { ok: false, error: own.error! };
  const row = own.row;
  if (row.status !== "draft") return { ok: false, error: `It was already ${row.status}.` };
  const { data: c } = await admin.from("clients").select("name, status, archived_at, internal_slack_channel_id, slack_channel_id").eq("id", row.client_id).maybeSingle();
  if (!c || c.archived_at || !["active", "onboarding"].includes(String(c.status))) return { ok: false, error: `${c?.name ?? "The client"} is ${c?.archived_at ? "archived" : (c?.status ?? "gone")} in Kaizen OS: nothing goes out.` };
  const channel = String(c.internal_slack_channel_id ?? "").trim();
  if (!channel) return { ok: false, error: `${c.name} has no internal Slack channel linked, so the review can't be posted. Link it on the client page (it never goes to the client's channel).` };
  // Never the client's own channel, whatever is linked where
  if (channel === String(c.slack_channel_id ?? "").trim()) return { ok: false, error: `${c.name}'s internal channel is set to the client's channel: fix the link first. Reviews only ever go to the internal channel.` };
  const text = String(message ?? row.message ?? "").trim();
  if (!text) return { ok: false, error: "The message is empty." };
  const issues = slackIssues(text, { status: c.status as string, team: await teamOf(admin) });
  if (issues.length) return { ok: false, error: "Not sent: fix these first.", issues };
  const posted = await postAsUser(me.id, { channel, text });
  const at = new Date().toISOString();
  if (!posted.ok) {
    await admin.from("line_reviews").update({ error: posted.error }).eq("id", id);
    return { ok: false, error: posted.error, needsConnect: posted.needsConnect };
  }
  await admin
    .from("line_reviews")
    .update({ status: "sent", message: text, sent_by: me.id, sent_at: at, slack_channel: posted.channel, slack_ts: posted.ts, permalink: posted.permalink ?? null, error: null })
    .eq("id", id);
  return { ok: true, message: `Posted in ${c.name}'s internal channel as you.`, permalink: posted.permalink };
}

export async function skipReview(admin: SupabaseClient, me: Staff, id: string, reason: string): Promise<ActResult> {
  const own = await loadOwn(admin, me, id);
  if ("error" in own) return { ok: false, error: own.error! };
  if (own.row.status !== "draft") return { ok: false, error: `It was already ${own.row.status}.` };
  await admin.from("line_reviews").update({ status: "skipped", skipped_by: me.id, skipped_at: new Date().toISOString(), skip_reason: String(reason ?? "").slice(0, 300) || null }).eq("id", id);
  return { ok: true, message: "Skipped for this week." };
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type ReviewCard = {
  id: string;
  clientId: string;
  client: string;
  slug: string;
  line: ReviewLine;
  status: "draft" | "sent" | "skipped";
  risk: number;
  message: string;
  review: Review;
  draftedAt: string;
  sentAt: string | null;
  permalink: string | null;
  skipReason: string | null;
  error: string | null;
  edited: boolean;
};

/** This week's reviews the person may see (their session: RLS lets a head read their line, an exec everything), worst first */
export async function loadReviews(db: SupabaseClient, opts: { week?: string; line?: ReviewLine | null; client?: string | null } = {}): Promise<{ week: string; cards: ReviewCard[] }> {
  const week = opts.week ?? weekStartOf(nyDay(new Date()));
  let q = db
    .from("line_reviews")
    .select("id, client_id, line, status, risk, message, review, drafted_at, sent_at, permalink, skip_reason, error, edited_at, clients!inner(name, slug)")
    .eq("week_start", week)
    .order("risk", { ascending: false })
    .limit(800);
  if (opts.line) q = q.eq("line", opts.line);
  const { data } = await q;
  const needle = opts.client?.toLowerCase().trim() ?? "";
  const cards = ((data ?? []) as unknown as (Record<string, unknown> & { clients: { name: string; slug: string } })[])
    .map((r) => ({
      id: r.id as string,
      clientId: r.client_id as string,
      client: r.clients.name,
      slug: r.clients.slug,
      line: r.line as ReviewLine,
      status: r.status as ReviewCard["status"],
      risk: Number(r.risk ?? 0),
      message: String(r.message ?? ""),
      review: r.review as Review,
      draftedAt: r.drafted_at as string,
      sentAt: (r.sent_at as string | null) ?? null,
      permalink: (r.permalink as string | null) ?? null,
      skipReason: (r.skip_reason as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      edited: Boolean(r.edited_at),
    }))
    .filter((c) => !needle || c.client.toLowerCase().includes(needle) || c.slug === needle);
  return { week, cards };
}

/** The execs' rollup: one row per client, its lines' reviews under it, worst first by retention risk */
export function rollup(cards: readonly ReviewCard[]) {
  const by = new Map<string, { clientId: string; client: string; slug: string; risk: number; atRisk: boolean; lines: ReviewCard[] }>();
  for (const c of cards) {
    const cur = by.get(c.clientId) ?? { clientId: c.clientId, client: c.client, slug: c.slug, risk: 0, atRisk: false, lines: [] };
    cur.lines.push(c);
    cur.risk = Math.max(cur.risk, c.risk);
    cur.atRisk = cur.atRisk || Boolean(c.review?.health?.atRisk);
    by.set(c.clientId, cur);
  }
  return [...by.values()].sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || b.risk - a.risk || a.client.localeCompare(b.client));
}
