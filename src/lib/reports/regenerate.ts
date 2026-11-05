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
}
