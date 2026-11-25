import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, researchWeb } from "@/lib/ai";
import { briefText, cleanBrief, cleanPitch, cleanReview, cleanSite, clampScore, forwardStatus, isProspectStatus, sameBusiness, siteHost, type CallReview, type PitchDrafts, type ProspectBrief, type ProspectStatus } from "@/lib/sales-core";

// The Sales agent (phase 1, internal: execs and leads). It researches a business from its site and the open web into a
// prospect brief and a Kaizen sales strategy, builds prospect lists scored by fit, drafts outreach (call script,
// email, LinkedIn note and message, all sent by the person themselves), reviews sales calls, and keeps everything on
// the prospect in Sales › Prospects. When a prospect is won and enrolled, it's linked to the new client and its
// documents can move from Kaizen Sales › Prospects › <name> to the client's Headquarters (the Drive rule: said back
// for a yes first). LinkedIn: research and drafts only; nothing here browses, scrapes, connects or sends on LinkedIn.
// Every function here trusts its caller to have checked the person works sales (worksSales); the tools do.

type Admin = SupabaseClient;
export type Prospect = {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  location: string | null;
  contacts: { name: string; role: string; where: string }[];
  fit_score: number | null;
  fit_reason: string | null;
  brief: ProspectBrief | null;
  status: ProspectStatus;
  owner_id: string | null;
  source: string | null;
  notes: string | null;
  lost_reason: string | null;
  client_id: string | null;
  won_at: string | null;
  researched_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  archive_note: string | null;
  relationship: "direct" | "white_label" | null;
  partner_key: string | null;
};

export const PROSPECT_COLS = "id, name, website, industry, location, contacts, fit_score, fit_reason, brief, status, owner_id, source, notes, lost_reason, client_id, won_at, researched_at, created_at, updated_at, archived_at, archived_by, archive_reason, archive_note, relationship, partner_key";

const RESEARCH_RULES = `Public sources only: the business's own website, Google (Business Profile, reviews), Yelp and similar review sites, their public social profiles (Instagram, Facebook, TikTok, YouTube), the Meta Ad Library (facebook.com/ads/library, search the page name: active ads and how long they've run) and the Google Ads Transparency Center (adstransparency.google.com). LinkedIn: only what a public web search shows (a company page or a person's title in a search result); never log in, browse or scrape LinkedIn. Never guess: when you can't see something (an ad library page that won't load), say "not visible" and why.`;

/** Kaizen's rate card as lines for the prompt (the only prices the agent may quote) */
export async function rateCardText(admin: Admin): Promise<string> {
  const { data } = await admin.from("rate_card").select("service, tier, label, cadence, amount").eq("active", true).order("service").order("sort_order");
  if (!(data ?? []).length) return "The rate card is empty: name services without prices and say prices are to confirm.";
  return (data ?? []).map((r) => `- [${r.service}${r.tier ? ` · ${r.tier}` : ""}] ${r.label}: $${Number(r.amount).toLocaleString("en-US")}${r.cadence === "month" ? "/month" : " one-time"}`).join("\n");
}

/**
 * Kaizen's own clients by industry with how their main ad account does against its target (last 30 days), for proof.
 * Internal only: the agent describes them by industry, never by name, in anything a prospect sees.
 */
export async function clientProofText(admin: Admin, industryHint: string | null): Promise<string> {
  const { data: clients } = await admin.from("clients").select("id, name, industry, industry_detail, created_at").is("archived_at", null).limit(400);
  const all = (clients ?? []).filter((c) => c.industry || c.industry_detail);
  if (!all.length) return "No client industries are recorded yet.";
  const words = String(industryHint ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  const near = words.length ? all.filter((c) => words.some((w) => `${c.industry ?? ""} ${c.industry_detail ?? ""}`.toLowerCase().includes(w))) : [];
  const pick = (near.length ? near : all).slice(0, 40);
  const ids = pick.map((c) => c.id as string);
  const [{ data: targets }, { data: snaps }] = await Promise.all([
    admin.from("kpi_targets").select("id, client_id, platform, conversion, target").in("client_id", ids).eq("active", true),
    admin.from("kpi_snapshots").select("target_id, windows, status").in("client_id", ids),
  ]);
  const lines = pick.map((c) => {
    const ts = (targets ?? []).filter((t) => t.client_id === c.id);
    const perf = ts
      .map((t) => {
        const s = (snaps ?? []).find((x) => x.target_id === t.id);
        const d30 = ((s?.windows ?? {}) as Record<string, { spend?: number; results?: number }>).d30;
        if (!d30?.spend) return null;
        const cpr = d30.results ? Math.round((d30.spend / d30.results) * 100) / 100 : null;
        return `${t.platform} ${t.conversion ?? "results"}: $${Math.round(d30.spend)} spend, ${d30.results ?? 0} results${cpr != null ? `, $${cpr} each` : ""}${t.target ? ` (target $${t.target})` : ""}${s?.status ? `, ${s.status}` : ""}`;
      })
      .filter(Boolean);
    const months = Math.max(0, Math.round((Date.now() - new Date(c.created_at as string).getTime()) / (30 * 86_400_000)));
    return `- ${c.name} · ${c.industry_detail ?? c.industry} · with Kaizen ~${months} months${perf.length ? ` · last 30 days: ${perf.join("; ")}` : ""}`;
  });
  return `${near.length ? "Kaizen clients in a similar industry" : "Kaizen clients (none matched the industry closely)"} (internal: never name them to a prospect):\n${lines.join("\n")}`;
}

const STR = { type: "string" };
const STRS = { type: "array", items: STR };
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "website", "industry", "summary", "sells", "locations", "positioning", "marketing", "market", "tiers", "gaps", "fit_score", "fit_reason", "strategy", "contacts", "sources"],
  properties: {
    name: STR,
    website: STR,
    industry: STR,
    summary: STR,
    sells: STR,
    locations: STRS,
    positioning: STR,
    marketing: {
      type: "object",
      additionalProperties: false,
      required: ["site", "offers", "reviews", "social", "meta_ads", "google_ads", "email_capture"],
      properties: { site: STR, offers: STR, reviews: STR, social: STR, meta_ads: STR, google_ads: STR, email_capture: STR },
    },
    gaps: STRS,
    fit_score: { type: "integer" },
    fit_reason: STR,
    strategy: {
      type: "object",
      additionalProperties: false,
      required: ["services", "angle", "proof", "talking_points"],
      properties: {
        services: { type: "array", items: { type: "object", additionalProperties: false, required: ["service", "why", "price"], properties: { service: STR, why: STR, price: STR } } },
        angle: STR,
        proof: STRS,
        talking_points: STRS,
      },
    },
    contacts: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "role", "where"], properties: { name: STR, role: STR, where: STR } } },
    sources: STRS,
    market: {
      type: "object",
      additionalProperties: false,
      required: ["geo", "avatar", "tam", "competitors", "trends", "benchmarks", "seasonality", "email_intel"],
      properties: {
        geo: STR,
        avatar: STR,
        tam: STR,
        competitors: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "website", "channels", "funnel", "messaging", "offer", "usp"], properties: { name: STR, website: STR, channels: STR, funnel: STR, messaging: STR, offer: STR, usp: STR } } },
        trends: { type: "array", items: { type: "object", additionalProperties: false, required: ["keyword", "cpc", "volume", "note"], properties: { keyword: STR, cpc: STR, volume: STR, note: STR } } },
        benchmarks: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "metric", "value", "source", "proxy"], properties: { platform: STR, metric: STR, value: STR, source: STR, proxy: STR } } },
        seasonality: STR,
        email_intel: STR,
      },
    },
    tiers: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "services", "ad_spend", "fees", "projection", "best_for"], properties: { name: STR, services: STRS, ad_spend: STR, fees: STR, projection: STR, best_for: STR } } },
  },
};

