// The email and organic social KPI boards, as plain functions (no database, no browser) so they're tested on their own.
//   email   main KPI: Klaviyo-attributed revenue this month, paced to month end, against a monthly target
//   social  main KPI: engagement rate (interactions / reach) this month against a target rate
// The bands are the ads board's (src/lib/kpi/calc.ts): 20% better than target is "Crushing it", at target "On target",
// up to 15% under "Close", further under "Off target".

export type Line = "email" | "social";
export type ChannelStatus = "excellent" | "good" | "close" | "off" | "unset" | "setup" | "early";

export const METRIC: Record<Line, "attributed_revenue" | "engagement_rate"> = { email: "attributed_revenue", social: "engagement_rate" };
export const SERVICE: Record<Line, "email-marketing" | "social-media"> = { email: "email-marketing", social: "social-media" };

const DAY = 86_400_000;

export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

/** Today's date in New York (the app's clock for "this month") */
export const etToday = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export type Month = { today: string; start: string; dayOfMonth: number; daysInMonth: number; prevStart: string; prevEnd: string };

/** The calendar month today falls in, and the month before it */
export function monthOf(today: string): Month {
  const [y, m, d] = today.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prevEnd = shiftDay(start, -1);
  return { today, start, dayOfMonth: d, daysInMonth, prevStart: `${prevEnd.slice(0, 7)}-01`, prevEnd };
}

/** The first days of a month are too thin to judge a pace by */
export const EARLY_DAYS = 3;

/**
 * Where the month's revenue lands at this pace. Today counts as half a day: its row is only partly in. Null until a
 * day has passed (nothing to pace from).
 */
export function projectMonth(mtd: number, m: Pick<Month, "dayOfMonth" | "daysInMonth">): number | null {
  if (m.dayOfMonth < 1) return null;
  const elapsed = m.dayOfMonth - 0.5;
  return (mtd / elapsed) * m.daysInMonth;
}

/** How far through the month we are, 0 to 1 */
export const monthElapsed = (m: Pick<Month, "dayOfMonth" | "daysInMonth">) => Math.min(1, (m.dayOfMonth - 0.5) / m.daysInMonth);

/** A result against its target: above 1 is better than target (both KPIs read higher-is-better) */
export const ratioOf = (value: number | null, target: number | null | undefined): number | null => (value == null || target == null || target <= 0 ? null : value / target);

/** The ads board's bands for a higher-is-better KPI */
export function bandOf(ratio: number | null): "excellent" | "good" | "close" | "off" | null {
  if (ratio == null) return null;
  if (ratio >= 1.2) return "excellent";
  if (ratio >= 1) return "good";
  if (ratio >= 0.85) return "close";
  return "off";
}

export type EmailJudged = { status: ChannelStatus; projected: number | null; ratio: number | null };

/**
 * An email client's status. Not read yet is "setup"; no target is "unset" (numbers neutral); the first days of the
 * month are "early" unless the target is already met; then the projection against the target.
 */
export function judgeEmail(input: { readable: boolean; target: number | null; mtd: number; month: Month }): EmailJudged {
  const projected = projectMonth(input.mtd, input.month);
  if (!input.readable) return { status: "setup", projected: null, ratio: null };
  if (input.target == null || input.target <= 0) return { status: "unset", projected, ratio: null };
  // Already at the target: never "early"
  if (input.mtd >= input.target) return { status: bandOf(ratioOf(projected, input.target)) === "excellent" ? "excellent" : "good", projected, ratio: ratioOf(projected, input.target) };
  if (input.month.dayOfMonth <= EARLY_DAYS) return { status: "early", projected, ratio: null };
  const ratio = ratioOf(projected, input.target);
  return { status: bandOf(ratio) ?? "unset", projected, ratio };
}

export type SocialJudged = { status: ChannelStatus; ratio: number | null };

/** An engagement rate (interactions over reach); null without reach, so "no data" is never a zero */
export const engagement = (interactions: number | null | undefined, reach: number | null | undefined): number | null => (interactions != null && reach != null && reach > 0 ? interactions / reach : null);

/** Which window the rate is read over: the month so far, or the last 30 days while the month is too young to say */
export const socialBasis = (m: Pick<Month, "dayOfMonth">): "month" | "last30" => (m.dayOfMonth > 7 ? "month" : "last30");

