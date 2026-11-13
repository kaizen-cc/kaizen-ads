import type { CampaignLine, ReportMetrics } from "./metrics";
import { costLabel, weeklyValue } from "./weekly-core";
import type { MetricKey } from "./format";
import { platformConversion } from "./manual";

// The "Campaign performance" table every weekly and monthly report carries: every campaign that spent in the period,
// straight from the ad account, with a total row (so the client can see where all of the money went). Plain functions
// (no server code), shared by the PDF and the tests. The columns depend on the platform and on what the account has:
// Meta e-commerce adds add to cart and initiate checkout (when the campaigns counted them), conversion value and ROAS
// show when there is revenue, and a column that is empty for every campaign is dropped.

export type CampaignColumnKey = "spend" | "impressions" | "clicks" | "ctr" | "cpc" | "cpm" | "results" | "cost_per_result" | "revenue" | "add_to_cart" | "initiate_checkout" | "roas";

export type CampaignCell = { text: string; /** the number behind it (null: not available, shown as a dash) */ value: number | null };
export type CampaignRow = { key: string; name: string; id: string | null; cells: Record<CampaignColumnKey, CampaignCell> };

/** One row's raw numbers: what the table is built from, and what the total is summed from */
type Raw = { spend: number; impressions: number; clicks: number; results: number; revenue: number; addToCart: number | null; initiateCheckout: number | null };

// Meta reports a purchase funnel step under several names (all channels, the plain one, the pixel's): ONE of them counts
const ATC = ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"];
const IC = ["omni_initiate_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"];

/** A funnel step's count on a campaign: the first of its names the account reports, summed over the period */
function eventCount(c: CampaignLine, types: string[]): number | null {
  const e = c.events ?? [];
  for (const t of types) {
    const hit = e.find((x) => x.type === t);
    if (hit) return hit.count;
  }
  return null;
}

const raw = (c: CampaignLine): Raw => ({
  spend: c.spend,
  impressions: c.impressions ?? 0,
  clicks: c.clicks ?? 0,
  // What the report counts as the client's result for the campaign (a reach or engagement campaign counts none)
  results: c.counted ?? c.results,
  revenue: c.revenue ?? 0,
  addToCart: eventCount(c, ATC),
  initiateCheckout: eventCount(c, IC),
});

const r2 = (x: number) => Math.round(x * 100) / 100;

function cells(x: Raw): Record<CampaignColumnKey, CampaignCell> {
  // The funnel steps are plain counts, like impressions
  const metric = (k: CampaignColumnKey): MetricKey => (k === "add_to_cart" || k === "initiate_checkout" ? "impressions" : k);
  const cell = (k: CampaignColumnKey, v: number | null): CampaignCell => ({ text: weeklyValue(metric(k), v), value: v });
  const ctr = x.impressions ? r2((x.clicks / x.impressions) * 100) : null;
  return {
    spend: cell("spend", x.spend),
    impressions: cell("impressions", x.impressions),
    clicks: cell("clicks", x.clicks),
    ctr: cell("ctr", ctr),
    cpc: cell("cpc", x.clicks ? r2(x.spend / x.clicks) : null),
    cpm: cell("cpm", x.impressions ? r2((x.spend / x.impressions) * 1000) : null),
    // Nothing counted: a dash, never a zero that reads as "no results" for a campaign that isn't run for one
    results: cell("results", x.results > 0 ? Math.round(x.results * 10) / 10 : null),
    cost_per_result: cell("cost_per_result", x.results > 0 ? r2(x.spend / x.results) : null),
    revenue: cell("revenue", x.revenue > 0 ? r2(x.revenue) : null),
    add_to_cart: cell("add_to_cart", x.addToCart != null && x.addToCart > 0 ? x.addToCart : null),
    initiate_checkout: cell("initiate_checkout", x.initiateCheckout != null && x.initiateCheckout > 0 ? x.initiateCheckout : null),
    roas: cell("roas", x.spend && x.revenue ? r2(x.revenue / x.spend) : null),
  };
}

export type CampaignTable = {
  /** The columns, left to right (the name comes first, always) */
  columns: { key: CampaignColumnKey; head: string }[];
  rows: CampaignRow[];
  total: Record<CampaignColumnKey, CampaignCell>;
  /** True when the account has more campaigns than the table lists, so the total is of those listed */
  partial: boolean;
};

/** A column's heading: short, the columns are narrow */
export function campaignHead(m: Pick<ReportMetrics, "conversion" | "roasKpi" | "platform" | "manual">, k: CampaignColumnKey): string {
  const conversion = platformConversion(m);
  const kind = { conversion, roasKpi: false };
  return {
    spend: "Spend",
    impressions: "Impr.",
    clicks: m.platform === "meta" || m.platform === "tiktok" ? "Link clicks" : "Clicks",
    ctr: "CTR",
    cpc: "CPC",
    cpm: "CPM",
    results: conversion,
    cost_per_result: costLabel(kind),
    revenue: "Conv. value",
    add_to_cart: "Add to cart",
    initiate_checkout: "Checkout",
    roas: "ROAS",
  }[k];
}

/**
 * The table's columns, rows (biggest spend first) and total. Returns null when no campaign spent in the period. Every
 * campaign that spent is a row; the total is the sum of the rows (so it equals the report's own totals).
 */
export function campaignTable(m: ReportMetrics): CampaignTable | null {
  const list = m.campaigns.filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend);
  if (!list.length) return null;
  const rows = list.map((c) => ({ key: c.id ?? c.name, name: c.name, id: c.id ?? null, raw: raw(c) }));
  const sum: Raw = rows.reduce<Raw>(
    (n, r) => ({
      spend: n.spend + r.raw.spend,
      impressions: n.impressions + r.raw.impressions,
      clicks: n.clicks + r.raw.clicks,
      results: n.results + r.raw.results,
      revenue: n.revenue + r.raw.revenue,
      addToCart: r.raw.addToCart == null ? n.addToCart : (n.addToCart ?? 0) + r.raw.addToCart,
      initiateCheckout: r.raw.initiateCheckout == null ? n.initiateCheckout : (n.initiateCheckout ?? 0) + r.raw.initiateCheckout,
    }),
    { spend: 0, impressions: 0, clicks: 0, results: 0, revenue: 0, addToCart: null, initiateCheckout: null },
  );
  const has = (f: (r: Raw) => boolean) => rows.some((r) => f(r.raw));
  const revenue = has((r) => r.revenue > 0);
  // The funnel steps are an e-commerce thing on Meta: only when the account sells (purchase value) and counted them
  const funnel = m.platform === "meta" && revenue;
  const keys: CampaignColumnKey[] = [
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "results",
    "cost_per_result",
    ...(revenue ? (["revenue"] as const) : []),
    ...(funnel && has((r) => (r.addToCart ?? 0) > 0) ? (["add_to_cart"] as const) : []),
    ...(funnel && has((r) => (r.initiateCheckout ?? 0) > 0) ? (["initiate_checkout"] as const) : []),
    ...(revenue ? (["roas"] as const) : []),
  ];
  // Impressions are dropped when no campaign has any (a source that doesn't report them)
  const columns = keys.filter((k) => k !== "impressions" || has((r) => r.impressions > 0)).map((key) => ({ key, head: campaignHead(m, key) }));
  return {
    columns,
    rows: rows.map((r) => ({ key: r.key, name: r.name, id: r.id, cells: cells(r.raw) })),
    total: cells(sum),
    partial: m.campaigns.length >= 80,
  };
}
