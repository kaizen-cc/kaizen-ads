import type { Move } from "@/lib/reports/weekly-core";
import { paceStatus, type PaceStatus } from "@/lib/reports/mtd-core";
import { int, money, moveOf, pct, signed, type EmailMetrics, type MtdFrame, type SocialMetrics } from "./core";

// A weekly email or social report's month to date, as one view the PDF draws and the writer reads: the month so far
// against the same days last month and, when the line has a monthly target, how it paces against it. Pure, so the PDF,
// the text and the tests say the same thing. Monthly and custom reports have no month to date.

export type MtdRow = { label: string; value: string; before: string; move: Move };
export type ChannelMtdView = {
  /** "May 1 – May 17" */
  range: string;
  /** What the headline number is ("Attributed revenue", "Reach") and its value */
  headline: { label: string; value: string };
  /** The month's target the headline paces against (the whole month's), with how much of it is done and how much of the month has gone */
  pace: { target: string; pctDone: number; pctElapsed: number; projected: string; status: PaceStatus; label: string } | null;
  /** Where the headline lands by month end at this rate, when there is no target to pace against */
  projected: { label: string; value: string } | null;
  rows: MtdRow[];
  /** One plain sentence on the pace (or on there being no target) */
  note: string;
  early: boolean;
  elapsed: number;
  daysInMonth: number;
  status: PaceStatus;
};

const STATUS_WORD: Record<PaceStatus, string> = { on: "On pace", over: "Ahead of pace", under: "Behind pace", early: "Early in the month", none: "No monthly target set" };

const earlyNote = (f: Pick<MtdFrame, "early" | "elapsed" | "daysInMonth">) => (f.early ? ` Early in the month (day ${f.elapsed} of ${f.daysInMonth}), so this will move.` : "");

type Cumulative = { label: string; value: number; projected: number | null; target: number | null; format: (n: number | null) => string };

/** A cumulative headline (revenue, reach) against its monthly target: the pace as a bar, the status and one sentence */
function paced(f: MtdFrame, h: Cumulative) {
  const status = h.projected != null ? paceStatus(h.projected, h.target, f.window.end) : "none";
  const done = h.target ? (h.value / h.target) * 100 : null;
  const note =
    h.target && h.projected != null
      ? `${h.format(h.value)} of the month's ${h.format(h.target)} ${h.label.toLowerCase()} target (${Math.round(done ?? 0)}%) with ${Math.round(f.pctElapsed)}% of the month gone. On track for ${h.format(h.projected)}${status === "over" ? ", ahead of target" : status === "under" ? ", short of target" : status === "on" ? ", in line with target" : " at this rate"}.${earlyNote(f)}`
      : `No monthly target set. ${h.format(h.value)} ${h.label.toLowerCase()} so far${h.projected != null ? `, ${h.format(h.projected)} by month end at this pace` : ""}.${earlyNote(f)}`;
  return {
    status,
    note,
    pace: h.target && h.projected != null && done != null ? { target: h.format(h.target), pctDone: Math.min(100, done), pctElapsed: f.pctElapsed, projected: h.format(h.projected), status, label: STATUS_WORD[status] } : null,
    projected: h.projected != null ? { label: "Projected month end", value: h.format(h.projected) } : null,
  };
}

