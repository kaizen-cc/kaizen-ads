// The routines (owner, Nov 24 2026): what an exec's Claude scheduled runs did, BAKED into Kaizen OS for everyone:
// every active team member gets each one at the standard times in their own time zone, scoped to what their role has,
// with no page and no settings (their assistant runs one on demand, and changes their times if they ask). The pure
// rules: the kinds, their default times, and when a run is due. Tested in tests/routines.test.ts.

export type RoutineKind = "debrief" | "morning" | "afternoon" | "eod" | "delegation" | "nightly" | "clean_sweep" | "week_recap" | "week_ahead" | "call_prep";
export type Days = "weekdays" | "daily" | "fri" | "sun";

export const ROUTINES: { kind: RoutineKind; label: string; about: string; times: string[]; days: Days; multi?: boolean }[] = [
  { kind: "clean_sweep", label: "Morning clean sweep", about: "Closes what you already did (only on proof), merges duplicates, and leaves only what you still have to do today", times: ["07:40"], days: "daily" },
  { kind: "morning", label: "Morning recap", about: "Overnight calls and messages, what's still open from yesterday, today's meetings with prep, and your top 3", times: ["08:45"], days: "weekdays" },
  { kind: "debrief", label: "Call debrief sweep", about: "Every call from Gemini and Fireflies: the team's commitments, sales calls into Sales, and your own action items", times: ["10:07", "12:07", "14:07", "16:07", "20:07"], days: "weekdays", multi: true },
  { kind: "afternoon", label: "Afternoon meeting recap", about: "Every meeting so far today: decisions, numbers, risks and who owes what; what's still to come", times: ["15:00"], days: "weekdays" },
  { kind: "eod", label: "End-of-day recap", about: "Meetings and messages since 3pm, what's still open tonight, and tomorrow's prep", times: ["18:00"], days: "weekdays" },
  { kind: "delegation", label: "Delegation tracker", about: "Every ask you made of a teammate in Slack today becomes an item they own", times: ["19:25"], days: "daily" },
  { kind: "nightly", label: "Nightly execution agent", about: "Works your open items overnight: drafts, briefs and staged tasks for you to review and send (never sends)", times: ["19:48"], days: "daily" },
  { kind: "week_recap", label: "Friday week recap", about: "Every open action this week ranked revenue-first, what you're waiting on, the week in numbers and risks", times: ["16:45"], days: "fri" },
  { kind: "week_ahead", label: "Sunday week-ahead prep", about: "Monday's meetings prepped, the week ahead, and what to do before Monday 9am", times: ["17:55"], days: "sun" },
  { kind: "call_prep", label: "Call prep", about: "A brief before every client and sales call on your calendar, and a check the afternoon before that every integration is connected", times: [], days: "daily" },
];
export const routineOf = (kind: string) => ROUTINES.find((r) => r.kind === kind) ?? null;
export const ROUTINE_KINDS = ROUTINES.map((r) => r.kind) as readonly RoutineKind[];

/** The date and minutes past midnight for an instant in a time zone (New York by default), and its weekday (0 Sunday) */
export function nyClock(now: Date, timeZone = "America/New_York"): { date: string; minutes: number; weekday: number } {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday };
}

const toMinutes = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const validTime = (t: string) => {
  const m = toMinutes(t);
  return m != null && m >= 0 && m < 24 * 60;
};

export function runsOn(days: Days, weekday: number): boolean {
  if (days === "daily") return true;
  if (days === "fri") return weekday === 5;
  if (days === "sun") return weekday === 0;
  return weekday >= 1 && weekday <= 5;
}

/** How late a run may still start after its time (a missed cron catches up, a day-old one doesn't) */
export const CATCH_UP_MIN = 150;

/**
 * The runs due now for one routine: each of its times today that has passed within the catch-up window, keyed so a run
 * happens once (profile · kind · date · time). The caller skips keys that already ran.
 */
