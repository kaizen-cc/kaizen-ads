// The Overview for heads of a service line and their team, as plain functions (no database, no browser) so they're
// tested on their own (tests/overview-desk.test.ts):
//   mineFirst        the person's own accounts first, then the rest of their team's, each worst first (retention risk)
//   auditReminders   what of the audits and sprints needs a head: critical ones and ones gone stale. The strategist who
//                    owns the account sees all of theirs; a head sees only these reminders
//   ideaPriority     a campaign idea as critical (a send gap, a missing core flow, a revenue drop, a holiday about to be
//                    missed, a launch the client raised that sends soon), worth doing, or nice to have (fun days)

import { orderByRisk, type Risk } from "@/lib/channel-kpis/calc";

const DAY = 86_400_000;
const dayNum = (d: string) => Date.parse(`${d.slice(0, 10)}T12:00:00Z`);
/** Whole days from one ISO day (or moment) to another */
export const daysFrom = (from: string, to: string) => Math.round((dayNum(to) - dayNum(from)) / DAY);

// ─── Clients: mine first, then the team's ─────────────────────────────────

/** The person's own accounts (a seat on them) first, then the rest of their team's; worst first inside each */
export function mineFirst<T extends { name: string; mine: boolean; risk: Risk }>(rows: T[]): { mine: T[]; team: T[] } {
  return { mine: orderByRisk(rows.filter((r) => r.mine)), team: orderByRisk(rows.filter((r) => !r.mine)) };
}

// ─── Audits and sprints: only what needs a head ──────────────────────────

/** An audit or sprint with no move ticked for this long has gone stale */
export const STALE_DAYS = 10;
/** A red audit with no sprint started and nothing ticked this long after it ran is critical */
export const RED_GRACE_DAYS = 3;
/** A sprint whose score fell this many points under where it started is critical */
export const SPRINT_DROP = 5;

export type DeskAudit = {
  id: string;
  status: "running" | "ready" | "failed";
  score: number | null;
  band: "good" | "watch" | "bad" | null;
  headline: string | null;
  createdAt: string;
  actions: number;
  done: number;
  /** When the last move was ticked (null for none) */
  lastTickAt: string | null;
};
export type DeskSprint = {
  id: string;
  score: number | null;
  baseline: number | null;
  moves: number;
  done: number;
  startedAt: string;
  lastDoneAt: string | null;
  nextCheckAt: string | null;
  /** Ads sprints: the last check said it's getting worse or the move was wrong (in plain words), else null */
  worse?: string | null;
};

export type Reminder = {
  clientId: string;
  kind: "audit" | "sprint";
  id: string;
  /** critical and stale reach a head; open is everything else the owner works through */
  level: "critical" | "stale" | "open";
  why: string;
  /** Days since anything moved (for the order inside a level) */
  idle: number;
  score: number | null;
  band: "good" | "watch" | "bad" | null;
  headline: string | null;
  progress: { done: number; of: number };
};