export function judgeSocial(input: { readable: boolean; target: number | null; rate: number | null }): SocialJudged {
  if (!input.readable || input.rate == null) return { status: "setup", ratio: null };
  if (input.target == null || input.target <= 0) return { status: "unset", ratio: null };
  const ratio = ratioOf(input.rate, input.target);
  return { status: bandOf(ratio) ?? "unset", ratio };
}

/** The status's words and colors: the ads board's labels, plus "Early in the month" */
export const STATUS_LABEL: Record<ChannelStatus, string> = {
  excellent: "Crushing it",
  good: "On target",
  close: "Close",
  off: "Off target",
  unset: "No target set",
  setup: "Needs connecting",
  early: "Early in the month",
};

/** "12% under target" / "8% over target", from a ratio */
export function gapWords(ratio: number | null): string | null {
  if (ratio == null) return null;
  const n = Math.round(Math.abs(ratio - 1) * 100);
  if (n === 0) return "Right on target";
  return `${n}% ${ratio > 1 ? "above" : "below"} target`;
}

// ─── Who may set a target ──────────────────────────────────────────────────

export const HEAD_OF: Record<Line, string> = { email: "head_of_email", social: "head_of_social" };
export const LINE_SEAT_ROLES: Record<Line, string[]> = { email: ["email_strategist", "email_designer", "email_builder"], social: ["social_manager", "social_creative"] };

/** An exec, a lead, the line's head, or someone seated on the client in that line (`seats`: the roles they hold on it) */
export function canSetTarget(me: { role: string; isExec: boolean; isLead: boolean }, line: Line, seats: string[]): boolean {
  return me.isExec || me.isLead || me.role === HEAD_OF[line] || seats.some((s) => LINE_SEAT_ROLES[line].includes(s));
}

// ─── Formatting ────────────────────────────────────────────────────────────

export const moneyShort = (x: number | null | undefined, currency: string | null = "USD") => {
  if (x == null) return "n/a";
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  const a = Math.abs(x);
  const body = a >= 100_000 ? `${(a / 1000).toFixed(0)}k` : a >= 10_000 ? `${(a / 1000).toFixed(1)}k` : Math.round(a).toLocaleString("en-US");
  return `${x < 0 ? "-" : ""}${sym}${body}`;
};

