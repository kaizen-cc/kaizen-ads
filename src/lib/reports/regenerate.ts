import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftReport } from "./write";

// Regenerate: a report not yet sent, written again from scratch with the account's freshest numbers and the latest
// report logic. The draft it replaces is kept on the report (`previous`) for a day, so it can be undone. One buyer's
// part of a joint report is rewritten on its own: the other parts, approved or not, stay as they are.

export const UNDO_MS = 24 * 3_600_000;
/** How long the platform pull may hold up the writing; past it the report is written from what's already synced */
const PULL_MS = 45_000;

export type Previous = {
  at: string;
  by: string | null;
  status: string;
  message: string | null;
  sections: unknown;
  metrics: unknown;
  work: unknown;
  extra_metrics: unknown;
  qa: unknown;
  message_basis: string | null;
};

/** Whether "Undo regenerate" still applies: a kept draft from the last day, and nothing being written right now. */
export const canUndo = (r: { status: string; previous: Previous | null }) => Boolean(r.previous?.at && Date.now() - Date.parse(r.previous.at) < UNDO_MS && ["draft", "failed"].includes(r.status));

/** The account's latest numbers from Meta or Google, waited on for at most PULL_MS (it carries on in the background). */
export async function freshen(admin: SupabaseClient, targetId: string | null, ms = PULL_MS) {
  if (!targetId) return;
  const { refreshTargetKpis } = await import("@/lib/kpi/sync");
  await Promise.race([refreshTargetKpis(admin, targetId).catch(() => null), new Promise((r) => setTimeout(r, ms))]);
}

type Row = {
  id: string;
  status: string;
  bundle_id: string | null;
  message: string | null;
  sections: unknown;
  metrics: unknown;
  work: unknown;
  extra_metrics: unknown;
  qa: unknown;
  message_basis: string | null;
  previous: Previous | null;
  report_bundles: { status: string; kind: string } | null;
};

/**
 * Marks reports for a fresh draft: the current one kept as `previous`, and the report set to drafting (written now) or
 * queued (written by the queue a few at a time). Sent ones are left alone. A part of a monthly or built report that
 * was approved goes back to review, and the bundle's message waits for a fresh approval (it was written from the old
 * part); the other parts keep their approval. Returns the ids that were marked.
 */
export async function markForRegenerate(admin: SupabaseClient, ids: string[], by: string, status: "drafting" | "queued") {
  if (!ids.length) return [];
  const { data } = await admin.from("reports").select("id, status, bundle_id, message, sections, metrics, work, extra_metrics, qa, message_basis, previous, report_bundles(status, kind)").in("id", ids);
  const now = new Date().toISOString();
  const marked: string[] = [];
  const bundles = new Map<string, string>();
  for (const r of (data ?? []) as unknown as Row[]) {
    if (r.status === "posted" || (r.report_bundles?.status === "sent" && r.status === "submitted")) continue;
    // A report that was never written (it failed) keeps whatever draft was kept before it
    const previous: Previous | null = r.sections
      ? { at: now, by, status: r.status, message: r.message, sections: r.sections, metrics: r.metrics, work: r.work, extra_metrics: r.extra_metrics, qa: r.qa, message_basis: r.message_basis }
      : r.previous;
    const { data: ok } = await admin.from("reports").update({ status, previous, regenerated_at: now, submitted_at: null, error: null, updated_at: now }).eq("id", r.id).neq("status", "posted").select("id").maybeSingle();
    if (!ok) continue;
    marked.push(r.id);
    if (r.bundle_id && r.report_bundles && r.report_bundles.status !== "sent") bundles.set(r.bundle_id, r.report_bundles.kind);
  }
  // The bundle's message was approved (or written) from the parts as they were: it waits for the new one
  for (const [id, kind] of bundles) await admin.from("report_bundles").update({ message_approved_at: null, message_approved_by: null, ...(kind === "built" ? { message: null } : {}) }).eq("id", id).neq("status", "sent");
  return marked;
}

/** Writes one marked report: the account's numbers pulled first (time-boxed), then the draft and its QA. */
export async function regenerateNow(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("reports").select("target_id").eq("id", id).maybeSingle();
  await freshen(admin, (data?.target_id as string | undefined) ?? null);
  await draftReport(admin, id);
}

export type PeriodChange = { ok: true; ids: string[]; same: boolean } | { ok: false; error: string; openId?: string };

/**
 * Sets a report's period (the one source of truth for every page) and marks it to be redrawn with fresh numbers:
 * every tile, table, campaign line, top ad and chart follows, and the comparison is the same number of days just
 * before. A built report moves its main range on every part. A sent report keeps the dates it went with (duplicate it
 * for other dates); a monthly recap covers its month. Another unsent report on the same account and dates is opened
 * instead of making a second one.
 */
