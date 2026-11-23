import type { ConversionMetric } from "@/lib/email-metrics";
import type { LocationBreakdown, LocationRow } from "@/lib/klaviyo/locations";
import type { Pair } from "./email-detail";

// A client whose Klaviyo account credits email through more than one order system (Crust Pizza Co.: Toast online
// orders and a custom POS integration) gets a section per revenue source in the email report: each source's attributed
// revenue and orders against the period before, its share of the combined, how much of that system's own revenue email
// earned, campaigns against automated emails and its revenue by location, then one combined total that never counts an
// order twice. Which ranked metrics are revenue sources is the team's pick on the Klaviyo card (ConversionMetric.revenueSource);
// unset, the primary always is and a lower one is once it carries attributed revenue. Pure, so it is tested.

/** One ranked metric's numbers for the period and the one before (klaviyo_metric_daily), as the report reads them */
export type SourceSide = { id: string; name: string; revenue: Pair; conversions: Pair; store: Pair; campaignRevenue?: Pair; flowRevenue?: Pair };

export type SourceLocation = { location: string; revenue: number; conversions: number };

export type RevenueSource = {
  id: string;
  name: string;
  primary: boolean;
  revenue: Pair;
  orders: Pair;
  campaignRevenue: number | null;
  flowRevenue: number | null;
  /** The order system's own total for the period (every order of this metric, from email or not) */
  store: number | null;
  /** Attributed revenue over that total: how much of the system's revenue email earned */
  attributedShare: number | null;
  /** This source's part of the combined attributed revenue */
  share: number | null;
  /** The best locations by revenue (multi-location clients), and how many converted */
  locations: SourceLocation[];
  locationCount: number;
};

