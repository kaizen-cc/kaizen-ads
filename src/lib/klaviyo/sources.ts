// A second order system email earns through (Crust Pizza Co.: Toast's Placed Order and a custom POS integration's
// order metric), found by the sync before anyone ranks it: the account's order-like metrics that aren't ranked yet,
// and how much revenue Klaviyo credits to email on each (a metric aggregate grouped by the attributed message, which
// only attributed orders carry). Pure, so it is tested; the calls are in api.ts, the weekly check in store.ts.

import type { KlaviyoMetric } from "./core";

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
