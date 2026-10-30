// The services Kaizen sells, as Kaizen Track names them (its slugs). A client's services are Track's (clients.services,
// mirrored hourly) plus any added here (clients.services_extra) for a client Track doesn't have right.

export const SERVICES = [
  { slug: "facebook-ads", label: "Meta Ads", short: "Meta", platform: "meta" },
  { slug: "google-ads", label: "Google Ads", short: "Google", platform: "google" },
  { slug: "tiktok-ads", label: "TikTok Ads", short: "TikTok", platform: null },
  { slug: "creative", label: "Creative", short: "Creative", platform: null },
  { slug: "email-marketing", label: "Email Marketing", short: "Email", platform: null },
  { slug: "web-design", label: "Web Design", short: "Web", platform: null },
  { slug: "social-media", label: "Social Media", short: "Social", platform: null },
  { slug: "crm", label: "CRM", short: "CRM", platform: null },
] as const;

export type ServiceSlug = (typeof SERVICES)[number]["slug"];

/** Everything the client buys: Track's services and those added in Kaizen Ads, in the order above. */
export function servicesOf(c: { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null }): ServiceSlug[] {
  // Taken off in Kaizen Ads (Track's included) stays off
  const removed = new Set(c.services_removed ?? []);
  const all = new Set([...(c.services ?? []), ...(c.services_extra ?? [])].filter((s) => !removed.has(s)));
  return SERVICES.filter((s) => all.has(s.slug)).map((s) => s.slug);
}

/** A service as a form or sheet names it ("Facebook Ads", "Social Media Management", "Email Marketing") → its slug. */
export function serviceFromName(name: string): ServiceSlug | null {
  const n = name.toLowerCase();
  if (/facebook|meta|instagram/.test(n)) return "facebook-ads";
  if (/google|ppc|search ads|youtube/.test(n)) return "google-ads";
  if (/tik ?tok/.test(n)) return "tiktok-ads";
  if (/creative|content creation|ugc/.test(n)) return "creative";
  if (/e-?mail|klaviyo|newsletter/.test(n)) return "email-marketing";
  if (/web|landing page|site/.test(n)) return "web-design";
  if (/social|organic|community/.test(n)) return "social-media";
  if (/crm|gohighlevel|ghl|hubspot|automation/.test(n)) return "crm";
  return null;
}
