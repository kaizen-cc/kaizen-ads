// The marketing intake as a question bank, shared by the server and the portal: a short core every client answers, a
// set for how they sell (ecommerce, a local business people visit or book, lead generation), and a set for each service
// they bought from us. The AI then picks and rewords for their industry, adds a few questions only their kind of business
// needs, and fills in what we already know for them to confirm. Our old Google Form was the starting point, not the script.

import type { ServiceSlug } from "@/lib/services";

export type QuestionKind = "long" | "short" | "one" | "many";
export type IntakeQuestion = {
  id: string;
  section: string;
  q: string;
  help?: string;
  kind: QuestionKind;
  options?: string[];
  required?: boolean;
  /** What we already know, for them to confirm or change */
  prefill?: string | null;
};
export type BusinessModel = "ecommerce" | "local" | "leadgen" | "other";
export type IntakeSection = { key: string; title: string; line: string };
export type IntakeForm = { model: BusinessModel; industry: string | null; sections: IntakeSection[]; questions: IntakeQuestion[] };
export type CallType = "dfy" | "dwy";

export const CALLS: Record<CallType, { name: string; line: string; url: string }> = {
  dfy: { name: "Done-for-you onboarding call", line: "Share your screen and we take over: we click through the setup for you while you watch.", url: "https://calendly.com/d/dtgt-nwk-b7s/done-for-you-onboarding-call" },
  dwy: { name: "Done-with-you onboarding call", line: "A quick call to go over your plan together, and finish anything small that's left while you share your screen.", url: "https://calendly.com/d/dtcn-k4q-8z8/done-with-you-onboarding-call" },
};

/** How a business sells, from its industry (the AI can correct it: a restaurant that ships nationwide is ecommerce) */
export function modelFor(industry: string | null | undefined): BusinessModel {
  if (!industry) return "other";
  if (["ecommerce", "cpg"].includes(industry)) return "ecommerce";
  if (["restaurant", "hospitality", "fitness", "med_spa", "entertainment", "automotive"].includes(industry)) return "local";
  if (["home_services", "dental", "medical", "real_estate", "legal", "financial", "education", "professional"].includes(industry)) return "leadgen";
  return "other";
}

const CORE_SECTIONS: IntakeSection[] = [
  { key: "business", title: "Your business", line: "What you sell, and why people pick you" },
  { key: "customers", title: "Your customers", line: "Who buys, where they are and what they care about" },
  { key: "offer", title: "What we'll lead with", line: "The offer, the numbers and what a win looks like" },
  { key: "brand", title: "Your brand", line: "How you look and sound, and what to avoid" },
];
const MODEL_SECTION: Record<BusinessModel, IntakeSection | null> = {
  ecommerce: { key: "model", title: "How you sell online", line: "Products, shipping and your sales calendar" },
  local: { key: "model", title: "How customers find and buy from you", line: "Visits, bookings, orders and your busy times" },
  leadgen: { key: "model", title: "Your leads", line: "What a good lead is and what happens after" },
  other: null,
};
const SERVICE_SECTIONS: Partial<Record<ServiceSlug, IntakeSection>> = {
  "facebook-ads": { key: "meta", title: "Facebook & Instagram ads", line: "What you've tried, who to reach and your budget" },
  "google-ads": { key: "google", title: "Google Ads", line: "What people search, what counts as a result and your budget" },
  "tiktok-ads": { key: "tiktok", title: "TikTok ads", line: "Your budget and who could be on camera" },
  creative: { key: "creative", title: "Your creative", line: "What you love, and who can be in it" },
  "email-marketing": { key: "email", title: "Email & SMS", line: "Your platform, your list and what's running" },
  "web-design": { key: "web", title: "Your website", line: "Where it's built and what it should do better" },
  "social-media": { key: "social", title: "Organic social", line: "Where we post, how often, and who replies" },
  crm: { key: "crm", title: "Your CRM", line: "Your tools and what happens after a lead" },
};
const LAST: IntakeSection[] = [
  { key: "industry", title: "A few more for your industry", line: "Questions only a business like yours needs" },
  { key: "last", title: "Anything else", line: "Last thing before we book your call" },
];

const AGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

const CORE: IntakeQuestion[] = [
  { id: "why", section: "business", q: "Why did you start the business, and what still drives it?", kind: "long", help: "The story behind it: our best ads often start here." },
  { id: "best_sellers", section: "business", q: "What are your best-selling products or services?", kind: "long", required: true },
  { id: "different", section: "business", q: "Why do customers pick you over the alternatives?", kind: "long", required: true, help: "Quality, speed, price, experience, guarantees: what you hear from happy customers." },
  { id: "competitors", section: "business", q: "Which competitors would you most like to beat?", kind: "short", required: true, help: "Names or websites." },
  { id: "seasons", section: "business", q: "Does your business change with the seasons?", kind: "one", options: ["Steady all year", "Busier in some months", "Very seasonal"] },
  { id: "seasons_detail", section: "business", q: "When are your busiest and slowest times?", kind: "short" },
  { id: "ideal_customer", section: "customers", q: "Describe your best customer", kind: "long", required: true, help: "Age, life stage, income, interests, what their day looks like." },
  { id: "gender", section: "customers", q: "Who buys most?", kind: "one", options: ["Mostly women", "Mostly men", "Both about the same"] },
  { id: "ages", section: "customers", q: "Their ages", kind: "many", options: AGES },
  { id: "pains", section: "customers", q: "What problems or frustrations bring them to you?", kind: "long", required: true },
  { id: "hesitations", section: "customers", q: "What makes people hesitate before they buy?", kind: "long", help: "Price, trust, timing, not knowing you: the doubts our ads should answer." },
  { id: "locations", section: "customers", q: "Where are the customers you want?", kind: "short", required: true, help: "Cities, zip codes, a radius around you, or nationwide." },
  { id: "exclude", section: "customers", q: "Any areas we should leave out?", kind: "short" },
  { id: "sources", section: "customers", q: "Where do most new customers come from today?", kind: "many", options: ["Referrals and word of mouth", "Social media", "Google search", "Paid ads", "Walk-ins", "Marketplaces (Amazon, Etsy…)", "Not sure"] },
  { id: "focus_offer", section: "offer", q: "Which offer, product or service should we lead with first?", kind: "long", required: true, help: "Include the price, any promotion and its end date." },
  { id: "aov", section: "offer", q: "What does a new customer spend on their first purchase?", kind: "one", options: ["Under $100", "$100 – $500", "$500 – $1,000", "$1,000 – $2,500", "$2,500 – $5,000", "Over $5,000"] },
  { id: "ltv", section: "offer", q: "And over time, what's a customer worth to you?", kind: "short", help: "Roughly: how often they come back, and what they spend in a year." },
  { id: "win", section: "offer", q: "What would make the first 90 days a win?", kind: "long", required: true, help: "A number if you have one: a cost per lead under $40, 3x return on ad spend, 50 new bookings a month. Not sure? Tell us what you'd be happy with and we'll set the target together." },
  { id: "brand_guide", section: "brand", q: "Do you have brand guidelines?", kind: "long", help: "Paste a link, or tell us your colors, fonts and the feel you want." },
  { id: "voice", section: "brand", q: "How should your ads sound?", kind: "many", options: ["Friendly and casual", "Premium and polished", "Bold and direct", "Funny and playful", "Warm and caring", "Expert and trustworthy"] },
  { id: "proof", section: "brand", q: "Reviews, results, awards or guarantees we can use", kind: "long" },
  { id: "avoid", section: "brand", q: "Anything we should never say or show?", kind: "long", help: "Claims, words, competitors, imagery." },
  { id: "anything", section: "last", q: "Anything else we should know?", kind: "long" },
];

