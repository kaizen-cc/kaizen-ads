// A creative ticket's assignee and due date, edited right on the ticket like Asana (owner, Nov 26 2026). Plain module:
// the ticket sheet, the server actions and the assistant all use it.

const TZ = "America/New_York";

/** Who may change a ticket's assignee and due date: whoever moves it today (an exec, a lead, or the person it's with) */
export function mayEditTicket(me: { id: string; isExec?: boolean; isLead?: boolean } | null, assigneeId: string | null): boolean {
  if (!me) return false;
  return Boolean(me.isExec || me.isLead || (assigneeId && assigneeId === me.id));
}

/** "YYYY-MM-DDTHH:mm" in Eastern time for an instant (what a datetime-local input shows) */
export function toEtLocal(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** An Eastern wall-clock time ("YYYY-MM-DDTHH:mm") as an instant, daylight saving included */
export function fromEtLocal(v: string): string {
  const guess = new Date(`${v}:00Z`);
  // How far Eastern is from UTC at that moment, applied once (and once more across a DST change)
  const offset = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find((x) => x.type === "timeZoneName")?.value ?? "GMT-05:00";
    const m = p.match(/GMT([+-])(\d{2}):(\d{2})/);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -300;
  };
  let t = guess.getTime() - offset(guess) * 60_000;
  t = guess.getTime() - offset(new Date(t)) * 60_000;
  return new Date(t).toISOString();
}

/**
 * What someone typed or said as a due date, read as Eastern time: "2026-12-01" (5 PM that day), "2026-12-01 17:00" or
 * "2026-12-01T17:00". Null when it isn't a date.
 */
export function parseDue(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const hh = m[2] ? m[2].padStart(2, "0") : "17";
  const mm = m[3] ?? "00";
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  const iso = fromEtLocal(`${m[1]}T${hh}:${mm}`);
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export type DueChip = { key: "today" | "tomorrow" | "monday" | "week"; label: string; iso: string };

/**
 * The quick picks under the due date: Today, Tomorrow, Next Mon, +1 week. Each keeps the current due time of day
 * (5 PM when there's none); +1 week is a week after the current due date (or today).
 */
export function dueChips(now: Date, currentIso: string | null): DueChip[] {
  const cur = toEtLocal(currentIso);
  const time = cur ? cur.slice(11) : "17:00";
  const today = toEtLocal(now.toISOString()).slice(0, 10);
  const add = (ymd: string, days: number) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = add(today, ((8 - dow) % 7) || 7);
  const base = cur ? cur.slice(0, 10) : today;
  const at = (ymd: string) => fromEtLocal(`${ymd}T${time}`);
  return [
    { key: "today", label: "Today", iso: at(today) },
    { key: "tomorrow", label: "Tomorrow", iso: at(add(today, 1)) },
    { key: "monday", label: "Next Mon", iso: at(monday) },
    { key: "week", label: "+1 week", iso: at(add(base, 7)) },
  ];
}

/** Asana's due fields for an instant: due_at with the time (Asana keeps it in UTC) */
export function asanaDue(iso: string | null): { dueAt: string | null } {
  return { dueAt: iso ? new Date(iso).toISOString() : null };
}

/** The best match for a name or role the person said ("Jesus", "the video editor"): one, several, or none */
export function matchTeammate<T extends { id: string; name: string; role: string }>(people: T[], said: string): T[] {
  const q = said.trim().toLowerCase().replace(/^the\s+/, "");
  if (!q) return [];
  const exact = people.filter((p) => p.name.toLowerCase() === q);
  if (exact.length) return exact;
  const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === q.split(/\s+/)[0] && p.name.toLowerCase().includes(q));
  if (first.length) return first;
  const part = people.filter((p) => p.name.toLowerCase().includes(q));
  if (part.length) return part;
  return people.filter((p) => p.role.replace(/_/g, " ").toLowerCase() === q || p.role.replace(/_/g, " ").toLowerCase().includes(q));
}