export function dueRuns(r: { profileId: string; kind: string; times: readonly string[]; days: Days; enabled: boolean }, now: Date, timeZone?: string | null): string[] {
  if (!r.enabled) return [];
  const c = nyClock(now, timeZone ?? undefined);
  if (!runsOn(r.days, c.weekday)) return [];
  const out: string[] = [];
  for (const t of r.times) {
    const m = toMinutes(t);
    if (m == null) continue;
    if (c.minutes >= m && c.minutes - m <= CATCH_UP_MIN) out.push(runKey(r.profileId, r.kind, c.date, t));
  }
  // Only the latest slot that's due (two missed sweeps catch up as one)
  return out.slice(-1);
}

export const runKey = (profileId: string, kind: string, date: string, slot: string) => `${profileId}|${kind}|${date}|${slot}`;

/** Whether a run has anything to say (a recap with nothing in it is never sent) */
export const hasContent = (r: { sections: readonly { lines: readonly unknown[] }[]; urgent?: boolean }) => Boolean(r.urgent || r.sections.some((s) => s.lines.length));

/**
 * One row of a report (Mel, Nov 25 2026: every report is a scannable card): a short verb-first title, the client chip,
 * when it's due, and what the row does: open the item, send its drafted message, answer the agent's question inline,
 * or hand it off. The older fields (text, href, tag) stay so reports saved before still read.
 */
export type RecapAct = "open" | "send" | "answer" | "handoff";
export type RecapDraft = { kind: "slack" | "email"; text: string; channel?: string | null; canPost?: boolean; to?: string | null; subject?: string | null };
export type RecapLine = {
  text: string;
  href?: string | null;
  tag?: "certain" | "likely" | "guessing" | null;
  /** The agent_asks item behind the row, for its actions */
  itemId?: string | null;
  client?: string | null;
  /** YYYY-MM-DD, or a short time ("3pm") */
  due?: string | null;
  /** The longer words under the title (truncated in the card, expand to read) */
  detail?: string | null;
  act?: RecapAct | null;
  draft?: RecapDraft | null;
  question?: string | null;
};

export type RecapSection = { title: string; lines: RecapLine[] };
export type RoutineReport = { headline: string; sections: RecapSection[]; failedSources?: string[]; urgent?: boolean; /** Calls a debrief already read (it reads each once) */ processed?: string[] };

/** A report's first sentence, for the bell and the push (what the person must do first) */
export const pushLine = (r: RoutineReport) => r.headline.split(/(?<=[.!?])\s/)[0].slice(0, 200);

/** Where an item opens: its sheet on the Overview */
export const itemHref = (id: string) => `/pipeline?block=needs&item=${encodeURIComponent(`ask:${id}`)}`;

/** An item's title without the "[Agent 11/24] " tag a routine stamps on it */
export const plainTitle = (t: string) => t.replace(/^\[[^\]]{1,24}\]\s*/, "").trim();

/** The bell's body: each section with its count ("Only you can do 3 · Just hit send 2") */
export const sectionCounts = (r: Pick<RoutineReport, "sections">) =>
  r.sections
    .filter((s) => s.lines.length)
    .map((s) => `${s.title} ${s.lines.length}`)
    .join(" · ");

/** The short version for the assistant to say or write: the headline, then each section's count and its first rows */
export function shortReport(r: RoutineReport, per = 3) {
  return {
    headline: r.headline,
    sections: r.sections
      .filter((s) => s.lines.length)
      .map((s) => ({ title: s.title, count: s.lines.length, top: s.lines.slice(0, per).map((l) => [l.client ? `${l.client}: ` : "", l.text, l.due ? ` (due ${l.due})` : ""].join("")) })),
    ...(r.failedSources?.length ? { couldnt_read: r.failedSources } : {}),
  };
}

/** Due, said short: "today", "tomorrow", "overdue", "Dec 2", or a time as given */
export function dueLabel(due: string | null | undefined, today: string): { text: string; late: boolean } | null {
  if (!due) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(due)) return { text: due, late: false };
  const d = due.slice(0, 10);
  if (d < today) return { text: "overdue", late: true };
  if (d === today) return { text: "today", late: false };
  const next = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (d === next) return { text: "tomorrow", late: false };
  return { text: new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), late: false };
}
