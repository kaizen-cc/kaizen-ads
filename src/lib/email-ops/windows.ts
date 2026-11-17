// The email account sheet's Numbers: revenue and the key email numbers over every window (7 to 90 days, this and last
// month, this and last quarter), each judged against the month's revenue target at the same daily pace (or the score's
// bar for a rate), and the last 30 days day by day for the trend chart. Pure (calendar days as YYYY-MM-DD in the
// account's own days), so it is tested without a database.

export type EmailDay = { d: string; revenue: number; campaignRevenue: number; flowRevenue: number; recipients: number; orders: number; storeRevenue: number | null };
/** One campaign sent, by the day it went out: what the rates are read from */
export type SentCampaign = { d: string; recipients: number; delivered: number; opens: number; clicks: number };

export type WindowKey = "d7" | "d14" | "d30" | "d60" | "d90" | "mtd" | "lastMonth" | "qtd" | "lastQuarter";
export const ROLLING: WindowKey[] = ["d7", "d14", "d30", "d60", "d90"];
export const CALENDAR: WindowKey[] = ["mtd", "lastMonth", "qtd", "lastQuarter"];
export const WINDOW_LABEL: Record<WindowKey, string> = { d7: "7 days", d14: "14 days", d30: "30 days", d60: "60 days", d90: "90 days", mtd: "This month", lastMonth: "Last month", qtd: "This quarter", lastQuarter: "Last quarter" };

export type WindowNumbers = {
  key: WindowKey;
  from: string;
  to: string;
  days: number;
  /** Days in the window the account has numbers for (fewer than `days`: read only from `dataFrom`) */
  covered: number;
  revenue: number;
  campaignRevenue: number;
  flowRevenue: number;
  recipients: number;
  orders: number;
  /** Revenue per recipient across campaigns and flows */
  rpr: number | null;
  /** Email campaigns sent in the window: unique opens over delivered, unique clicks over delivered */
  openRate: number | null;
  clickRate: number | null;
  sent: number;
  /** The month's target at the same daily pace, for the days in the window */
  target: number | null;
};

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
export const shiftDay = (d: string, n: number) => new Date(at(d) + n * DAY).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((at(to) - at(from)) / DAY) + 1;
export const daysInMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();

/** Each window's first and last day, as of `today` */
export function windowRanges(today: string): Record<WindowKey, { from: string; to: string }> {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const q = Math.floor(m / 3) * 3;
  return {
    d7: { from: shiftDay(today, -6), to: today },
    d14: { from: shiftDay(today, -13), to: today },
    d30: { from: shiftDay(today, -29), to: today },
    d60: { from: shiftDay(today, -59), to: today },
    d90: { from: shiftDay(today, -89), to: today },
    mtd: { from: iso(y, m, 1), to: today },
    lastMonth: { from: iso(y, m - 1, 1), to: iso(y, m, 0) },
    qtd: { from: iso(y, q, 1), to: today },
    lastQuarter: { from: iso(y, q - 3, 1), to: iso(y, q, 0) },
  };
}

/** The earliest day any window reads (last quarter's first day, or 90 days back when that's earlier) */
export function earliestDay(today: string): string {
  const r = windowRanges(today);
  return r.lastQuarter.from < r.d90.from ? r.lastQuarter.from : r.d90.from;
}

/** The month's revenue target spread evenly over its days, for `days` days */
export function targetFor(monthTarget: number | null, today: string, days: number): number | null {
  if (monthTarget == null || !(monthTarget > 0)) return null;
  return Math.round((monthTarget / daysInMonth(today)) * days * 100) / 100;
}

