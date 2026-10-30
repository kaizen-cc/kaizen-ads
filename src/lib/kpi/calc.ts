import { MAIN_RESULTS, conversionFor, type Conversion } from "./conversions";

/** One day of an ad account (campaigns already filtered and summed). */
export type Day = {
  date: string; // YYYY-MM-DD
  spend: number;
  actions: Record<string, number>;
  values: Record<string, number>;
  linkClicks?: number;
  uniqueLinkClicks?: number;
};

export type Agg = { spend: number; results: number; value: number | null };
export type Status = "excellent" | "good" | "close" | "off" | "idle" | "setup";
export type Trend = "improving" | "steady" | "slipping";
export type Pacing = {
  spent: number;
  budget: number;
  expected: number;
  projected: number;
  pace: number; // projected / budget
  status: "over" | "on" | "under" | "early";
  dailyNeeded: number | null;
  daysLeft: number;
};

export type Snapshot = {
  dataThrough: string | null;
  windows: Record<"d3" | "d7" | "d14" | "d30" | "d60" | "d90", Agg>;
  months: Record<"mtd" | "lastMonth" | "qtd" | "lastQuarter", Agg>;
  deviation: number | null;
  vsMonth: number | null;
  vsQuarter: number | null;
  status: Status;
  trend: Trend | null;
  budget: Pacing | null;
  daily: { d: string; spend: number; results: number }[];
};

// Thresholds on the 14-day deviation from target (positive = worse than target)
export const BANDS = { excellent: -0.2, good: 0, close: 0.15 } as const;
const PACE_TOLERANCE = 0.1;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** A date's parts in New York, where the agency's day starts and ends. */
export function nyParts(now: Date) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, year: Number(p.year), month: Number(p.month), day: Number(p.day), hours: Number(p.hour) + Number(p.minute) / 60 };
}

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Which action type this account reports for the conversion (the first one with any results). */
export function pickType(days: Day[], conv: Conversion, custom?: string | null): string | null {
  if (conv.key === "custom") return custom ?? null;
  for (const t of conv.types ?? []) if (days.some((d) => (d.actions[t] ?? 0) > 0)) return t;
  return conv.types?.[0] ?? null;
}

export function resultsOf(day: Day, conv: Conversion, type: string | null) {
  if (conv.field === "unique_link_clicks") return day.uniqueLinkClicks ?? day.linkClicks ?? day.actions.link_click ?? 0;
  if (conv.field === "link_clicks") return day.linkClicks ?? day.actions.link_click ?? 0;
  return type ? (day.actions[type] ?? 0) : 0;
}

/** Sum a set of days. value = cost per result, or ROAS for a ROAS KPI. */
export function aggregate(days: Day[], conv: Conversion, type: string | null): Agg {
  let spend = 0;
  let results = 0;
  let revenue = 0;
  for (const d of days) {
    spend += d.spend;
    results += resultsOf(d, conv, type);
    if (conv.roas && type) revenue += d.values[type] ?? 0;
  }
  const value = conv.roas ? (spend ? revenue / spend : null) : results ? spend / results : null;
  return { spend: round(spend), results: round(results, 1), value: value == null ? null : round(value) };
}

/** How much worse than the reference a value is: +0.2 = 20% worse. Cost: higher is worse. ROAS: lower is worse. */
export function worseBy(value: number | null, reference: number | null | undefined, roas = false) {
  if (value == null || reference == null || reference === 0) return null;
  return round(roas ? (reference - value) / reference : (value - reference) / reference, 4);
}

export function statusFor(deviation: number | null, d14: Agg, hasTarget: boolean): Status {
  if (!hasTarget) return "setup";
  if (d14.spend === 0) return "idle";
  if (deviation == null) return "off"; // spending with no results
  if (deviation <= BANDS.excellent) return "excellent";
  if (deviation <= BANDS.good) return "good";
  if (deviation <= BANDS.close) return "close";
  return "off";
}

/** Budget pacing: month to date against where an even spend would be right now, and where the month lands. */
export function pacing(spent: number, budget: number | null | undefined, now: Date): Pacing | null {
  if (!budget || budget <= 0) return null;
  const t = nyParts(now);
  const total = daysIn(t.year, t.month);
  const elapsed = t.day - 1 + t.hours / 24;
  const expected = (budget * elapsed) / total;
  const projected = elapsed > 0 ? (spent / elapsed) * total : 0;
  const pace = projected / budget;
  const daysLeft = total - elapsed;
  return {
    spent: round(spent),
    budget,
    expected: round(expected),
    projected: round(projected),
    pace: round(pace, 3),
    // The first day and a half is too noisy to call
    status: elapsed < 1.5 ? "early" : pace > 1 + PACE_TOLERANCE ? "over" : pace < 1 - PACE_TOLERANCE ? "under" : "on",
    dailyNeeded: daysLeft > 0.5 ? round(Math.max(0, budget - spent) / daysLeft) : null,
    daysLeft: round(daysLeft, 1),
  };
}

/**
 * Everything the dashboard shows for one target.
 * Moving averages use complete days ending yesterday (today is still filling in); month and quarter to date include today.
 */