/** The market pass's brief (run beside the business pass): what the CEO's Loom said the research was missing */
export const MARKET_PROMPT = (who: string, industry: string | null) => `Research the MARKET around this business: ${who}${industry ? ` (${industry})` : ""}. Each finding with its source URL; say "not found" rather than guess.
1. Geography: the area they serve (city, county, zip codes). Median household income, age mix, marital status, homeownership and anything else that shapes the local buyer (census.gov QuickFacts, ACS data, city-data). If they sell US-wide or online, describe the national buyer instead.
2. The customer avatar(s): who buys this, with age, income, role (business owner?), what triggers the purchase.
3. TAM: a rough count of reachable buyers in that area or nationally, and how you estimated it (population x share).
4. Competitors: the 3-5 closest direct competitors in the same area (for a national or online business, nationally), found through Google and Google Maps searches for what this business sells near its location. Each one NAMED with its own website (required: the system reads their live ads from the ad libraries by that site), plus what their site shows: offer, messaging, USP, how they book or sell.
5. Search demand: the main buying keywords with typical cost per click and monthly search volume (public keyword data, agency benchmark posts, WordStream/LocaliQ, Semrush/Ahrefs public pages) and the seasonality (when clicks cost most and least).
6. Benchmarks: the current year's WordStream/LocaliQ benchmarks for this industry (Google: CTR, CPC, CVR, cost per lead; Facebook: CTR, CPC, CVR, cost per lead; CPM if available). If the industry isn't broken out, use the closest adjacent category and say which.
7. Email marketing: the business's and two competitors' email programs from public archives (milled.com search by brand, MailCharts public pages): how many emails, cadence, offers, design. If nothing is archived, say so.
8. Rules that limit advertising in this vertical (licensing boards, health or financial ad rules, Meta special ad categories).
Plain notes, no recommendations.`;

/** One prospect by id (the caller's own session decides access) */
export async function getProspect(db: SupabaseClient, id: string): Promise<Prospect | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("prospects").select(PROSPECT_COLS).eq("id", id).maybeSingle();
  return (data as Prospect | null) ?? null;
}

/** A prospect by id, its site or its name (loosely) */
export async function findProspect(db: SupabaseClient, ref: string): Promise<Prospect | null> {
  const r = ref.trim();
  if (!r) return null;
  const byId = await getProspect(db, r);
  if (byId) return byId;
  const host = siteHost(r);
  if (host && /\./.test(r)) {
    const { data } = await db.from("prospects").select(PROSPECT_COLS).ilike("website", `%${host}%`).limit(1).maybeSingle();
    if (data) return data as Prospect;
  }
  const { data } = await db.from("prospects").select(PROSPECT_COLS).ilike("name", `%${r.replace(/[%_]/g, "")}%`).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return (data as Prospect | null) ?? null;
}

/**
 * Researches one business into a prospect brief and a Kaizen sales strategy, and keeps it on the prospect (made if
 * new, found by its site or name otherwise). Takes a minute or two: the web first, then the brief.
 */
