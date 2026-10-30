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

/** The label a target shows: "Purchases", or "ROAS", or the custom action when it's custom. */
export function conversionLabel(key: string, custom?: string | null) {
  const c = conversionFor(key);
  if (c.key === "custom" && custom) return custom.replace(/^offsite_conversion\.custom\./, "Custom ").replace(/^action:/, "");
  return c.label;
}

// ─── Each campaign's own goal ─────────────────────────────────────────────────

// The action types Meta reports for each optimization event, best first
const EVENT_ACTIONS: Record<string, string[]> = {
  PURCHASE: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  LEAD: ["offsite_conversion.fb_pixel_lead", "lead"],
  COMPLETE_REGISTRATION: ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  SCHEDULE: ["schedule_total", "schedule_website", "offsite_conversion.fb_pixel_schedule"],
  SUBMIT_APPLICATION: ["submit_application_total", "submit_application_website", "offsite_conversion.fb_pixel_submit_application"],
  CONTACT: ["contact_total", "contact_website", "offsite_conversion.fb_pixel_contact"],
  ADD_TO_CART: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  INITIATED_CHECKOUT: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
  CONTENT_VIEW: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  START_TRIAL: ["start_trial_total", "offsite_conversion.fb_pixel_start_trial"],
  SUBSCRIBE: ["subscribe_total", "offsite_conversion.fb_pixel_subscribe"],
  OTHER: ["offsite_conversion.fb_pixel_custom"],
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
  if (event && EVENT_ACTIONS[event]) return { label: event === "OTHER" ? "Custom event" : pretty(event), actions: EVENT_ACTIONS[event] };
  if (goal && GOAL_ACTIONS[goal]) return { label: GOAL_ACTIONS[goal][0], actions: GOAL_ACTIONS[goal][1] };
  return null;
}