export function windowNumbers(input: { today: string; days: EmailDay[]; campaigns: SentCampaign[]; monthTarget: number | null }): Record<WindowKey, WindowNumbers> {
  const ranges = windowRanges(input.today);
  const out = {} as Record<WindowKey, WindowNumbers>;
  for (const key of [...ROLLING, ...CALENDAR]) {
    const { from, to } = ranges[key];
    const ds = input.days.filter((x) => x.d >= from && x.d <= to);
    const cs = input.campaigns.filter((x) => x.d >= from && x.d <= to);
    const sum = (f: (x: EmailDay) => number) => Math.round(ds.reduce((t, x) => t + f(x), 0) * 100) / 100;
    const revenue = sum((x) => x.revenue);
    const recipients = ds.reduce((t, x) => t + x.recipients, 0);
    const delivered = cs.reduce((t, x) => t + (x.delivered || x.recipients), 0);
    const days = span(from, to);
    out[key] = {
      key,
      from,
      to,
      days,
      covered: new Set(ds.map((x) => x.d)).size,
      revenue,
      campaignRevenue: sum((x) => x.campaignRevenue),
      flowRevenue: sum((x) => x.flowRevenue),
      recipients,
      orders: Math.round(ds.reduce((t, x) => t + x.orders, 0)),
      rpr: recipients > 0 ? revenue / recipients : null,
      openRate: delivered > 0 ? cs.reduce((t, x) => t + x.opens, 0) / delivered : null,
      clickRate: delivered > 0 ? cs.reduce((t, x) => t + x.clicks, 0) / delivered : null,
      sent: cs.length,
      target: targetFor(input.monthTarget, input.today, days),
    };
  }
  return out;
}

/** How far a number is from what it is judged against, with higher better: +0.2 is 20% over, -0.1 is 10% under */
export function gapOf(value: number | null | undefined, target: number | null | undefined): number | null {
  if (value == null || target == null || !(target > 0)) return null;
  return value / target - 1;
}

/** The tone of a gap, the way the boards colour: at or over is good, up to 15% under is close, more is off */
export function gapTone(gap: number | null): "ok" | "warn" | "bad" | null {
  if (gap == null) return null;
  return gap >= 0 ? "ok" : gap >= -0.15 ? "warn" : "bad";
}

/** This month against last month and this quarter against last, each per day (so a month in progress compares fairly) */
export function momentum(w: Record<WindowKey, WindowNumbers>): { vsMonth: number | null; vsQuarter: number | null } {
  const perDay = (x: WindowNumbers) => (x.covered > 0 ? x.revenue / x.days : null);
  const rate = (a: number | null, b: number | null) => (a == null || b == null || b <= 0 ? null : a / b - 1);
  const full = (x: WindowNumbers) => x.covered >= Math.max(1, x.days - 2);
  return {
    vsMonth: full(w.lastMonth) ? rate(perDay(w.mtd), perDay(w.lastMonth)) : null,
    vsQuarter: full(w.lastQuarter) ? rate(perDay(w.qtd), perDay(w.lastQuarter)) : null,
  };
}

export type TrendMetric = "revenue" | "rpr" | "orders" | "recipients";
export type TrendPoint = { d: string; value: number | null; avg: number | null; revenue: number; recipients: number; orders: number };

/**
 * The last `n` days of one number for the trend chart, with its 7-day average (the line), empty days as zero. Revenue
 * per recipient is the day's revenue over its recipients (null on a day nothing went out), its average over the 7 days.
 */
export function trendSeries(days: EmailDay[], today: string, metric: TrendMetric, n = 30): TrendPoint[] {
  const by = new Map(days.map((x) => [x.d, x]));
  const all: EmailDay[] = [];
  for (let i = n + 5; i >= 0; i--) {
    const d = shiftDay(today, -i);
    all.push(by.get(d) ?? { d, revenue: 0, campaignRevenue: 0, flowRevenue: 0, recipients: 0, orders: 0, storeRevenue: null });
  }
  const pick = (x: EmailDay) => (metric === "revenue" ? x.revenue : metric === "orders" ? x.orders : metric === "recipients" ? x.recipients : x.recipients > 0 ? x.revenue / x.recipients : null);
  return all.slice(-n).map((x) => {
    const i = all.indexOf(x);
    const win = all.slice(Math.max(0, i - 6), i + 1);
    let avg: number | null;
    if (metric === "rpr") {
      const r = win.reduce((t, y) => t + y.recipients, 0);
      avg = r > 0 ? win.reduce((t, y) => t + y.revenue, 0) / r : null;
    } else avg = win.reduce((t, y) => t + (pick(y) ?? 0), 0) / win.length;
    return { d: x.d, value: pick(x), avg, revenue: x.revenue, recipients: x.recipients, orders: x.orders };
  });
}