export async function researchProspect(db: SupabaseClient, admin: Admin, me: { id: string }, input: { name?: string | null; website?: string | null; location?: string | null; question?: string | null; prospectId?: string | null; sequential?: boolean; relationship?: "direct" | "white_label" | null; partnerKey?: string | null; gtm?: boolean }): Promise<{ ok: true; prospect: Prospect; text: string; thin?: boolean; gtm?: { queued: boolean; say?: string } } | { ok: false; error: string }> {
  const existing = input.prospectId ? await getProspect(db, input.prospectId) : null;
  const name = (input.name ?? existing?.name ?? "").trim();
  const website = cleanSite(input.website) ?? existing?.website ?? null;
  if (!name && !website) return { ok: false, error: "Which business? Give its name or website." };
  const location = (input.location ?? existing?.location ?? "").trim() || null;
  const who = [name, website, location].filter(Boolean).join(" · ");

  // Two passes at once: the business itself, and the market around it (competitors, demand, benchmarks, the buyer)
  // Two passes: the business itself, and the market around it. In the background job they run one after the other (with
  // a bigger budget), so they never compete for web searches; asked live, side by side to stay quick
  const runMarket = () => researchWeb({
    agent: "sales_research",
    label: "prospect market research",
    model: "sonnet",
    maxSearches: input.sequential ? 16 : 10,
    maxFetches: input.sequential ? 16 : 12,
    maxTurns: input.sequential ? 10 : 6,
    system: `You research a market for Kaizen, a paid-ads and creative agency, before a pitch. Facts with sources. ${RESEARCH_RULES}`,
    prompt: MARKET_PROMPT(who, existing?.industry ?? null),
  }).catch((e) => `(The market research didn't finish: ${e instanceof Error ? e.message : String(e)})`);
  const marketNotes = input.sequential ? null : runMarket();
  const notes = await researchWeb({
    agent: "sales_research",
    label: "prospect research",
    model: "sonnet",
    maxSearches: 8,
    maxFetches: 10,
    system: `You research a business for Kaizen, a paid-ads and creative agency, before anyone reaches out. Gather facts, with the URL each came from. ${RESEARCH_RULES}`,
    prompt: `Research this business: ${who}.${input.question ? ` They also asked: ${input.question}` : ""}
Find and note, each with its source URL:
1. What they sell (products or services, price points or ticket size if shown), and who to.
2. Their locations (addresses, service area, number of locations).
3. Positioning: how they describe themselves, what sets them apart, their brand look and tone.
4. Website: quality (mobile, speed feel, clear calls to action, booking or checkout), current offers or promotions, email or SMS capture (popup, newsletter, lead magnet).
5. Reviews: Google rating and count, other review sites, what reviewers praise and complain about.
6. Social: each profile, followers, how often they post, last post date.
7. Ads: Meta Ad Library (active ads, how many, how long running, formats) and Google Ads Transparency Center (any ads). Say "none found" only after checking.
8. Owners or decision makers named publicly (the site's About page, press, a public search result), with their title and where seen.
Plain notes, no recommendations.`,
  });

  const [rates, proof, market] = await Promise.all([rateCardText(admin), clientProofText(admin, `${existing?.industry ?? ""} ${notes.slice(0, 1500)}`), marketNotes ?? runMarket()]);
  const { tierPlan, verticalOf, VERTICAL_FOCUS } = await import("@/lib/sales-gtm-core");
  const vertical = verticalOf(existing?.industry ?? null, notes.slice(0, 2000));
  const raw = await askJson<ProspectBrief & { name: string; website: string; industry: string }>({
    agent: "sales_research",
    label: "prospect brief",
    schema: BRIEF_SCHEMA,
    maxTokens: 12000,
    system: `You are Kaizen's Sales agent. Turn the research notes into a prospect brief, a market analysis and a Kaizen sales strategy.
- name, website (https://domain), industry (a short sub-vertical like "med spa" or "roofing contractor").
- summary: two sentences: who they are and the opportunity for Kaizen.
- marketing: what was seen for each (site, offers, reviews, social, meta_ads, google_ads, email_capture); "not visible" when unknown.
- gaps: the likely gaps Kaizen fixes, most valuable first (at most 6), each tied to the evidence.
- fit_score 0-100 and fit_reason: real offer, ticket size or margin for paid media to pay back, demand, visible gaps we fix, ability to pay. Under 40 means say plainly why it's a poor fit.
- strategy.services: only from the rate card below, with its price as written there; why it fits this business.
- strategy.angle: the pitch about their business (the revenue left on the table, the fastest win), not about Kaizen.
- strategy.proof: from Kaizen's similar clients below, described by industry and result, never by client name ("a med spa on Meta: leads at $38 against a $45 target"). Empty if none are similar.
- strategy.talking_points: 3 to 6 first-outreach points specific to this business.
- contacts: people named publicly, with role and where seen. Never invent one.
- sources: the URLs the facts came from.
- market (from the market notes): geo (area, zips, income, demographics), avatar (the local buyer, or the US-wide buyer), tam (an estimate and how it was made), competitors (who advertises and how: name, website as https://domain, channels, funnel, messaging, offer, USP; internal only), trends (keyword, CPC, monthly volume, note), benchmarks (platform, metric, value, source with year; proxy names the adjacent category when the industry isn't published, else ""), seasonality, email_intel (their and competitors' email programs from public archives, or that none were found).
- tiers: exactly three, weighted for this kind of business (${vertical}: lead with ${VERTICAL_FOCUS[vertical].lead.join(", ")}; add-ons ${VERTICAL_FOCUS[vertical].addons.join(", ")}). Start from: ${tierPlan(vertical).map((t) => `${t.name} = ${t.services.join(" + ")}`).join("; ")}. Each with ad_spend (monthly, paid to the platforms), fees (management and creative from the rate card, exact), projection (a planning range from the benchmarks, e.g. "25-55 leads/month"), best_for. The Basic creative package is the "310": 3 images + 10 videos a month, always attached to Meta.
Only what the notes support; never invent a number, review or fact. Estimates say so.`,
    prompt: `<research_notes>\n${notes.slice(0, 36_000)}\n</research_notes>\n\n<market_notes>\n${market.slice(0, 36_000)}\n</market_notes>\n\n<rate_card>\n${rates}\n</rate_card>\n\n<kaizen_clients note="internal proof">\n${proof}\n</kaizen_clients>${input.question ? `\n\n<asked>${input.question}</asked>` : ""}`,
  });
  const brief = cleanBrief(raw);
  const finalName = name || String(raw.name ?? "").trim() || siteHost(website) || "Prospect";
  const finalSite = website ?? cleanSite(raw.website);
  const row = {
    name: finalName.slice(0, 160),
    website: finalSite,
    industry: String(raw.industry ?? "").trim().slice(0, 120) || existing?.industry || null,
    location: location ?? (brief.locations[0] ?? null),
    contacts: brief.contacts,
    fit_score: brief.fit_score,
    fit_reason: brief.fit_reason || null,
    brief,
    researched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const match = existing ?? (finalSite ? await findProspect(db, finalSite) : null) ?? (finalName ? await findExact(db, finalName) : null);
  let saved: Prospect | null = null;
  if (match) {
    const { data, error } = await db.from("prospects").update({ ...row, status: forwardStatus(match.status, "researched") }).eq("id", match.id).select(PROSPECT_COLS).single();
    if (error) return { ok: false, error: error.message };
    saved = data as Prospect;
  } else {
    const { data, error } = await db.from("prospects").insert({ ...row, status: "researched", owner_id: me.id, created_by: me.id, source: "research" }).select(PROSPECT_COLS).single();
    if (error) return { ok: false, error: error.message };
    saved = data as Prospect;
  }
  await db.from("prospect_notes").insert({ prospect_id: saved.id, kind: "research", title: input.question ? `Research: ${input.question.slice(0, 120)}` : "Research", body: { brief, notes: notes.slice(0, 40_000), market_notes: market.slice(0, 40_000) }, created_by: me.id });
  // The prospect and its competitors join the swipe file, so their real email flows are captured (src/lib/swipe)
  await followInSwipe(admin, saved, brief).catch(() => undefined);
  // Direct or white label, when it was said at research start
  if (input.relationship) await admin.from("prospects").update({ relationship: input.relationship, partner_key: input.relationship === "white_label" ? (input.partnerKey ?? null) : null }).eq("id", saved.id);
  // Research done: the go-to-market strategy builds by itself (the GTM job's own research pass passes gtm: false)
  let gtm: { queued: boolean; say?: string } | undefined;
  if (input.gtm !== false && !thinResearch(market)) {
    const { autoGtm } = await import("@/lib/sales-gtm");
    const g = await autoGtm(admin, { prospectId: saved.id, profileId: me.id, ask: input.question ?? null }).catch((e) => ({ queued: false as const, need: "relationship" as const, say: e instanceof Error ? e.message : String(e) }));
    gtm = g.queued ? { queued: true } : { queued: false, say: g.say };
  }
  return { ok: true, prospect: saved, text: briefText(saved.name, brief), thin: thinResearch(market), gtm };
}

/** The market pass came back without its research (search limits, errors): don't build on it */
export const thinResearch = (notes: string) => notes.length < 1500 || /usage limit|rate limit|search tool (?:hit|reached)|didn't finish|could not (?:search|check)|unable to search/i.test(notes.slice(0, 600));

async function findExact(db: SupabaseClient, name: string): Promise<Prospect | null> {
  const { data } = await db.from("prospects").select(PROSPECT_COLS).ilike("name", name.replace(/[%_]/g, "")).limit(1).maybeSingle();
  return (data as Prospect | null) ?? null;
}

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prospects"],
  properties: {
    prospects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "website", "location", "industry", "signals", "fit_score", "fit_reason"],
        properties: { name: STR, website: STR, location: STR, industry: STR, signals: STR, fit_score: { type: "integer" }, fit_reason: STR },
      },
    },
  },
};

