import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// How a client makes money, for everything that has to be tailored to it: the funnels the media buyers track, the
// KPIs, where their reviews live, the offers that fit and the platforms their revenue or leads sit in. Read from their
// industry and sub-vertical, with what they told us in setup (whether they sell online, whether customers visit). A
// restaurant often runs two models at once (online orders and event inquiries), so a model can carry a second one.

export type BusinessModel = "ecommerce" | "restaurant" | "bookings" | "local_service" | "lead_gen";

type Guide = { label: string; funnels: string[]; kpis: string; reviews: string; offers: string; tracking: string; google: string };

export const MODEL_GUIDE: Record<BusinessModel, Guide> = {
  ecommerce: {
    label: "Online store (ecommerce)",
    funnels: ["Purchase: any page or collection → product page (PDP) → add to cart → initiate checkout → purchase", "Subscription (when they sell one): product or subscribe page → subscription start → renewals"],
    kpis: "ROAS and cost per purchase, new-customer cost (CAC), average order value, lifetime value, subscriptions started, new vs returning revenue",
    reviews: "the store's review app on the website (Judge.me, Okendo, Yotpo, Loox, Stamped), Trustpilot, Google (Business Profile or Merchant Center seller ratings), Facebook, Amazon or other marketplaces they sell on, and long positive comments on their Facebook and Instagram posts",
    offers: "the welcome pop-up offer (email or SMS sign-up), a first-order offer for new customers, free shipping thresholds, bundles and gift-with-purchase, subscription savings, gift cards",
    tracking: "the store platform (Shopify, WooCommerce) and any subscription app (Recharge, Skio, Loop)",
    google: "Shopping and Performance Max from Merchant Center, brand and non-brand search, YouTube",
  },
  restaurant: {
    label: "Restaurant or food service",
    funnels: ["Online order: home → menu or online ordering page → item → cart → checkout → order", "Reservation: home → reservations page → booking confirmed", "Private events or catering (lead gen): home → event inquiry page → thank-you page"],
    kpis: "cost per online order and ROAS on orders, cost per reservation, cost per event or catering inquiry, repeat visits, foot traffic where it can be read",
    reviews: "Google Business Profile, Yelp, TripAdvisor, OpenTable and Resy, Facebook, delivery app ratings (DoorDash, Uber Eats, Grubhub), and long positive comments on their Facebook and Instagram posts",
    offers: "a first online order offer, a free item or dessert, happy hour, events and special menus, loyalty, gift cards, catering packages",
    tracking: "the POS (Toast, Square, Clover, SpotOn), online ordering (Olo, ChowNow, Lunchbox, Owner.com) and reservations (OpenTable, Resy)",
    google: "local search and Maps (Business Profile), brand and cuisine-near-me search, Performance Max for store visits",
  },
  bookings: {
    label: "Appointments and bookings (med spa, salon, fitness, clinic)",
    funnels: ["Booking: home → service page → booking widget → appointment booked", "Consultation (higher-ticket services): landing page → consult form → consult booked → show → purchase"],
    kpis: "cost per booking, cost per consult, show rate, cost per new client, new-client value over 90 days",
    reviews: "Google Business Profile, Yelp, the booking platform (Mindbody, Vagaro, Boulevard, ClassPass), RealSelf for aesthetics, Facebook, and long positive comments on their Facebook and Instagram posts",
    offers: "an intro or first-visit offer, a new-client package, memberships, seasonal treatments, referral rewards",
    tracking: "the booking software (Mindbody, Vagaro, Boulevard, Square Appointments, GlossGenius, Zenoti)",
    google: "local service search (\"near me\"), brand search, Business Profile and Maps",
  },
  local_service: {
    label: "Local services (home services and trades)",
    funnels: ["Lead: landing page → form or call → thank-you page", "In the CRM: lead → appointment or estimate booked → closed won / closed lost"],
    kpis: "cost per lead, cost per booked appointment or estimate, cost per sale (closed won), close rate, average job value",
    reviews: "Google Business Profile, Yelp, the BBB, Angi and HomeAdvisor, Thumbtack, Houzz, Nextdoor, Facebook, and long positive comments on their Facebook and Instagram posts",
    offers: "a free estimate or inspection, financing, a seasonal discount, a guarantee or warranty, same-week service",
    tracking: "the CRM or field-service tool (ServiceTitan, Jobber, Housecall Pro, GoHighLevel) and call tracking (CallRail)",
    google: "local search with tight geo targeting and negatives, Local Services Ads where they qualify, call extensions, Business Profile",
  },
  lead_gen: {
    label: "Lead generation (professional, B2B and high-consideration services)",
    funnels: ["Lead: landing page → form, call or booked call → thank-you page", "In the CRM: lead → qualified → appointment → closed won / closed lost"],
    kpis: "cost per lead, cost per qualified lead, cost per appointment, cost per sale, close rate, lead-to-sale time",
    reviews: "Google Business Profile, Trustpilot, the BBB, Facebook, industry review sites (Avvo for legal, Zillow for real estate, Clutch or G2 for B2B), and long positive comments on their Facebook and Instagram posts",
    offers: "a free consultation, audit or quote, a guide or webinar, a guarantee, limited-time pricing",
    tracking: "the CRM (GoHighLevel, HubSpot, Salesforce) and call tracking (CallRail)",
    google: "high-intent search with negatives, brand search, YouTube for consideration",
  },
};