export type RevenueSources = {
  version: 1;
  sources: RevenueSource[];
  combined: { revenue: Pair; orders: Pair; campaignRevenue: number | null; flowRevenue: number | null; /** Orders both systems recorded, counted once (taken off the plain sum) */ overlap: { revenue: number; orders: number } };
  note: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const has = (p: Pair | undefined) => p != null && ((p.now ?? 0) > 0 || (p.before ?? 0) > 0);

/** Whether a ranked metric counts as a revenue source: the primary always; a lower one as the team set it, else once it carries attributed revenue */
export function countsAsRevenue(m: Pick<ConversionMetric, "revenueSource">, rank: number, side?: Pick<SourceSide, "revenue"> | null): boolean {
  if (rank === 0) return true;
  if (m.revenueSource === false) return false;
  if (m.revenueSource === true) return true;
  return has(side?.revenue);
}

/** Two numbers the same order would carry in both systems: equal counts, and money within a dollar or 1% */
const same = (a: { revenue: number; conversions: number }, b: { revenue: number; conversions: number }) => a.conversions === b.conversions && Math.abs(a.revenue - b.revenue) <= Math.max(1, Math.max(a.revenue, b.revenue) * 0.01);

/**
 * Orders recorded by two sources at once (a restaurant mid-move between POS systems sending the same order through
 * both): the same day, location and email credited, with the same count and amount in each. Counted once: what this
 * returns is the extra to take off the plain sum. Rows of other metrics, and unknown locations, are left alone.
 */
export function mirroredOverlap(rows: LocationRow[], metricIds: string[], window?: { start: string; end: string }): { revenue: number; orders: number } {
  const ids = new Set(metricIds);
  const by = new Map<string, Map<string, { revenue: number; conversions: number }>>();
  for (const r of rows) {
    if (!ids.has(r.metricId) || (window && (r.date < window.start || r.date > window.end))) continue;
    const k = `${r.date}|${r.location}|${r.messageId}`;
    const per = by.get(k) ?? new Map<string, { revenue: number; conversions: number }>();
    const had = per.get(r.metricId) ?? { revenue: 0, conversions: 0 };
    per.set(r.metricId, { revenue: had.revenue + r.revenue, conversions: had.conversions + r.conversions });
    by.set(k, per);
  }
  let revenue = 0;
  let orders = 0;
  for (const per of by.values()) {
    const list = [...per.values()];
    if (list.length < 2 || !list[0].conversions) continue;
    const first = list[0];
    // Every source the same: one order system's worth is real, the rest are copies
    if (list.every((x) => same(x, first))) {
      revenue += first.revenue * (list.length - 1);
      orders += first.conversions * (list.length - 1);
    }
  }
  return { revenue: r2(revenue), orders: Math.round(orders) };
}

const sumPair = (ps: Pair[], k: "now" | "before"): number | null => {
  const xs = ps.map((p) => p[k]).filter((x): x is number => x != null);
  return xs.length ? r2(xs.reduce((a, b) => a + b, 0)) : null;
};

/**
 * The per-source view, or null when fewer than two revenue sources carry numbers (a single-source client reads as
 * before). `overlap` is the same orders seen in both systems for each period (mirroredOverlap), taken off the combined.
 */
export function revenueSources(input: { metrics: ConversionMetric[]; sides: SourceSide[]; locations?: LocationBreakdown | null; overlap?: { now?: { revenue: number; orders: number } | null; before?: { revenue: number; orders: number } | null } }): RevenueSources | null {
  const sideOf = new Map(input.sides.map((s) => [s.id, s]));
  const picked = input.metrics
    .map((m, i) => ({ m, i, side: sideOf.get(m.id) }))
    .filter((x) => x.side && countsAsRevenue(x.m, x.i, x.side) && (has(x.side.revenue) || has(x.side.conversions)));
  if (picked.length < 2) return null;
  const now = input.overlap?.now ?? { revenue: 0, orders: 0 };
  const before = input.overlap?.before ?? { revenue: 0, orders: 0 };
  const revenues = picked.map((x) => x.side!.revenue);
  const orders = picked.map((x) => x.side!.conversions);
  const plain = sumPair(revenues, "now");
  const combinedNow = plain == null ? null : r2(Math.max(0, plain - now.revenue));
  const sources: RevenueSource[] = picked.map(({ m, i, side }) => {
    const s = side!;
    const loc = input.locations?.metrics.find((x) => x.metricId === m.id) ?? null;
    const store = s.store.now;
    return {
      id: m.id,
      // Two systems that both call it "Placed Order" (E11EVEN: Speakeasy's and Shopify's) are told apart by their integration
      name: m.integration && picked.some((o) => o.m.id !== m.id && o.m.name.trim().toLowerCase() === m.name.trim().toLowerCase()) ? `${m.name} (${m.integration})` : m.name,
      primary: i === 0,
      revenue: s.revenue,
      orders: s.conversions,
      campaignRevenue: s.campaignRevenue?.now ?? null,
      flowRevenue: s.flowRevenue?.now ?? null,
      store,
      attributedShare: store != null && store > 0 && s.revenue.now != null ? s.revenue.now / store : null,
      // Shares of the plain sum, so the sources' shares add up to 100%
      share: plain != null && plain > 0 && s.revenue.now != null ? s.revenue.now / plain : null,
      locations: (loc?.ranked ?? []).slice(0, 5).map((x) => ({ location: x.location, revenue: x.revenue, conversions: x.conversions })),
      locationCount: loc?.ranked.length ?? 0,
    };
  });
  const part = (k: "campaignRevenue" | "flowRevenue") => (sources.every((x) => x[k] != null) ? r2(sources.reduce((t, x) => t + (x[k] ?? 0), 0)) : null);
  const plainBefore = sumPair(revenues, "before");
  const ordersNow = sumPair(orders, "now");
  const ordersBefore = sumPair(orders, "before");
  const names = sources.map((x) => x.name);
  const dup = now.revenue > 0;
  return {
    version: 1,
    sources,
    combined: {
      revenue: { now: combinedNow, before: plainBefore == null ? null : r2(Math.max(0, plainBefore - before.revenue)) },
      orders: { now: ordersNow == null ? null : Math.max(0, Math.round(ordersNow - now.orders)), before: ordersBefore == null ? null : Math.max(0, Math.round(ordersBefore - before.orders)) },
      campaignRevenue: part("campaignRevenue"),
      flowRevenue: part("flowRevenue"),
      overlap: now,
    },
    note: `Combined = ${names.join(" + ")}. Each order is counted once: ${names.length === 2 ? "the two systems record" : "the systems record"} different orders${dup ? ", and orders both recorded (same day, location, email and amount) are counted once" : ""}.`,
  };
}

/** The sources as the writer and the QA read them */
export function sourcesText(s: RevenueSources, money: (n: number | null | undefined) => string, prior: string): string {
  const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
  const out = [`Revenue sources (this client's Klaviyo credits email through ${s.sources.length} order systems; report each one separately and the combined total, never add them up yourself):`];
  for (const x of s.sources)
    out.push(
      `- ${x.name}${x.primary ? " (primary; the headline revenue above is this one)" : ""}: ${money(x.revenue.now)} attributed (the ${prior} before: ${money(x.revenue.before)}), ${x.orders.now ?? "n/a"} orders (before: ${x.orders.before ?? "n/a"}), ${pct(x.share)} of the combined${x.attributedShare != null ? `, ${pct(x.attributedShare)} of ${x.name}'s own ${money(x.store)} came from email` : ""}${x.campaignRevenue != null && x.flowRevenue != null ? `; campaigns ${money(x.campaignRevenue)}, automated emails ${money(x.flowRevenue)}` : ""}${x.locations.length ? `; top locations: ${x.locations.slice(0, 3).map((l) => `${l.location} ${money(l.revenue)}`).join(", ")} (${x.locationCount} converted)` : ""}`,
    );
  out.push(`- Combined (each order once): ${money(s.combined.revenue.now)} (before: ${money(s.combined.revenue.before)}), ${s.combined.orders.now ?? "n/a"} orders${s.combined.overlap.revenue > 0 ? `; ${money(s.combined.overlap.revenue)} recorded by both systems counted once` : ""}.`);
  return out.join("\n");
}

// ─── Every number of the report on all the revenue sources ──────────────────────────────────────────────────────────

/** One ranked metric's day (klaviyo_metric_daily) */
export type MetricDay = { metric_id: string; date: string; revenue?: unknown; campaign_revenue?: unknown; flow_revenue?: unknown; conversions?: unknown; store_revenue?: unknown };

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Which ranked metrics count toward the report's revenue: the primary always, a lower one as the team set it on the
 * Klaviyo card, else once it carries attributed revenue in the days read. Two or more: the report adds them up.
 */
export function revenueSourceIds(metrics: ConversionMetric[], days: MetricDay[]): string[] {
  return metrics
    .filter((m, i) => countsAsRevenue(m, i, { revenue: { now: days.filter((d) => d.metric_id === m.id).reduce((t, d) => t + n(d.revenue), 0), before: 0 } }))
    .map((m) => m.id);
}

/**
 * The report's days with every revenue source added up (E11EVEN: Speakeasy + Shopify; Crust: Toast + its POS's API):
 * attributed revenue, campaigns', flows', orders and the systems' own revenue. A day no ranked metric was read for keeps
 * what it had (the primary's). So the headline, the month to date, the pace, the share and the trend all count every
 * source, as the per-source section does.
 */
export function combineDays<T extends { date: string; revenue: number; campaignRevenue: number; flowRevenue: number; conversions?: number | null; storeRevenue: number | null }>(rows: T[], days: MetricDay[], ids: string[]): T[] {
  if (ids.length < 2) return rows;
  const by = new Map<string, MetricDay[]>();
  for (const d of days) if (ids.includes(d.metric_id)) by.set(d.date, [...(by.get(d.date) ?? []), d]);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return rows.map((row) => {
    const ds = by.get(row.date);
    if (!ds?.length) return row;
    const stores = ds.filter((d) => d.store_revenue != null);
    return {
      ...row,
      revenue: r2(ds.reduce((t, d) => t + n(d.revenue), 0)),
      campaignRevenue: r2(ds.reduce((t, d) => t + n(d.campaign_revenue), 0)),
      flowRevenue: r2(ds.reduce((t, d) => t + n(d.flow_revenue), 0)),
      conversions: ds.reduce((t, d) => t + n(d.conversions), 0),
      storeRevenue: stores.length ? r2(stores.reduce((t, d) => t + n(d.store_revenue), 0)) : row.storeRevenue,
    };
  });
}

/**
 * Each flow's days with every revenue source added up (Crust's flows: their Toast orders and their POS orders), so the
 * flow table matches the flows total and the headline. `rows` are the primary's days (klaviyo_flow_daily); the other
 * counted systems (the ids after the first, from klaviyo_flow_metric_daily) are added on top. Sends, opens and clicks
 * stay as read; a flow day only another system earned on is added with its money alone.
 */
export function combineFlowDays<T extends { flowId: string; date: string; conversions: number; revenue: number; recipients: number; delivered: number; opensUnique: number; clicksUnique: number }>(rows: T[], perMetric: { flow_id: string; date: string; metric_id: string; conversions?: unknown; revenue?: unknown }[], ids: string[]): T[] {
  const others = ids.slice(1);
  if (!others.length || !perMetric.length) return rows;
  const sum = new Map<string, { conversions: number; revenue: number }>();
  for (const r of perMetric) {
    if (!others.includes(r.metric_id)) continue;
    const k = `${r.flow_id}|${r.date}`;
    const had = sum.get(k) ?? { conversions: 0, revenue: 0 };
    sum.set(k, { conversions: had.conversions + n(r.conversions), revenue: had.revenue + n(r.revenue) });
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const seen = new Set<string>();
  const out = rows.map((row) => {
    const k = `${row.flowId}|${row.date}`;
    seen.add(k);
    const s = sum.get(k);
    return s ? { ...row, conversions: row.conversions + s.conversions, revenue: r2(row.revenue + s.revenue) } : row;
  });
  for (const [k, s] of sum) {
    if (seen.has(k)) continue;
    const [flowId, date] = k.split("|");
    out.push({ flowId, date, conversions: s.conversions, revenue: r2(s.revenue), recipients: 0, delivered: 0, opensUnique: 0, clicksUnique: 0 } as T);
  }
  return out;
}
