// Finding a time for an internal call: everyone's busy blocks (Google FreeBusy), each person's working hours in their
// own timezone (Mon–Fri 9–6, New York, when we don't know better), the length asked for (30 minutes by default) and
// any window the asker gave ("tomorrow", "after 2pm" arrive here as days and times in the asker's timezone). Two or
// three options, spread out so they're real choices. Pure: no network, tested on its own.

export const DEFAULT_TZ = "America/New_York";
export const DEFAULT_MINUTES = 30;
/** Working hours as minutes after midnight, local to the person, and the weekdays they work (0 Sunday … 6 Saturday) */
export type Hours = { start: number; end: number; days: readonly number[] };
export const DEFAULT_HOURS: Hours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };

export type Busy = { start: number; end: number };
export type Person = { tz: string; busy: readonly Busy[]; hours?: Hours };

const MIN = 60_000;
const DAY_MS = 86_400_000;

/** A timezone's offset from UTC at an instant, in minutes (New York in winter: -300) */
export function tzOffset(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / MIN);
}

/** The instant a wall-clock time happens in a timezone ("2026-11-24", 14:00, New York → 19:00 UTC) */
export function zonedTime(day: string, minutes: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * MIN;
  // Twice, so a day that changes offset (daylight saving) lands right
  const first = guess - tzOffset(tz, guess) * MIN;
  return guess - tzOffset(tz, first) * MIN;
}

/** The local day (YYYY-MM-DD), weekday and minute of the day an instant falls on in a timezone */
export function localParts(at: number, tz: string): { day: string; weekday: number; minute: number } {
  const local = at + tzOffset(tz, at) * MIN;
  const d = new Date(local);
  return { day: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Whether [start, end) sits inside the person's working hours on one working day of theirs */
export function inWorkingHours(start: number, end: number, p: Pick<Person, "tz" | "hours">): boolean {
  const h = p.hours ?? DEFAULT_HOURS;
  const a = localParts(start, p.tz);
  const b = localParts(end - 1, p.tz);
  if (a.day !== b.day || !h.days.includes(a.weekday)) return false;
  return a.minute >= h.start && b.minute + 1 <= h.end;
}

export const overlaps = (a: Busy, b: Busy) => a.start < b.end && b.start < a.end;

export type SlotAsk = {
  people: readonly Person[];
  /** The asker's timezone: the window, earliest and latest are read in it */
  tz: string;
  /** First and last day to look at, YYYY-MM-DD in the asker's timezone */
  fromDay: string;
  toDay: string;
  minutes?: number;
  /** Not before / not after these times of day, minutes after midnight in the asker's timezone */
  earliest?: number | null;
  latest?: number | null;
  /** Nothing before this instant (now, plus a little to get ready) */
  notBefore: number;
  /** How far apart candidate starts are (30 minutes: on the hour and the half hour) */
  step?: number;
  max?: number;
};

/** Every start that works for everyone, in order */
export function freeStarts(ask: SlotAsk): number[] {
  const minutes = ask.minutes ?? DEFAULT_MINUTES;
  const step = (ask.step ?? 30) * MIN;
  const from = zonedTime(ask.fromDay, 0, ask.tz);
  const to = zonedTime(ask.toDay, 24 * 60, ask.tz);
  const out: number[] = [];
  // Starts on the step's grid (whole hours and half hours in UTC are whole and half hours nearly everywhere)
  let t = Math.ceil(Math.max(from, ask.notBefore) / step) * step;
  for (; t + minutes * MIN <= to && out.length < 2000; t += step) {
    const slot = { start: t, end: t + minutes * MIN };
    const mine = localParts(t, ask.tz);
    if (ask.earliest != null && mine.minute < ask.earliest) continue;
    if (ask.latest != null && localParts(slot.end - 1, ask.tz).minute + 1 > ask.latest) continue;
    if (!ask.people.every((p) => inWorkingHours(slot.start, slot.end, p) && !p.busy.some((b) => overlaps(b, slot)))) continue;
    out.push(t);
  }
  return out;
}

/**
 * Two or three real choices: the soonest, then the next ones on other days (or, on the same day, a couple of hours
 * apart), filling in from what's left when the days run out.
 */
export function pickOptions(starts: readonly number[], tz: string, max = 3): number[] {
  const picked: number[] = [];
  const day = (t: number) => localParts(t, tz).day;
  for (const t of starts) {
    if (picked.length >= max) break;
    if (picked.every((p) => day(p) !== day(t))) picked.push(t);
  }
  for (const t of starts) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p - t) >= 2 * 60 * MIN)) picked.push(t);
  }
  return picked.sort((a, b) => a - b);
}

export function findSlots(ask: SlotAsk): { start: number; end: number }[] {
  const minutes = ask.minutes ?? DEFAULT_MINUTES;
  return pickOptions(freeStarts(ask), ask.tz, ask.max ?? 3).map((start) => ({ start, end: start + minutes * MIN }));
}

/** "Tue, Nov 24, 2:00 PM" in a timezone (with its short name when asked: "2:00 PM EST") */
export function slotLabel(at: number, tz: string, withZone = false): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" } : {}) }).format(new Date(at));
}

/** An instant as Google wants it, with the timezone's offset ("2026-11-24T14:00:00-05:00") */
export function rfc3339(at: number, tz: string): string {
  const off = tzOffset(tz, at);
  const local = new Date(at + off * MIN).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** "14:00", "2pm", "2:30 PM" as minutes after midnight (null when it isn't a time) */
export function parseClock(v: unknown): number | null {
  const s = String(v ?? "").trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59 || h > 24) return null;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h * 60 + min;
}

/** A day and the next working days after it, as the default window (today and the next four working days) */
export function defaultWindow(today: string, workingDays = 5): { fromDay: string; toDay: string } {
  let t = Date.parse(`${today}T12:00:00Z`);
  let n = 0;
  let last = today;
  while (n < workingDays) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      n++;
      last = new Date(t).toISOString().slice(0, 10);
    }
    t += DAY_MS;
  }
  return { fromDay: today, toDay: last };
}

/** Busy blocks from a FreeBusy answer ("2026-11-24T15:00:00Z" pairs) */
export function busyOf(list: readonly { start: string; end: string }[] | undefined): Busy[] {
  return (list ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
}

/** Only teammates: an address on the asker's own domain */
export function sameDomain(a: string, b: string): boolean {
  const d = (x: string) => x.trim().toLowerCase().split("@")[1] ?? "";
  return Boolean(d(a)) && d(a) === d(b);
}

/** What Google's refusal means for the calendar: the scope isn't in domain-wide delegation yet */
export function calendarScopeMissing(message: string): boolean {
  return /unauthorized_client|access_denied|insufficient(?:Permissions| authentication scopes)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message);
}