/** The month to date of an email report (null on a monthly or an older report with none) */
export function emailMtdView(m: EmailMetrics): ChannelMtdView | null {
  const x = m.mtd;
  if (!x) return null;
  const c = m.currency;
  const { now, before } = x;
  const row = (label: string, a: number | null, b: number | null, f: (n: number | null) => string, better: "up" | "down" | "none" = "up"): MtdRow => ({ label, value: f(a), before: f(b), move: moveOf(a, b, better) });
  const rows: MtdRow[] = [
    ...(m.revenueMeasured === false ? [] : [row("Campaign revenue", now.campaignRevenue, before.campaignRevenue, (n) => money(n, c)), row("Flow revenue", now.flowRevenue, before.flowRevenue, (n) => money(n, c))]),
    row("Campaigns sent", now.campaignsSent, before.campaignsSent, int, "none"),
    row("Messages sent", now.sends, before.sends, int, "none"),
    row("Open rate", now.openRate, before.openRate, (n) => pct(n)),
    row("Click rate", now.clickRate, before.clickRate, (n) => pct(n, 2)),
    ...(now.share != null ? [{ label: "Share of store revenue", value: pct(now.share, 0), before: pct(before.share, 0), move: moveOf(now.share, before.share, "none") }] : []),
  ];
  const range = x.window.label;
  if (m.revenueMeasured === false) {
    const note = `${int(now.sends)} messages sent and ${int(now.campaignsSent)} campaigns so far this month; this source reports no revenue.${earlyNote(x)}`;
    return { range, headline: { label: "Messages sent", value: int(now.sends) }, pace: null, projected: null, rows, note, early: x.early, elapsed: x.elapsed, daysInMonth: x.daysInMonth, status: "none" };
  }
  const t = x.target && x.target.unit === "money" ? x.target.target : null;
  const p = paced(x, { label: "Attributed revenue", value: now.revenue, projected: x.projectedRevenue, target: t, format: (n) => money(n, c) });
  return { range, headline: { label: "Attributed revenue", value: money(now.revenue, c) }, pace: p.pace, projected: p.pace ? null : p.projected, rows, note: p.note, early: x.early, elapsed: x.elapsed, daysInMonth: x.daysInMonth, status: p.status };
}

/** The month to date of an organic social report (null on a monthly or an older report with none) */
export function socialMtdView(m: SocialMetrics): ChannelMtdView | null {
  const x = m.mtd;
  if (!x) return null;
  const { now, before } = x;
  const row = (label: string, a: number | null, b: number | null, f: (n: number | null) => string, better: "up" | "down" | "none" = "up"): MtdRow => ({ label, value: f(a), before: f(b), move: moveOf(a, b, better) });
  const rows: MtdRow[] = [
    row("Posts published", now.posts, before.posts, int),
    ...(m.insightsRead ? [row("Reach", now.reach, before.reach, int), row("Views", now.views, before.views, int), row("Engagement rate", now.rate, before.rate, (n) => pct(n)), row("Interactions", now.interactions, before.interactions, int)] : [row("Views", now.views, before.views, int)]),
    row("Follower change", now.followerChange, before.followerChange, signed),
  ];
  const range = x.window.label;
  // Reach is the one cumulative number with a monthly target to pace against
  const t = x.target && /reach/i.test(x.target.label) ? x.target.target : null;
  if (m.insightsRead && now.reach != null) {
    const p = paced(x, { label: "Reach", value: now.reach, projected: x.projectedReach, target: t, format: int });
    return { range, headline: { label: "Reach", value: int(now.reach) }, pace: p.pace, projected: p.pace ? null : p.projected, rows, note: p.note, early: x.early, elapsed: x.elapsed, daysInMonth: x.daysInMonth, status: p.status };
  }
  return { range, headline: { label: "Posts published", value: int(now.posts) }, pace: null, projected: null, rows, note: `${int(now.posts)} posts published so far this month.${earlyNote(x)}`, early: x.early, elapsed: x.elapsed, daysInMonth: x.daysInMonth, status: "none" };
}

export const channelMtdView = (m: EmailMetrics | SocialMetrics): ChannelMtdView | null => (m.platform === "klaviyo" ? emailMtdView(m) : socialMtdView(m));

/** The month to date as lines for the writer, the QA and the Slack text (empty when the report has none) */
export function channelMtdText(m: EmailMetrics | SocialMetrics): string[] {
  const v = channelMtdView(m);
  if (!v) return [];
  const same = m.mtd ? m.mtd.compare.label : "the same days last month";
  return [
    `Month to date (${v.range}, day ${v.elapsed} of ${v.daysInMonth}): ${v.headline.label} ${v.headline.value}. ${v.note}`,
    `Month to date against the same days last month (${same}): ${v.rows.map((r) => `${r.label} ${r.value} (before: ${r.before})`).join("; ")}.`,
    ...(v.status === "over" || v.status === "under" ? [`Pacing is ${STATUS_WORD[v.status].toLowerCase()}: mention it in one or two sentences in the message.`] : []),
  ];
}

export { STATUS_WORD as MTD_STATUS_WORD };
