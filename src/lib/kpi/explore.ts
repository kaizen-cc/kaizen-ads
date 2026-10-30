import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSnapshot, nyParts, pickType, resultsOf, type Day, type Snapshot } from "./calc";
import { CONVERSIONS, conversionFor } from "./conversions";
import { accountRows, type CampaignRow } from "./sync";

// The KPI card's explorer: the same numbers recomputed live for any "counts as a result" before it's saved, what the
// account actually reports (so it's clear what's pulling and what isn't), and extra metric boxes a client's card can
// carry (ROAS next to cost per lead, engagement, CTR…), chosen per KPI so they don't change anyone else's view.

/** Extra metrics a KPI card can show. `action:<type>` (any action the account reports) is allowed too. */
export const METRICS = [
  { key: "roas", label: "ROAS", unit: "x" },
  { key: "revenue", label: "Purchase value", unit: "$" },
  { key: "purchases", label: "Purchases", unit: "" },
  { key: "cost_per_purchase", label: "Cost per purchase", unit: "$" },
  { key: "leads", label: "Leads (all)", unit: "" },
  { key: "cost_per_lead", label: "Cost per lead", unit: "$" },
  { key: "engagement", label: "Engagement", unit: "" },
  { key: "cost_per_engagement", label: "Cost per engagement", unit: "$" },
  { key: "link_clicks", label: "Link clicks", unit: "" },
  { key: "ctr", label: "Link CTR", unit: "%" },
  { key: "cpc", label: "Cost per link click", unit: "$" },
  { key: "cpm", label: "CPM", unit: "$" },
  { key: "impressions", label: "Impressions", unit: "" },
  { key: "landing_page_views", label: "Landing page views", unit: "" },
  { key: "add_to_cart", label: "Adds to cart", unit: "" },
  { key: "checkouts", label: "Checkouts started", unit: "" },
  { key: "video_views", label: "3-second video views", unit: "" },
  { key: "spend", label: "Spend", unit: "$" },
] as const;

/** The Google catalog: its own keys (g_), so a box always says what it measures on that platform. */
export const GOOGLE_METRICS = [
  { key: "g_conversions", label: "Conversions", unit: "" },
  { key: "g_cost_per_conversion", label: "Cost per conversion", unit: "$" },
  { key: "g_value", label: "Conversion value", unit: "$" },
  { key: "g_roas", label: "ROAS", unit: "x" },
  { key: "g_conv_rate", label: "Conversion rate", unit: "%" },
  { key: "g_clicks", label: "Clicks", unit: "" },
  { key: "g_ctr", label: "CTR", unit: "%" },
  { key: "g_cpc", label: "Avg. CPC", unit: "$" },
  { key: "g_cpm", label: "CPM", unit: "$" },
  { key: "g_impressions", label: "Impressions", unit: "" },
  { key: "g_search_is", label: "Search impression share", unit: "%" },
  { key: "g_lost_budget", label: "Search share lost to budget", unit: "%" },
  { key: "g_lost_rank", label: "Search share lost to rank", unit: "%" },
  { key: "spend", label: "Spend", unit: "$" },
] as const;

const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const LEAD = ["onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead", "lead"];
const firstOf = (days: Day[], types: string[]) => types.find((t) => days.some((d) => (d.actions[t] ?? 0) > 0)) ?? types[0];

/** Friendlier names for Meta's action types. */
export function actionLabel(type: string) {
  // Google: all conversions together, or one conversion action by its name
  if (type === "conversions") return "All conversions (Google)";
  if (type.startsWith("action:")) return type.slice(7);
  const known: Record<string, string> = {
    omni_purchase: "Purchases (all)",
    purchase: "Purchases",
    "offsite_conversion.fb_pixel_purchase": "Purchases (pixel)",
    lead: "Leads",
    "offsite_conversion.fb_pixel_lead": "Website leads (pixel)",
    "onsite_conversion.lead_grouped": "Meta lead forms",
    leadgen_grouped: "Lead form submissions",
    schedule_total: "Schedules (all)",
    schedule_website: "Website schedules",
    "offsite_conversion.fb_pixel_schedule": "Schedules (pixel)",
    submit_application_total: "Applications (all)",
    landing_page_view: "Landing page views",
    omni_landing_page_view: "Landing page views (all)",
    link_click: "Link clicks",
    post_engagement: "Post engagement",
    page_engagement: "Page engagement",
    video_view: "3-second video views",
    omni_add_to_cart: "Adds to cart (all)",
    add_to_cart: "Adds to cart",
    omni_initiated_checkout: "Checkouts started (all)",
    initiate_checkout: "Checkouts started",
    "onsite_conversion.messaging_conversation_started_7d": "Messaging conversations",
    contact_total: "Contacts",
    complete_registration: "Registrations",
    omni_complete_registration: "Registrations (all)",
    view_content: "Content views",
    omni_view_content: "Content views (all)",
    omni_purchase_value: "Purchase value",
    schedule: "Schedules",
    submit_application: "Applications",
    contact: "Contacts",
    "offsite_conversion.fb_pixel_complete_registration": "Registrations (pixel)",
    "offsite_conversion.fb_pixel_view_content": "Content views (pixel)",
    "offsite_conversion.fb_pixel_custom": "Custom pixel events",
  };
  if (known[type]) return known[type];
  if (type.startsWith("offsite_conversion.custom.")) return `Custom conversion ${type.split(".").pop()}`;
  return type.replace(/^(onsite_conversion|offsite_conversion|omni)\./, "").replaceAll("_", " ");
}

