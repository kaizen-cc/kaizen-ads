import { conversionValue } from "@/lib/kpi/conversion-value";
import type { Period, ReportMetrics } from "./metrics";

// Month to date on a weekly report: the month's first day through the report's last day, against the monthly budget the
// client is budgeted by (the budget is set by month, so this is where pacing is read). Pure, so it's tested and the PDF,
// the writer, the QA and the Slack text all say the same thing.

/** Over or under the budget by more than this and the pace is called (the KPI board's own tolerance) */
export const PACE_TOLERANCE = 0.1;
/** The first days of a month are too thin to judge a pace by: shown, with a note, never called */
export const EARLY_DAYS = 3;

export type PaceStatus = "on" | "under" | "over" | "early" | "none";

export type Pace = {
  /** Days of the month through the report's last day, and the month's length */
  elapsed: number;
  daysInMonth: number;
  pctElapsed: number;
  /** Spend over the monthly budget, % (null with no budget) */
  pctUsed: number | null;
  budget: number | null;
  spend: number;
  /** Where the month's spend lands at the current daily rate */
  projected: number | null;
  /** Projected spend over budget, % of budget (null with no budget) */
  projectedPct: number | null;
  status: PaceStatus;
  early: boolean;
  /** Spend per day that stays inside the budget for the rest of the month (null with no budget, or the month is over) */
  dailyLeft: number | null;
  /** A few words: "On pace", "Under pace", "Over pace", "No monthly budget set" */
  label: string;
  /** One plain sentence */
  note: string;
};