export async function setPeriod(admin: SupabaseClient, id: string, p: { key: string; label: string; start: string; end: string }, by: string): Promise<PeriodChange> {
  const { data: r } = await admin.from("reports").select("id, kind, status, target_id, bundle_id, period_start, period_end").eq("id", id).maybeSingle();
  if (!r) return { ok: false, error: "Not found." };
  if (r.status === "posted") return { ok: false, error: "This one already went to the client with its dates. Duplicate it from the history for other dates." };
  if (r.kind === "monthly") return { ok: false, error: "A monthly recap covers its month. Build a report for other dates." };
  if (r.status === "drafting" || r.status === "queued") return { ok: false, error: "It's being written right now. Pick the dates again when it's done." };
  const same = r.period_start === p.start && r.period_end === p.end;
  const now = new Date().toISOString();
  let ids = [id];
  if (r.kind === "built" && r.bundle_id) {
    const { data: b } = await admin.from("report_bundles").select("id, status, ranges").eq("id", r.bundle_id).maybeSingle();
    if (!b || b.status === "sent") return { ok: false, error: "This report already went to the client with its dates." };
    const { data: parts } = await admin.from("reports").select("id, status").eq("bundle_id", b.id).neq("status", "skipped");
    if ((parts ?? []).some((x) => x.status === "drafting" || x.status === "queued")) return { ok: false, error: "A part is being written right now. Pick the dates again when it's done." };
    ids = (parts ?? []).filter((x) => x.status !== "posted").map((x) => x.id as string);
    if (!same) {
      const ranges = ((b.ranges ?? []) as { key: string; label: string; start: string; end: string }[]).slice();
      ranges[0] = { key: p.key, label: p.label, start: p.start, end: p.end };
      const { error } = await admin.from("report_bundles").update({ ranges, period_start: p.start, period_end: p.end }).eq("id", b.id);
      if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? "There's already a report built for this client starting on those dates." : error.message };
      const { error: e2 } = await admin.from("reports").update({ period_start: p.start, period_end: p.end, updated_at: now }).in("id", ids);
      if (e2) return { ok: false, error: e2.message };
    }
  } else if (!same) {
    const { data: twin } = await admin.from("reports").select("id, status").eq("target_id", r.target_id).eq("kind", r.kind).eq("period_start", p.start).neq("id", id).maybeSingle();
    if (twin)
      return twin.status === "posted"
        ? { ok: false, error: "A report for these dates already went to the client. It's open to review and resend in the history.", openId: twin.id as string }
        : { ok: false, error: "There's already a report for these dates on this account.", openId: twin.id as string };
    const { error } = await admin.from("reports").update({ period_start: p.start, period_end: p.end, updated_at: now }).eq("id", id);
    if (error) return { ok: false, error: error.message };
  }
  // The preset it came from, for the picker (kept apart: the column may not be there before its migration)
  await admin.from("reports").update({ period_key: p.key }).in("id", ids).then(() => null, () => null);
  const marked = await markForRegenerate(admin, ids, by, ids.length <= 2 ? "drafting" : "queued");
  return { ok: true, ids: marked, same };
}

/** Back to the draft a regenerate replaced (within a day). */
export async function undoRegenerate(admin: SupabaseClient, id: string) {
  const { data: r } = await admin.from("reports").select("status, previous").eq("id", id).maybeSingle();
  if (!r) throw new Error("Not found.");
  const p = r.previous as Previous | null;
  if (!canUndo({ status: r.status as string, previous: p })) throw new Error(r.status === "drafting" || r.status === "queued" ? "Wait for it to finish writing, then undo." : "There's no earlier draft to go back to (it's kept for a day).");
  const { error } = await admin
    .from("reports")
    .update({ status: "draft", message: p!.message, sections: p!.sections, metrics: p!.metrics, work: p!.work, extra_metrics: p!.extra_metrics, qa: p!.qa, message_basis: p!.message_basis, previous: null, regenerated_at: null, error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["draft", "failed"]);
  if (error) throw new Error(error.message);
  // The dates go back with the draft (it was drawn for them), so every page still follows the report's period
  const m = p!.metrics as { main?: { start: string; end: string }; kind?: string } | null;
  const { data: now } = await admin.from("reports").select("kind, bundle_id").eq("id", id).maybeSingle();
  if (m?.main && now && now.kind !== "monthly" && !now.bundle_id) await admin.from("reports").update({ period_start: m.main.start, period_end: m.main.end }).eq("id", id).then(() => null, () => null);
}