const BY_MODEL: Record<BusinessModel, IntakeQuestion[]> = {
  ecommerce: [
    { id: "hero_products", section: "model", q: "Your hero products, and which have the best margins", kind: "long" },
    { id: "shipping", section: "model", q: "Where do you ship?", kind: "one", options: ["My country only", "A few countries", "Worldwide", "Local delivery or pickup only"] },
    { id: "shipping_policy", section: "model", q: "Free shipping, returns or guarantees we can mention", kind: "short" },
    { id: "store_numbers", section: "model", q: "Monthly orders and your store's conversion rate, if you know them", kind: "short", help: "Rough is fine. It tells us where to start." },
    { id: "sales_calendar", section: "model", q: "Sales and launches coming up", kind: "long", help: "Black Friday, new products, restocks, anniversaries." },
  ],
  local: [
    { id: "how_buy", section: "model", q: "How do customers buy from you?", kind: "many", options: ["Walk in", "Book online", "Call", "Order online or delivery", "Message us"] },
    { id: "booking_system", section: "model", q: "Which booking, ordering or point-of-sale system do you use?", kind: "short", help: "OpenTable, Toast, DoorDash, Vagaro, Square, Mindbody…" },
    { id: "hours", section: "model", q: "Your hours, and your busiest and quietest days", kind: "short", help: "We'll push ads hardest when you have room for more customers." },
    { id: "travel", section: "model", q: "How far will customers travel to you?", kind: "short" },
  ],
  leadgen: [
    { id: "good_lead", section: "model", q: "What counts as a good lead for you?", kind: "long", help: "Who you want calling, and who wastes your time." },
    { id: "lead_preference", section: "model", q: "How do you want leads to reach you?", kind: "many", options: ["Form fills", "Phone calls", "Booked appointments", "Messages (DM or text)"] },
    { id: "follow_up", section: "model", q: "What happens after a lead comes in, and how fast?", kind: "long" },
    { id: "close_rate", section: "model", q: "Out of 10 leads, how many become customers?", kind: "short" },
  ],
  other: [],
};

