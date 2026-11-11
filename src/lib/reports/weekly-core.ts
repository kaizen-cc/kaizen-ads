import type { Period, ReportMetrics, TopAd } from "./metrics";
import { BETTER, count, metricLabel, metricNumber, money, multiple, percent, singular, type MetricKey, type ReportLayout } from "./format";

// The weekly report's layout as plain functions (no server code), shared by the PDF, the studio and the tests: which
// four numbers lead (by the client's KPI), whether each moved the right way (green) or the wrong way (red), the five-week
// history the chart draws, the scorecard (each ad with its picture beside its numbers, or on Google each campaign and ad
// group), and three takeaways worked out from the numbers when the writer hasn't written its own.

/** One week of the five the chart shows (Monday to Sunday, ending with the report's week) */
export type WeekPoint = { label: string; start: string; end: string; spend: number; results: number; costPerResult: number | null; revenue: number; roas: number | null; clicks: number; impressions: number };

/** A Google ad group or Performance Max asset group in the period: its best RSA headline, or the asset group's picture */
export type GoogleUnit = { id: string; kind: "ad_group" | "asset_group"; name: string; campaign: string; campaignId?: string; headline: string | null; image: string | null; spend: number; clicks: number; impressions: number; results: number; revenue: number };

/** A takeaway card: a short claim, then one or two sentences with the numbers behind it */
export type Takeaway = { title: string; text: string };

/** How the client is judged, which decides what leads */
export type KpiType = "roas" | "leads" | "purchases" | "other";

export function kpiType(m: Pick<ReportMetrics, "roasKpi" | "conversion">): KpiType {
  if (m.roasKpi) return "roas";
  if (/lead|application|registration|sign.?up|booking|appointment|contact|call|schedul/i.test(m.conversion)) return "leads";
  if (/purchase|order|sale|checkout/i.test(m.conversion)) return "purchases";
  return "other";
}

/** "CPA" for purchases, "CPL" for leads, else "Cost per booking" */
export function costLabel(m: Pick<ReportMetrics, "conversion" | "roasKpi">) {
  const t = kpiType({ ...m, roasKpi: false });
  return t === "purchases" || /^conversions?$|^results?$/i.test(m.conversion.trim()) ? "CPA" : t === "leads" && /lead/i.test(m.conversion) ? "CPL" : `Cost per ${singular(m.conversion)}`;
}

/** A metric's short name on a tile or a column */
export function shortLabel(m: Pick<ReportMetrics, "conversion" | "roasKpi">, k: MetricKey) {
  if (k === "cost_per_result") return costLabel(m);
  if (k === "hook_rate") return "6s view rate";
  if (k === "views_6s") return "6s views";
  if (k === "clicks") return "Link clicks";
  return metricLabel(m, k, true);
}

/** Two rows that read the same in a sentence ("Flexible Seafood plan" and its copy) keep their full names there */
export function sayable(rows: ScoreRow[]) {
  // Only ads are shortened ("VID | Salmon Lover Box | Jan 9"): a campaign's name is its structure ("SCALE | Pmax | …")
  const short = (r: ScoreRow) => (r.kind === "ad" ? shortName(r.name) : r.name);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(short(r), (counts.get(short(r)) ?? 0) + 1);
  return (r: ScoreRow) => ((counts.get(short(r)) ?? 0) > 1 ? r.name : short(r));
}

/**
 * The four tiles a weekly leads with. ROAS clients: ROAS, revenue, purchases and their cost. Everyone else: their result,
 * its cost, CPC and CTR (the reference report's four). TikTok swaps CTR for the 6-second view rate. The buyer's own
 * choice (clicking a tile in the studio) always wins.
 */
export function weeklyTileKeys(m: Pick<ReportMetrics, "roasKpi" | "conversion" | "platform" | "main" | "compare">, layout?: ReportLayout | null): MetricKey[] {
  if (layout?.tiles?.length) return layout.tiles;
  const roas = m.roasKpi && (m.main.revenue > 0 || m.compare.revenue > 0);
  if (m.platform === "tiktok") return roas ? ["roas", "revenue", "results", "hook_rate"] : ["results", "cost_per_result", "cpc", "hook_rate"];
  return roas ? ["roas", "revenue", "results", "cost_per_result"] : ["results", "cost_per_result", "cpc", "ctr"];
}