const r0 = (n: number) => Math.round(n);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const daysInMonthOf = (day: string) => {
  const d = new Date(`${day.slice(0, 8)}01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.getUTCDate();
};

/** How far through the month a report's last day is: days gone (that day counts whole), the month's length, % elapsed, and whether it is too early to call */
export function monthProgress(end: string) {
  const elapsed = Math.max(1, Number(end.slice(8, 10)) || 1);
  const daysInMonth = daysInMonthOf(end);
  return { elapsed, daysInMonth, pctElapsed: (elapsed / daysInMonth) * 100, early: elapsed <= EARLY_DAYS && elapsed < daysInMonth };
}

/** Where a month-to-date amount lands by month end at its daily rate so far */
export const projectMonthEnd = (value: number, end: string) => {
  const { elapsed, daysInMonth } = monthProgress(end);
  return value > 0 ? (value / elapsed) * daysInMonth : 0;
};

/** A projection against a monthly amount (budget or target): on, under or over by more than the tolerance; early in the month nothing is called */
export function paceStatus(projected: number, monthly: number | null | undefined, end: string): PaceStatus {
  if (!monthly || monthly <= 0) return "none";
  if (monthProgress(end).early) return "early";
  const ratio = projected / monthly;
  return ratio > 1 + PACE_TOLERANCE ? "over" : ratio < 1 - PACE_TOLERANCE ? "under" : "on";
}

/** Pacing for the month so far: `spend` from the 1st through `end` (a whole day, data is in for it) against the monthly budget */
export function monthPace(i: { spend: number; budget: number | null | undefined; end: string }): Pace {
  const { elapsed, daysInMonth, pctElapsed, early } = monthProgress(i.end);
  const spend = Number(i.spend) || 0;
  const budget = i.budget && i.budget > 0 ? i.budget : null;
  const projected = projectMonthEnd(spend, i.end);
  const left = daysInMonth - elapsed;
  const earlyNote = early ? ` Early in the month (day ${elapsed} of ${daysInMonth}), so this will move.` : "";
  if (!budget) {
    return { elapsed, daysInMonth, pctElapsed, pctUsed: null, budget: null, spend, projected, projectedPct: null, status: "none", early, dailyLeft: null, label: "No monthly budget set", note: `No monthly budget set. ${usd(spend)} spent so far, ${usd(projected)} by month end at this pace.${earlyNote}` };
  }
  const projectedPct = (projected / budget) * 100;
  const pctUsed = (spend / budget) * 100;
  const status = paceStatus(projected, budget, i.end);
  const gap = Math.abs(projectedPct - 100);
  const label = status === "over" ? "Over pace" : status === "under" ? "Under pace" : status === "on" ? "On pace" : "Early in the month";
  const base = `${usd(spend)} of the ${usd(budget)} monthly budget (${r0(pctUsed)}%) with ${r0(pctElapsed)}% of the month gone.`;
  const tail =
    status === "over" ? ` On track for ${usd(projected)}, about ${r0(gap)}% over budget.` : status === "under" ? ` On track for ${usd(projected)}, about ${r0(gap)}% under budget.` : status === "on" ? ` On track for ${usd(projected)}, in line with budget.` : ` On track for ${usd(projected)} at this rate.`;
  return { elapsed, daysInMonth, pctElapsed, pctUsed, budget, spend, projected, projectedPct, status, early, dailyLeft: left > 0 ? Math.max(0, (budget - spend) / left) : null, label, note: `${base}${tail}${earlyNote}` };
}

/** True when the pace is worth a sentence in the write-up: over or under by a meaningful margin, never early or without a budget */
export const paceMatters = (p: Pace) => p.status === "over" || p.status === "under";

export type MtdAds = {
  label: string;
  compareLabel: string | null;
  pace: Pace;
  period: Period;
  compare: Period | null;
  /** The result named the way the report names it ("Leads") */
  conversion: string;
  /** What the account is judged on here: cost per result, or ROAS */
  basis: "roas" | "cpr";
  /** ROAS to show: a ROAS KPI's, or Google's only when its conversion value looks real */
  roas: number | null;
  compareRoas: number | null;
  target: number | null;
  /** Against the KPI target: on, close to or off (null with no target or nothing to judge) */
  vsTarget: "on" | "close" | "off" | null;
};

type MtdInput = Pick<ReportMetrics, "mtd" | "mtdCompare" | "monthlyBudget" | "platform" | "roasKpi" | "target" | "conversion">;

/** What the month so far shows for an ad report, or null when the report has no month-to-date (monthly, custom) */
export function adsMtd(m: MtdInput): MtdAds | null {
  if (!m.mtd) return null;
  const pace = monthPace({ spend: m.mtd.spend, budget: m.monthlyBudget, end: m.mtd.end });
  const roasOf = (p: Period | null) => {
    if (!p) return null;
    if (m.platform === "google") return conversionValue({ spend: p.spend, conversions: p.results, value: p.revenue }).roas;
    return m.roasKpi ? p.roas : null;
  };
  const basis = m.roasKpi && m.mtd.roas != null ? "roas" : "cpr";
  const now = basis === "roas" ? m.mtd.roas : m.mtd.costPerResult;
  let vsTarget: MtdAds["vsTarget"] = null;
  if (m.target != null && m.target > 0 && now != null) {
    const ratio = basis === "roas" ? now / m.target : m.target / now; // above 1 is better than target either way
    vsTarget = ratio >= 1 ? "on" : ratio >= 0.85 ? "close" : "off";
  }
  return { label: m.mtd.label, compareLabel: m.mtdCompare?.label ?? null, pace, period: m.mtd, compare: m.mtdCompare && m.mtdCompare.spend > 0 ? m.mtdCompare : null, conversion: m.conversion, basis, roas: roasOf(m.mtd), compareRoas: roasOf(m.mtdCompare), target: m.target, vsTarget };
}

export const TARGET_WORD = { on: "on target", close: "close to target", off: "off target" } as const;

/** The month so far as lines for the writer, the QA, the Slack text and the assistant (empty when there is none) */
export function adsMtdText(m: MtdInput): string[] {
  const x = adsMtd(m);
  if (!x) return [];
  const $ = (n: number | null) => (n == null ? "n/a" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const p = x.period;
  const unit = x.conversion.toLowerCase();
  const out = [`Month to date (${x.label}): ${x.pace.note}`];
  const results = `${p.results} ${unit}${p.costPerResult != null ? ` at ${$(p.costPerResult)} each` : ""}${x.roas != null ? `, ROAS ${x.roas}x` : ""}`;
  const target = x.target != null && x.vsTarget ? ` (${x.basis === "roas" ? `${x.target}x target` : `${$(x.target)} target`}: ${TARGET_WORD[x.vsTarget]})` : "";
  out.push(`Month to date results: ${results}${target}.`);
  if (x.compare) out.push(`Same days last month (${x.compareLabel}): ${$(x.compare.spend)} spent, ${x.compare.results} ${unit}${x.compare.costPerResult != null ? ` at ${$(x.compare.costPerResult)} each` : ""}${x.compareRoas != null ? `, ROAS ${x.compareRoas}x` : ""}.`);
  if (x.pace.status === "none") out.push("No monthly budget is set for this account: say pacing can't be judged and suggest setting one; never invent a budget.");
  else if (paceMatters(x.pace)) out.push(`Pacing is ${x.pace.label.toLowerCase()}: mention it in one or two sentences in the message.`);
  return out;
}