const BY_SERVICE: Partial<Record<ServiceSlug, IntakeQuestion[]>> = {
  "facebook-ads": [
    { id: "meta_budget", section: "meta", q: "Monthly budget for Facebook and Instagram ads", kind: "short", required: true, help: "What you'll spend on ads with Meta, separate from our fee." },
    { id: "meta_before", section: "meta", q: "Have you run Meta ads before? What worked and what didn't?", kind: "long" },
    { id: "interests", section: "meta", q: "Pages, brands or interests your customers follow", kind: "short" },
    { id: "fav_creative", section: "meta", q: "Your favorite ads or posts you've made", kind: "long", help: "Links to posts, Drive or Dropbox folders, your website." },
    { id: "model_creative", section: "meta", q: "Ads from other brands you'd love to look like", kind: "long", help: "Any industry. It tells us your taste." },
  ],
  "tiktok-ads": [
    { id: "tiktok_budget", section: "tiktok", q: "Monthly budget for TikTok ads", kind: "short", required: true },
    { id: "on_camera", section: "tiktok", q: "Is anyone on your team comfortable on camera?", kind: "one", options: ["Yes, happily", "Maybe, with help", "No, we'd rather not"] },
  ],
  creative: [
    { id: "fav_creative", section: "creative", q: "Your favorite ads or posts you've made", kind: "long", help: "Links to posts, Drive or Dropbox folders, your website." },
    { id: "model_creative", section: "creative", q: "Ads from other brands you'd love to look like", kind: "long", help: "Any industry. It tells us your taste." },
    { id: "talent", section: "creative", q: "Who could appear in photos and videos?", kind: "many", options: ["The owner", "Our team", "Happy customers", "Creators we hire", "Nobody, product only"] },
  ],
  "google-ads": [
    { id: "google_budget", section: "google", q: "Monthly budget for Google Ads", kind: "short", required: true },
    { id: "keywords", section: "google", q: "What would your customers type into Google to find you?", kind: "long", required: true },
    { id: "negative_keywords", section: "google", q: "Searches we should never show up for", kind: "long", help: "Jobs, free, DIY, services you don't offer." },
    { id: "conversions", section: "google", q: "What counts as a result for you?", kind: "many", options: ["Phone calls", "Form fills", "Online purchases", "Bookings", "Store visits"] },
    { id: "call_tracking", section: "google", q: "Do you track phone calls from ads?", kind: "one", options: ["Yes (CallRail or similar)", "No", "Not sure"] },
    { id: "google_before", section: "google", q: "Have you run Google Ads before? How did it go?", kind: "long" },
  ],
  "email-marketing": [
    { id: "email_platform", section: "email", q: "Which email or SMS platform do you use?", kind: "one", options: ["Klaviyo", "Mailchimp", "Attentive", "Postscript", "Omnisend", "HubSpot", "None yet", "Other"] },
    { id: "list_size", section: "email", q: "Roughly how many subscribers?", kind: "one", options: ["Under 1,000", "1,000 – 5,000", "5,000 – 25,000", "25,000 – 100,000", "Over 100,000", "Not sure"] },
    { id: "flows", section: "email", q: "Which automated emails already run?", kind: "many", options: ["Welcome", "Abandoned cart", "Browse abandonment", "After purchase", "Win-back", "Birthday", "None yet", "Not sure"] },
    { id: "email_cadence", section: "email", q: "How often do you email your list today?", kind: "one", options: ["Never or rarely", "Monthly", "Every week", "Several times a week"] },
  ],
  "web-design": [
    { id: "site_platform", section: "web", q: "Where is your website built?", kind: "one", options: ["Shopify", "WordPress", "Wix", "Squarespace", "Webflow", "Other", "No website yet"] },
    { id: "site_goal", section: "web", q: "What should the new site do better?", kind: "long", required: true },
    { id: "site_love", section: "web", q: "Websites you love, and why", kind: "long" },
    { id: "site_pages", section: "web", q: "Pages you know you need", kind: "long" },
  ],
  "social-media": [
    { id: "social_channels", section: "social", q: "Where should we post?", kind: "many", options: ["Instagram", "Facebook", "TikTok", "LinkedIn", "YouTube", "Pinterest", "X"] },
    { id: "social_cadence", section: "social", q: "How often would you like to post?", kind: "one", options: ["A few times a week", "Daily", "Not sure: recommend it"] },
    { id: "social_topics", section: "social", q: "Topics you want more of, and anything off limits", kind: "long" },
    { id: "social_replies", section: "social", q: "Who replies to comments and DMs today?", kind: "short" },
  ],
  crm: [
    { id: "crm_tools", section: "crm", q: "Which CRM and tools do you use today?", kind: "short" },
    { id: "crm_journey", section: "crm", q: "What happens after someone becomes a lead, step by step?", kind: "long", required: true },
    { id: "crm_first", section: "crm", q: "What should we automate first?", kind: "long" },
  ],
};

/** The bank for one client before the AI tailors it: core, how they sell, each service (a question shared by two services asked once) */
export function bankFor(services: ServiceSlug[], model: BusinessModel): IntakeForm {
  const seen = new Set<string>();
  const questions: IntakeQuestion[] = [];
  for (const q of [...CORE.filter((x) => x.section !== "last"), ...BY_MODEL[model], ...services.flatMap((s) => BY_SERVICE[s] ?? []), ...CORE.filter((x) => x.section === "last")]) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    questions.push({ ...q });
  }
  const sections = [...CORE_SECTIONS, ...(MODEL_SECTION[model] ? [MODEL_SECTION[model]!] : []), ...services.map((s) => SERVICE_SECTIONS[s]).filter((x): x is IntakeSection => Boolean(x)), ...LAST];
  return { model, industry: null, sections: sections.filter((s) => questions.some((q) => q.section === s.key) || s.key === "industry"), questions };
}

/** Sections that have questions, in order */
export const sectionsOf = (f: IntakeForm) => f.sections.filter((s) => f.questions.some((q) => q.section === s.key));

/** An answer as text (a pick of several is kept as "A; B") */
export const answered = (v: string | undefined | null) => Boolean(v && v.trim());