/** The smaller line under the tiles: spend (with its change), link clicks, impressions (and 6-second views on TikTok) */
export function supportKeys(m: Pick<ReportMetrics, "platform">, tiles: MetricKey[]): MetricKey[] {
  const all: MetricKey[] = ["spend", "clicks", "impressions", ...(m.platform === "tiktok" ? (["views_6s"] as MetricKey[]) : [])];
  return all.filter((k) => !tiles.includes(k));
}

export type Tone = "good" | "bad" | "flat";
/** pct: the change as a positive percent with one decimal ("71.4%"); up: which way it moved; tone: good, bad or neither */
export type Move = { pct: string; up: boolean; tone: Tone } | null;

/**
 * Whether a change is good news: up is good for results, revenue, ROAS, CTR, clicks and views; down is good for every
 * cost (cost per result, CPC, CPM); spend is neither (more or less budget is a choice, not a result).
 */
export function move(k: MetricKey, now: number | null | undefined, before: number | null | undefined): Move {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  const raw = ((now - before) / Math.abs(before)) * 100;
  const pct = Math.abs(raw).toFixed(1);
  if (pct === "0.0") return { pct: "0.0%", up: false, tone: "flat" };
  const up = raw > 0;
  const better = BETTER[k];
  const tone: Tone = better === "none" ? "flat" : up === (better === "up") ? "good" : "bad";
  return { pct: `${pct}%`, up, tone };
}

export type WeeklyTile = { key: MetricKey; label: string; value: string; before: string; move: Move };

/** A number as a weekly shows it: money with cents under $1,000, counts with commas */
export function weeklyValue(k: MetricKey, n: number | null) {
  if (n == null || !Number.isFinite(n)) return "–";
  if (["spend", "cost_per_result", "revenue", "cpc", "cpm"].includes(k)) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (k === "roas") return multiple(n);
  if (k === "ctr" || k === "hook_rate") return percent(n);
  return count(n);
}

export function weeklyTile(m: Pick<ReportMetrics, "conversion" | "roasKpi">, k: MetricKey, main: Period, compare: Period): WeeklyTile {
  const now = metricNumber(main, k);
  const was = metricNumber(compare, k);
  return { key: k, label: shortLabel(m, k), value: weeklyValue(k, now), before: weeklyValue(k, was), move: move(k, now, was) };
}

/**
 * A round top for a chart axis with four even steps: 12 purchases → 16 (0, 4, 8, 12, 16), $848 → $1,000. counts: whole
 * steps only (no "3.8 purchases" on an axis).
 */
export function niceMax(v: number, counts = false) {
  if (!(v > 0)) return counts ? 4 : 1;
  const step = (v * 1.08) / 4;
  const p = 10 ** Math.floor(Math.log10(step));
  for (const s of [1, 2, 2.5, 3, 4, 5, 10]) {
    const st = s * p;
    if (counts && st % 1) continue;
    if (st >= step) return st * 4;
  }
  return 10 * p * 4;
}

/** The weeks the chart draws: the five kept with the report (older reports have none, and show no chart) */
export const chartWeeks = (m: Pick<ReportMetrics, "weeks">) => (m.weeks ?? []).filter((w) => w.spend > 0 || w.results > 0).slice(-5);

/** "Oct 26 – Nov 1" → "Oct 26–Nov 1"; "Nov 2 – Nov 8" → "Nov 2–8" */
export function weekLabel(start: string, end: string) {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return start.slice(0, 7) === end.slice(0, 7) ? `${f(start, { month: "short", day: "numeric" })}–${f(end, { day: "numeric" })}` : `${f(start, { month: "short", day: "numeric" })}–${f(end, { month: "short", day: "numeric" })}`;
}