export type ListedProspect = { id: string | null; name: string; website: string | null; location: string; industry: string; signals: string; fit_score: number | null; fit_reason: string; already: boolean };

/**
 * Finds businesses matching a profile ("med spas in Tampa running no ads") from public web sources, scores each by fit
 * and adds the new ones to the pipeline as "new" (one already there is left as it is and marked already).
 */
export async function buildProspectList(db: SupabaseClient, admin: Admin, me: { id: string }, input: { profile: string; count?: number | null; save?: boolean }): Promise<{ ok: true; prospects: ListedProspect[]; added: number } | { ok: false; error: string }> {
  const profile = input.profile.trim().slice(0, 500);
  if (!profile) return { ok: false, error: "What kind of business, and where? (e.g. med spas in Tampa running no ads)" };
  const count = Math.max(3, Math.min(15, Math.round(Number(input.count) || 8)));
  const notes = await researchWeb({
    agent: "sales_list",
    label: "prospect list",
    model: "sonnet",
    maxSearches: 10,
    maxFetches: 12,
    system: `You build prospect lists for Kaizen, a paid-ads and creative agency. Find real, independent businesses (not directories, franchise corporate pages or listicles) that match the profile, each with its own website. ${RESEARCH_RULES}`,
    prompt: `Find about ${count} businesses matching: ${profile}.
For each: name, website, location, what they sell, and the signals behind fit: price point or ticket size, number of locations, review count and rating, social activity, whether they run Meta ads (Meta Ad Library) or Google ads (Ads Transparency Center), email capture on their site. When the profile names a condition ("running no ads"), check it for each and keep only those that meet it, or say it couldn't be checked. Plain notes with URLs.`,
  });
  const rates = await rateCardText(admin);
  const out = await askJson<{ prospects: { name: string; website: string; location: string; industry: string; signals: string; fit_score: number; fit_reason: string }[] }>({
    agent: "sales_list",
    label: "prospect list scoring",
    schema: LIST_SCHEMA,
    maxTokens: 6000,
    system: `You are Kaizen's Sales agent. From the notes, list the businesses that match the profile, best fit first, at most ${count}. Score fit 0-100 on: a real offer with enough ticket size or margin for paid ads to pay back, demand in their area, visible gaps Kaizen fixes (services on the rate card), and signs they can pay (locations, reviews, an established site). signals: the evidence seen, in one line. fit_reason: why the score, in one line. website as https://domain. Only businesses in the notes; never invent one.`,
    prompt: `<profile>${profile}</profile>\n\n<notes>\n${notes.slice(0, 40_000)}\n</notes>\n\n<rate_card>\n${rates}\n</rate_card>`,
  });
  const listed: ListedProspect[] = [];
  let added = 0;
  for (const p of (out.prospects ?? []).slice(0, count)) {
    const name = String(p.name ?? "").trim().slice(0, 160);
    if (!name) continue;
    const website = cleanSite(p.website);
    const have = (website ? await findProspect(db, website) : null) ?? (await findExact(db, name));
    const base = { name, website, location: String(p.location ?? "").slice(0, 200), industry: String(p.industry ?? "").slice(0, 120), signals: String(p.signals ?? "").slice(0, 600), fit_score: clampScore(p.fit_score), fit_reason: String(p.fit_reason ?? "").slice(0, 600) };
    if (have) {
      listed.push({ ...base, id: have.id, already: true });
      continue;
    }
    if (input.save === false) {
      listed.push({ ...base, id: null, already: false });
      continue;
    }
    const { data } = await db
      .from("prospects")
      .insert({ name, website, location: base.location || null, industry: base.industry || null, fit_score: base.fit_score, fit_reason: [base.fit_reason, base.signals && `Signals: ${base.signals}`].filter(Boolean).join(" · ") || null, status: "new", owner_id: me.id, created_by: me.id, source: `list: ${profile.slice(0, 120)}` })
      .select("id")
      .maybeSingle();
    if (data) added++;
    listed.push({ ...base, id: (data?.id as string | undefined) ?? null, already: false });
  }
  return { ok: true, prospects: listed, added };
}

const PITCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["call_script", "email", "linkedin"],
  properties: {
    call_script: {
      type: "object",
      additionalProperties: false,
      required: ["opener", "questions", "angle", "ask", "objections"],
      properties: { opener: STR, questions: STRS, angle: STR, ask: STR, objections: { type: "array", items: { type: "object", additionalProperties: false, required: ["objection", "answer"], properties: { objection: STR, answer: STR } } } },
    },
    email: { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: STR, body: STR } },
    linkedin: { type: "object", additionalProperties: false, required: ["connection_note", "message"], properties: { connection_note: STR, message: STR } },
  },
};

/** The prospect's research and the newest notes, as text for the agent */
async function prospectContext(db: SupabaseClient, p: Prospect): Promise<string> {
  const { data: notes } = await db.from("prospect_notes").select("kind, title, body, created_at").eq("prospect_id", p.id).neq("kind", "research").order("created_at", { ascending: false }).limit(4);
  const head = `${p.name}${p.website ? ` (${p.website})` : ""}${p.industry ? ` · ${p.industry}` : ""}${p.location ? ` · ${p.location}` : ""} · stage: ${p.status}`;
  const brief = p.brief ? briefText(p.name, cleanBrief(p.brief)) : `Not researched yet.${p.fit_reason ? ` ${p.fit_reason}` : ""}`;
  const more = (notes ?? []).map((n) => `${n.kind} (${String(n.created_at).slice(0, 10)}): ${n.title ?? ""} ${JSON.stringify(n.body).slice(0, 1500)}`).join("\n");
  return [head, brief, p.notes ? `Team notes: ${p.notes}` : "", more ? `Earlier work:\n${more}` : ""].filter(Boolean).join("\n\n");
}

/** Outreach drafts for one prospect: a call script, an email, and a LinkedIn note and message (sent by the person) */
export async function draftPitch(db: SupabaseClient, admin: Admin, me: { id: string; name?: string | null; role?: string | null }, p: Prospect, opts: { focus?: string | null } = {}): Promise<{ ok: true; drafts: PitchDrafts }> {
  const [context, rates] = await Promise.all([prospectContext(db, p), rateCardText(admin)]);
  const raw = await askJson<PitchDrafts>({
    agent: "sales_pitch",
    label: "pitch drafts",
    schema: PITCH_SCHEMA,
    maxTokens: 5000,
    system: `You are Kaizen's Sales agent writing first outreach for one prospect, in Kaizen's voice: a real person at a growth agency, direct and warm, specific to this business, one clear ask, no hype, no fake familiarity, no "I hope this finds you well".
- call_script: opener (who we are and why them, in two sentences), questions (two or three discovery questions), angle (the one insight about their business), ask (a 15-minute call or a free audit), objections (the three most likely, with a short honest answer each).
- email: subject (short, specific, lower-key), body under 120 words, signed "[Your name]". Use a fact from the research.
- linkedin: connection_note under 280 characters; message (after they accept) under 600 characters. These are drafts the person sends by hand on LinkedIn.
Prices only from the rate card, and only if the focus asks for them. Never mention other Kaizen clients by name.`,
    prompt: `<prospect>\n${context}\n</prospect>\n\n<rate_card>\n${rates}\n</rate_card>${opts.focus ? `\n\n<focus>${opts.focus}</focus>` : ""}`,
  });
  const drafts = cleanPitch(raw);
  await db.from("prospect_notes").insert({ prospect_id: p.id, kind: "pitch", title: opts.focus ? `Pitch: ${opts.focus.slice(0, 100)}` : "Pitch drafts", body: drafts, created_by: me.id });
  return { ok: true, drafts };
}

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "went_well", "improve", "objections", "next_steps", "proposal", "stage"],
  properties: {
    summary: STR,
    went_well: STRS,
    improve: STRS,
    objections: { type: "array", items: { type: "object", additionalProperties: false, required: ["objection", "how_handled", "better_answer"], properties: { objection: STR, how_handled: STR, better_answer: STR } } },
    next_steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["step", "who", "when"], properties: { step: STR, who: STR, when: STR } } },
    proposal: { type: "object", additionalProperties: false, required: ["send", "services", "note"], properties: { send: { type: "boolean" }, services: STRS, note: STR } },
    stage: { type: "string", enum: ["contacted", "talking", "proposal", "won", "lost"] },
  },
};

