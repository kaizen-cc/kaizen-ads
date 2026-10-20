import type { Period, ReportMetrics } from "./metrics";

// How a report's numbers read, the same in the PDF and on the live report page: money, counts, the change against the
// comparison period (green when better: for costs lower is better, spend is neither), and the KPI tiles.

export type Tone = "good" | "bad" | "flat";
export type Delta = { text: string; tone: Tone };
export type Tile = { label: string; value: string; sub: string | null; delta: Delta | null; now: number | null; before: number | null };

export const money = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "–";
  const big = Math.abs(n) >= 1000;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 })}`;
};
export const count = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));
export const percent = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}%`);
export const multiple = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}x`);

/** "Leads" → "lead", for "cost per lead". */
export const singular = (conversion: string) => conversion.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");

/** The change from `before` to `now`, as a percent. `better`: which way is good ("up", "down", or neither). */
export function delta(now: number | null | undefined, before: number | null | undefined, better: "up" | "down" | "none"): Delta | null {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return { text: "No change", tone: "flat" };
  const up = pct > 0;
  const tone: Tone = better === "none" ? "flat" : up === (better === "up") ? "good" : "bad";
  return { text: `${up ? "+" : "-"}${Math.abs(rounded)}%`, tone };
}

const hasRevenue = (m: ReportMetrics) => m.main.revenue > 0 || m.compare.revenue > 0;

/** The four headline tiles: spend, results (with their cost), CTR, and ROAS when there's revenue (else cost per result). */
export function headlineTiles(m: ReportMetrics, main: Period = m.main, compare: Period = m.compare): Tile[] {
  const one = singular(m.conversion);
  const tiles: Tile[] = [
    { label: "Spend", value: money(main.spend), sub: null, delta: delta(main.spend, compare.spend, "none"), now: main.spend, before: compare.spend },
    { label: m.conversion, value: count(main.results), sub: main.costPerResult != null ? `${money(main.costPerResult)} per ${one}` : null, delta: delta(main.results, compare.results, "up"), now: main.results, before: compare.results },
    { label: "Click-through rate", value: percent(main.ctr), sub: main.clicks ? `${count(main.clicks)} link clicks` : null, delta: delta(main.ctr, compare.ctr, "up"), now: main.ctr, before: compare.ctr },
  ];
  if (hasRevenue(m)) tiles.push({ label: "ROAS", value: multiple(main.roas), sub: `${money(main.revenue)} revenue`, delta: delta(main.roas, compare.roas, "up"), now: main.roas, before: compare.roas });
  else tiles.push({ label: `Cost per ${one}`, value: money(main.costPerResult), sub: m.target != null && !m.roasKpi ? `Target ${money(m.target)}` : null, delta: delta(main.costPerResult, compare.costPerResult, "down"), now: main.costPerResult, before: compare.costPerResult });
  return tiles;
}

/** The monthly conversion summary: results, cost per result, revenue and ROAS, this month against last. */
export function conversionTiles(m: ReportMetrics): Tile[] {
  const one = singular(m.conversion);
  const tiles: Tile[] = [
    { label: m.conversion, value: count(m.main.results), sub: `${count(m.compare.results)} in ${m.compare.label}`, delta: delta(m.main.results, m.compare.results, "up"), now: m.main.results, before: m.compare.results },
    { label: `Cost per ${one}`, value: money(m.main.costPerResult), sub: `${money(m.compare.costPerResult)} in ${m.compare.label}`, delta: delta(m.main.costPerResult, m.compare.costPerResult, "down"), now: m.main.costPerResult, before: m.compare.costPerResult },
  ];
  if (hasRevenue(m)) {
    tiles.push({ label: "Revenue", value: money(m.main.revenue), sub: `${money(m.compare.revenue)} in ${m.compare.label}`, delta: delta(m.main.revenue, m.compare.revenue, "up"), now: m.main.revenue, before: m.compare.revenue });
    tiles.push({ label: "ROAS", value: multiple(m.main.roas), sub: `${multiple(m.compare.roas)} in ${m.compare.label}`, delta: delta(m.main.roas, m.compare.roas, "up"), now: m.main.roas, before: m.compare.roas });
  } else {
    tiles.push({ label: "Spend", value: money(m.main.spend), sub: `${money(m.compare.spend)} in ${m.compare.label}`, delta: delta(m.main.spend, m.compare.spend, "none"), now: m.main.spend, before: m.compare.spend });
  }
  return tiles;
}

export type KpiRow = { label: string; now: string; before: string; delta: Delta | null; target: string };

/** The monthly KPI table: this month, last month, the change, and the target where the KPI has one. */
export function kpiRows(m: ReportMetrics): KpiRow[] {
  const a = m.main;
  const b = m.compare;
  const row = (label: string, f: (n: number | null) => string, x: number | null, y: number | null, better: "up" | "down" | "none", target = "–"): KpiRow => ({ label, now: f(x), before: f(y), delta: delta(x, y, better), target });
  return [
    row("Spend", money, a.spend, b.spend, "none", m.monthlyBudget != null ? `${money(m.monthlyBudget)} budget` : "–"),
    row("CTR", percent, a.ctr, b.ctr, "up"),
    row("CPC", money, a.cpc, b.cpc, "down"),
    row("CPM", money, a.cpm, b.cpm, "down"),
    row(m.conversion, count, a.results, b.results, "up"),
    row(`Cost per ${singular(m.conversion)}`, money, a.costPerResult, b.costPerResult, "down", m.target != null && !m.roasKpi ? money(m.target) : "–"),
    row("ROAS", multiple, a.roas, b.roas, "up", m.target != null && m.roasKpi ? multiple(m.target) : "–"),
  ];
}

export const platformName = (p: "meta" | "google") => (p === "google" ? "Google Ads" : "Meta Ads");

/** "Oct 12-18", "Sep 28-Oct 4": a short period for file names. */
export function shortRange(start: string, end: string) {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return start.slice(0, 7) === end.slice(0, 7) ? `${f(start, { month: "short", day: "numeric" })}-${f(end, { day: "numeric" })}` : `${f(start, { month: "short", day: "numeric" })}-${f(end, { month: "short", day: "numeric" })}`;
}

/** "September 2026". */
export const monthLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A Content-Disposition that survives any client name. */
export function pdfDisposition(name: string, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
