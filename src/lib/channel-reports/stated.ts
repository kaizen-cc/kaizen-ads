import type { EmailMetrics, SocialMetrics } from "./core";

// Numbers the owner states in the report's chat ("Klaviyo shows $12,400 for the month"), the way an ads report takes
// the buyer's own figures (set_reported_numbers): they change the tiles, tables and PDF, not only the text. Kept on the
// report (reports.manual_results.stated) so a refresh or a regenerate keeps them, and applied over the synced numbers
// every time they're worked out. Only what the owner gave is changed. Pure, so it is tested.

type Metrics = EmailMetrics | SocialMetrics;

/** What the owner gave, by name (counts and money as numbers; the engagement rate in percent, 4.2 for 4.2%) */
export type StatedValues = Partial<Record<StatedKey, number>>;
export type Stated = { values: StatedValues; source: string; note?: string | null; by: string | null; byName: string | null; at: string };

export const EMAIL_STATED = ["revenue", "orders", "campaign_revenue", "flow_revenue", "prior_revenue", "prior_orders"] as const;
export const SOCIAL_STATED = ["followers", "reach", "views", "engagement_rate", "prior_followers", "prior_reach", "prior_views", "prior_engagement_rate"] as const;
export type StatedKey = (typeof EMAIL_STATED)[number] | (typeof SOCIAL_STATED)[number];

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x.replace(/[$,%\s]/g, ""))) ? Math.max(0, Number(x.replace(/[$,%\s]/g, ""))) : null);

/** The values a chat tool call gave, kept to the ones this line takes and that are real numbers */
export function statedFrom(platform: "klaviyo" | "social", input: Record<string, unknown>): StatedValues {
  const keys: readonly StatedKey[] = platform === "klaviyo" ? EMAIL_STATED : SOCIAL_STATED;
  const out: StatedValues = {};
  for (const k of keys) {
    const v = num(input[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

/** The owner's stated numbers over the synced ones (a fresh copy; nothing else changes) */
export function applyStated<M extends Metrics>(m: M, stated: Stated | null | undefined): M {
  const v = stated?.values;
  if (!v || !Object.keys(v).length) return m;
  if (m.platform === "klaviyo") {
    const e = structuredClone(m) as EmailMetrics;
    if (v.campaign_revenue != null) e.now.campaignRevenue = v.campaign_revenue;
    if (v.flow_revenue != null) e.now.flowRevenue = v.flow_revenue;
    // Revenue given: it stands; else the parts given add up to it
    if (v.revenue != null) e.now.revenue = v.revenue;
    else if (v.campaign_revenue != null || v.flow_revenue != null) e.now.revenue = e.now.campaignRevenue + e.now.flowRevenue;
    if (v.prior_revenue != null) e.before.revenue = v.prior_revenue;
    if (e.detail) {
      if (v.orders != null) e.detail.orders.now = v.orders;
      if (v.prior_orders != null) e.detail.orders.before = v.prior_orders;
    }
    e.stated = { source: stated!.source, keys: Object.keys(v) };
    return e as M;
  }
  const s = structuredClone(m) as SocialMetrics;
  if (v.followers != null) s.now.followers = v.followers;
  if (v.reach != null) s.now.reach = v.reach;
  if (v.views != null) s.now.views = v.views;
  if (v.engagement_rate != null) s.now.rate = v.engagement_rate / 100;
  if (v.prior_followers != null) s.before.followers = v.prior_followers;
  if (v.prior_reach != null) s.before.reach = v.prior_reach;
  if (v.prior_views != null) s.before.views = v.prior_views;
  if (v.prior_engagement_rate != null) s.before.rate = v.prior_engagement_rate / 100;
  if (v.engagement_rate != null) s.insightsRead = true;
  s.stated = { source: stated!.source, keys: Object.keys(v) };
  return s as M;
}

/** The stated numbers merged with what was stated before (a later figure for the same number wins) */
export function mergeStated(was: Stated | null | undefined, next: Stated): Stated {
  return { ...next, values: { ...(was?.values ?? {}), ...next.values } };
}
