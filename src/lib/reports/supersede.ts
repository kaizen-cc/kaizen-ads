import type { SupabaseClient } from "@supabase/supabase-js";
import { appendLog, type LogEntry } from "./skip-log";
import { rangeLabel } from "./period";

// The owner's rule (Nov 24): once a newer report exists for the same client, service and cadence (weekly, monthly; every
// line), the older one that was never sent is cleared by itself. It's skipped ("superseded by the Nov 16 – Nov 22
// report"), never deleted, and what pointed at it (its ladder nudge, the bell notice) closes with it. Sent reports are
// records and are never touched.

export type Rep = { id: string; client_id: string; platform: string; kind: string; target_id: string | null; period_start: string; period_end: string; status: string };

/** Statuses a report can be cleared from: not sent, not being written right now */
const OPEN = new Set(["draft", "submitted", "failed", "queued"]);
const CADENCE = new Set(["weekly", "monthly"]);
const groupOf = (r: Rep) => `${r.client_id}|${r.platform}|${r.kind}|${r.target_id ?? ""}`;

/** Each open report a newer one of its kind has replaced, with the newest one (pure, tested) */
export function supersededBy(rows: Rep[]): { old: Rep; by: Rep }[] {
  const newest = new Map<string, Rep>();
  for (const r of rows) {
    if (!CADENCE.has(r.kind)) continue;
    const k = groupOf(r);
    const had = newest.get(k);
    if (!had || r.period_end > had.period_end) newest.set(k, r);
  }
  const out: { old: Rep; by: Rep }[] = [];
  for (const r of rows) {
    if (!CADENCE.has(r.kind) || !OPEN.has(r.status)) continue;
    const top = newest.get(groupOf(r));
    if (top && top.id !== r.id && top.period_end > r.period_end) out.push({ old: r, by: top });
  }
  return out;
}

/** The skip entry a superseded report carries */
export const supersedeEntry = (by: Rep, at = new Date().toISOString()): LogEntry => ({ action: "skipped", reason: "superseded", note: `Superseded by the ${rangeLabel({ start: by.period_start, end: by.period_end }, at.slice(0, 10))} report`, by: null, byName: "Kaizen OS", at });

/**
 * Clears every open weekly or monthly report a newer one has replaced (all clients, or one). Returns how many. Each is
 * skipped with the reason on its log; its ladder nudges resolve and their bell notices are marked read.
 */
export async function supersedeOlder(admin: SupabaseClient, opts: { clientId?: string } = {}): Promise<number> {
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const page = (at: number) => {
    const q = admin.from("reports").select("id, client_id, platform, kind, target_id, period_start, period_end, status").in("kind", ["weekly", "monthly"]).gte("period_end", since);
    return (opts.clientId ? q.eq("client_id", opts.clientId) : q).order("id").range(at, at + 999);
  };
  const rows: Rep[] = [];
  for (let at = 0; at < 50_000; at += 1000) {
    const { data, error } = await page(at);
    if (error) return 0;
    rows.push(...((data ?? []) as Rep[]));
    if ((data ?? []).length < 1000) break;
  }
  const now = new Date().toISOString();
  let cleared = 0;
  for (const { old, by } of supersededBy(rows)) {
    const { data: cur } = await admin.from("reports").select("log").eq("id", old.id).maybeSingle();
    const { data: done } = await admin
      .from("reports")
      .update({ status: "skipped", updated_at: now, log: appendLog((cur as { log?: unknown } | null)?.log, supersedeEntry(by, now)) })
      .eq("id", old.id)
      .in("status", [...OPEN])
      .select("id")
      .maybeSingle();
    if (!done) continue;
    cleared++;
    // What pointed at it closes with it: the ladder's nudge to the lead, and that nudge's bell notice
    const { data: nudges } = await admin.from("ladder_nudges").update({ status: "resolved", resolved_at: now }).eq("item_key", `report:${old.id}`).in("status", ["open", "sent"]).select("id");
    for (const n of nudges ?? []) await admin.from("notifications").update({ read_at: now }).eq("key", `nudge:${n.id}`).is("read_at", null);
    await admin.from("notifications").update({ read_at: now }).eq("href", `/reports/${old.id}`).is("read_at", null);
  }
  return cleared;
}
