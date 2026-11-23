// A second order system email earns through (Crust Pizza Co.: Toast's Placed Order and a custom POS integration's
// order metric), found by the sync before anyone ranks it: the account's order-like metrics that aren't ranked yet,
// and how much revenue Klaviyo credits to email on each (a metric aggregate grouped by the attributed message, which
// only attributed orders carry). Pure, so it is tested; the calls are in api.ts, the weekly check in store.ts.

import type { KlaviyoMetric } from "./core";
import { MAX_CONVERSION_METRICS, type ConversionMetric } from "@/lib/email-metrics";

/** Names an order (placed, completed, a closed check, a purchase, a sale) */
const ORDER = /\b(placed order|order placed|completed order|order completed|new order|orders?|purchase[ds]?|checkout completed|closed check|check closed|transaction|sale)\b/i;
/** Order-like names that are a step, a line item or an undo, never the order itself */
const NOT_ORDER = /ordered product|product ordered|line item|item|cancel|refund|return|fulfill|ship|deliver|started checkout|checkout started|viewed|abandon|added|subscri|review|status|updated|edited|paid out/i;

/** How many unranked metrics one check reads (each is one Events-tier aggregate call) */
export const MAX_CANDIDATES = 3;

/** The account's order metrics not ranked yet, most order-like first (a "Placed Order" before a "Sale"), at most three */
export function sourceCandidates(all: KlaviyoMetric[], rankedIds: string[]): KlaviyoMetric[] {
  const ranked = new Set(rankedIds);
  const score = (m: KlaviyoMetric) => (/placed order|order placed/i.test(m.name) ? 0 : /order/i.test(m.name) ? 1 : 2);
  return all
    .filter((m) => !ranked.has(m.id) && ORDER.test(m.name) && !NOT_ORDER.test(m.name))
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);
}

/**
 * A metric aggregate grouped by "$attributed_message" as the attributed total: the rows with a message carry the orders
 * Klaviyo credits to email; the row without one (blank, "none", "null") is everything else and is left out.
 */
export function parseAttributedTotal(pages: unknown[]): { revenue: number; orders: number } {
  let revenue = 0;
  let orders = 0;
  for (const json of pages) {
    const attrs = ((json as { data?: { attributes?: { data?: unknown[] } } } | null)?.data?.attributes ?? {}) as { data?: unknown[] };
    for (const r of Array.isArray(attrs.data) ? attrs.data : []) {
      const row = (r ?? {}) as { dimensions?: unknown[]; measurements?: { sum_value?: unknown[]; count?: unknown[] } };
      const msg = String(row.dimensions?.[0] ?? "").trim();
      if (!msg || /^(none|null|undefined|\$none)$/i.test(msg)) continue;
      const add = (xs: unknown[] | undefined) => (Array.isArray(xs) ? xs.reduce<number>((t, v) => t + (Number.isFinite(Number(v)) ? Number(v) : 0), 0) : 0);
      revenue += add(row.measurements?.sum_value);
      orders += add(row.measurements?.count);
    }
  }
  return { revenue: Math.round(revenue * 100) / 100, orders: Math.round(orders) };
}

/** What the weekly check keeps (sync_state "klaviyo-sources:<client>") */
export type SourcesMemo = { at: string; found: { id: string; name: string; integration: string | null; revenue: number; orders: number }[]; error?: string | null };

/** The check runs once a week per client */
export const SOURCES_EVERY_MS = 7 * 86_400_000;

/**
 * The ranking nobody picked by hand, kept up to date by itself: every order system email earns through is read, the one
 * Klaviyo credits the most revenue to (last 30 days) first. `current` is the ranked list (primary first), `found` the
 * weekly check's unranked order metrics with their attributed revenue, `primaryRevenue` the primary's own (the synced
 * days). Null when nothing changes. A ranking a lead or an exec set by hand is never touched (the caller checks).
 */
export function autoRank(current: ConversionMetric[], found: SourcesMemo["found"], primaryRevenue: number | null, integrationOf: Map<string, string | null> = new Map()): ConversionMetric[] | null {
  const have = new Set(current.map((m) => m.id));
  // Another order system adds its sales (Toast next to a POS's API, Shopify next to Speakeasy); a second metric of the
  // SAME system (Toast's "Prepared Order" next to its "Placed Order") is the same orders at another step: never added by
  // itself, so nothing is counted twice. A lead can still rank it by hand on the Klaviyo card.
  const sys = (i: string | null | undefined) => (i ?? "").trim().toLowerCase();
  const systems = new Set(current.map((m) => sys(m.integration ?? integrationOf.get(m.id))).filter(Boolean));
  const fresh: SourcesMemo["found"] = [];
  for (const f of [...(found ?? [])].sort((a, b) => Number(b.revenue) - Number(a.revenue))) {
    if (!f?.id || have.has(f.id) || !(Number(f.revenue) > 0)) continue;
    const s = sys(f.integration ?? integrationOf.get(f.id));
    if (s && systems.has(s)) continue;
    if (s) systems.add(s);
    fresh.push(f);
  }
  if (!fresh.length || !current.length) return null;
  const [primary0, ...rest] = current;
  const primary = { ...primary0, integration: primary0.integration ?? integrationOf.get(primary0.id) ?? null };
  const top = [{ m: primary, revenue: primaryRevenue ?? 0 }, ...fresh.map((f) => ({ m: { id: f.id, name: f.name, integration: f.integration ?? null, revenueSource: true } as ConversionMetric, revenue: Number(f.revenue) }))]
    // The most revenue first; a tie keeps the primary where it is
    .sort((a, b) => b.revenue - a.revenue || (a.m.id === primary.id ? -1 : b.m.id === primary.id ? 1 : 0))
    .map((x) => x.m);
  const list = [...top, ...rest].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i).slice(0, MAX_CONVERSION_METRICS);
  // Every metric on the list counts as revenue: the old primary stays one when a bigger source moves above it
  return list.map((m) => (m.id === primary.id && list[0].id !== primary.id ? { ...m, revenueSource: true } : m));
}