/** Their model, and a second one when they run two (a restaurant with event inquiries, a store with a showroom) */
export async function businessModelOf(admin: SupabaseClient, clientId: string): Promise<{ model: BusinessModel; also: BusinessModel | null; why: string }> {
  const [{ data: c }, { data: o }] = await Promise.all([
    admin.from("clients").select("industry, industry_detail, vertical_id").eq("id", clientId).maybeSingle(),
    admin.from("client_onboarding").select("business, website").eq("client_id", clientId).maybeSingle(),
  ]);
  const { data: v } = c?.vertical_id ? await admin.from("verticals").select("name").eq("id", c.vertical_id).maybeSingle() : { data: null };
  const industry = (c?.industry as string | null) ?? null;
  const sub = [v?.name, c?.industry_detail].filter(Boolean).join(" ");
  const said = (o?.business ?? {}) as { ecommerce?: boolean; location?: boolean };
  const shop = ((o?.website ?? {}) as { platform?: string }).platform === "shopify";
  const ecommerce = said.ecommerce ?? (shop || industry === "ecommerce" || industry === "cpg");
  const { trackingKind } = await import("@/lib/tracking-platforms");
  const kind = trackingKind(industry, sub, ecommerce);
  const where = [industry, sub].filter(Boolean).join(", ") || "industry not set";
  if (kind === "orders") return { model: "restaurant", also: "lead_gen", why: `${where}: online orders and reservations, with event and catering inquiries as leads` };
  if (kind === "bookings") return { model: "bookings", also: ecommerce ? "ecommerce" : null, why: where };
  if (kind === "store") return { model: "ecommerce", also: said.location ? "local_service" : null, why: where };
  if (/home|roof|hvac|plumb|electric|landscap|pest|clean|fenc|pool|remodel|contract|garage|solar|window|paint|moving|auto/.test(`${industry ?? ""} ${sub}`.toLowerCase())) return { model: "local_service", also: null, why: where };
  return { model: "lead_gen", also: ecommerce ? "ecommerce" : null, why: where };
}

/** The tailoring block every Bible, GTM and brief reads */
export function modelBlock(m: { model: BusinessModel; also: BusinessModel | null; why: string }) {
  const one = (k: BusinessModel) => {
    const g = MODEL_GUIDE[k];
    return `${g.label}\n- Funnels to map: ${g.funnels.join(" | ")}\n- KPIs that matter: ${g.kpis}\n- Where their reviews live: ${g.reviews}\n- Offers that fit: ${g.offers}\n- Where revenue or leads are tracked: ${g.tracking}\n- Google for this model: ${g.google}`;
  };
  return `<business_model note="tailor every section to this; ${m.why}">\n${one(m.model)}${m.also ? `\nAlso runs:\n${one(m.also)}` : ""}\n</business_model>`;
}
