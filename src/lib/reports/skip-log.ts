import { shiftDay } from "./period";

// Skipping a report: not ready to send, sent the old way, sent their own way. The report waits for its next period and
// leaves the queue; what happened is kept on the report itself (reports.log) so there's a history. Pure logic, shared
// by the server actions, the Reports page, the studio and the tests.

export const SKIP_REASONS = [
  { key: "not_ready", label: "Not ready to send yet" },
  { key: "old_way", label: "Sent it the old way" },
  { key: "own_way", label: "Sent it our own way" },
  { key: "client_asked", label: "Client asked to skip" },
  { key: "paused", label: "Account paused" },
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number]["key"];

export const isSkipReason = (k: unknown): k is SkipReason => SKIP_REASONS.some((r) => r.key === k);
export const reasonLabel = (k: string | null | undefined) => SKIP_REASONS.find((r) => r.key === k)?.label ?? (k ? String(k) : "");

export type LogEntry = { action: "skipped" | "unskipped"; reason?: string | null; note?: string | null; by: string | null; byName: string | null; at: string };

const MAX_LOG = 100;

/** The log as stored (jsonb): anything that isn't a well-formed entry is dropped */
export function parseLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    if (e.action !== "skipped" && e.action !== "unskipped") continue;
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) continue;
    out.push({
      action: e.action,
      reason: typeof e.reason === "string" ? e.reason : null,
      note: typeof e.note === "string" && e.note.trim() ? e.note : null,
      by: typeof e.by === "string" ? e.by : null,
      byName: typeof e.byName === "string" ? e.byName : null,
      at: e.at,
    });
  }
  return out;
}

/** A new entry on the end (oldest dropped past a hundred) */
export function appendLog(log: unknown, entry: LogEntry): LogEntry[] {
  return [...parseLog(log), entry].slice(-MAX_LOG);
}

export function skipEntry(p: { reason: string; note?: string | null; by: string | null; byName: string | null; at?: string }): LogEntry {
  const note = (p.note ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  return { action: "skipped", reason: p.reason, note: note || null, by: p.by, byName: p.byName, at: p.at ?? new Date().toISOString() };
}

export function unskipEntry(p: { by: string | null; byName: string | null; at?: string }): LogEntry {
  return { action: "unskipped", reason: null, note: null, by: p.by, byName: p.byName, at: p.at ?? new Date().toISOString() };
}

/** The skip that's in force: the last entry, if it's a skip (a skip that was brought back no longer counts) */
export function latestSkip(log: unknown): LogEntry | null {
  const last = parseLog(log).at(-1);
  return last?.action === "skipped" ? last : null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const first = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : null);

/** "Skipped by Dana · Nov 13 · Sent it the old way" */
export function skipLine(e: LogEntry): string {
  return ["Skipped" + (first(e.byName) ? ` by ${first(e.byName)}` : ""), day(e.at), reasonLabel(e.reason)].filter(Boolean).join(" · ");
}

/** One line of the history list: the skip with its note, or the bringing back */
export function logLine(e: LogEntry): string {
  if (e.action === "unskipped") return `Brought back${first(e.byName) ? ` by ${first(e.byName)}` : ""} · ${day(e.at)}`;
  return skipLine(e) + (e.note ? ` · "${e.note}"` : "");
}

/** The last day a skipped report can still be brought back: the end of its next period (after that, a newer report has taken its place) */
export function bringBackUntil(kind: string, periodEnd: string): string {
  if (kind === "weekly") return shiftDay(periodEnd, 7);
  if (kind === "monthly") {
    const [y, m] = periodEnd.split("-").map(Number);
    return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  }
  return shiftDay(periodEnd, 30);
}

export const canBringBack = (kind: string, periodEnd: string, today: string) => today <= bringBackUntil(kind, periodEnd);