const LEVEL_RANK: Record<Reminder["level"], number> = { critical: 0, stale: 1, open: 2 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One client's audit and sprint read as a reminder, or null when there's nothing open on it */
export function reminderFor(clientId: string, audit: DeskAudit | null, sprint: DeskSprint | null, now: string): Reminder | null {
  if (sprint) {
    const last = [sprint.startedAt, sprint.lastDoneAt].filter(Boolean).sort().at(-1)!;
    const idle = Math.max(0, daysFrom(last, now));
    const base = { clientId, kind: "sprint" as const, id: sprint.id, idle, score: sprint.score, band: audit?.band ?? null, headline: audit?.headline ?? null, progress: { done: sprint.done, of: sprint.moves } };
    if (sprint.worse) return { ...base, level: "critical", why: sprint.worse };
    if (sprint.score != null && sprint.baseline != null && sprint.baseline - sprint.score >= SPRINT_DROP) return { ...base, level: "critical", why: `Score fell ${sprint.baseline - sprint.score} points since the sprint began` };
    if (sprint.moves > sprint.done && idle >= STALE_DAYS) return { ...base, level: "stale", why: sprint.done ? `No move ticked in ${plural(idle, "day")}` : `Sprint started ${plural(idle, "day")} ago, nothing ticked` };
    if (sprint.moves > sprint.done) return { ...base, level: "open", why: `${sprint.done} of ${sprint.moves} moves done` };
    return null;
  }
  if (!audit || audit.status === "running") return null;
  const last = [audit.createdAt, audit.lastTickAt].filter(Boolean).sort().at(-1)!;
  const idle = Math.max(0, daysFrom(last, now));
  const base = { clientId, kind: "audit" as const, id: audit.id, idle, score: audit.score, band: audit.band, headline: audit.headline, progress: { done: audit.done, of: audit.actions } };
  if (audit.status === "failed") return { ...base, level: "critical", why: "The audit didn't finish" };
  const open = audit.actions > audit.done;
  if (audit.band === "bad" && audit.done === 0 && idle >= RED_GRACE_DAYS) return { ...base, level: "critical", why: `Red audit ${plural(idle, "day")} old, no sprint and nothing ticked` };
  if (open && idle >= STALE_DAYS) return { ...base, level: "stale", why: audit.done ? `No move ticked in ${plural(idle, "day")}` : `Untouched for ${plural(idle, "day")}` };
  if (open && audit.band !== "good") return { ...base, level: "open", why: `${audit.done} of ${audit.actions} moves ticked` };
  return null;
}

/**
 * The reminders for a set of clients (or ad accounts: `clientId` is whatever the audits and sprints are keyed by). A head (`head`) gets only the critical and stale ones: the rest is the
 * strategist's to work through on their own Overview and the board. Critical first, then stale, the longest idle first.
 */
export function auditReminders(clients: { clientId: string }[], audits: Map<string, DeskAudit>, sprints: Map<string, DeskSprint>, now: string, opts: { head: boolean }): Reminder[] {
  const out: Reminder[] = [];
  for (const c of clients) {
    const r = reminderFor(c.clientId, audits.get(c.clientId) ?? null, sprints.get(c.clientId) ?? null, now);
    if (r && (!opts.head || r.level !== "open")) out.push(r);
  }
  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.idle - a.idle || (a.score ?? 101) - (b.score ?? 101));
}

// ─── Campaign ideas: critical first ──────────────────────────────────────

export type IdeaInput = {
  origin: "performance" | "calendar" | "slack" | "email" | "call";
  title: string;
  idea: string;
  why: string | null;
  evidence?: string[];
  sendOn: string | null;
};
export type IdeaTier = "critical" | "worth" | "nice" | "missed";
export type IdeaPriority = { tier: IdeaTier; reason: string; daysLeft: number | null };

/** A holiday about to be missed counts as critical this many days out */
export const HOLIDAY_WINDOW = 21;
/** A launch or promo the client raised counts as critical this many days out */
export const MENTION_WINDOW = 14;

