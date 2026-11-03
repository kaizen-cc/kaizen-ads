// The client's onboarding guide in their portal: what each step holds, and the styles and pacing they pick from.
// Shared by the server and the guide.

import type { TrackingKind } from "@/lib/tracking-platforms";

export type MetaStep = { status?: "todo" | "done" | "verified" | "on_call"; at?: string; by?: string; account?: string | null; accountName?: string | null; page?: string | null; pageName?: string | null; typed?: string | null; note?: string | null; checkedAt?: string };
export type GoogleStep = { status?: "todo" | "sent" | "invited" | "verified" | "on_call" | "none"; account?: string | null; at?: string; by?: string; note?: string | null; checkedAt?: string };
/** drive: whether their files were copied into their Drive folder ("partly": some were; driveNote says what went wrong) */
export type AssetsStep = { files?: number; links?: number; at?: string; by?: string; drive?: "saved" | "partly" | "kept here" | null; driveNote?: string | null };
/** An example of their own: an ad or post they love, as a link or a file they uploaded (url: a long-lived link to it) */
export type OwnExample = { kind: "link" | "file"; url: string; name: string; video?: boolean };
export type StyleStep = { styles?: string[]; pacing?: string | null; liked?: { image: string; label: string }[]; own?: OwnExample[]; note?: string; at?: string; by?: string };
/** A real ad in each style, to show what it means (a looping video when there is one) */
export type StyleLook = { image: string; video: string | null };
/**
 * A Google tool (Analytics, Tag Manager, Business Profile, Merchant Center), their website or their email platform:
 * they add our address as an admin (or, on Shopify, send their collaborator code and store address). done: they say
 * it's done (the team checks); on_call: we do it together on the onboarding call (none: they don't have one yet, so we
 * set it up); na: doesn't apply to them (no location for a Business Profile).
 */
export type ToolStep = { status?: "todo" | "done" | "on_call" | "na"; none?: boolean; id?: string | null; at?: string; by?: string; note?: string | null };
/** platform: a WEBSITE_PLATFORMS key; Shopify: their collaborator request code and their myshopify.com address */
export type WebsiteStep = ToolStep & { platform?: string | null; url?: string | null; code?: string | null; store?: string | null };
/** platform: an EMAIL_PLATFORMS key (or what they typed for "other") */
export type EmailStep = ToolStep & { platform?: string | null };
/**
 * Where their orders, bookings or leads live (POS, booking software, CRM, call tracking): each platform they picked,
 * added (our tech address invited), or set up with the tracking team on the call (it can't add a user, or they're not
 * sure). status: done when every pick is added, on_call when the rest waits for the call.
 */
export type TrackingPick = { key: string; name: string; status: "todo" | "done" | "on_call"; at?: string; by?: string };
export type TrackingStep = { status?: "todo" | "done" | "on_call" | "na"; picks?: TrackingPick[]; notSure?: boolean; at?: string; by?: string; note?: string | null };
/** How they sell, as they told us (our guess until then): online orders that ship, a place customers come to */
export type BusinessStep = { ecommerce?: boolean | null; location?: boolean | null; at?: string; by?: string };
export type Guide = { meta: MetaStep; google: GoogleStep; assets: AssetsStep; style: StyleStep; business: BusinessStep; ga4: ToolStep; gtm: ToolStep; gbp: ToolStep; merchant: ToolStep; website: WebsiteStep; email: EmailStep; tracking: TrackingStep };

export type GoogleTool = "ga4" | "gtm" | "gbp" | "merchant";
export const GOOGLE_TOOLS: { key: GoogleTool; name: string; line: string; idLabel: string | null }[] = [
  { key: "ga4", name: "Google Analytics", line: "So we can see what happens after the click", idLabel: "Property ID (optional)" },
  { key: "gtm", name: "Google Tag Manager", line: "So we can add and fix tracking without touching your site", idLabel: "Container ID, like GTM-AB12CD3 (optional)" },
  { key: "gbp", name: "Google Business Profile", line: "Your listing on Google Maps and Search", idLabel: null },
  { key: "merchant", name: "Google Merchant Center", line: "Your products in Google Shopping ads", idLabel: "Merchant Center ID (optional)" },
];
export const WEBSITE_PLATFORMS = [
  { key: "shopify", name: "Shopify" },
  { key: "wordpress", name: "WordPress" },
  { key: "wix", name: "Wix" },
  { key: "squarespace", name: "Squarespace" },
  { key: "webflow", name: "Webflow" },
  { key: "other", name: "Something else" },
] as const;
export const EMAIL_PLATFORMS = [
  { key: "klaviyo", name: "Klaviyo" },
  { key: "mailchimp", name: "Mailchimp" },
  { key: "attentive", name: "Attentive" },
  { key: "postscript", name: "Postscript" },
  { key: "omnisend", name: "Omnisend" },
  { key: "other", name: "Something else" },
] as const;

/** The setup steps by name, for the team and the call brief */
export const STEP_LABELS: Record<string, string> = { tracking: "Orders, bookings & leads", meta: "Meta", google: "Google Ads", tools: "Google tools", website: "Website", email: "Email platform", ga4: "Google Analytics", gtm: "Google Tag Manager", gbp: "Google Business Profile", merchant: "Google Merchant Center" };

