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

/**
 * ROAS (and revenue) show by default only on a ROAS KPI with purchase value. A report judged on bookings, leads or
 * applications shows its own result and its cost: purchase value there is a side number the buyer can still add as a
 * tile, row or column, never put in front of the client on its own.
 */
export const hasRevenue = (m: Pick<ReportMetrics, "roasKpi" | "main" | "compare">) => Boolean(m.roasKpi) && (m.main.revenue > 0 || m.compare.revenue > 0);

/** The four headline tiles: spend, results (with their cost), CTR, and ROAS on a ROAS KPI with revenue (else cost per result). */
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
    ...(m.roasKpi ? [row("ROAS", multiple, a.roas, b.roas, "up", m.target != null ? multiple(m.target) : "–")] : []),
  ];
}

export const platformName = (p: string) => (p === "google" ? "Google Ads" : p === "tiktok" ? "TikTok Ads" : "Meta Ads");

/** "Oct 12-18", "Sep 28-Oct 4": a short period for file names. */
export function shortRange(start: string, end: string) {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return start.slice(0, 7) === end.slice(0, 7) ? `${f(start, { month: "short", day: "numeric" })}-${f(end, { day: "numeric" })}` : `${f(start, { month: "short", day: "numeric" })}-${f(end, { month: "short", day: "numeric" })}`;
}

