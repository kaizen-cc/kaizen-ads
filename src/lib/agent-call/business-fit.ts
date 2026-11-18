// What fits a client's business, for every agent answering about that client on a call or in chat: the business
// model and sub-category (from business-model.ts: their industry, sub-vertical and what they told us in setup), and
// the tactics that fit that kind of business and the ones that don't, so a restaurant never gets ecommerce flows
// (browse or checkout abandonment, cart upsells). Unknown: the agent asks, or says what it's assuming. Pure.

export type BusinessModelKey = "ecommerce" | "restaurant" | "bookings" | "local_service" | "lead_gen";

/** The finer kind of business the tactics depend on (a hotel books like a spa but sells like neither) */
export type FitKind = "restaurant" | "hotel" | "ecommerce" | "subscription" | "bookings" | "local_service" | "lead_gen";

type Fit = { label: string; fits: string; avoid: string };

export const FIT: Record<FitKind, Fit> = {
  restaurant: {
    label: "a restaurant",
    fits: "loyalty and rewards, online ordering through their ordering system (Toast or similar), reservations, location-based sends by store, birthday offers, catering and private events, limited-time menu drops, happy hour and events, gift cards, win-back for lapsed guests",
    avoid: "ecommerce tactics: browse abandonment, cart or checkout abandonment, product upsells and cross-sells, back in stock, shipping offers",
  },
  hotel: {
    label: "a hotel or resort",
    fits: "direct booking offers, pre-arrival and post-stay sends, booking abandonment from the booking engine (Cloudbeds or similar), seasonal and package offers, local events, room upgrades and add-ons, the loyalty or returning-guest offer, reviews after the stay",
    avoid: "store tactics: product upsells, back in stock, shipping offers",
  },
  ecommerce: {
    label: "an online store",
    fits: "welcome series, browse abandonment, cart and checkout abandonment, post-purchase and cross-sell, win-back, back in stock, VIP and loyalty, product launches, bundles",
    avoid: "local-only tactics (reservations, store visits) unless they also have a location",
  },
  subscription: {
    label: "a subscription business",
    fits: "the welcome and first-box series, subscription start and onboarding, skip and pause saves, cancellation win-back, upgrade and add-on offers, referral, renewal reminders, plus the store flows for one-time buyers",
    avoid: "tactics that push one-off discounts on subscribers or train them to cancel and come back for a deal",
  },
  bookings: {
    label: "an appointments business (spa, salon, fitness, clinic)",
    fits: "the first-visit offer, booking reminders and no-show saves, rebooking after a visit, memberships and packages, seasonal treatments, referral rewards, reviews after a visit",
    avoid: "ecommerce flows (cart or checkout abandonment, back in stock, shipping offers)",
  },
  local_service: {
    label: "a local service business",
    fits: "fast lead follow-up, estimate and appointment reminders, seasonal maintenance, financing and guarantees, reviews and referrals after a job, service-area targeting",
    avoid: "ecommerce flows (cart or checkout abandonment, product upsells, back in stock)",
  },
  lead_gen: {
    label: "a lead generation business",
    fits: "fast lead follow-up and nurture, consult or call booking, show-up reminders, case studies and proof, re-engaging cold leads, referral",
    avoid: "ecommerce flows (cart or checkout abandonment, product upsells, back in stock)",
  },
};

/** The finer kind, from the model and the words of their industry ("Hotel", "Boutique hotel", "Coffee subscription") */
export function fitKindOf(model: BusinessModelKey, industryWords: string): FitKind {
  const w = industryWords.toLowerCase();
  if (/\b(?:hotels?|resorts?|inns?|lodg\w*|motels?|hospitality|bed and breakfast|b&b|vacation rentals?|glamping)\b/.test(w)) return "hotel";
  if (model === "ecommerce" && /\bsubscri\w*/.test(w)) return "subscription";
  return model;
}

export type ClientBusiness = { client: string; model: BusinessModelKey | null; also: BusinessModelKey | null; industry: string | null; sub: string | null };

/**
 * The business block every agent reads about a client in play: what the business is (model, industry and
 * sub-category), the tactics that fit and the ones that don't, and the rule to suggest only what fits. Unknown: ask
 * or say what you're assuming.
 */
export function businessFitBlock(b: ClientBusiness): string {
  const name = b.client.replace(/"/g, "");
  const where = [b.industry, b.sub].filter(Boolean).join(", ");
  if (!b.model) {
    return `<client_business client="${name}">\nBusiness type: not on record.\nBefore suggesting tactics (flows, offers, campaigns), ask what kind of business ${name} is in a few words, or say plainly what you're assuming ("Assuming they sell online…").\n</client_business>`;
  }
  const kind = fitKindOf(b.model, `${b.industry ?? ""} ${b.sub ?? ""}`);
  const f = FIT[kind];
  // A restaurant's catering and event inquiries are already in its own list
  const also = b.also && b.also !== b.model && kind !== "restaurant" ? FIT[fitKindOf(b.also, "")] : null;
  return [
    `<client_business client="${name}">`,
    `Business type: ${f.label}${where ? ` (${where})` : ""}${also ? `; also runs as ${also.label}` : ""}.`,
    `Only suggest tactics that fit this business. What fits: ${f.fits}.${also ? ` For the ${also.label} side: ${also.fits}.` : ""}`,
    `What doesn't fit: ${f.avoid}. Never suggest these unless the person asks for them.`,
    `Lean on your own knowledge items for this kind of business (its setups and integrations) when you have them.`,
    `</client_business>`,
  ].join("\n");
}
