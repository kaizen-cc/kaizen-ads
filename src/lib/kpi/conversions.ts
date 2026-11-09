/**
 * What a KPI counts as a result. Meta reports many action types for the same thing, so each conversion
 * lists them in order of preference; the first one the account actually reports is used for the whole period.
 */
export type Conversion = {
  key: string;
  label: string;
  /** Meta action types, best first */
  types?: string[];
  /** Counted from a column instead of actions */
  field?: "unique_link_clicks" | "link_clicks";
  /** ROAS: higher is better and the KPI is a multiple, not a cost */
  roas?: boolean;
  platforms: ("meta" | "google")[];
};

export const CONVERSIONS: Conversion[] = [
  { key: "purchases", label: "Purchases", types: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"], platforms: ["meta"] },
  { key: "roas", label: "ROAS", types: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"], roas: true, platforms: ["meta"] },
  { key: "lead_form", label: "Meta Lead Form", types: ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead"], platforms: ["meta"] },
  { key: "website_lead", label: "Website Lead", types: ["offsite_conversion.fb_pixel_lead", "lead"], platforms: ["meta"] },
  { key: "schedules", label: "Website Schedules", types: ["schedule_total", "schedule_website", "offsite_conversion.fb_pixel_schedule"], platforms: ["meta"] },
  { key: "applications", label: "Applications", types: ["submit_application_total", "submit_application_website", "offsite_conversion.fb_pixel_submit_application"], platforms: ["meta"] },
  { key: "landing_page_views", label: "Landing Page Views", types: ["landing_page_view", "omni_landing_page_view"], platforms: ["meta"] },
  { key: "link_clicks", label: "Link Clicks", field: "unique_link_clicks", platforms: ["meta"] },
  { key: "add_to_cart", label: "Adds to Cart", types: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"], platforms: ["meta"] },
  { key: "engagement", label: "Engagement", types: ["post_engagement"], platforms: ["meta"] },
  { key: "custom", label: "Custom Conversion", platforms: ["meta", "google"] },
  { key: "conversions", label: "Conversions", types: ["conversions"], platforms: ["google"] },
  // Every campaign counted by what it's optimized for (one for registrations, another for a schedule event): Meta reads
  // each campaign's goal from its ad sets; on Google a campaign's conversions already follow its own goals
  { key: "campaign_goal", label: "Each campaign's own goal", types: ["campaign_goal"], platforms: ["meta", "google"] },
  { key: "google_roas", label: "ROAS", types: ["conversions"], roas: true, platforms: ["google"] },
  { key: "google_clicks", label: "Clicks", field: "link_clicks", platforms: ["google"] },
];

export const conversionFor = (key: string) => CONVERSIONS.find((c) => c.key === key) ?? CONVERSIONS[0];

// ─── Counting a result ────────────────────────────────────────────────────────

/**
 * The purchase action types, best first. Meta reports ONE purchase under all of them at once (omni_purchase, purchase,
 * offsite_conversion.fb_pixel_purchase, onsite_web_purchase, web_in_store_purchase...), so they are never added together.
 */
export const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

/** Kaizen's attribution standard for every Meta insights request: 7-day click, 1-day view (what Ads Manager shows by default). */
export const META_ATTRIBUTION = ["7d_click", "1d_view"] as const;

/** Meta's actions list ([{ action_type, value }]) or an already-built map, as action_type → number. */
export function actionMap(list: unknown): Record<string, number> {
  if (!list) return {};
  if (!Array.isArray(list)) return Object.fromEntries(Object.entries(list as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]));
  const out: Record<string, number> = {};
  for (const a of list as { action_type?: string; value?: unknown }[]) if (a?.action_type) out[a.action_type] = Number(a.value) || 0;
  return out;
}

/**
 * The insights fields every Meta pull asks for besides `actions`: Meta reports most standard events (Schedule, Contact,
 * Submit application, Start trial, Subscribe, Find location, Customize product, Donate) only in `conversions`, as
 * schedule_total / schedule_website and the like. Without them a campaign optimized for website schedules counts 0.
 */
export const CONVERSION_FIELDS = "conversions,conversion_values";

/**
 * Days stored before this were read without CONVERSION_FIELDS (no schedules, contacts, applications...): an account
 * with any such day still in range is read again in full once, then only its last days as usual.
 */
export const CONVERSIONS_READ_FROM = "2026-11-09T18:00:00Z";

type ActionList = { action_type?: string; value?: unknown }[];

/**
 * One insights row with its `conversions` and `conversion_values` folded into `actions` and `action_values` (as
 * Meta's lists), so everything that reads actions sees the standard events too. A type already in actions is kept as
 * it is (never counted twice); the two conversion fields are dropped once folded in.
 */
export function foldConversions<T extends Record<string, unknown>>(row: T): T {
  const merge = (base: unknown, extra: unknown) => {
    const list = Array.isArray(base) ? (base as ActionList) : [];
    if (!Array.isArray(extra) || !extra.length) return base;
    const have = new Set(list.map((a) => a?.action_type));
    return [...list, ...(extra as ActionList).filter((a) => a?.action_type && !have.has(a.action_type))];
  };
  const { conversions, conversion_values, ...rest } = row as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  const actions = merge(rest.actions, conversions);
  const values = merge(rest.action_values, conversion_values);
  if (actions !== undefined) out.actions = actions;
  if (values !== undefined) out.action_values = values;
  return out as T;
}

/**
 * Which one of `types` a set of rows reports: the first, in order of preference, with any count over the whole period.
 * Chosen once for the whole period so every day (and every ad) is counted the same way.
 */
export function reportedType(rows: Record<string, number>[], types: string[] = PURCHASE_TYPES): string | null {
  for (const t of types) if (rows.some((r) => (r[t] ?? 0) > 0)) return t;
  return null;
}

/**
 * The one count of a result over some rows (days or ads): the type the rows report (see reportedType), summed. The
 * aliases of the same purchase are never added together, and a type is never mixed with another from day to day.
 */
export function countResult(rows: Record<string, number>[], types: string[] = PURCHASE_TYPES): { type: string | null; count: number } {
  const type = reportedType(rows, types);
  return { type, count: type ? rows.reduce((s, r) => s + (r[type] ?? 0), 0) : 0 };
}

/** Purchases over some rows of Meta actions. */
export const countPurchases = (rows: Record<string, number>[]) => countResult(rows, PURCHASE_TYPES).count;

/** The label a target shows: "Purchases", or "ROAS", or the custom action when it's custom. */
export function conversionLabel(key: string, custom?: string | null) {
  const c = conversionFor(key);
  if (c.key === "custom" && custom) return custom.replace(/^offsite_conversion\.custom\./, "Custom ").replace(/^action:/, "");
  return c.label;
}

// ─── Each campaign's own goal ─────────────────────────────────────────────────

// The action types Meta reports for each optimization event, best first. The standard events without an omni_ type
// (Schedule, Contact, Submit application...) come through the insights' `conversions` field (see CONVERSION_FIELDS)
// as <event>_total and <event>_website; the pixel's own name and the onsite_web_ alias are kept as fallbacks.
const std = (e: string) => [`${e}_total`, `${e}_website`, `offsite_conversion.fb_pixel_${e}`, `onsite_web_${e}`];
const EVENT_ACTIONS: Record<string, string[]> = {
  PURCHASE: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  LEAD: ["offsite_conversion.fb_pixel_lead", "lead", "onsite_web_lead"],
  COMPLETE_REGISTRATION: ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  SCHEDULE: std("schedule"),
  SUBMIT_APPLICATION: std("submit_application"),
  CONTACT: std("contact"),
  START_TRIAL: std("start_trial"),
  SUBSCRIBE: std("subscribe"),
  FIND_LOCATION: std("find_location"),
  CUSTOMIZE_PRODUCT: std("customize_product"),
  DONATE: std("donate"),
  ADD_TO_CART: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  INITIATED_CHECKOUT: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
  ADD_PAYMENT_INFO: ["omni_add_payment_info", "add_payment_info", "offsite_conversion.fb_pixel_add_payment_info"],
  CONTENT_VIEW: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  OTHER: ["offsite_conversion.fb_pixel_custom"],
};
// Each event as Ads Manager names its results column, so a campaign's line reads "Website schedules" as on Meta
const EVENT_LABELS: Record<string, string> = {
  PURCHASE: "Website purchases",
  LEAD: "Website leads",
  COMPLETE_REGISTRATION: "Website registrations completed",
  SCHEDULE: "Website schedules",
  SUBMIT_APPLICATION: "Website applications submitted",
  CONTACT: "Website contacts",
  START_TRIAL: "Website trials started",
  SUBSCRIBE: "Website subscriptions",
  FIND_LOCATION: "Website location searches",
  CUSTOMIZE_PRODUCT: "Website product customizations",
  DONATE: "Website donations",
  ADD_TO_CART: "Website adds to cart",
  INITIATED_CHECKOUT: "Website checkouts initiated",
  ADD_PAYMENT_INFO: "Website payment info adds",
  CONTENT_VIEW: "Website content views",
  OTHER: "Custom event",
};
// Optimization goals that aren't a pixel event
const GOAL_ACTIONS: Record<string, [string, string[]]> = {
  LEAD_GENERATION: ["Instant form leads", ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead"]],
  QUALITY_LEAD: ["Instant form leads", ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead"]],
  LINK_CLICKS: ["Link clicks", ["link_click"]],
  LANDING_PAGE_VIEWS: ["Landing page views", ["landing_page_view", "omni_landing_page_view"]],
  POST_ENGAGEMENT: ["Engagement", ["post_engagement"]],
  CONVERSATIONS: ["Conversations", ["onsite_conversion.messaging_conversation_started_7d"]],
  THRUPLAY: ["ThruPlays", ["video_view"]],
};
const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * What a campaign is optimized for, as the action types that count as its result and a name for it. From its ad set's
 * optimization goal and promoted object (the pixel event, a custom event or a custom conversion).
 */
export function goalOf(goal: string | null, event: string | null, customConversion: { id: string; name: string | null } | null): { label: string; actions: string[] } | null {
  if (customConversion) return { label: customConversion.name ?? "Custom conversion", actions: [`offsite_conversion.custom.${customConversion.id}`, "offsite_conversion.fb_pixel_custom"] };
  if (event && EVENT_ACTIONS[event]) return { label: EVENT_LABELS[event] ?? pretty(event), actions: EVENT_ACTIONS[event] };
  if (goal && GOAL_ACTIONS[goal]) return { label: GOAL_ACTIONS[goal][0], actions: GOAL_ACTIONS[goal][1] };
  // Any other standard event Meta adds: its usual names, so it still counts
  if (event && /^[A-Z_]+$/.test(event)) {
    const e = event.toLowerCase();
    return { label: pretty(event), actions: [`omni_${e}`, e, ...std(e)] };
  }
  return null;
}

/**
 * When a campaign's goal can't be read, its result is the strongest one it reports, in this order: a sale, then a
 * booking, an application, a sign-up, a lead, a contact, then steps toward them.
 */
export const MAIN_RESULTS = [
  "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase",
  "schedule_total", "schedule_website", "offsite_conversion.fb_pixel_schedule",
  "submit_application_total", "submit_application_website", "offsite_conversion.fb_pixel_submit_application",
  "omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration",
  "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead", "lead",
  "start_trial_total", "start_trial_website", "subscribe_total", "subscribe_website",
  "contact_total", "contact_website", "offsite_conversion.fb_pixel_contact",
  "onsite_conversion.messaging_conversation_started_7d",
  "omni_initiated_checkout", "initiate_checkout",
  "omni_add_to_cart", "add_to_cart",
  "landing_page_view", "link_click",
];