/** One row of the scorecard: an ad (Meta, TikTok) or a campaign, ad group or asset group (Google) */
export type ScoreRow = {
  id: string;
  kind: "ad" | "campaign" | "ad_group" | "asset_group";
  name: string;
  /** "Video · Active", "Search · Brand campaign", the RSA headline */
  detail: string | null;
  /** Where its picture is in the part's images (null: no picture to show) */
  img: number | null;
  /** The ad's preview link (Meta), on its name in the PDF */
  link?: string | null;
  spend: number;
  results: number;
  costPerResult: number | null;
  revenue: number;
  roas: number | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  cpc: number | null;
  views6s?: number;
  hookRate?: number | null;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** An ad's name as a client reads it: Meta's "ID: 1784… | " prefix and copy suffixes taken off */
export function cleanAdName(name: string) {
  return (
    name
      .replace(/^\s*ID:\s*\d+\s*\|\s*/i, "")
      .replace(/\s*-\s*Copy(\s*\d+)?\s*$/i, " (copy)")
      .replace(/\s{2,}/g, " ")
      .trim() || name
  );
}

function adRow(a: TopAd, i: number, platform: string): ScoreRow {
  const status = a.active == null ? null : a.active ? "Active" : "Inactive";
  const format = a.format ?? (platform === "tiktok" ? "Video" : null);
  return {
    id: a.id,
    kind: "ad",
    name: cleanAdName(a.name),
    detail: [format, status].filter(Boolean).join(" · ") || null,
    img: i,
    link: a.link,
    spend: a.spend,
    results: a.results,
    costPerResult: a.costPerResult,
    revenue: a.revenue ?? 0,
    roas: a.roas ?? (a.revenue && a.spend ? r2(a.revenue / a.spend) : null),
    clicks: a.clicks,
    impressions: a.impressions ?? 0,
    ctr: a.ctr,
    cpc: a.cpc ?? (a.clicks ? r2(a.spend / a.clicks) : null),
    ...(a.views6s != null ? { views6s: a.views6s, hookRate: a.hookRate ?? null } : {}),
  };
}

/** Best first, by what the client is judged on: ROAS (then revenue), else the most results at the lowest cost */
export function byKpi(roas: boolean) {
  return (a: ScoreRow, b: ScoreRow) => (roas ? (b.roas ?? -1) - (a.roas ?? -1) || b.revenue - a.revenue : b.results - a.results || (a.costPerResult ?? 1e12) - (b.costPerResult ?? 1e12)) || b.spend - a.spend;
}

/**
 * The scorecard's rows, sorted by the KPI. Meta and TikTok: each ad that spent (its picture is the part's image at the
 * same place). Google: each ad group and asset group when they were read, else each campaign.
 */
export function scorecardRows(m: ReportMetrics, limit = 8): ScoreRow[] {
  let rows: ScoreRow[];
  if (m.platform === "google") {
    rows = m.googleUnits?.length
      ? m.googleUnits.map((u, i) => ({
          id: u.id,
          kind: u.kind,
          name: u.name,
          detail: u.kind === "asset_group" ? `Asset group · ${u.campaign}` : u.headline ? `“${u.headline}”` : u.campaign,
          img: u.image ? i : null,
          spend: u.spend,
          results: u.results,
          costPerResult: u.results ? r2(u.spend / u.results) : null,
          revenue: u.revenue,
          roas: u.spend && u.revenue ? r2(u.revenue / u.spend) : null,
          clicks: u.clicks,
          impressions: u.impressions,
          ctr: u.impressions ? r2((u.clicks / u.impressions) * 100) : null,
          cpc: u.clicks ? r2(u.spend / u.clicks) : null,
        }))
      : m.campaigns.map((c) => ({ id: c.id ?? c.name, kind: "campaign" as const, name: c.name, detail: null, img: null, spend: c.spend, results: c.results, costPerResult: c.costPerResult, revenue: c.revenue ?? 0, roas: c.roas, clicks: c.clicks ?? 0, impressions: c.impressions ?? 0, ctr: c.ctr, cpc: c.cpc ?? null }));
  } else rows = m.topAds.map((a, i) => adRow(a, i, m.platform));
  return rows.filter((r) => r.spend > 0).sort(byKpi(m.roasKpi)).slice(0, limit);
}

/** The scorecard's number columns, by platform and KPI (the reference's: results, cost, CPC, CTR, spend, clicks) */
export function scoreColumns(m: Pick<ReportMetrics, "platform" | "roasKpi">): MetricKey[] {
  if (m.roasKpi) return ["roas", "revenue", "results", "cost_per_result", "ctr", "spend"];
  if (m.platform === "tiktok") return ["results", "cost_per_result", "cpc", "ctr", "hook_rate", "spend"];
  return ["results", "cost_per_result", "cpc", "ctr", "spend", "clicks"];
}

export const scoreValue = (r: ScoreRow, k: MetricKey) => weeklyValue(k, metricNumber(r, k));

/** A scorecard column's heading (short: the columns are narrow) */
export function scoreHead(m: Pick<ReportMetrics, "conversion" | "roasKpi">, k: MetricKey) {
  return k === "results" ? m.conversion : k === "cost_per_result" ? costLabel(m) : k === "hook_rate" ? "6s rate" : k === "clicks" ? "Clicks" : shortLabel(m, k);
}

/** The bar beside the scorecard: what each row brought (revenue on a ROAS KPI, else results) */
export const barMetric = (m: Pick<ReportMetrics, "roasKpi">): MetricKey => (m.roasKpi ? "revenue" : "results");

/** A name for a sentence: "Lobster | Dec 10" → "Lobster", "VID | Salmon Lover Box | Jan 9" → "Salmon Lover Box" */
export function shortName(s: string) {
  const noise = /^(vid|video|static|img|image|ugc|carousel|gif|copy|v\d+|id:.*|\d+|[a-z]{3,9}\.? \d{1,2}(,? \d{4})?|\(copy\))$/i;
  return (
    s
      .split("|")
      .map((x) => x.trim())
      .find((x) => x && !noise.test(x)) ?? s
  );
}

/** The one line under the bars: who brought the most, then the rest in order */
export function barsRead(m: Pick<ReportMetrics, "conversion" | "roasKpi" | "platform">, rows: ScoreRow[]): string | null {
  const k = barMetric(m);
  const sorted = rows.filter((r) => (metricNumber(r, k) ?? 0) > 0).sort((a, b) => (metricNumber(b, k) ?? 0) - (metricNumber(a, k) ?? 0));
  if (!sorted.length) return null;
  const what = k === "revenue" ? "revenue" : m.conversion.toLowerCase();
  const fmt = (r: ScoreRow) => weeklyValue(k, metricNumber(r, k));
  const unit = m.platform === "google" ? (rows[0]?.kind === "campaign" ? "campaign" : "group") : "ad";
  const say = sayable(rows);
  const [top, ...rest] = sorted;
  if (!rest.length) return `${say(top)} brought all of this week's ${what} (${fmt(top)}).`;
  const tail = rest.slice(0, 3).map((r) => `${say(r)} (${fmt(r)})`);
  const list = tail.length > 1 ? `${tail.slice(0, -1).join(", ")} and ${tail.at(-1)}` : tail[0];
  return `${say(top)} brought the most ${what} of any ${unit} (${fmt(top)}), followed by ${list}.`;
}

const pctText = (now: number | null, before: number | null) => {
  if (now == null || before == null || !before) return null;
  const v = ((now - before) / Math.abs(before)) * 100;
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}%`;
};

/**
 * Three takeaways from the numbers alone, for a report whose writer didn't write its own (older reports, a failed draft):
 * the KPI and its cost, the traffic (CPC and CTR, or the 6-second view rate on TikTok), and the scorecard's leader.
 * Plain and specific, every number from the report.
 */
export function autoTakeaways(m: ReportMetrics): Takeaway[] {
  const a = m.main;
  const b = m.compare;
  const out: Takeaway[] = [];
  const conv = m.conversion;
  const lower = conv.toLowerCase();
  const cost = costLabel(m);
  if (m.roasKpi && (a.revenue || b.revenue)) {
    const up = (a.roas ?? 0) >= (b.roas ?? 0);
    out.push({
      title: up ? "Higher return on spend" : "Lower return on spend",
      text: `ROAS ${up ? "rose" : "fell"} from ${multiple(b.roas)} to ${multiple(a.roas)}${pctText(a.roas, b.roas) ? ` (${pctText(a.roas, b.roas)})` : ""}, on ${money(a.revenue)} revenue from ${money(a.spend)} spent.`,
    });
  } else {
    const more = a.results >= b.results;
    const cheaper = (a.costPerResult ?? Infinity) <= (b.costPerResult ?? Infinity);
    const title = `${more ? "More" : "Fewer"} ${lower}, ${cheaper ? "lower" : "higher"} ${cost === "CPA" || cost === "CPL" ? cost : "cost"}`;
    const p1 = pctText(a.results, b.results);
    const p2 = pctText(a.costPerResult, b.costPerResult);
    out.push({ title, text: `${conv} ${a.results === b.results ? "held at" : more ? "increased from" : "fell from"} ${a.results === b.results ? count(a.results) : `${count(b.results)} to ${count(a.results)}`}${p1 && a.results !== b.results ? ` (${p1})` : ""}, while ${cost} ${cheaper ? "fell" : "rose"} from ${money(b.costPerResult)} to ${money(a.costPerResult)}${p2 ? ` (${p2})` : ""}.` });
  }
  if (m.platform === "tiktok" && a.hookRate != null) {
    const up = (a.hookRate ?? 0) >= (b.hookRate ?? 0);
    out.push({ title: up ? "The videos hold attention better" : "The videos hold attention less", text: `${percent(a.hookRate)} of impressions watched 6 seconds or more, against ${percent(b.hookRate)} the week before, with ${count(a.views6s ?? 0)} 6-second views.` });
  } else if (a.cpc == null || b.cpc == null) {
    const ctrUp = (a.ctr ?? 0) >= (b.ctr ?? 0);
    out.push({ title: `Click-through rate ${ctrUp ? "up" : "down"}`, text: `CTR ${ctrUp ? "rose" : "eased"} to ${percent(a.ctr)} from ${percent(b.ctr)}, on ${count(a.clicks)} link clicks.` });
  } else {
    const cheaperClicks = (a.cpc ?? Infinity) <= (b.cpc ?? Infinity);
    const ctrUp = (a.ctr ?? 0) >= (b.ctr ?? 0);
    const cpcMove = pctText(a.cpc, b.cpc);
    const ctrMove = pctText(a.ctr, b.ctr);
    out.push({
      title: `${cheaperClicks ? "Cheaper" : "Pricier"} traffic, ${ctrUp ? "higher" : "lower"} CTR`,
      text: `CPC ${cheaperClicks ? "improved" : "rose"}${cpcMove ? ` ${cpcMove.replace(/^[+-]/, "")}` : ""} to ${money(a.cpc)}. CTR ${ctrUp ? "rose" : "eased"}${ctrMove ? ` ${ctrMove.replace(/^[+-]/, "")}` : ""} to ${percent(a.ctr)} on ${count(a.clicks)} link clicks.`,
    });
  }
  const rows = scorecardRows(m);
  const say = sayable(rows);
  // The leader on cost: the cheapest among the rows with more than one result (one lucky sale isn't a trend)
  const efficient = m.roasKpi ? undefined : rows.filter((r) => r.results >= 2 && r.costPerResult != null).sort((a, b) => (a.costPerResult ?? 0) - (b.costPerResult ?? 0))[0];
  const best = efficient ?? rows[0];
  if (best && (m.roasKpi ? best.roas != null : best.results > 0)) {
    const unit = best.kind === "ad" ? "ads" : best.kind === "campaign" ? "campaigns" : "groups";
    const cheapest = !m.roasKpi && rows.filter((r) => r.costPerResult != null && r.results >= 2).every((r) => (best.costPerResult ?? Infinity) <= (r.costPerResult ?? Infinity));
    const most = rows.every((r) => r.results <= best.results);
    const underTarget = !m.roasKpi && m.target != null && best.costPerResult != null && best.costPerResult <= m.target ? `, under the ${money(m.target)} target` : "";
    out.push({
      title: best.kind === "ad" ? (m.roasKpi || !efficient || most ? "Creative leader" : "Creative efficiency leader") : "Strongest performer",
      text: m.roasKpi
        ? `${say(best)} returned ${multiple(best.roas)} on ${money(best.spend)}, the best ROAS of the ${rows.length} ${unit} shown.`
        : `${say(best)} delivered ${count(best.results)} ${best.results === 1 ? singular(conv) : lower} at ${money(best.costPerResult)} ${cost === "CPA" || cost === "CPL" ? cost : "each"}${cheapest && rows.length > 1 ? `, the lowest among the ${rows.length} ${unit} shown` : most && rows.length > 1 ? `, the most of the ${rows.length} ${unit} shown` : ""}${underTarget}.`,
    });
  } else out.push({ title: "Spend this week", text: `${money(a.spend)} spent across ${count(a.impressions)} impressions and ${count(a.clicks)} link clicks${pctText(a.spend, b.spend) ? ` (${pctText(a.spend, b.spend)} on spend vs the week before)` : ""}.` });
  return out.slice(0, 3);
}

/** The takeaways a report shows: the writer's (three at most), else worked out from the numbers */
export function takeawaysFor(m: ReportMetrics, written: Takeaway[] | null | undefined): Takeaway[] {
  const own = (written ?? []).filter((t) => t?.title?.trim() || t?.text?.trim());
  return own.length ? own.slice(0, 3) : autoTakeaways(m);
}