/** A sales call reviewed from its transcript; kept on the prospect when there is one (and its stage moved forward) */
export async function reviewSalesCall(db: SupabaseClient, admin: Admin, me: { id: string }, input: { transcript: string; prospect: Prospect | null; source?: string | null }): Promise<{ ok: true; review: CallReview; stage: ProspectStatus | null } | { ok: false; error: string }> {
  const transcript = input.transcript.trim();
  if (transcript.length < 200) return { ok: false, error: "That transcript is too short to review. Paste the call's transcript, attach it, or give its Google Doc link." };
  const [context, rates] = await Promise.all([input.prospect ? prospectContext(db, input.prospect) : Promise.resolve(""), rateCardText(admin)]);
  const raw = await askJson<CallReview>({
    agent: "sales_call_review",
    label: "sales call review",
    schema: REVIEW_SCHEMA,
    maxTokens: 6000,
    system: `You are Kaizen's Sales agent reviewing a sales call for the Kaizen person who ran it. Be a good sales coach: specific, honest, short.
- summary: three sentences: where the deal stands, the prospect's real need, and the risk.
- went_well / improve: concrete moments, quoting short phrases from the call.
- objections: each one raised, how it was handled, and a better answer for next time.
- next_steps: what happens next, who does it (Kaizen or the prospect, by role), and when if said.
- proposal: send true when a proposal is the right next move; services only from the rate card; note: tiers, scope or pricing angle.
- stage: where the deal is now (contacted, talking, proposal, won, lost).
Only what the transcript supports.`,
    prompt: `${context ? `<prospect>\n${context}\n</prospect>\n\n` : ""}<rate_card>\n${rates}\n</rate_card>\n\n<call_transcript${input.source ? ` source="${input.source.replace(/"/g, "'")}"` : ""}>\n${transcript.slice(0, 120_000)}\n</call_transcript>`,
  });
  const review = cleanReview(raw);
  let stage: ProspectStatus | null = null;
  if (input.prospect) {
    await db.from("prospect_notes").insert({ prospect_id: input.prospect.id, kind: "call_review", title: input.source ? `Call review: ${input.source.slice(0, 100)}` : "Call review", body: review, created_by: me.id });
    // Won and lost are the person's call (they set those themselves); a review only moves an open deal forward
    if (review.stage && review.stage !== "won" && review.stage !== "lost") {
      const next = forwardStatus(input.prospect.status, review.stage);
      if (next !== input.prospect.status) {
        await db.from("prospects").update({ status: next, updated_at: new Date().toISOString() }).eq("id", input.prospect.id);
        stage = next;
      }
    }
  }
  return { ok: true, review, stage };
}

/** Changes a prospect's stage, owner, notes or details (the person's own session; RLS checks they work sales) */
export async function updateProspect(db: SupabaseClient, id: string, patch: { status?: unknown; owner_id?: unknown; notes?: unknown; lost_reason?: unknown; name?: unknown; website?: unknown; location?: unknown; industry?: unknown; fit_score?: unknown; relationship?: unknown; partner_key?: unknown }): Promise<{ ok: true; prospect: Prospect } | { ok: false; error: string }> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // Direct Kaizen deal or a white-label pitch (with its partner): the GTM, notes and proposal follow it
  if (patch.relationship !== undefined) {
    if (patch.relationship !== "direct" && patch.relationship !== "white_label" && patch.relationship !== null) return { ok: false, error: "The relationship is direct or white_label." };
    row.relationship = patch.relationship;
    if (patch.relationship === "direct") row.partner_key = null;
  }
  if (patch.partner_key !== undefined && patch.relationship !== "direct") row.partner_key = typeof patch.partner_key === "string" && patch.partner_key ? patch.partner_key : null;
  if (patch.status !== undefined) {
    if (!isProspectStatus(patch.status)) return { ok: false, error: "The stage is one of new, researched, contacted, talking, proposal, won or lost." };
    row.status = patch.status;
    if (patch.status === "won") row.won_at = new Date().toISOString();
  }
  if (patch.owner_id !== undefined) row.owner_id = typeof patch.owner_id === "string" && /^[0-9a-f-]{36}$/i.test(patch.owner_id) ? patch.owner_id : null;
  for (const k of ["notes", "lost_reason", "name", "location", "industry"] as const) if (patch[k] !== undefined) row[k] = String(patch[k] ?? "").trim().slice(0, k === "notes" ? 4000 : 300) || null;
  if (patch.name !== undefined && !row.name) return { ok: false, error: "A prospect needs a name." };
  if (patch.website !== undefined) row.website = cleanSite(patch.website);
  if (patch.fit_score !== undefined) row.fit_score = clampScore(patch.fit_score);
  const { data, error } = await db.from("prospects").update(row).eq("id", id).select(PROSPECT_COLS).maybeSingle();
  if (error) return { ok: false, error: /prospects_site/.test(error.message) ? "Another prospect already has that website." : error.message };
  if (!data) return { ok: false, error: "That prospect isn't one you can change." };
  return { ok: true, prospect: data as Prospect };
}