type Agg = { spend: number; impressions: number; clicks: number; actions: Record<string, number>; values: Record<string, number> };
function sum(rows: CampaignRow[]): Agg {
  const a: Agg = { spend: 0, impressions: 0, clicks: 0, actions: {}, values: {} };
  for (const r of rows) {
    a.spend += Number(r.spend) || 0;
    a.impressions += Number(r.impressions) || 0;
    a.clicks += Number(r.link_clicks) || 0;
    for (const [k, v] of Object.entries(r.actions ?? {})) a.actions[k] = (a.actions[k] ?? 0) + Number(v);
    for (const [k, v] of Object.entries(r.action_values ?? {})) a.values[k] = (a.values[k] ?? 0) + Number(v);
  }
  return a;
}

function metricValue(key: string, a: Agg, days: Day[]): number | null {
  const div = (x: number, y: number) => (y ? x / y : null);
  const purchase = firstOf(days, PURCHASE);
  const lead = firstOf(days, LEAD);
  if (key.startsWith("action:")) return a.actions[key.slice(7)] ?? 0;
  if (key.startsWith("cost:")) return div(a.spend, a.actions[key.slice(5)] ?? 0);
  const is = (k: string) => (a.actions["_is:eligible"] ? ((a.actions[k] ?? 0) / a.actions["_is:eligible"]) * 100 : null);
  switch (key) {
    case "g_conversions": return a.actions.conversions ?? 0;
    case "g_cost_per_conversion": return div(a.spend, a.actions.conversions ?? 0);
    case "g_value": return a.values.conversions ?? 0;
    case "g_roas": return div(a.values.conversions ?? 0, a.spend);
    case "g_conv_rate": return a.clicks ? ((a.actions.conversions ?? 0) / a.clicks) * 100 : null;
    case "g_clicks": return a.clicks;
    case "g_ctr": return a.impressions ? (a.clicks / a.impressions) * 100 : null;
    case "g_cpc": return div(a.spend, a.clicks);
    case "g_cpm": return a.impressions ? (a.spend / a.impressions) * 1000 : null;
    case "g_impressions": return a.impressions;
    case "g_search_is": return is("_is:impressions");
    case "g_lost_budget": return is("_is:lost_budget");
    case "g_lost_rank": return is("_is:lost_rank");
    case "roas": return div(a.values[purchase] ?? 0, a.spend);
    case "revenue": return a.values[purchase] ?? 0;
    case "purchases": return a.actions[purchase] ?? 0;
    case "cost_per_purchase": return div(a.spend, a.actions[purchase] ?? 0);
    case "leads": return a.actions[lead] ?? 0;
    case "cost_per_lead": return div(a.spend, a.actions[lead] ?? 0);
    case "engagement": return a.actions.post_engagement ?? 0;
    case "cost_per_engagement": return div(a.spend, a.actions.post_engagement ?? 0);
    case "link_clicks": return a.clicks;
    case "ctr": return a.impressions ? (a.clicks / a.impressions) * 100 : null;
    case "cpc": return div(a.spend, a.clicks);
    case "cpm": return a.impressions ? (a.spend / a.impressions) * 1000 : null;
    case "impressions": return a.impressions;
    case "landing_page_views": return a.actions.landing_page_view ?? a.actions.omni_landing_page_view ?? 0;
    case "add_to_cart": return a.actions.omni_add_to_cart ?? a.actions.add_to_cart ?? 0;
    case "checkouts": return a.actions.omni_initiated_checkout ?? a.actions.initiate_checkout ?? 0;
    case "video_views": return a.actions.video_view ?? 0;
    case "spend": return a.spend;
  }
  return null;
}

