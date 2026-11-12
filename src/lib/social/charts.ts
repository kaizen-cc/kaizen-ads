import { shiftDay } from "./core";
import { engagementRate, followerSeries, type DailyRow, type FollowerPoint } from "./insights";

// Numbers behind the Social Overview's charts. Pure, so they're tested without a browser.

export type DayPoint = { date: string; value: number | null };

/** Both platforms' followers added up per day (a day counts only when every platform with a series has a count for it) */
export function combineFollowers(series: FollowerPoint[][]): FollowerPoint[] {
  const live = series.filter((s) => s.some((p) => p.followers != null));
  if (!live.length) return [];
  const dates = live[0].map((p) => p.date);
  return dates.map((date, i) => {
    let total = 0;
    let est = false;
    for (const s of live) {
      const v = s[i]?.followers ?? null;
      if (v == null) return { date, followers: null, estimated: false };
      total += v;
      est = est || s[i].estimated;
    }
    return { date, followers: total, estimated: est };
  });
}

/** One field across platforms, per day from `from` to `to` (null where no platform had it that day) */
export function dailyTotal(rows: DailyRow[], key: "reach" | "views" | "interactions" | "gained" | "lost", from: string, to: string): DayPoint[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    if (v == null) continue;
    by.set(r.date, (by.get(r.date) ?? 0) + v);
  }
  const out: DayPoint[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push({ date: d, value: by.has(d) ? by.get(d)! : null });
  return out;
}

export type RatePoint = { date: string; rate: number | null; interactions: number; reach: number };

/**
 * Engagement rate by day, smoothed over the 7 days up to and including it (interactions over reach, both summed over
 * the window, so a quiet day doesn't jump to zero or a spike). Null while the window has no reach.
 */
export function rateSeries(rows: DailyRow[], from: string, to: string, window = 7): RatePoint[] {
  const start = shiftDay(from, -(window - 1));
  const inter = dailyTotal(rows, "interactions", start, to);
  const reach = dailyTotal(rows, "reach", start, to);
  const out: RatePoint[] = [];
  for (let i = window - 1; i < inter.length; i++) {
    let a = 0;
    let b = 0;
    for (let j = i - (window - 1); j <= i; j++) {
      a += inter[j].value ?? 0;
      b += reach[j].value ?? 0;
    }
    out.push({ date: inter[i].date, rate: engagementRate(a, b), interactions: a, reach: b });
  }
  return out;
}

/** The followers chart's series for one platform from its rows (the helper the page and the tests share) */
export const platformFollowers = (rows: DailyRow[], platform: DailyRow["platform"], today: string, current: number | null, days = 90) =>
  followerSeries(
    rows.filter((r) => r.platform === platform),
    { from: shiftDay(today, -(days - 1)), today, current, lossKnown: platform === "facebook" },
  );