const MAJOR =
  /\b(black friday|cyber (monday|week)|bfcm|thanksgiving|christmas|xmas|hanukkah|chanukah|kwanzaa|new year'?s?|valentine'?s?|mother'?s day|father'?s day|easter|memorial day|labor day|independence day|fourth of july|4th of july|july 4(th)?|halloween|small business saturday|giving tuesday|boxing day|back[- ]to[- ]school|prime day|holiday (sale|gift|season|shopping|rush|weekend)|the holidays|st\.? patrick'?s|cinco de mayo|super bowl|graduation|last (shipping|order) day)\b/i;
const FUN = /\b(national|international|world)\b[\w\s'&-]{1,40}\bday\b|\b\w+ (awareness|appreciation) (day|week|month)\b/i;
const SEND_GAP = /\b(send gap|gone quiet|went quiet|no (campaigns?|emails?|sends?) (in|for|since)|haven'?t (sent|emailed)|hasn'?t (sent|emailed)|nothing (sent|went out)|days since (the )?last (send|campaign|email)|last (send|campaign|email) was)\b/i;
const CORE_FLOW = /\b(welcome( series| flow)?|abandon(ed)? (cart|checkout|browse)|cart abandon\w*|checkout abandon\w*|browse abandon\w*|post[- ]purchase|win[- ]?back|sunset flow)\b/i;
const MISSING = /\b(missing|no |not (live|running|set up|on)|isn'?t (live|running|set up|on)|aren'?t (live|running)|turned off|paused|never (built|set up)|set up|build (the|a|out)|turn on|switch on)/i;
const DROP = /\b(revenue|sales|orders|open rates?|click rates?|conversions?|placed orders?)\b[^.]{0,40}\b(drop(ped|s)?|down|fell|fall(ing)?|declin\w*|slid|slipp\w*|dipp?\w*|sank|lower)\b|\b(drop|decline|dip|fall|slide)\b[^.]{0,20}\b(in|of) (revenue|sales|orders)\b/i;

/** How much an idea matters: critical first, then worth doing, then nice to have; a send day already gone is missed */
export function ideaPriority(s: IdeaInput, today: string): IdeaPriority {
  const daysLeft = s.sendOn ? daysFrom(today, s.sendOn) : null;
  const text = `${s.title}\n${s.idea}\n${s.why ?? ""}\n${(s.evidence ?? []).join("\n")}`;
  const head = `${s.title}\n${s.idea}`;
  if (daysLeft != null && daysLeft < 0) return { tier: "missed", reason: "The send day passed", daysLeft };
  const when = daysLeft == null ? "" : daysLeft === 0 ? " · sends today" : ` · ${daysLeft === 1 ? "1 day" : `${daysLeft} days`} left`;
  if (SEND_GAP.test(text)) return { tier: "critical", reason: `Closes a send gap${when}`, daysLeft };
  if (CORE_FLOW.test(head) && MISSING.test(text)) return { tier: "critical", reason: "A core flow is missing", daysLeft };
  if (DROP.test(text)) return { tier: "critical", reason: `Answers a revenue drop${when}`, daysLeft };
  const fun = FUN.test(s.title);
  if (!fun && MAJOR.test(head) && daysLeft != null && daysLeft <= HOLIDAY_WINDOW) return { tier: "critical", reason: daysLeft === 0 ? "A holiday, sends today" : `A holiday in ${daysLeft === 1 ? "1 day" : `${daysLeft} days`}`, daysLeft };
  const asked = s.origin === "slack" || s.origin === "email" || s.origin === "call";
  if (asked && daysLeft != null && daysLeft <= MENTION_WINDOW) return { tier: "critical", reason: `The client raised it${when}`, daysLeft };
  if (fun) return { tier: "nice", reason: "A fun day on the calendar", daysLeft };
  if (asked) return { tier: "worth", reason: "The client raised it", daysLeft };
  if (s.origin === "performance") return { tier: "worth", reason: "Built on what past sends proved", daysLeft };
  if (MAJOR.test(head)) return { tier: "worth", reason: daysLeft == null ? "A holiday coming up" : `A holiday in ${daysLeft} days`, daysLeft };
  if (s.origin === "calendar") return { tier: "nice", reason: "A moment on the calendar", daysLeft };
  return { tier: "worth", reason: "Worth a send", daysLeft };
}

const TIER_RANK: Record<IdeaTier, number> = { critical: 0, worth: 1, nice: 2, missed: 3 };

/** Ideas with their priority, critical first; inside a tier the soonest send day first (undated last) */
export function prioritizeIdeas<T extends IdeaInput>(ideas: T[], today: string): (T & { priority: IdeaPriority })[] {
  return ideas
    .map((s) => ({ ...s, priority: ideaPriority(s, today) }))
    .sort((a, b) => TIER_RANK[a.priority.tier] - TIER_RANK[b.priority.tier] || (a.priority.daysLeft ?? 9999) - (b.priority.daysLeft ?? 9999) || a.title.localeCompare(b.title));
}

// ─── The ads and creative lines: what's hurting first ────────────────────

export type AdsRiskInput = {
  /** The KPI board's status for the account */
  status: "excellent" | "good" | "close" | "off" | "idle" | "setup" | "unset";
  /** 14 days against target, positive is worse (0.3 = 30% worse) */
  deviation: number | null;
  /** Budget pacing: over or under where an even spend would be */
  pacing: "over" | "under" | "check" | null;
  /** setup only: an ad account is linked but can't be read (else none is linked yet) */
  hasAccount: boolean;
  owed?: number;
  escalated?: number;
};

/**
 * An ad account's retention risk, higher first (the email and social boards' scale): off target leads and weighs more
 * the further off it is, then an account we can't read, close, pacing that's off, not spending, no KPI set.
 */
export function adsRisk(r: AdsRiskInput): Risk {
  let score = 0;
  const reasons: string[] = [];
  const off = r.deviation != null && r.deviation > 0 ? Math.round(r.deviation * 100) : null;
  if (r.status === "off") {
    score += 100 + Math.min(60, off ?? 0);
    reasons.push(off != null ? `${off}% off target` : "Off target");
  } else if (r.status === "close") {
    score += 45;
    reasons.push("Close to target");
  } else if (r.status === "setup") {
    score += 60;
    reasons.push(r.hasAccount ? "Can't read the account" : "No ad account yet");
  } else if (r.status === "idle") {
    score += 20;
    reasons.push("Not spending");
  } else if (r.status === "unset") {
    score += 12;
    reasons.push("No KPI set");
  }
  if (r.pacing) {
    score += 25;
    reasons.push(r.pacing === "over" ? "Spending over pace" : r.pacing === "under" ? "Spending under pace" : "Check the budget");
  }
  if (r.owed) {
    score += 20 * Math.min(r.owed, 3) + (r.escalated ? 25 : 0);
    reasons.push(`${r.owed} ${r.owed === 1 ? "reply" : "replies"} owed`);
  }
  return { score, reasons };
}

/** A creative client's risk from its allotment pace (src/lib/home.ts's tone and note) and what waits on them */
export function creativeRisk(r: { tone: string; note: string; waiting: number; revisionsPerItem: number }): Risk {
  const reasons: string[] = [];
  let score = 0;
  if (r.tone === "bad") {
    score += 100;
    reasons.push(r.note);
  } else if (r.tone === "warn") {
    score += 45;
    reasons.push(r.note);
  }
  if (r.revisionsPerItem >= 2 && !reasons.includes("Revision-heavy")) {
    score += 20;
    reasons.push("Revision-heavy");
  }
  if (r.waiting > 0) {
    score += Math.min(3, r.waiting) * 5;
    reasons.push(`${r.waiting} with the client`);
  }
  return { score, reasons };
}

/** A suggested brief's priority by what raised it: an account off target, an unhappy client or what was promised come first */
const BRIEF_CRITICAL: Record<string, string> = { kpi: "The account is off target", unhappy: "The client is unhappy", call: "Promised on a call", offer: "A new offer to launch", pacing: "Spend is off pace" };
const BRIEF_NICE = new Set(["market", "pattern", "idea", "lab", "moment"]);
export function briefPriority(kind: string, clientRisk = 0): { tier: "critical" | "worth" | "nice"; reason: string } {
  if (BRIEF_CRITICAL[kind]) return { tier: "critical", reason: BRIEF_CRITICAL[kind] };
  // Ads wearing out on an account that's already slipping can't wait
  if ((kind === "fatigue" || kind === "refresh" || kind === "flop") && clientRisk >= 100) return { tier: "critical", reason: "Ads wearing out on an account off target" };
  if (BRIEF_NICE.has(kind)) return { tier: "nice", reason: kind === "moment" ? "A moment on the calendar" : "Worth a test" };
  return { tier: "worth", reason: kind === "fatigue" || kind === "refresh" ? "Ads wearing out" : kind === "onboarding" ? "A new client's first round" : "Worth doing" };
}