export const pctText = (x: number | null | undefined, digits = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(digits)}%`);

/** An engagement target typed as percent ("3.5" or "3.5%", the field says %): stored as a fraction (0.035); null outside 0 to 100 */
export function parseRateTarget(raw: string): number | null {
  const n = Number(raw.replace(/[%\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return Math.round(n * 1000) / 100_000;
}

/** A revenue target typed as "$12,000" or "12k" */
export function parseRevenueTarget(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  const k = s.endsWith("k");
  const n = Number(k ? s.slice(0, -1) : s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * (k ? 1000 : 1));
}

// ─── Series for the charts ─────────────────────────────────────────────────

/** Running total of a month's days: one value per day from the first to `through`, a day with no row adding nothing */
export function cumulative(days: { date: string; value: number }[], start: string, through: string): number[] {
  const by = new Map(days.map((d) => [d.date, d.value]));
  const out: number[] = [];
  let sum = 0;
  for (let d = start; d <= through; d = shiftDay(d, 1)) {
    sum += by.get(d) ?? 0;
    out.push(sum);
  }
  return out;
}

/** Engagement rate per day over the 7 days up to it (a quiet day doesn't jump to zero); null while the window has no reach */
export function rollingRate(days: { date: string; interactions: number | null; reach: number | null }[], from: string, to: string, window = 7): (number | null)[] {
  const out: (number | null)[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    const lo = shiftDay(d, -(window - 1));
    let i = 0;
    let r = 0;
    for (const x of days) {
      if (x.date >= lo && x.date <= d) {
        i += x.interactions ?? 0;
        r += x.reach ?? 0;
      }
    }
    out.push(r > 0 ? i / r : null);
  }
  return out;
}

// ─── Who needs a look first ────────────────────────────────────────────────

export type RiskInput = {
  status: ChannelStatus;
  /** Where the client's numbers come from: not connected, failing and stale all leave the team blind */
  data: "connected" | "behind" | "pending" | "failing" | "missing";
  /** Days since the last email sent / post published; null when unknown */
  quietDays: number | null;
  /** Messages the team owes this client a reply on (Slack, email), and how many of those went past a second notice */
  owed: number;
  escalated: number;
};

export type Risk = { score: number; reasons: string[] };

/** Days with nothing sent or posted before it counts as gone quiet */
export const QUIET_AFTER: Record<Line, number> = { email: 14, social: 7 };

/**
 * A client's retention risk, higher first. Off target leads (a client not getting results leaves), then going blind
 * (a data connection that isn't working), a client gone quiet, and owed replies; close and unset targets weigh a
 * little; on target and ahead weigh nothing.
 */
export function riskOf(line: Line, r: RiskInput): Risk {
  let score = 0;
  const reasons: string[] = [];
  if (r.status === "off") {
    score += 100;
    reasons.push("Off target");
  } else if (r.status === "close") {
    score += 45;
    reasons.push("Close to target");
  }
  if (r.data === "failing") {
    score += 70;
    reasons.push("Data connection failing");
  } else if (r.data === "missing" || r.data === "pending") {
    score += 60;
    reasons.push(r.data === "pending" ? "First read pending" : line === "email" ? "Klaviyo not connected" : "Social not linked");
  } else if (r.data === "behind") {
    score += 30;
    reasons.push("Numbers are behind");
  }
  if (r.quietDays != null && r.quietDays >= QUIET_AFTER[line]) {
    score += 40 + Math.min(20, r.quietDays - QUIET_AFTER[line]);
    reasons.push(line === "email" ? `No email sent in ${r.quietDays} days` : `No post in ${r.quietDays} days`);
  }
  if (r.owed > 0) {
    score += 20 * Math.min(r.owed, 3) + (r.escalated ? 25 : 0);
    reasons.push(`${r.owed} ${r.owed === 1 ? "reply" : "replies"} owed`);
  }
  if (r.status === "unset") {
    score += 12;
    reasons.push("No target set");
  }
  return { score, reasons };
}

/** Worst first; clients with the same score by name */
export function orderByRisk<T extends { name: string; risk: Risk }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.risk.score - a.risk.score || a.name.localeCompare(b.name));
}

/** Rows ordered for the board: worst status first, then neutral ones, then the best */
const BOARD_RANK: Record<ChannelStatus, number> = { off: 0, close: 1, early: 2, good: 3, excellent: 4, unset: 5, setup: 6 };
export function orderForBoard<T extends { name: string; status: ChannelStatus; ratio: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => BOARD_RANK[a.status] - BOARD_RANK[b.status] || (a.ratio ?? 9) - (b.ratio ?? 9) || a.name.localeCompare(b.name));
}

/** Whole days between an ISO moment and today (null for none) */
export function daysSince(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  return Math.max(0, daysBetween(iso.slice(0, 10), today));
}

/** The seats a line's card names, in order: who is in charge first */
export const CREW_ORDER: Record<Line, readonly string[]> = { email: ["Strategist", "Designer", "Builder"], social: ["Strategist", "Graphic designer", "Video editor"] };

/** A seated person's seat, as the card names it (the social creative's second person is the video editor) */
export function crewSeat(role: string, primary: boolean): string {
  if (role === "email_strategist" || role === "social_manager") return "Strategist";
  if (role === "email_designer") return "Designer";
  if (role === "email_builder") return "Builder";
  if (role === "social_creative") return primary ? "Graphic designer" : "Video editor";
  return role;
}

/**
 * Who is on a client for a line, seat by seat: the people seated in the app, else the names the Account Overview sheet
 * gives (pending: not in the app yet, so not seated). A seat with neither is left out.
 */
export function crewOf(line: Line, seated: { seat: string; name: string }[], sheet: { seat: string; names: string[] }[] | null | undefined): { seat: string; name: string; pending: boolean }[] {
  const out: { seat: string; name: string; pending: boolean }[] = [];
  for (const seat of CREW_ORDER[line]) {
    const here = seated.filter((s) => s.seat === seat);
    if (here.length) for (const s of here) out.push({ seat, name: s.name, pending: false });
    else for (const name of (sheet ?? []).find((s) => s.seat === seat)?.names ?? []) out.push({ seat, name, pending: true });
  }
  return out;
}