export function computeSnapshot(
  days: Day[],
  opts: { conversion: string; custom?: string | null; target: number | null; budget: number | null; now: Date },
): Snapshot {
  const conv = conversionFor(opts.conversion);
  const type = pickType(days, conv, opts.custom);
  const t = nyParts(opts.now);
  const today = t.date;
  const yesterday = shift(today, -1);
  const range = (from: string, to: string) => days.filter((d) => d.date >= from && d.date <= to);
  const win = (n: number) => aggregate(range(shift(yesterday, -(n - 1)), yesterday), conv, type);

  const monthStart = ymd(t.year, t.month, 1);
  const lastMonthStart = t.month === 1 ? ymd(t.year - 1, 12, 1) : ymd(t.year, t.month - 1, 1);
  const qStartMonth = Math.floor((t.month - 1) / 3) * 3 + 1;
  const quarterStart = ymd(t.year, qStartMonth, 1);
  const lastQuarterStart = qStartMonth === 1 ? ymd(t.year - 1, 10, 1) : ymd(t.year, qStartMonth - 3, 1);

  const windows = { d3: win(3), d7: win(7), d14: win(14), d30: win(30), d60: win(60), d90: win(90) };
  const months = {
    mtd: aggregate(range(monthStart, today), conv, type),
    lastMonth: aggregate(range(lastMonthStart, shift(monthStart, -1)), conv, type),
    qtd: aggregate(range(quarterStart, today), conv, type),
    lastQuarter: aggregate(range(lastQuarterStart, shift(quarterStart, -1)), conv, type),
  };
  const roas = Boolean(conv.roas);
  const deviation = worseBy(windows.d14.value, opts.target, roas);
  const recent = worseBy(windows.d3.value, windows.d14.value, roas);

  return {
    dataThrough: days.length ? days.map((d) => d.date).sort().at(-1)! : null,
    windows,
    months,
    deviation,
    vsMonth: worseBy(months.mtd.value, months.lastMonth.value, roas),
    vsQuarter: worseBy(months.qtd.value, months.lastQuarter.value, roas),
    status: statusFor(deviation, windows.d14, opts.target != null && opts.target > 0),
    trend: recent == null ? null : recent < -0.1 ? "improving" : recent > 0.1 ? "slipping" : "steady",
    budget: pacing(months.mtd.spend, opts.budget, opts.now),
    daily: range(shift(today, -29), today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ d: d.date, spend: round(d.spend), results: round(resultsOf(d, conv, type), 1) })),
  };
}

/**
 * Add up campaign rows into days, optionally only campaigns whose name contains `match`, and leaving out the campaigns
 * in `exclude` (ones the client runs themselves, that we're not on the hook for).
 */
export function toDays(
  rows: { date: string; campaign_id?: string; campaign_name?: string | null; spend: number | string; actions: Record<string, number>; action_values: Record<string, number>; link_clicks?: number | string; unique_link_clicks?: number | string }[],
  match?: string | null,
  exclude?: string[] | null,
  /** campaign id → the action types its own goal counts (for "each campaign's own goal"); Google uses conversions */
  goals?: Map<string, string[]>,
  platform = "meta",
): Day[] {
  const m = match?.trim().toLowerCase();
  const out = new Set(exclude ?? []);
  const byDate = new Map<string, Day>();
  // A Meta campaign whose goal isn't known yet: its strongest result over the whole period (MAIN_RESULTS), chosen once
  // per campaign so it's counted the same way every day
  const strongest = new Map<string, string>();
  if (goals && platform !== "google") {
    const seen = new Map<string, Set<string>>();
    for (const r of rows) if (r.campaign_id && !goals.has(String(r.campaign_id))) for (const [k, v] of Object.entries(r.actions ?? {})) if (Number(v) > 0) (seen.get(String(r.campaign_id)) ?? seen.set(String(r.campaign_id), new Set()).get(String(r.campaign_id))!).add(k);
    for (const [id, types] of seen) {
      const t = MAIN_RESULTS.find((x) => types.has(x));
      if (t) strongest.set(id, t);
    }
  }
  for (const r of rows) {
    if (m && !(r.campaign_name ?? "").toLowerCase().includes(m)) continue;
    if (r.campaign_id && out.has(String(r.campaign_id))) continue;
    const d = byDate.get(r.date) ?? { date: r.date, spend: 0, actions: {}, values: {}, linkClicks: 0, uniqueLinkClicks: 0 };
    d.spend += Number(r.spend) || 0;
    d.linkClicks! += Number(r.link_clicks) || 0;
    d.uniqueLinkClicks! += Number(r.unique_link_clicks) || 0;
    for (const [k, v] of Object.entries(r.actions ?? {})) d.actions[k] = (d.actions[k] ?? 0) + Number(v);
    // Each campaign's own result, summed as one action: the first of its goal's types this campaign reports
    // A campaign whose goal isn't known yet counts its strongest result; Google counts conversions
    const id = String(r.campaign_id);
    const own = goals?.get(id) ?? (platform === "google" ? ["conversions"] : strongest.has(id) ? [strongest.get(id)!] : undefined);
    const hit = own?.find((t) => r.actions?.[t] != null);
    if (hit) {
      d.actions.campaign_goal = (d.actions.campaign_goal ?? 0) + Number(r.actions[hit]);
      d.values.campaign_goal = (d.values.campaign_goal ?? 0) + Number(r.action_values?.[hit] ?? 0);
    }
    for (const [k, v] of Object.entries(r.action_values ?? {})) d.values[k] = (d.values[k] ?? 0) + Number(v);
    byDate.set(r.date, d);
  }
  return [...byDate.values()];
}
