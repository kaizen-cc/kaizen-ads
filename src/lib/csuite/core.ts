import type { LineKpi } from "@/lib/clients-kpi/core";
import type { ServiceSlug } from "@/lib/services";

// The C-suite account review, the pure part: the agenda (an EOS-style weekly full-account review run step by step),
// how far a meeting has got, and the upsell rules (clients beating their KPI on one line who don't buy a fitting
// other line, industry fit, growing spend, and a client who asked about something). No database, no AI: the page, the
// assistant and the tests all say the same thing.

export const STEPS = [
  { key: "scorecard", title: "Scorecard", blurb: "Success ratio and each line's pacing" },
  { key: "critical", title: "Critical accounts", blurb: "Most critical first, with the top reasons" },
  { key: "issues", title: "Issues to resolve", blurb: "Account watch alerts, off-target and at-risk clients" },
  { key: "upsell", title: "Upsell opportunities", blurb: "Who is ready for more, why, and the offer" },
  { key: "financial", title: "Financial overview", blurb: "What each client is billed for" },
  { key: "todos", title: "Decisions and to-dos", blurb: "Who does what, by when" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const stepIndex = (k: string | null | undefined): number => Math.max(0, STEPS.findIndex((s) => s.key === k));
export const asStep = (k: string | null | undefined): StepKey => STEPS[stepIndex(k)].key;

export type ItemState = "discuss" | "done";
export type ItemMark = { state: ItemState; note?: string | null; at?: string };
export type Marks = Record<string, ItemMark>;

/** An agenda item's key: the step and what it's about ("critical:<client id>", "upsell:<client id>:google-ads") */
export const itemKey = (step: StepKey, ...parts: string[]) => [step, ...parts].join(":");

/** How far along the meeting is: items done of all items on the agenda, and per step */
export function progress(items: Record<StepKey, string[]>, marks: Marks): { done: number; total: number; byStep: Record<StepKey, { done: number; total: number }> } {
  const byStep = {} as Record<StepKey, { done: number; total: number }>;
  let done = 0;
  let total = 0;
  for (const s of STEPS) {
    const keys = items[s.key] ?? [];
    const d = keys.filter((k) => marks[k]?.state === "done").length;
    byStep[s.key] = { done: d, total: keys.length };
    done += d;
    total += keys.length;
  }
  return { done, total, byStep };
}

/** A mark set or cleared: "done" twice clears it (a toggle), a note is kept with it */
export function mark(marks: Marks, key: string, state: ItemState | null, note?: string | null, at = new Date().toISOString()): Marks {
  const next = { ...marks };
  if (!state) delete next[key];
  else next[key] = { state, ...(note ? { note: note.slice(0, 1000) } : next[key]?.note ? { note: next[key].note } : {}), at };
  return next;
}

// ─── Upsell ─────────────────────────────────────────────────────────────────

export type UpsellInput = {
  clientId: string;
  name: string;
  services: readonly ServiceSlug[];
  industry: string | null;
  /** The client's KPI chips (every line, not narrowed to the viewer) */
  kpis: readonly LineKpi[];
  /** Ad spend this 14 days against the 14 before (0.3 = up 30%), null when not read */
  spendGrowth?: number | null;
  /** What the client said recently (call summaries, notes from Slack and email), newest first */
  said?: readonly { text: string; source: string; at?: string | null }[];
};

export type Upsell = {
  clientId: string;
  client: string;
  service: ServiceSlug;
  /** The offer, in a line the team can say to the client */
  offer: string;
  /** Why, most telling first */
  why: string[];
  /** For ordering: higher is a stronger case */
  score: number;
};

const OFFER: Record<ServiceSlug, string> = {
  "facebook-ads": "Meta Ads to reach new customers where they scroll",
  "google-ads": "Google Search Ads to catch the people already looking for them",
  "tiktok-ads": "TikTok Ads to test the winning angles on a cheaper, younger audience",
  creative: "A Creative Package so winning ads get fresh variations every month",
  "email-marketing": "Email and SMS flows to turn the traffic we're buying into repeat revenue",
  "web-design": "A landing page rebuild so more of the traffic converts",
  "social-media": "Organic social to keep the brand alive between ads",
  crm: "A CRM setup so every lead gets followed up",
};

/** Industries where a line usually pays off (what the team sells most successfully to whom) */
export const INDUSTRY_FIT: Partial<Record<ServiceSlug, readonly string[]>> = {
  "google-ads": ["home_services", "dental", "medical", "legal", "automotive", "real_estate", "med_spa", "professional", "financial", "education", "ecommerce"],
  "tiktok-ads": ["ecommerce", "cpg", "fitness", "med_spa", "restaurant", "entertainment", "education", "hospitality"],
  "email-marketing": ["ecommerce", "cpg", "restaurant", "hospitality", "fitness", "med_spa", "entertainment", "education"],
  "social-media": ["restaurant", "hospitality", "fitness", "med_spa", "entertainment", "cpg", "ecommerce", "real_estate"],
  "facebook-ads": ["ecommerce", "cpg", "restaurant", "home_services", "fitness", "med_spa", "dental", "real_estate", "entertainment", "hospitality", "education"],
};
const fits = (service: ServiceSlug, industry: string | null) => Boolean(industry && INDUSTRY_FIT[service]?.includes(industry));

/** What a client might ask about, and the line it means */
const ASKS: { service: ServiceSlug; words: RegExp; label: string }[] = [
  { service: "google-ads", words: /\b(google( ads| search)?|ppc|search ads|youtube ads)\b/i, label: "Google" },
  { service: "tiktok-ads", words: /\btik ?tok\b/i, label: "TikTok" },
  { service: "email-marketing", words: /\b(email (marketing|campaigns?|flows?|list)|newsletters?|klaviyo|sms)\b/i, label: "email" },
  { service: "social-media", words: /\b(organic|social media|posting|instagram (posts|content)|content calendar)\b/i, label: "organic social" },
  { service: "web-design", words: /\b(website|web site|landing pages?|new site|site redesign)\b/i, label: "the website" },
  { service: "creative", words: /\b(more (ads|creative|videos)|ugc|video ads|new creatives?)\b/i, label: "more creative" },
  { service: "crm", words: /\b(crm|gohighlevel|go high level|hubspot|lead follow[- ]?up)\b/i, label: "a CRM" },
  { service: "facebook-ads", words: /\b(facebook ads|meta ads|instagram ads)\b/i, label: "Meta ads" },
];
/** The words that make a mention an interest, not a passing word ("are you able to", "we'd love", "thinking about") */
const INTEREST = /\b(interested|asked|asking|want(ed|s)?|would (like|love)|we'?d (like|love)|thinking (about|of)|consider(ing)?|how (about|much)|could (you|we)|can you|do you (do|offer|handle)|are you able|looking (into|for|at)|curious|help (us )?with|start(ing)?|add(ing)?|expand(ing)?)\b/i;

/** The lines a client asked about, from what they said: a line named with an interest word in the same sentence */
export function askedAbout(said: UpsellInput["said"]): { service: ServiceSlug; quote: string; source: string; at: string | null }[] {
  const out: { service: ServiceSlug; quote: string; source: string; at: string | null }[] = [];
  for (const s of said ?? []) {
    for (const sentence of String(s.text ?? "").split(/(?<=[.!?\n])\s+/)) {
      if (!INTEREST.test(sentence)) continue;
      for (const a of ASKS) {
        if (!a.words.test(sentence) || out.some((o) => o.service === a.service)) continue;
        out.push({ service: a.service, quote: sentence.trim().replace(/\s+/g, " ").slice(0, 200), source: s.source, at: s.at ?? null });
      }
    }
  }
  return out;
}

const good = (k: readonly LineKpi[], line: LineKpi["line"]) => k.some((x) => x.line === line && x.tone === "good");
const beatsBy = (k: readonly LineKpi[], line: LineKpi["line"]) => k.find((x) => x.line === line && x.tone === "good") ?? null;

/**
 * The upsells for one client, strongest first. A client beating its KPI on a line is ready for a fitting next line
 * they don't buy; the industry fit, growing spend and their own question add to the case. Never offers what they buy.
 */
export function upsellsFor(c: UpsellInput): Upsell[] {
  const buys = new Set<ServiceSlug>(c.services);
  const found = new Map<ServiceSlug, Upsell>();
  const add = (service: ServiceSlug, why: string, score: number) => {
    if (buys.has(service)) return;
    const u = found.get(service) ?? { clientId: c.clientId, client: c.name, service, offer: OFFER[service], why: [], score: 0 };
    if (!u.why.includes(why)) u.why.push(why);
    u.score += score;
    found.set(service, u);
  };
  const k = c.kpis;
  const ads = (["meta", "google", "tiktok"] as const).filter((l) => good(k, l));
  const label = { meta: "Meta", google: "Google", tiktok: "TikTok" } as const;

  // Winning on Meta: the demand it creates is searched for (Google), the same angles can run cheaper (TikTok)
  if (good(k, "meta")) {
    add("google-ads", `Meta is beating its target (${beatsBy(k, "meta")!.shown})`, 30);
    if (fits("tiktok-ads", c.industry)) add("tiktok-ads", `Meta is beating its target (${beatsBy(k, "meta")!.shown})`, 25);
  }
  // Winning on Google: Meta reaches the people not searching yet
  if (good(k, "google")) add("facebook-ads", `Google is beating its target (${beatsBy(k, "google")!.shown})`, 25);
  // Paid traffic converting well: keep it with email, scale it with more creative
  if (ads.length) {
    const why = `${ads.map((l) => label[l]).join(" and ")} on or better than target`;
    if (fits("email-marketing", c.industry)) add("email-marketing", `${why}, and the traffic we buy isn't being kept by email`, 25);
    add("creative", `${why}; more creative keeps the winners from tiring`, 15);
  }
  // Email healthy: the audience is engaged enough for organic social
  if (good(k, "email") && fits("social-media", c.industry)) add("social-media", `Email is healthy (score ${beatsBy(k, "email")!.shown})`, 15);
  // Off target with good traffic: the site is what's losing them
  if (k.some((x) => x.tone !== "good" && x.reasons.some((r) => /website or landing page update/.test(r.text)))) add("web-design", "Conversion rate is down while click-through holds: the traffic is good, the site isn't converting it", 30);
  // Growing spend: they're investing, and more spend needs more creative
  if (c.spendGrowth != null && c.spendGrowth >= 0.25) {
    add("creative", `Ad spend is up ${Math.round(c.spendGrowth * 100)}% on the 14 days before`, 20);
    if (ads.length) add("google-ads", `Ad spend is up ${Math.round(c.spendGrowth * 100)}%, a sign they're ready to invest more`, 10);
  }
  // Industry fit lifts what's already found
  for (const u of found.values()) if (fits(u.service, c.industry)) u.score += 10;
  // Their own words: the strongest signal, an upsell on its own
  for (const a of askedAbout(c.said)) add(a.service, `They asked about it (${a.source}): "${a.quote}"`, 45);
  // Their question goes first among the reasons
  for (const u of found.values()) u.why.sort((a, b) => Number(b.startsWith("They asked")) - Number(a.startsWith("They asked")));
  return [...found.values()].sort((a, b) => b.score - a.score || a.service.localeCompare(b.service));
}

/** Every client's upsells, the strongest case in the book first (one per client unless `perClient` is more) */
export function upsellBook(clients: readonly UpsellInput[], perClient = 1, limit = 30): Upsell[] {
  return clients
    .flatMap((c) => upsellsFor(c).slice(0, perClient))
    .sort((a, b) => b.score - a.score || a.client.localeCompare(b.client))
    .slice(0, limit);
}

// ─── Financial overview ─────────────────────────────────────────────────────

export type BilledLine = { service: ServiceSlug; amount: number | null; last: string | null };

/** A client's monthly billed total from Stripe's lines (as the Track mirror keeps them), null when none is known */
export function billedTotal(lines: readonly BilledLine[]): number | null {
  const known = lines.filter((l) => l.amount != null && Number.isFinite(l.amount));
  return known.length ? Math.round(known.reduce((s, l) => s + (l.amount as number), 0)) : null;
}

/** Services they're billed for but we don't list, and listed but not billed (when billing is known at all) */
export function billingGaps(services: readonly ServiceSlug[], billed: readonly BilledLine[] | null): { unlisted: ServiceSlug[]; unbilled: ServiceSlug[] } {
  if (!billed) return { unlisted: [], unbilled: [] };
  const b = new Set(billed.map((l) => l.service));
  const s = new Set(services);
  return { unlisted: [...b].filter((x) => !s.has(x)), unbilled: [...s].filter((x) => !b.has(x) && x !== "crm" && x !== "web-design") };
}
