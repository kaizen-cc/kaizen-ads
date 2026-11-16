import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportMetrics } from "./metrics";
import { applyManual, cleanLines, type ManualLine, type ManualResults } from "./manual";

// Saving manual results on a report: the one place that does it, for the studio's "Results from the CRM" box and for
// numbers the buyer gives in the Ask the AI chat. Saved on the report (so a regenerate and every refresh keeps them) and
// merged into its numbers straight away, so the tiles, the PDF and the shared link follow.

export type SaveManual = { ok: true; lines: ManualLine[]; metrics: ReportMetrics | null } | { ok: false; error: string };

export async function saveManual(admin: SupabaseClient, id: string, lines: ManualLine[], by: { id: string; fullName: string }, status: string): Promise<SaveManual> {
  if (status === "posted") return { ok: false, error: "It's already gone out." };
  if (status === "queued" || status === "drafting") return { ok: false, error: "It's being written right now. Add the results when it's done." };
  const { data: row } = await admin.from("reports").select("period_start, period_end, metrics").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "Not found." };
  const clean = cleanLines(lines);
  const at = new Date().toISOString();
  const entered: ManualResults | null = clean.length ? { lines: clean, start: row.period_start as string, end: row.period_end as string, by: by.id, byName: by.fullName, at } : null;
  const update: Record<string, unknown> = { manual_results: entered, updated_at: at };
  const metrics = row.metrics ? applyManual(row.metrics as ReportMetrics, entered) : null;
  if (metrics) update.metrics = metrics;
  const { error } = await admin.from("reports").update(update).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, lines: clean, metrics };
}
