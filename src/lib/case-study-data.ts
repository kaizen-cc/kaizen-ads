// The numbers behind a client case study, month by month, from the synced daily rows (never typed by anyone): each ad
// account's spend, results by its KPI's conversion and the value of those results (ROAS where there's revenue), plus
// email revenue from their email platform and the store's own revenue. Pure part: rolling daily rows into months.

export type DailyRow = { date: string; spend?: number | string | null; actions?: Record<string, number> | null; action_values?: Record<string, number> | null };
export type MonthPoint = { month: string; spend: number; results: number; value: number };

/**
 * Daily rows as months, oldest first. A result counts under the first of the conversion's types a row has (Meta books
 * one purchase under several types at once, so they're never added together), and its value the same way.
 */
export function monthlySeries(rows: readonly DailyRow[], types: readonly string[]): MonthPoint[] {
  const by = new Map<string, MonthPoint>();
  for (const r of rows) {
    const month = String(r.date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const m = by.get(month) ?? { month, spend: 0, results: 0, value: 0 };
    m.spend += Number(r.spend) || 0;
    const t = types.find((x) => Number(r.actions?.[x]) > 0);
    if (t) m.results += Number(r.actions?.[t]) || 0;
    const v = types.find((x) => Number(r.action_values?.[x]) > 0);
    if (v) m.value += Number(r.action_values?.[v]) || 0;
    by.set(month, m);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ month: m.month, spend: round(m.spend), results: round(m.results), value: round(m.value) }));
}

const round = (n: number) => Math.round(n * 100) / 100;

/** "2026-06" → "Jun" (and the year when the series crosses one) */
export function monthLabel(month: string, withYear = false): string {
  const d = new Date(`${month}-15T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", ...(withYear ? { year: "2-digit" } : {}), timeZone: "UTC" });
}

/** The months as plain lines for the writer: spend, results, cost per result, value and ROAS when there's value */
export function seriesText(label: string, series: readonly MonthPoint[], resultWord: string): string {
  if (!series.length) return "";
  const lines = series.map((m) => {
    const cpr = m.results ? m.spend / m.results : null;
    const roas = m.value && m.spend ? m.value / m.spend : null;
    return `- ${m.month}: spend $${m.spend.toFixed(0)}, ${m.results.toFixed(0)} ${resultWord}${cpr != null ? ` at $${cpr.toFixed(2)} each` : ""}${m.value ? `, value $${m.value.toFixed(0)}` : ""}${roas != null ? `, ROAS ${roas.toFixed(2)}x` : ""}`;
  });
  return `<${label}>\n${lines.join("\n")}\n</${label}>`;
}