export function metricMeta(key: string) {
  if (key.startsWith("action:")) return { key, label: actionLabel(key.slice(7)), unit: "" };
  if (key.startsWith("cost:")) return { key, label: `Cost per ${actionLabel(key.slice(5)).toLowerCase()}`, unit: "$" };
  return [...METRICS, ...GOOGLE_METRICS].find((m) => m.key === key) ?? { key, label: key, unit: "" };
}

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export type Explore = {
  catalog: { key: string; label: string; unit: string }[];
  snapshot: Snapshot;
  resultType: string | null; // the Meta action type counted for the chosen "counts as a result"
  conversions: { key: string; label: string; results30: number; type: string | null }[];
  actions: { type: string; label: string; count30: number; value30: number }[];
  metrics: { key: string; label: string; unit: string; d7: number | null; d14: number | null; d30: number | null; prev30: number | null }[];
};

/** Everything the KPI card's explorer shows, for one target, with the "counts as a result" being tried. */
export async function exploreTarget(
  admin: SupabaseClient,
  t: { ad_account_id: string; platform?: string; target: number | null; monthly_budget: number | null; extra_metrics: string[]; excluded_campaigns?: string[] | null; campaign_results?: Record<string, string> | null },
  tryOut: { conversion: string; custom: string | null; campaignMatch: string | null },
): Promise<Explore> {
  const account = t.ad_account_id.replace(/^act_/, "");
  const all = await accountRows(admin, account, t.platform ?? "meta");
  const m = tryOut.campaignMatch?.trim().toLowerCase();
  const left = new Set(t.excluded_campaigns ?? []);
  const rows = (m ? all.filter((r) => (r.campaign_name ?? "").toLowerCase().includes(m)) : all).filter((r) => !left.has(String(r.campaign_id)));
  const { toDays } = await import("./calc");
  const { goalsFor } = await import("./sync");
  const goals = tryOut.conversion === "campaign_goal" ? await goalsFor(admin, account, t.platform ?? "meta", t.campaign_results) : undefined;
  const days = toDays(rows, null, null, goals, t.platform ?? "meta");
  const now = new Date();
  const snapshot = computeSnapshot(days, { conversion: tryOut.conversion, custom: tryOut.custom, target: t.target, budget: t.monthly_budget, now });
  const conv = conversionFor(tryOut.conversion);

  const today = nyParts(now).date;
  const yesterday = shift(today, -1);
  const between = (from: string, to: string) => rows.filter((r) => r.date >= from && r.date <= to);
  const last = (n: number) => between(shift(yesterday, -(n - 1)), yesterday);
  const d30 = sum(last(30));
  const days30 = days.filter((d) => d.date > shift(yesterday, -30) && d.date <= yesterday);

  const conversions = CONVERSIONS.filter((c) => c.platforms.includes((t.platform ?? "meta") as "meta" | "google") && c.key !== "custom").map((c) => {
    const type = pickType(days30, c, null);
    return { key: c.key, label: c.label, type, results30: Math.round(days30.reduce((n, d) => n + resultsOf(d, c, type), 0) * 10) / 10 };
  });
  const actions = Object.entries(d30.actions)
    .filter(([type, v]) => v > 0 && !type.startsWith("_"))
    .map(([type, count]) => ({ type, label: actionLabel(type), count30: Math.round(count), value30: Math.round(d30.values[type] ?? 0) }))
    .sort((a, b) => b.count30 - a.count30);

  const keys = t.extra_metrics ?? [];
  const metrics = keys.map((key) => {
    const meta = metricMeta(key);
    const at = (r: CampaignRow[]) => {
      const v = metricValue(key, sum(r), toDays(r));
      return v == null ? null : Math.round(v * 100) / 100;
    };
    return { key, label: meta.label, unit: meta.unit, d7: at(last(7)), d14: at(last(14)), d30: at(last(30)), prev30: at(between(shift(yesterday, -59), shift(yesterday, -30))) };
  });

  return { catalog: (t.platform === "google" ? GOOGLE_METRICS : METRICS).map((x) => ({ key: x.key, label: x.label, unit: x.unit })), snapshot, resultType: pickType(days, conv, tryOut.custom), conversions, actions, metrics };
}
