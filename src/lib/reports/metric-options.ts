import { PERIOD_ONLY, eventName, metricKeysFor, metricLabel, type MetricKey } from "./format";
import type { ReportMetrics } from "./metrics";

// What the "Show in this tile" picker offers on a report: every metric the report has data for, grouped, searchable. Ads:
// the standard metrics plus every event the account counted in the period (its count and its cost). Email and social
// build theirs from their own tiles (channel-reports/layout.ts). Pure, so the picker, the PDF and the tests agree.

export type MetricOption = { key: string; label: string; group: string; hint?: string | null };

const ADS_GROUP: Record<string, string> = { results: "Results", cost_per_result: "Results", revenue: "Results", roas: "Results", spend: "Spend and delivery", impressions: "Spend and delivery", cpm: "Spend and delivery", reach: "Spend and delivery", frequency: "Spend and delivery", clicks: "Clicks", ctr: "Clicks", cpc: "Clicks", clicks_all: "Clicks", ctr_all: "Clicks", cpc_all: "Clicks", views_6s: "Video", hook_rate: "Video" };
/** Events already shown as a standard metric (TikTok's 6-second views), or noise nobody reports on */
const SKIP_EVENT = /^(tiktok_video_6s|conversions)$/;

const n = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 10) / 10));

/**
 * Every metric an ads report can show. where: "columns" (the scorecard of campaigns and ads) offers the standard ones only,
 * since a campaign's row doesn't carry every event; tiles and the line under them offer every event the period counted.
 */
export function adsMetricOptions(m: Pick<ReportMetrics, "conversion" | "main" | "compare"> & { eventLabels?: Record<string, string>; knownEvents?: string[] }, platform: string, where: "tiles" | "table" | "columns"): MetricOption[] {
  // Reach and frequency only where the report read them (Meta); clicks (all) where the days carry them
  const has = (k: string) => (k === "reach" || k === "frequency" ? m.main.reach != null || m.compare.reach != null : k.endsWith("_all") ? m.main.clicksAll != null || m.compare.clicksAll != null : true);
  const base: MetricOption[] = metricKeysFor(platform)
    .filter((k) => (where === "columns" ? !PERIOD_ONLY.includes(k) : has(k)))
    .map((k) => ({ key: k, label: metricLabel(m, k), group: ADS_GROUP[k] ?? "More" }));
  if (where === "columns") return base;
  const counts = new Map<string, number>();
  for (const p of [m.main, m.compare]) for (const [k, v] of Object.entries(p?.actions ?? {})) if (v > 0 && !SKIP_EVENT.test(k)) counts.set(k, Math.max(counts.get(k) ?? 0, p === m.main ? v : 0));
  // What the campaigns are optimized for, and the account's other events, offered at none this period too
  for (const k of m.knownEvents ?? []) if (!SKIP_EVENT.test(k) && !counts.has(k)) counts.set(k, 0);
  const events = [...counts].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
  const named = (t: string) => eventName(t, m.eventLabels);
  return [
    ...base,
    ...events.map(([t, v]) => ({ key: `n:${t}`, label: named(t), group: "Events counted", hint: v ? `${n(v)} this period` : "None this period" })),
    ...events.map(([t]) => ({ key: `c:${t}`, label: metricLabel(m, `c:${t}` as MetricKey), group: "Cost per event" })),
  ];
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s$%]/g, " ").split(/\s+/).filter(Boolean);

/**
 * The options that match what was typed, best first: every word typed must start a word of the name or its group (so
 * "cost lead" finds "Cost per lead", "add" finds "Adds to cart"); a name starting with it ranks above one containing it.
 */
export function searchOptions(options: MetricOption[], query: string): MetricOption[] {
  const q = words(query);
  if (!q.length) return options;
  const scored = options
    .map((o, i) => {
      const name = words(o.label);
      // The event's own name in the ad account too ("subscribe_total" for "Subscriptions")
      const all = [...name, ...words(o.group), ...words(o.key.replace(/^[nc]:/, "").replace(/[._]+/g, " "))];
      if (!q.every((w) => all.some((x) => x.startsWith(w)))) return null;
      const lead = name[0]?.startsWith(q[0]) ? 0 : 1;
      return { o, rank: lead * 1000 + i };
    })
    .filter((x): x is { o: MetricOption; rank: number } => Boolean(x));
  return scored.sort((a, z) => a.rank - z.rank).map((x) => x.o);
}

/** The options in their groups, in order of first appearance (the order the list is drawn and the arrows move through) */
export function groupOptions(options: MetricOption[]): { group: string; options: MetricOption[] }[] {
  const out: { group: string; options: MetricOption[] }[] = [];
  for (const o of options) {
    const g = out.find((x) => x.group === o.group);
    if (g) g.options.push(o);
    else out.push({ group: o.group, options: [o] });
  }
  return out;
}
