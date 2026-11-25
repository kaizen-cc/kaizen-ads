import { costOf, type Usage } from "@/lib/ai-costs";

// The daily AI spend (Settings › Calls & usage, the owner only; docs/API-COST.md): what each New York day cost, by
// agent and by place in the app, the 7-day average, the month's projection, and whether a day ran past twice the
// average (the owner is told). Pure, so it's tested without the database.

export type SpendRow = { day: string; agent_key: string; place: string; model: string; auto: boolean; runs: number; input: number; output: number; cache_w: number; cache_r: number; searches: number };
export type SpendLine = { key: string; agent: string; place: string; cost: number; runs: number; auto: boolean };
export type SpendSummary = {
  today: string;
  todayCost: number;
  /** The 7 full days before today, averaged */
  avg7: number;
  /** This month so far, today included */
  monthToDate: number;
  /** Month to date plus the 7-day average for every day left after today */
  projected: number;
  /** Share of the prompt read from the cache over the last 7 full days */
  cacheHit7: number;
  days: { day: string; cost: number }[];
  topToday: SpendLine[];
  top7: SpendLine[];
  byAgent7: { agent: string; cost: number; runs: number }[];
  /** A day (today so far, or yesterday) past twice the average of the 7 days before it */
  spike: { day: string; cost: number; avg: number } | null;
};

export const SPIKE_FACTOR = 2;

const usageOf = (r: SpendRow): Usage => ({ runs: Number(r.runs), failed: 0, input: Number(r.input), output: Number(r.output), cacheW: Number(r.cache_w), cacheR: Number(r.cache_r), searches: Number(r.searches) });
export const rowCost = (r: SpendRow) => costOf(r.model, usageOf(r));

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysInMonth = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** The average of the 7 days before this one (days with no runs count as nothing spent) */
function priorAvg(byDay: Map<string, number>, day: string) {
  let sum = 0;
  for (let i = 1; i <= 7; i++) sum += byDay.get(addDays(day, -i)) ?? 0;
  return sum / 7;
}

/** A day past twice the 7-day average before it, and worth telling (a few dollars over a tiny average isn't) */
export function isSpike(cost: number, avg: number, factor = SPIKE_FACTOR) {
  return avg > 0 && cost > factor * avg && cost - avg >= 20;
}

function top(rows: SpendRow[], n: number): SpendLine[] {
  const m = new Map<string, SpendLine>();
  for (const r of rows) {
    const key = `${r.agent_key}|${r.place}`;
    const l = m.get(key) ?? { key, agent: r.agent_key, place: r.place || r.agent_key, cost: 0, runs: 0, auto: r.auto };
    l.cost += rowCost(r);
    l.runs += Number(r.runs);
    l.auto = l.auto && r.auto;
    m.set(key, l);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost).slice(0, n);
}

/** rows: at least the last 38 days (the trend and each day's own average) */
export function summarize(rows: SpendRow[], today: string, trendDays = 30): SpendSummary {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(String(r.day).slice(0, 10), (byDay.get(String(r.day).slice(0, 10)) ?? 0) + rowCost(r));
  const avg7 = priorAvg(byDay, today);
  const todayCost = byDay.get(today) ?? 0;
  const month = today.slice(0, 7);
  const monthToDate = [...byDay.entries()].filter(([d]) => d.startsWith(month) && d <= today).reduce((s, [, c]) => s + c, 0);
  const left = daysInMonth(today) - Number(today.slice(8, 10));
  const days = Array.from({ length: trendDays }, (_, i) => addDays(today, i - trendDays + 1)).map((day) => ({ day, cost: byDay.get(day) ?? 0 }));
  const week = new Set(Array.from({ length: 7 }, (_, i) => addDays(today, -i - 1)));
  const rows7 = rows.filter((r) => week.has(String(r.day).slice(0, 10)));
  const prompt7 = rows7.reduce((s, r) => s + Number(r.input) + Number(r.cache_w) + Number(r.cache_r), 0);
  const agents = new Map<string, { agent: string; cost: number; runs: number }>();
  for (const r of rows7) {
    const a = agents.get(r.agent_key) ?? { agent: r.agent_key, cost: 0, runs: 0 };
    a.cost += rowCost(r);
    a.runs += Number(r.runs);
    agents.set(r.agent_key, a);
  }
  const yesterday = addDays(today, -1);
  const yCost = byDay.get(yesterday) ?? 0;
  const yAvg = priorAvg(byDay, yesterday);
  const spike = isSpike(todayCost, avg7) ? { day: today, cost: todayCost, avg: avg7 } : isSpike(yCost, yAvg) ? { day: yesterday, cost: yCost, avg: yAvg } : null;
  return {
    today,
    todayCost,
    avg7,
    monthToDate,
    projected: monthToDate + avg7 * left,
    cacheHit7: prompt7 ? rows7.reduce((s, r) => s + Number(r.cache_r), 0) / prompt7 : 0,
    days,
    topToday: top(rows.filter((r) => String(r.day).slice(0, 10) === today), 8),
    top7: top(rows7, 12),
    byAgent7: [...agents.values()].sort((a, b) => b.cost - a.cost),
    spike,
  };
}
