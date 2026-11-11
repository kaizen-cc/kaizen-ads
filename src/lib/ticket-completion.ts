// Completing a ticket. A ticket completes itself the moment the system sees its ad live: the launch made the ads (paused,
// per Kaizen's rules) and Meta's sync shows one turned on. The buyer can also complete it by hand. Completed tickets
// leave the board for the "Completed tasks" log, searchable and filtered by client, format and date, each opening
// read-only. Pure: tested in tests/ticket-completion.test.ts.

export type LaunchedAd = { adId: string | null; name: string };
export type AdStatus = { status?: string; effective_status?: string };

/** The launched ads Meta shows turned on (a test launch into the sandbox never completes a ticket) */
export function liveAds<T extends LaunchedAd>(ads: T[], statuses: Record<string, AdStatus | undefined> | null, sandbox = false): T[] {
  if (sandbox || !statuses) return [];
  return ads.filter((a) => a.adId && statuses[a.adId]?.status === "ACTIVE");
}

/** Should this ticket complete now: it waits in Ready to launch, its launch made ads, and one of them is live */
export function shouldAutoComplete(t: { stage: string; launchStatus: string | null; sandbox: boolean; liveAt: string | null }, live: number) {
  return t.stage === "ready_for_launch" && t.launchStatus === "launched" && !t.sandbox && !t.liveAt && live > 0;
}

/** A ticket is completed once it's launched (moved there by the system or by hand); completed_at says when, when it's known */
export const isCompleted = (t: { stage: string; completedAt?: string | null }) => t.stage === "launched" || Boolean(t.completedAt);

export type CompletedFilters = { q: string; client: string | null; format: "image" | "video" | "carousel" | null; range: "7" | "30" | "90" | "all" };

const RANGES = ["7", "30", "90", "all"] as const;
const FORMATS = ["image", "video", "carousel"] as const;

/** The log's filters from the address (?cq=&cclient=&cformat=&crange=), so back and a shared link keep them */
export function parseCompletedFilters(get: (k: string) => string | null): CompletedFilters {
  const range = get("crange");
  const format = get("cformat");
  return {
    q: (get("cq") ?? "").trim().slice(0, 100),
    client: get("cclient") || null,
    format: (FORMATS as readonly string[]).includes(format ?? "") ? (format as CompletedFilters["format"]) : null,
    range: (RANGES as readonly string[]).includes(range ?? "") ? (range as CompletedFilters["range"]) : "30",
  };
}

/** The earliest completion the range shows (null: all time) */
export function completedSince(range: CompletedFilters["range"], now = Date.now()): string | null {
  return range === "all" ? null : new Date(now - Number(range) * 86_400_000).toISOString();
}

export type CompletedRow = { number: number; title: string; clientName: string; clientSlug: string; format: string; completedAt: string };

/** The same filters on rows already loaded (the query does them in the database; this keeps the two in step) */
export function filterCompleted<T extends CompletedRow>(rows: T[], f: CompletedFilters, now = Date.now()): T[] {
  const since = completedSince(f.range, now);
  const q = f.q.toLowerCase().replace(/^#/, "");
  return rows
    .filter(
      (r) =>
        (!f.client || r.clientSlug === f.client) &&
        (!f.format || r.format === f.format) &&
        (!since || r.completedAt >= since) &&
        (!q || r.title.toLowerCase().includes(q) || r.clientName.toLowerCase().includes(q) || String(r.number).startsWith(q)),
    )
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

/** The search as a database filter: text in the title, or the ticket's number */
export function completedSearch(q: string): { title: string | null; number: number | null } {
  const t = q.trim().replace(/^#/, "");
  if (!t) return { title: null, number: null };
  return /^\d+$/.test(t) ? { title: null, number: Number(t) } : { title: t.replace(/[%_,()]/g, " ").trim(), number: null };
}
