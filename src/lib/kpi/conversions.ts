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