/** The looks a client can pick (as many as fit), each with what it means for the creative team */
export const STYLES = [
  { key: "ugc", name: "Real people, phone-shot", line: "Customers or creators talking to camera, like a friend's story", brief: "UGC: real people filmed on a phone, talking to camera" },
  { key: "founder", name: "Founder or team story", line: "The face behind the business, why it exists", brief: "Founder/team-led: the owner or staff on camera telling the story" },
  { key: "testimonial", name: "Reviews and results", line: "What customers say, before and after, proof", brief: "Testimonial/social proof: reviews, results, before and after" },
  { key: "demo", name: "Show it working", line: "The product or service in action, step by step", brief: "Demo: the product or service in use, close up" },
  { key: "lifestyle", name: "Lifestyle", line: "The life your customer wants, with you in it", brief: "Lifestyle: aspirational scenes with the product or place" },
  { key: "studio", name: "Clean and premium", line: "Studio light, simple backgrounds, polished", brief: "Studio/premium: clean, polished product or place shots" },
  { key: "bold", name: "Bold text and graphics", line: "Big headlines, motion graphics, offers that pop", brief: "Text-led/motion graphics: bold headlines and animated text" },
  { key: "trend", name: "Fun and trending", line: "Memes, trends and humor that feel native to the feed", brief: "Native/trend: humor, memes and trending formats" },
] as const;

export const PACING = [
  { key: "fast", name: "Fast", line: "Quick cuts every second or two, high energy", brief: "Fast pacing: cuts every 1-2 seconds" },
  { key: "medium", name: "Steady", line: "A clear story with room to breathe", brief: "Medium pacing: 2-4 second shots" },
  { key: "slow", name: "Slow and cinematic", line: "Long, calm shots that let it sink in", brief: "Slow, cinematic pacing: long, calm shots" },
] as const;

/** Which steps a client has */
export type GuideHas = { meta: boolean; google: boolean; looks: boolean; website: boolean; email: boolean; /** Our guess at whether they sell online, until they say */ ecommerce: boolean | null; /** Ads clients: which platforms their revenue and conversions live in (orders, bookings, leads, store apps), from their industry */ tracking: TrackingKind | null };

/**
 * Which steps a client has, from what they buy: Meta access if we run their Meta ads, Google (and its tools) if Google,
 * their website if we build it or run their ads (tracking), their email platform if we run their email, the look if we
 * run ads or make their creative; their assets always
 */
export function guideSteps(services: string[], ecommerce: boolean | null = null, tracking: TrackingKind | null = null): GuideHas {
  const meta = services.includes("facebook-ads");
  const google = services.includes("google-ads");
  return { meta, google, looks: meta || services.includes("creative") || services.includes("tiktok-ads"), website: services.includes("web-design") || meta || google, email: services.includes("email-marketing"), ecommerce, tracking: meta || google ? tracking : null };
}

/** Whether they sell online: what they told us, a Shopify site, else our guess */
export function isEcommerce(g: Guide, has: GuideHas) {
  return g.business?.ecommerce ?? (g.website?.platform === "shopify" ? true : (has.ecommerce ?? false));
}

/** The Google tools they need: Analytics and Tag Manager always, a Business Profile unless they have no location, Merchant Center if they sell online */
export function googleTools(g: Guide, has: GuideHas): GoogleTool[] {
  if (!has.google) return [];
  return ["ga4", "gtm", ...(g.business?.location === false ? [] : (["gbp"] as const)), ...(isEcommerce(g, has) ? (["merchant"] as const) : [])];
}

/** A tool, website or email step out of their hands: done, on the call, or not for them */
export const toolSettled = (t?: ToolStep) => ["done", "on_call", "na"].includes(t?.status ?? "");

/** Steps done, out of the steps they have */
export function guideProgress(g: Guide, has: GuideHas) {
  const tools = googleTools(g, has);
  const steps = [
    ...(has.meta ? [["verified", "done", "on_call"].includes(g.meta.status ?? "")] : []),
    ...(has.google ? [["sent", "invited", "verified", "on_call", "none"].includes(g.google.status ?? "")] : []),
    ...(tools.length ? [tools.every((t) => toolSettled(g[t]))] : []),
    ...(has.tracking ? [toolSettled(g.tracking)] : []),
    ...(has.website ? [toolSettled(g.website)] : []),
    ...(has.email ? [toolSettled(g.email)] : []),
    Boolean((g.assets.files ?? 0) + (g.assets.links ?? 0)),
    ...(has.looks ? [Boolean(g.style.styles?.length || g.style.pacing)] : []),
  ];
  return { done: steps.filter(Boolean).length, total: steps.length };
}

/**
 * The access still to share, for choosing the onboarding call: every access item they have that isn't shared yet,
 * counting ones saved for the call (they still need doing on it), and whether a big issue came up in setup.
 */
export function accessLeft(g: Guide, has: GuideHas, blockers: unknown[] = []) {
  const items: string[] = [];
  if (has.meta && !["verified", "done"].includes(g.meta.status ?? "")) items.push("meta");
  if (has.google && !["sent", "invited", "verified"].includes(g.google.status ?? "")) items.push("google");
  for (const t of googleTools(g, has)) if (!["done", "na"].includes(g[t]?.status ?? "")) items.push(t);
  if (has.website && !["done", "na"].includes(g.website?.status ?? "")) items.push("website");
  if (has.email && !["done", "na"].includes(g.email?.status ?? "")) items.push("email");
  if (has.tracking && !["done", "na"].includes(g.tracking?.status ?? "")) items.push("tracking");
  return { left: items.length, items, blocker: blockers.length > 0 };
}

/** The onboarding call to book: done-for-you (we take over their screen) with a big issue or 2+ access items left, else done-with-you */
export function callType(a: { left: number; blocker: boolean }): "dfy" | "dwy" {
  return a.blocker || a.left >= 2 ? "dfy" : "dwy";
}