/** "3:05 PM" / "Mon 3:05 PM" in New York time: pinned so the server (UTC) and the browser (local) draw the same text. */
export const clockTime = (at: Date | string, weekday = false) =>
  new Date(at).toLocaleString("en-US", { ...(weekday ? { weekday: "short" as const } : {}), hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** "September 2026". */
export const monthLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A Content-Disposition that survives any client name. */
export function pdfDisposition(name: string, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ─── The report's layout: which metrics the buyer chose ─────────────────────

/** Every number a report can show, in a tile, a row of the key metrics table, or a column of the campaign table */
export const METRIC_KEYS = ["spend", "results", "cost_per_result", "revenue", "roas", "ctr", "clicks", "cpc", "cpm", "impressions", "views_6s", "hook_rate"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
/** Only TikTok reports have video views and hook rates */
export const TIKTOK_ONLY: readonly MetricKey[] = ["views_6s", "hook_rate"];
/** The metrics a report on this platform can show */
export const metricKeysFor = (platform: string | null | undefined): MetricKey[] => METRIC_KEYS.filter((k) => platform === "tiktok" || !TIKTOK_ONLY.includes(k));

/**
 * What the buyer changed in a report's structure (kept on the report, and on its KPI as the client's layout for the
 * next one). tiles: the headline tiles; table: the key metrics rows; columns: the campaign table's columns;
 * campaigns: lines taken out or added by name (the rest are the biggest spenders).
 */
/** campaigns.results: a campaign's result picked by hand (its name → the action type it counts), for accounts where
 *  campaigns run for different conversions */
/** notes: the weekly's narrative (headline, summary, what we did, what's next) printed in the PDF too; off by default, as
 *  it travels in the Slack or email message that carries the report */
export type ReportLayout = { tiles?: MetricKey[]; table?: MetricKey[]; columns?: MetricKey[]; campaigns?: { hide?: string[]; add?: string[]; results?: Record<string, string> }; notes?: boolean };

type Nums = { spend: number; results: number; costPerResult: number | null; revenue?: number; roas: number | null; ctr: number | null; clicks?: number; cpc?: number | null; cpm?: number | null; impressions?: number; views6s?: number; hookRate?: number | null };

export function metricLabel(m: Pick<ReportMetrics, "conversion">, k: MetricKey, short = false) {
  const one = singular(m.conversion);
  return { spend: "Spend", results: m.conversion, cost_per_result: short ? `Per ${one}` : `Cost per ${one}`, revenue: "Revenue", roas: "ROAS", ctr: short ? "CTR" : "Click-through rate", clicks: "Link clicks", cpc: "CPC", cpm: "CPM", impressions: "Impressions", views_6s: short ? "6s views" : "6-second views", hook_rate: "Hook rate" }[k];
}

export const BETTER: Record<MetricKey, "up" | "down" | "none"> = { spend: "none", results: "up", cost_per_result: "down", revenue: "up", roas: "up", ctr: "up", clicks: "up", cpc: "down", cpm: "down", impressions: "up", views_6s: "up", hook_rate: "up" };

export function metricNumber(p: Nums, k: MetricKey): number | null {
  const v = { spend: p.spend, results: p.results, cost_per_result: p.costPerResult, revenue: p.revenue ?? null, roas: p.roas, ctr: p.ctr, clicks: p.clicks ?? null, cpc: p.cpc ?? null, cpm: p.cpm ?? null, impressions: p.impressions ?? null, views_6s: p.views6s ?? null, hook_rate: p.hookRate ?? null }[k];
  return v == null || !Number.isFinite(v) ? null : v;
}

export function metricText(p: Nums, k: MetricKey) {
  return formatMetric(k, metricNumber(p, k));
}

/** A number as its metric shows it ($, %, x or a count) */
export function formatMetric(k: MetricKey, n: number | null) {
  if (["spend", "cost_per_result", "revenue", "cpc", "cpm"].includes(k)) return money(n);
  if (k === "roas") return multiple(n);
  if (k === "ctr" || k === "hook_rate") return percent(n);
  return count(n);
}

/** The tiles a report shows now: the buyer's choice, else what it shows by default (weekly and built: headline; monthly: conversions) */
export function tileKeys(m: ReportMetrics, layout: ReportLayout | null | undefined, monthly: boolean): MetricKey[] {
  if (layout?.tiles?.length) return layout.tiles;
  // TikTok: spend, conversions and their cost, and how well the video hooks (6-second views over impressions)
  if (m.platform === "tiktok") return monthly ? ["results", "cost_per_result", ...(hasRevenue(m) ? (["roas"] as const) : (["spend"] as const)), "hook_rate"] : ["spend", "results", "cost_per_result", "hook_rate"];
  return monthly ? ["results", "cost_per_result", ...(hasRevenue(m) ? (["revenue", "roas"] as const) : (["spend"] as const))] : ["spend", "results", "ctr", hasRevenue(m) ? "roas" : "cost_per_result"];
}

export function tilesFor(m: ReportMetrics, keys: MetricKey[], main: Period = m.main, compare: Period = m.compare): Tile[] {
  return keys.map((k) => {
    const sub =
      k === "results" && main.costPerResult != null ? `${money(main.costPerResult)} per ${singular(m.conversion)}` : k === "ctr" && main.clicks ? `${count(main.clicks)} link clicks` : k === "roas" && main.revenue ? `${money(main.revenue)} revenue` : k === "cost_per_result" && m.target != null && !m.roasKpi ? `Target ${money(m.target)}` : `${metricText(compare, k)} in ${compare.label}`;
    return { label: metricLabel(m, k), value: metricText(main, k), sub, delta: delta(metricNumber(main, k), metricNumber(compare, k), BETTER[k]), now: metricNumber(main, k), before: metricNumber(compare, k) };
  });
}

export const TABLE_DEFAULT: MetricKey[] = ["spend", "ctr", "cpc", "cpm", "results", "cost_per_result", "roas"];

/** The key metrics rows a report shows now: the buyer's choice, else the default (ROAS only when it's the KPI) */
export function tableKeys(m: Pick<ReportMetrics, "roasKpi"> & { platform?: string }, layout: ReportLayout | null | undefined): MetricKey[] {
  if (layout?.table?.length) return layout.table;
  return [...TABLE_DEFAULT, ...(m.platform === "tiktok" ? TIKTOK_ONLY : [])].filter((k) => k !== "roas" || m.roasKpi);
}

/** The key metrics rows for the chosen metrics, with the target where the KPI has one */
export function rowsFor(m: ReportMetrics, keys: MetricKey[]): KpiRow[] {
  return keys.map((k) => ({
    label: metricLabel(m, k, true).replace(/^Per /, "Cost per "),
    now: metricText(m.main, k),
    before: metricText(m.compare, k),
    delta: delta(metricNumber(m.main, k), metricNumber(m.compare, k), BETTER[k]),
    target: k === "spend" && m.monthlyBudget != null ? `${money(m.monthlyBudget)} budget` : k === "cost_per_result" && m.target != null && !m.roasKpi ? money(m.target) : k === "roas" && m.target != null && m.roasKpi ? multiple(m.target) : "–",
  }));
}

/** The campaign table's columns: the buyer's choice, else spend, results, their cost, and ROAS on a ROAS KPI when any has revenue */
export function columnKeys(m: ReportMetrics, layout: ReportLayout | null | undefined): MetricKey[] {
  if (layout?.columns?.length) return layout.columns;
  return ["spend", "results", "cost_per_result", ...(m.roasKpi && m.campaigns.some((c) => c.roas != null) ? (["roas"] as const) : [])];
}

/** The campaign lines a report shows: the biggest spenders (minus any taken out) and any added, by spend */
export function campaignLines(m: ReportMetrics, layout: ReportLayout | null | undefined, limit: number) {
  const hide = new Set(layout?.campaigns?.hide ?? []);
  const add = new Set(layout?.campaigns?.add ?? []);
  const top = m.campaigns.filter((c) => !hide.has(c.name)).slice(0, limit);
  const extra = m.campaigns.filter((c) => add.has(c.name) && !hide.has(c.name) && !top.includes(c));
  const picked = layout?.campaigns?.results ?? {};
  return [...top, ...extra]
    .sort((a, b) => b.spend - a.spend)
    .map((c) => {
      // A result picked for this campaign: it counts that instead of what it's optimized for
      const e = picked[c.name] ? c.events?.find((x) => x.type === picked[c.name]) : null;
      if (!picked[c.name] || !c.events) return c;
      const n = e?.count ?? 0;
      return { ...c, results: n, costPerResult: n ? Math.round((c.spend / n) * 100) / 100 : null, result: e?.label ?? c.result };
    });
}

/** A fingerprint of a report's words (its sections and the buyer's note): when it differs from the one its Slack message
 *  was written from, the report was edited since and the message is brought up to date before it's sent */
export function reportBasis(sections: unknown, extras: string | null | undefined) {
  const text = JSON.stringify({ s: sections ?? null, e: (extras ?? "").trim() });
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * The campaigns a report leaves out, for the AI that writes and checks it: named only so it never reports on them, gives
 * advice about them or takes ideas from them (a client running their own brand's ads, or campaigns outside the KPI).
 */
export function leftOutText(m: Pick<ReportMetrics, "leftOut"> | null | undefined, words: string[] = []) {
  const names = [...new Set([...(m?.leftOut ?? []).map((c) => c.name), ...words].filter(Boolean))];
  if (!names.length) return "";
  return `<campaigns_not_in_this_report rule="These campaigns are not ours to report on (the client runs them, or they're outside this KPI). Their numbers are already left out of everything above. Never mention them, describe their results, recommend changes to them, or draw ideas or next steps from them, even if they show up in the work log, the chat or a lookup.">\n${names.map((n) => `- ${n}`).join("\n")}\n</campaigns_not_in_this_report>`;
}

/** A line of text (a change in the account's log, a sprint move) about a campaign the report leaves out. */
export function aboutLeftOut(text: string | null | undefined, names: string[]) {
  const t = (text ?? "").toLowerCase();
  return Boolean(t) && names.some((n) => n.trim().length >= 4 && t.includes(n.trim().toLowerCase()));
}