/**
 * A won prospect becomes a client through Kaizen's enrollment (Kaizen Track's enrollment starts onboarding). This finds
 * the enrolled client (by site or name, or the one named), links it, and points the prospect's Kaizen documents at
 * the client; moving the files in Drive is asked for separately (the Drive rule). Returns what's left to do.
 */
export async function linkWonProspect(db: SupabaseClient, admin: Admin, p: Prospect, clientRef?: string | null): Promise<{ client: { id: string; name: string; slug: string } | null; documents: { id: string; title: string; link: string | null; folder: string | null }[] }> {
  let client: { id: string; name: string; slug: string; website: string | null } | null = null;
  if (p.client_id) {
    const { data } = await admin.from("clients").select("id, name, slug, website").eq("id", p.client_id).maybeSingle();
    client = (data as typeof client) ?? null;
  }
  if (!client) {
    const { data: clients } = await admin.from("clients").select("id, name, slug, website").is("archived_at", null).order("created_at", { ascending: false }).limit(1000);
    const ref = String(clientRef ?? "").trim();
    const list = (clients ?? []) as { id: string; name: string; slug: string; website: string | null }[];
    client = (ref ? list.find((c) => c.id === ref || c.slug === ref || sameBusiness({ name: ref }, c)) : null) ?? list.find((c) => sameBusiness(p, c)) ?? null;
  }
  if (client) {
    await db.from("prospects").update({ client_id: client.id, status: "won", won_at: p.won_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", p.id);
    await admin.from("kaizen_documents").update({ client_id: client.id }).is("client_id", null).ilike("prospect_name", p.name.replace(/[%_]/g, ""));
  }
  const { data: docs } = await admin.from("kaizen_documents").select("id, title, google_url, folder_place, prospect_name, client_id").ilike("prospect_name", p.name.replace(/[%_]/g, "")).order("created_at", { ascending: false }).limit(20);
  return {
    client: client ? { id: client.id, name: client.name, slug: client.slug } : null,
    documents: (docs ?? []).map((d) => ({ id: d.id as string, title: (d.title as string) ?? "Document", link: (d.google_url as string | null) ?? null, folder: (d.folder_place as string | null) ?? null })),
  };
}

/**
 * Hourly: a won prospect not yet linked whose client has since been enrolled is linked, and its owner gets a notice to
 * move its documents to the client's Headquarters (moving them waits for their yes on the folder).
 */
export async function linkEnrolledProspects(admin: Admin) {
  const { data: won } = await admin.from("prospects").select(PROSPECT_COLS).eq("status", "won").is("client_id", null).is("archived_at", null).limit(50);
  let linked = 0;
  for (const p of (won ?? []) as Prospect[]) {
    const r = await linkWonProspect(admin, admin, p).catch(() => null);
    if (!r?.client) continue;
    linked++;
    if (p.owner_id)
      await admin.from("notifications").upsert(
        {
          profile_id: p.owner_id,
          kind: "agent",
          client_id: r.client.id,
          key: `prospect-won:${p.id}`,
          title: `${p.name} is now a client`,
          body: r.documents.length ? `Its ${r.documents.length} document${r.documents.length === 1 ? "" : "s"} can move from Kaizen Sales › Prospects to ${r.client.name}'s Headquarters: ask the assistant to move them.` : `Linked to ${r.client.name}; onboarding runs from the enrollment.`,
          href: `/sales/${p.id}`,
          priority: "normal",
        },
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
  return { linked };
}

/**
 * Everything the Sales agent starts a conversation about one prospect with: the prospect and its research, the latest
 * sales call brief, the saved drafts and call reviews, and this person's earlier Sales conversations about it (their
 * summaries and last lines), so a later chat (after the call, at the proposal) carries on with the same context.
 * Read through the person's own session.
 */
export async function prospectContextText(db: SupabaseClient, id: string): Promise<{ name: string; text: string } | null> {
  const p = await getProspect(db, id);
  if (!p) return null;
  const [{ data: briefs }, { data: notes }, { data: calls }] = await Promise.all([
    db.from("sales_call_briefs").select("id, title, starts_at, status, brief").eq("prospect_id", id).order("starts_at", { ascending: false }).limit(2),
    db.from("prospect_notes").select("kind, title, body, created_at").eq("prospect_id", id).in("kind", ["pitch", "call_review"]).order("created_at", { ascending: false }).limit(4),
    db.from("ai_role_calls").select("id, started_at, summary").eq("prospect_id", id).eq("role_key", "sales").order("started_at", { ascending: false }).limit(4),
  ]);
  const parts = [`${p.name}${p.website ? ` (${p.website})` : ""}${p.industry ? ` · ${p.industry}` : ""}${p.location ? ` · ${p.location}` : ""} · stage: ${p.status}${p.notes ? `\nTeam notes: ${p.notes}` : ""}`];
  parts.push(p.brief ? briefText(p.name, cleanBrief(p.brief)) : "Not researched yet: research_prospect can do it now.");
  const { callBriefText, cleanCallBrief, whenLabel } = await import("@/lib/sales-briefs-core");
  for (const b of (briefs ?? []) as { title: string; starts_at: string; status: string; brief: unknown }[])
    if (b.brief) parts.push(`<call_brief status="${b.status}">\n${callBriefText(p.name, whenLabel(b.starts_at), cleanCallBrief(b.brief, { booking: (b.brief as { booking?: { q: string; a: string }[] }).booking }))}\n</call_brief>`);
    else parts.push(`A sales call "${b.title}" on ${b.starts_at.slice(0, 16)} (${b.status}, no brief yet).`);
  for (const n of notes ?? []) parts.push(`${n.kind === "pitch" ? "Pitch drafts" : "Call review"} (${String(n.created_at).slice(0, 10)}): ${JSON.stringify(n.body).slice(0, 2000)}`);
  const ids = ((calls ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length) {
    const { data: lines } = await db.from("ai_role_chats").select("call_id, role, content, created_at").in("call_id", ids).order("created_at", { ascending: false }).limit(16);
    const said = ((lines ?? []) as { role: string; content: string | null }[]).reverse().map((l) => `${l.role === "user" ? "They" : "You"}: ${String(l.content ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    const sums = ((calls ?? []) as { started_at: string; summary: unknown }[]).filter((c) => c.summary).map((c) => `${String(c.started_at).slice(0, 10)}: ${typeof c.summary === "string" ? c.summary : JSON.stringify(c.summary)}`.slice(0, 800));
    parts.push(`<earlier_conversations_about_them>\n${[...sums, ...said].join("\n")}\n</earlier_conversations_about_them>`);
  }
  return { name: p.name, text: parts.join("\n\n") };
}

/**
 * Archives a prospect (never deleted): who, when and why are kept, it leaves the pipeline, and its upcoming call briefs
 * stop (no brief, no Needs me item, no bell; notices already sent are cleared). Its stage stays, so Unarchive puts it
 * back where it was. Through the person's own session (row-level security: execs and leads).
 */
export async function archiveProspect(db: SupabaseClient, admin: Admin, me: { id: string }, id: string, reason: unknown, note?: unknown): Promise<{ ok: true; prospect: Prospect; stopped: number } | { ok: false; error: string }> {
  const { archiveReasonFrom } = await import("@/lib/sales-core");
  const why = archiveReasonFrom(reason);
  if (!why) return { ok: false, error: "Why is it being archived? Not a fit, no budget, went with someone else, no response, duplicate, not a real business, or other (with a note)." };
  const text = String(note ?? "").trim().slice(0, 600) || (why === "other" && typeof reason === "string" && reason.trim() !== "other" ? reason.trim().slice(0, 600) : "");
  if (why === "other" && !text) return { ok: false, error: "Other: say why in a few words." };
  const now = new Date().toISOString();
  const { data, error } = await db.from("prospects").update({ archived_at: now, archived_by: me.id, archive_reason: why, archive_note: text || null, updated_at: now }).eq("id", id).is("archived_at", null).select(PROSPECT_COLS).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That prospect isn't there, or it's already archived." };
  // Its briefs for calls still to come stop, and anything already delivered about them is cleared
  const { data: briefs } = await admin.from("sales_call_briefs").select("id, owner_id").eq("prospect_id", id).in("status", ["pending", "ready", "failed"]).gt("starts_at", now);
  for (const b of briefs ?? []) {
    await admin.from("sales_call_briefs").update({ status: "stopped", updated_at: now }).eq("id", b.id);
    if (b.owner_id) await admin.from("notifications").update({ read_at: now, cleared_at: now }).eq("profile_id", b.owner_id).eq("key", `sales-brief:${b.id}`);
  }
  // Debrief prompts for calls already held go too
  await admin.from("sales_call_briefs").update({ status: "stopped", updated_at: now }).eq("prospect_id", id).eq("status", "done");
  await db.from("prospect_notes").insert({ prospect_id: id, kind: "note", title: "Archived", body: { reason: why, note: text || null, by: me.id, at: now }, created_by: me.id });
  return { ok: true, prospect: data as Prospect, stopped: (briefs ?? []).length };
}

/** Back into the pipeline at the stage it had; briefs for calls still to come pick up again on the next run */
export async function unarchiveProspect(db: SupabaseClient, admin: Admin, me: { id: string }, id: string): Promise<{ ok: true; prospect: Prospect } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  const { data, error } = await db.from("prospects").update({ archived_at: null, archived_by: null, archive_reason: null, archive_note: null, updated_at: now }).eq("id", id).not("archived_at", "is", null).select(PROSPECT_COLS).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That prospect isn't archived." };
  await admin.from("sales_call_briefs").update({ status: "pending", notified_at: null, updated_at: now }).eq("prospect_id", id).eq("status", "stopped").gt("starts_at", now);
  await db.from("prospect_notes").insert({ prospect_id: id, kind: "note", title: "Unarchived", body: { by: me.id, at: now }, created_by: me.id });
  return { ok: true, prospect: data as Prospect };
}

/** A researched prospect and the competitors its market research found (with a site) are followed in the swipe file */
async function followInSwipe(admin: Admin, p: Prospect, brief: ProspectBrief) {
  const { slugOf } = await import("@/lib/swipe/core");
  const rows: { slug: string; name: string; website: string; vertical: string; source: string; prospect_id: string }[] = [];
  const vertical = `prospect · ${(p.industry ?? "business").slice(0, 60)}`;
  if (p.website) rows.push({ slug: slugOf(p.name), name: p.name, website: p.website, vertical, source: "prospect", prospect_id: p.id });
  for (const c of brief.market?.competitors ?? []) {
    const site = cleanSite((c as { website?: string }).website);
    if (site && c.name) rows.push({ slug: slugOf(c.name), name: c.name.slice(0, 120), website: site, vertical: `competitor · ${(p.industry ?? "business").slice(0, 60)}`, source: "competitor", prospect_id: p.id });
  }
  const ok = rows.filter((r) => r.slug.length >= 2).slice(0, 6);
  if (ok.length) await admin.from("swipe_brands").upsert(ok, { onConflict: "slug", ignoreDuplicates: true });
}
