// Deeper email history on demand, as plain functions (no network, no database): when a report or the KPI sheet asks for
// dates before what is stored, which stretch is missing, how it is read in pieces and what the progress line says. The
// stored history starts where the first read left it (about 90 days); anything earlier is read from the provider only
// when somebody asks for it.

/** How far back a history read ever goes (the provider APIs keep about this much) */
export const HISTORY_MAX_DAYS = 730;
/** A read that has not moved for this long is taken as dead and picked up again */
export const HISTORY_STALE_MS = 15 * 60_000;

export type HistoryStatus = "queued" | "running" | "done" | "failed";
export type HistoryState = {
  status: HistoryStatus;
  /** The first day asked for (the start of the month the report starts in) */
  want: string;
  /** The last day to read (the day before the stored history began) */
  to: string;
  /** The oldest day read so far (null before the first piece lands); everything from here to `to` is stored */
  cursor: string | null;
  pct: number;
  step: string;
  at: string;
  error?: string | null;
  /** Who asked: a report, the KPI sheet or the client's card */
  asked?: "report" | "kpi" | "card";
};

export const historySource = (clientId: string) => `email-history:${clientId}`;

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The stretch missing for a range that starts at `wantStart`: from the start of that month to the day before what is
 * stored (or what an earlier read already covered, even when it found nothing there). Null when the range is inside
 * what is stored, or nothing is stored yet (the first read still has to land). `floor` is the earliest day worth reading
 * (the client's start, never more than HISTORY_MAX_DAYS back).
 */
export function historyGap(i: { wantStart: string; stored: string | null; covered?: string | null; today: string; floor?: string | null }): { from: string; to: string } | null {
  if (!i.stored) return null;
  const have = i.covered && i.covered < i.stored ? i.covered : i.stored;
  // A range that starts inside what's stored is missing nothing
  if (i.wantStart >= have) return null;
  const limit = [shift(i.today, -(HISTORY_MAX_DAYS - 1)), i.floor ? monthStart(i.floor) : null].filter((x): x is string => Boolean(x)).sort().at(-1)!;
  const from = [monthStart(i.wantStart), limit].sort().at(-1)!;
  if (from >= have) return null;
  return { from, to: shift(have, -1) };
}

/** "Mar to Aug" (with the year when the stretch crosses one: "Nov 2025 to Feb 2026"), or "Mar" for one month */
export function stretchLabel(from: string, to: string): string {
  const name = (d: string, year: boolean) => `${MONTHS[Number(d.slice(5, 7)) - 1]}${year ? ` ${d.slice(0, 4)}` : ""}`;
  const crosses = from.slice(0, 4) !== to.slice(0, 4);
  if (from.slice(0, 7) === to.slice(0, 7)) return name(from, crosses);
  return `${name(from, crosses)} to ${name(to, crosses)}`;
}

/** The line a report shows while the missing months are read */
export const readingLine = (provider: string, from: string, to: string) => `Reading ${stretchLabel(from, to)} history from ${provider}...`;

/** Windows of at most `days` days from `to` back to `from`, newest first (the newest are the likeliest to be asked for) */
export function historyWindows(from: string, to: string, days = 45): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let end = to; end >= from; end = shift(end, -days)) {
    const start = shift(end, -(days - 1));
    out.push({ start: start < from ? from : start, end });
  }
  return out;
}

/** Whether a stored state still holds up the reports it covers: queued or running (and not dead) */
export function historyBusy(s: Pick<HistoryState, "status" | "at"> | null | undefined, now = Date.now()): boolean {
  if (!s) return false;
  if (s.status === "queued") return true;
  return s.status === "running" && now - Date.parse(s.at) < HISTORY_STALE_MS;
}

/** Whether a report starting on `start` waits for this read (it covers that day, or is about to) */
export const historyHolds = (s: HistoryState | null | undefined, start: string, now = Date.now()) => historyBusy(s, now) && monthStart(start) >= s!.want && start <= s!.to;
