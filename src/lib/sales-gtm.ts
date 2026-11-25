import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, researchWeb } from "@/lib/ai";
import { briefText, cleanBrief, type ProspectBrief } from "@/lib/sales-core";
import { BASIC_CREATIVE, cleanGtm, RELATIONSHIP_QUESTION, shortName, cleanNotes, feeMentions, GTM_FILE, kaizenMentions, scrubKaizen, tierPlan, VERTICAL_FOCUS, verticalOf, type CaseStudy, type GtmContent, type GtmNotes, type Partner } from "@/lib/sales-gtm-core";

// The Sales agent's go-to-market engine (Nov 25 2026: the CEO's Loom and his "Proposal Builder" project). For one
// prospect it makes two things, as a background job (queued from the prospect page, the assistant or the Sales agent;
// run right after answering; the cron's five-minute step picks up the rest):
//   a client-facing GTM PDF in the gold-standard structure (src/lib/sales-gtm-pdf.tsx), in Kaizen's look or a
//     white-label partner's (sales_partners) with zero Kaizen mentions and, for a partner, ad spend only;
//   internal talking notes, never sent: flags, strategy decisions, numbers caveats, risks and objections (with the
//     vertical's compliance rules), firm facts, every claim tagged [certain] / [likely] / [guessing, informed];
//     rewritten for the partner's eyes when it's white-label.
// Stages: researching (the prospect's research, refreshed when it's missing the market or older than 14 days) →
// writing the strategy → writing the talking notes → drawing the PDF. The PDF is a kaizen_documents row (kind gtm),
// so it lists on the prospect and saves to Drive through upload_to_drive under the Drive rule. The GTM never carries
// case studies or a proposal: the proposal is its own document.

type Admin = SupabaseClient;
const STR = { type: "string" };
const STRS = { type: "array", items: STR };
const TABLE = { type: "object", additionalProperties: false, required: ["head", "rows", "note"], properties: { head: STRS, rows: { type: "array", items: STRS }, note: STR } };
const STATS = { type: "array", items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: STR, label: STR } } };
const LEADS = { type: "array", items: { type: "object", additionalProperties: false, required: ["lead", "text"], properties: { lead: STR, text: STR } } };
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

const GTM_SCHEMA = obj({
  cover: obj({ short: STR, eyebrow: STR, headline: STR, highlight: STR, subtitle: STR, location: STR, site: STR, date: STR }),
  exec: obj({ lede: STR, stats: STATS, opportunity: STR, recommend: LEADS, why_now: STR }),
  who: obj({ title: STR, lede: STR, table: TABLE, sources: STR }),
  footprint: obj({ title: STR, lede: STR, table: TABLE, bottom_line: STR }),
  market: obj({ title: STR, lede: STR, stats: STATS, avatar: STR, tam: STR, implications: LEADS, competitors: TABLE, trends: TABLE, sources: STR }),
  positioning: obj({ title: STR, lede: STR, services: TABLE, core: STR, offer: obj({ name: STR, text: STR, why: STR }), pillars: LEADS }),
  channels: obj({ title: STR, lede: STR, google: TABLE, google_note: STR, meta: TABLE, creative: obj({ title: STR, text: STR }) }),
  investment: obj({ title: STR, lede: STR, tiers: TABLE, assumptions: STR, benchmarks: TABLE, benchmarks_note: STR, math: STR }),
  plan: obj({ title: STR, ninety: TABLE, calendar: TABLE }),
  measure: obj({ title: STR, table: TABLE, note: STR, needs: STRS, next: LEADS, one_line: STR }),
  sources: STRS,
});
const CLAIMS = { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "tag"], properties: { text: STR, tag: { type: "string", enum: ["certain", "likely", "guessing"] } } } };
const NOTES_SCHEMA = obj({ headline: STR, competitors: CLAIMS, flags: CLAIMS, decisions: CLAIMS, caveats: CLAIMS, risks: CLAIMS, facts: CLAIMS });

export async function partnerOf(admin: Admin, key: string | null | undefined): Promise<Partner | null> {
  if (!key) return null;
  const { data } = await admin.from("sales_partners").select("key, name, prepared_by, brand, rules, show_fees, contact, pitcher, pitcher_title, website, kit_confirmed_at").eq("key", key).eq("active", true).maybeSingle();
  return (data as Partner | null) ?? null;
}

/** A partner by what someone called it ("ZenChange", "white label for zen change"), or null */
export async function partnerNamed(admin: Admin, text: string | null | undefined): Promise<Partner | null> {
  const t = String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return null;
  const { data } = await admin.from("sales_partners").select("key, name, prepared_by, brand, rules, show_fees, contact, pitcher, pitcher_title, website, kit_confirmed_at").eq("active", true);
  return ((data ?? []) as Partner[]).find((p) => t.includes(p.key) || t.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, ""))) ?? null;
}

/**
 * Whether a prospect is a direct Kaizen deal or a white-label pitch, from what its record already shows: the relationship
 * set on it, a partner on it, or a partner credited in its research ("Powered by ZenChange", the partner's domain on its
 * forms). Null: ask, once ("Is this a direct Kaizen deal or a white-label pitch for a partner agency?").
 */
export async function relationshipOf(admin: Admin, p: { relationship?: string | null; partner_key?: string | null; brief?: unknown; id: string }): Promise<{ relationship: "direct" | "white_label"; partner: Partner | null; detected: boolean } | null> {
  if (p.relationship === "direct") return { relationship: "direct", partner: null, detected: false };
  if (p.relationship === "white_label" && p.partner_key) return { relationship: "white_label", partner: await partnerOf(admin, p.partner_key), detected: false };
  const { data: partners } = await admin.from("sales_partners").select("key, name, prepared_by, brand, rules, show_fees, contact, pitcher, pitcher_title, website, kit_confirmed_at").eq("active", true);
  const { data: rn } = await admin.from("prospect_notes").select("body").eq("prospect_id", p.id).eq("kind", "research").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const text = `${JSON.stringify(p.brief ?? {})} ${String((rn?.body as { notes?: string } | null)?.notes ?? "")}`.toLowerCase();
  const { partnerCredited } = await import("@/lib/sales-gtm-core");
  const hit = ((partners ?? []) as Partner[]).find((x) => partnerCredited(text, x));
  return hit ? { relationship: "white_label", partner: hit, detected: true } : null;
}

export async function queueGtm(admin: Admin, o: { prospectId: string; profileId: string; partnerKey?: string | null; ask?: string | null; researched?: boolean; refresh?: boolean; assumed?: boolean }): Promise<{ id: string; existing: boolean }> {
  const { data: open } = await admin.from("prospect_gtms").select("id").eq("prospect_id", o.prospectId).in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (open) return { id: open.id as string, existing: true };
  // Earlier versions stay (their rows and PDFs); the prospect shows the newest and lists the rest
  const { data, error } = await admin.from("prospect_gtms").insert({ prospect_id: o.prospectId, profile_id: o.profileId, partner_key: o.partnerKey ?? null, ask: o.ask?.slice(0, 2000) ?? null, stage: o.researched ? "researched" : o.refresh ? "refresh" : null, assumed: Boolean(o.assumed) }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "The go-to-market strategy couldn't be started.");
  await kickGtm(data.id as string);
  return { id: data.id as string, existing: false };
}

/**
 * Starts a GTM pass now, in a run of its own (the cron route's gtm_run step, up to its 800s limit): the request is let go
 * once sent and that run carries on by itself. The cron's five-minute pickup stays the fallback.
 */
export async function kickGtm(id: string) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
  await fetch(`${base}/api/cron/context?step=gtm_run&id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(4000), cache: "no-store" }).catch(() => {});
}

/**
 * Research finished (on the page, from the assistant, re-run, or before a sales call): the go-to-market strategy builds
 * by itself, no "want it?" step. It follows the prospect's direct-or-white-label setting (stored, or detected from the
 * research); the only thing that can hold it is that one question when neither says, asked at research start.
 */
export async function autoGtm(admin: Admin, o: { prospectId: string; profileId: string; ask?: string | null; refresh?: boolean; hint?: string | null; assumeDirect?: boolean }): Promise<{ queued: true; id: string; existing: boolean; assumed?: boolean } | { queued: false; need: "relationship" | "kit"; say: string }> {
  const { data: p } = await admin.from("prospects").select("id, relationship, partner_key, brief").eq("id", o.prospectId).maybeSingle();
  if (!p) return { queued: false, need: "relationship", say: "The prospect isn't there." };
  let rel = await relationshipOf(admin, p as { id: string; relationship: string | null; partner_key: string | null; brief: unknown });
  // A sales call's invite: a partner's domain among the guests, or its name in the title or description
  if (!rel && o.hint) {
    const { data: partners } = await admin.from("sales_partners").select("key, name, prepared_by, brand, rules, show_fees, contact, pitcher, pitcher_title, website, kit_confirmed_at").eq("active", true);
    const { partnerCredited } = await import("@/lib/sales-gtm-core");
    const h = o.hint.toLowerCase();
    const hit = ((partners ?? []) as Partner[]).find((x) => partnerCredited(h, x) || (x.name.length >= 4 && h.includes(x.name.toLowerCase())));
    if (hit) rel = { relationship: "white_label", partner: hit, detected: true };
  }
  // Ahead of a sales call nothing waits on the question: Kaizen's branding, marked "Assumed Kaizen" with the switch
  if (!rel && o.assumeDirect) {
    const q = await queueGtm(admin, { prospectId: o.prospectId, profileId: o.profileId, ask: o.ask ?? null, researched: !o.refresh, refresh: o.refresh, assumed: true });
    return { queued: true, ...q, assumed: true };
  }
  if (!rel) return { queued: false, need: "relationship", say: `${RELATIONSHIP_QUESTION} The strategy builds as soon as that's set.` };
  if (rel.detected) await admin.from("prospects").update({ relationship: rel.relationship, partner_key: rel.partner?.key ?? null }).eq("id", o.prospectId);
  if (rel.partner && !rel.partner.kit_confirmed_at) return { queued: false, need: "kit", say: `${rel.partner.name}'s brand kit isn't confirmed yet (partner_kit); the strategy builds once it is.` };
  const q = await queueGtm(admin, { prospectId: o.prospectId, profileId: o.profileId, partnerKey: rel.partner?.key ?? null, ask: o.ask ?? null, researched: !o.refresh, refresh: o.refresh });
  return { queued: true, ...q };
}

const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", year: "numeric" });

/** The 3-5 closest local competitors, each with its own website, from a short web search (Google and Maps results) */
async function findCompetitors(p: { name: string; website: string | null; location: string | null; industry: string | null }, brief: ProspectBrief): Promise<{ name: string; website: string | null; role: "competitor" }[]> {
  const notes = await researchWeb({
    agent: "sales_research",
    label: "gtm competitors",
    model: "sonnet",
    maxSearches: 6,
    maxFetches: 4,
    maxTurns: 4,
    system: "You find a business's closest direct competitors from Google and Google Maps results. Real businesses only, each with its own website; never directories, listicles or the business itself.",
    prompt: `Business: ${p.name} (${p.website ?? "no site"}), ${p.industry ?? ""}, in ${p.location ?? brief.locations.join("; ")}. Sells: ${brief.sells.slice(0, 400)}\nList the 5 closest direct competitors in the same area, one per line exactly as: Name | https://their-site`,
  });
  const own = (p.website ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  return [...notes.matchAll(/^\s*[-*\d.)]*\s*([^|\n]{2,80}?)\s*\|\s*(https?:\/\/[^\s|)]+)/gm)]
    .map((m) => ({ name: m[1].replace(/\*+/g, "").trim(), website: m[2], role: "competitor" as const }))
    .filter((x) => !own || !x.website.toLowerCase().includes(own))
    .slice(0, 5);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Real search demand for the strategy: Google Keyword Planner (through any Google Ads account under Kaizen's manager
 * account), seeded by what the prospect sells and its site, in its area (else the US). Average monthly searches, the
 * top-of-page bid range advertisers pay, and the last 12 months. Null when Keyword Planner isn't reachable: the
 * strategy then labels its search numbers as estimates.
 */
export async function prospectKeywordData(admin: Admin, p: { website: string | null; location: string | null; industry: string | null }, brief: ProspectBrief): Promise<string | null> {
  try {
    const ga = await import("@/lib/context/google-ads");
    if (!ga.googleAdsConfigured()) {
      console.log("[gtm] keyword planner: Google Ads not configured");
      return null;
    }
    const { data: acct } = await admin.from("kpi_targets").select("ad_account_id").eq("platform", "google").eq("active", true).not("ad_account_id", "is", null).limit(1).maybeSingle();
    const planner = acct?.ad_account_id ? String(acct.ad_account_id).replace(/\D/g, "") : null;
    if (!planner) {
      console.log("[gtm] keyword planner: no Google Ads account to ask through");
      return null;
    }
    // Its places as "City, ST" (addresses and zips trip Google's matcher), up to five
    const places = [...new Set([p.location ?? "", ...brief.locations].flatMap((t) => [...t.matchAll(/([A-Z][A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/g)].map((m) => `${m[1].replace(/^.*\d\s*/, "").trim()}, ${m[2]}`)))].slice(0, 5);
    // Each place as "City, ST" and as the city alone (Google's matcher takes either), the first match per place kept
    const geos = places.length
      ? (await ga.suggestGeo([...places, ...places.map((x) => x.split(",")[0])]).catch((e) => {
          console.log("[gtm] keyword planner geo:", e instanceof Error ? e.message.slice(0, 300) : e);
          return [];
        })).filter((x, k, all) => all.findIndex((y) => y.geo === x.geo) === k).slice(0, 5)
      : [];
    const geoHit = geos.length ? { geo: geos[0].geo, name: geos.map((x) => x.name.split(",")[0]).join(", ") } : null;
    // Seeds: the kind of business and its service lines (phrases of two words or more, so "reviews" alone never seeds)
    const seeds: string[] = [p.industry?.replace(/\(.*?\)/g, ""), ...brief.sells.split(/[,;:()·.]| and /)].map((x) => String(x ?? "").trim().toLowerCase()).filter((x) => x.split(/\s+/).length >= 2 && x.length <= 60 && !/\$|\d/.test(x) && !/\b(no|not|shown|mentioned|site|faq|page|prices?|pricing|may|differ|also)\b/.test(x)).slice(0, 10);
    // And the searches the market research named ("sauna near me / cold plunge near me"), first
    const themed = (brief.market?.trends ?? []).flatMap((t) => t.keyword.split("/")).map((x) => x.replace(/\(.*?\)|\+.*$/g, "").trim().toLowerCase()).filter((x) => x.length >= 3 && x.length <= 60);
    seeds.unshift(...themed.filter((x) => !seeds.includes(x)));
    const asked = await askJson<{ searches: string[] }>({
      agent: "sales_research",
      label: "gtm keyword seeds",
      override: { model: "haiku", effort: "low" },
      maxTokens: 800,
      schema: { type: "object", additionalProperties: false, required: ["searches"], properties: { searches: { type: "array", items: { type: "string" } } } },
      system: "List 12 short Google searches (2-4 words, lowercase, no brand names, no locations) that someone ready to buy would type to find a business like this one. Plain generic category and service searches.",
      prompt: `${p.industry ?? ""}\n${brief.sells}\n${brief.summary ?? ""}`.slice(0, 2000),
    }).catch(() => ({ searches: [] as string[] }));
    seeds.unshift(...asked.searches.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 3 && x.length <= 60 && !seeds.includes(x)));
    seeds.splice(20);
    const url = p.website ? (/^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`) : null;
    const opts = { url, geo: geos.length ? geos.map((x) => x.geo) : undefined };
    const raw = await ga.keywordIdeas(planner, seeds, opts).catch((e) => {
      console.log("[gtm] keyword planner (with site):", e instanceof Error ? e.message.slice(0, 300) : e);
      return seeds.length ? ga.keywordIdeas(planner, seeds, { geo: opts.geo }) : [];
    });
    const ideas = raw.filter((r) => r.searches > 0).sort((a, b) => b.searches - a.searches).slice(0, 30);
    console.log(`[gtm] keyword planner: ${raw.length} ideas (${ideas.length} with searches), area ${geoHit?.name ?? "US"}, seeds ${seeds.join("; ") || "none"}`);
    if (!ideas.length) return null;
    // The last 12 months, oldest first (Keyword Planner's order): the month each one ends on
    const now = new Date();
    const monthName = (i: number, n: number) => MONTHS[(now.getMonth() - (n - i) + 24) % 12];
    const lines = ideas.map((r) => `${r.text} | ${r.searches}/mo | ${r.bidHigh > 0 ? `top-of-page bid $${r.bidLow.toFixed(2)}-$${r.bidHigh.toFixed(2)}` : "no bid data"} | ${r.competition} | ${r.months.length ? r.months.map((m, i) => `${monthName(i, r.months.length)} ${m}`).join(", ") : ""}`);
    return `<keyword_data source="Google Keyword Planner" read="${today()}" area="${geoHit?.name ?? "United States"}">\nkeyword | avg monthly searches | top-of-page bid range | competition | last 12 months\n${lines.join("\n")}\n</keyword_data>`;
  } catch (e) {
    console.error("[gtm] keyword planner", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Runs one queued GTM (claimed first, so two runners never run the same one) */
export async function runGtm(admin: Admin, id: string): Promise<{ ran: boolean; ok?: boolean }> {
  // Claimed with its stage kept ("researched" means this pass writes), so the research never runs twice for one job
  const { data: job } = await admin.from("prospect_gtms").update({ status: "running", started_at: new Date().toISOString() }).eq("id", id).eq("status", "queued").select("id, prospect_id, profile_id, partner_key, ask, attempts, stage").maybeSingle();
  if (!job) return { ran: false };
  await admin.from("prospect_gtms").update({ attempts: (job.attempts as number) + 1 }).eq("id", id);
  const set = (patch: Record<string, unknown>) => admin.from("prospect_gtms").update(patch).eq("id", id);
  const owner = job.profile_id as string;
  try {
    const { getProspect, researchProspect, rateCardText } = await import("@/lib/sales-agent");
    const p = await getProspect(admin, job.prospect_id as string);
    if (!p) throw new Error("The prospect isn't there anymore.");
    // 1. Research: refreshed when it's missing the market analysis or older than two weeks
    const brief0 = p.brief ? cleanBrief(p.brief) : null;
    // Research once per job (a job already researched goes straight to writing, so it can never loop): when there's none,
    // it has no market analysis, or it's over two weeks old
    const researched = job.stage === "researched";
    const stale = !researched && (job.stage === "refresh" || !brief0 || !(brief0.market?.geo || brief0.market?.competitors?.length) || !p.researched_at || Date.now() - Date.parse(p.researched_at) > 14 * 86_400_000);
    if (stale) {
      await set({ stage: "researching" });
      const r = await researchProspect(admin, admin, { id: owner }, { prospectId: p.id, name: p.name, website: p.website, location: p.location, question: job.ask as string | null, sequential: true, gtm: false });
      if (!r.ok) throw new Error(r.error);
      // The web search came back empty (limits, errors): try again in a later pass rather than write a thin strategy
      if (r.thin) {
        if ((job.attempts as number) >= 3) throw new Error("The market research kept coming back empty (web search limits). Try again later.");
        await set({ status: "queued", stage: null, error: "The market research came back thin: retrying" });
        return { ran: true, ok: false };
      }
      // Research done: the writing runs in the next pass, started now (each pass stays well inside a function's time limit)
      await set({ status: "queued", stage: "researched" });
      await kickGtm(id);
      return { ran: true, ok: true };
    }
    const brief = cleanBrief(p.brief) as ProspectBrief;
    const { data: rn } = await admin.from("prospect_notes").select("body").eq("prospect_id", p.id).eq("kind", "research").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const raw = (rn?.body ?? {}) as { notes?: string; market_notes?: string };
    const partner = await partnerOf(admin, job.partner_key as string | null);
    const { data: sb } = await admin.from("app_settings").select("value").eq("key", "sales_brand").maybeSingle();
    const sv = (sb?.value ?? {}) as { sender_name?: string; sender_title?: string; tagline?: string };
    const sender = { name: sv.sender_name ?? null, title: sv.sender_title ?? null, tagline: sv.tagline ?? "The 1% Agency" };
    const vertical = verticalOf(p.industry, brief.sells);
    const [rates, { data: studies }] = await Promise.all([rateCardText(admin), admin.from("sales_case_studies").select("key, name, vertical, fits, services, results, connection").eq("active", true).order("sort_order")]);
    const by = partner ? partner.prepared_by : "Kaizen Marketing";
    const short0 = shortName(p.name);
    // The market data, read now: search demand (Keyword Planner), the trade area (Census), live Meta ads (Motion)
    const { censusProfile, metaAdIntel, googleAdIntel } = await import("@/lib/sales-intel");
    let rivals = (brief.market?.competitors ?? []).filter((x) => x.name).slice(0, 5).map((x) => ({ name: x.name, website: x.website ?? null, role: "competitor" as const }));
    // The research named none (its search ran short): a quick search for the closest local competitors and their sites
    if (!rivals.length) rivals = await findCompetitors(p, brief).catch(() => []);
    const everyone = [{ name: p.name, website: p.website, role: "prospect" as const }, ...rivals];
    const [keywordData, censusData, adData, googleData] = await Promise.all([
      prospectKeywordData(admin, p, brief),
      censusProfile({ location: p.location, places: brief.locations }),
      metaAdIntel(admin, everyone),
      googleAdIntel(everyone),
    ]);
    console.log(`[gtm] ${id} market data: census ${censusData.includes('unavailable="true"') ? "unavailable" : "read"}, meta ads ${adData.includes('unavailable="true"') ? "unavailable" : "read"} (${rivals.length} competitors)`);
    const material = `<prospect name="${p.name.replace(/"/g, "'")}" short_name_guess="${short0}" site="${p.website ?? ""}" industry="${p.industry ?? ""}" location="${p.location ?? ""}">\n${briefText(p.name, brief)}\n</prospect>\n\n<business_research>\n${String(raw.notes ?? "").slice(0, 30_000)}\n</business_research>\n\n<market_research>\n${String(raw.market_notes ?? "").slice(0, 30_000)}\n</market_research>\n\n${keywordData ?? '<keyword_data unavailable="true">Keyword Planner could not be read for this draft.</keyword_data>'}\n\n${censusData}\n\n${adData}\n\n${googleData}${job.ask ? `\n\n<asked>${job.ask}</asked>` : ""}`;

    // 2. The strategy
    await set({ stage: "writing" });
    const fees = partner ? (partner.show_fees ? "Show management fees from the pricing reference." : "AD SPEND ONLY: never show management or creative fees anywhere; the partner sets its own fees.") : "Lead each tier with ad spend and projections, then the management and creative fees from the pricing reference (exact).";
    // Once more when it fails (a long answer now and then comes back cut or malformed)
    const strategyCall = () => askJson<Record<string, unknown>>({
      agent: "sales_gtm",
      label: "gtm strategy",
      schema: GTM_SCHEMA,
      maxTokens: 32_000,
      system: `You write a client-facing go-to-market strategy for ${p.name}, prepared by ${by}${partner ? ` (a white-label partner: never mention Kaizen anywhere, not in a word, a footer or a note; ${partner.rules})` : ""}. It's the document a prospect reads before or after a first call: research-heavy, specific, confident, plain language, no hype, no placeholders.
Structure (every section is filled; tables are {head, rows, note}, rows as arrays of cells in the head's order; note "" when none):
- cover: short (the name the business goes by in short, e.g. its initials or brand name, used in headers), eyebrow "GO-TO-MARKET STRATEGY · PAID MEDIA OVERVIEW" (or the channels in play), headline (a strong line about their opportunity, without the last few words) + highlight (its ending, shown in the accent color), subtitle (the channels and "90-day launch plan"), location, site (domain), date "${today()}".
- exec: lede (2-3 sentences: what they already have, what they lack); stats: exactly 3 tiles, each a real number from the research with a short label that says its source or date; opportunity (one paragraph); recommend: 3-5 {lead, text} (the front-door offer, the wedge competitors can't copy, the high-intent coverage, the recommended budget with a launch option and when to launch); why_now (seasonality, click-price timing, deadlines).
- who: title (their strongest marketing asset as a headline), lede, table head ["What we found", "Why it matters for marketing"] 4-7 rows of firm facts (credentials, network, footprint, rare capabilities, industries served); sources (where the facts came from).
- footprint: title "Where the pipeline is leaking today", lede, table head ["Area", "Current state", "Fix before or at launch"] 5-8 rows (paid social, paid search, reviews, conversion path, landing pages, proof, language, content, email capture), bottom_line.
- market: title (a headline about the market), lede, stats: exactly 3 market numbers with sources, avatar (the local buyer: area, income, demographics; or the US-wide avatar), tam (the estimate and how it was made, labelled an estimate), implications: 3 {lead, text}, competitors: table head ["Competitor type", "How they win", "Where ${short0} wins"] 3 rows by TYPE (never name a competitor in this document), trends: table head ["Search theme", "Typical CPC", "Monthly volume", "Note"] (see Search numbers below), sources.
- positioning: title, lede, services table head ["Service line", "Typical Google CPC*", "Client value", "Competition", "Role in plan"] with each service line's role (front door, wedge, always-on, upsell, excluded) and note "*Directional ranges from …(source)", core (a short quoted positioning line + one paragraph), offer {name, text, why} (a named, specific, easy-yes front-door offer), pillars: 4 {lead, text}.
- channels: title, lede (how the channels work together), google table head ["Campaign", "Example search themes", "Landing page"] 3-5 rows incl. brand defense when relevant, google_note (guardrails: targeting, negatives, bidding on qualified conversions), meta table head ["Lane", "Who it reaches", "Creative angle"] 2-4 rows incl. retargeting, creative {title, text}: the creative package; the basic package is the "310": ${BASIC_CREATIVE.images} images + ${BASIC_CREATIVE.videos} videos a month, attached to Meta; follow the vertical's advertising rules.
- investment: title, lede (ad spend paid directly to the platforms; projections are planning ranges, not guarantees, replaced by real results within 30-45 days), tiers table: first head cell "" then three tiers (e.g. "Launch", "Recommended", "Accelerate", or the tier names below), rows for each channel's monthly spend, total monthly ad spend, projected leads/month, projected qualified consultations or sales/month, ${partner && !partner.show_fees ? "" : "management + creative fees/month, "}best for. ${fees} Use these tiers, weighted for a ${vertical} business (lead with ${VERTICAL_FOCUS[vertical].lead.join(", ")}): ${tierPlan(vertical).map((t) => `${t.name} = ${t.services.join(" + ")}`).join("; ")}. assumptions (the CPC, conversion rate, CPL and qualification rate behind the projections, and a published spend reference if any), benchmarks: table head ["Metric", then 2-3 columns of sourced categories], rows CTR, CPC, conversion rate, cost per lead (CPM when available), benchmarks_note (the source with its year; say when the industry isn't broken out and an adjacent category stands in), math (the math that matters: how few customers cover the media, using their customer value).
- plan: title "What happens after ${short0} says yes", ninety table head ["Phase", "What we do", "What ${short0} sees"] rows Days 1-14 Foundation, Days 15-45 Launch & test, Days 46-90 Optimize & scale; calendar table head ["Window", "Market reality", "Campaign focus"] 4-6 rows across 12 months (their seasonality, deadlines, cheapest and most expensive click months).
- measure: title "How we'll judge success", table head ["Checkpoint", "What we measure", "What \\"on track\\" looks like"] rows Day 30, Day 60, Day 90; note (their sales cycle), needs (5-8 things we need from them), next: 4 {lead, text}, one_line (the opportunity in one line).
- sources: every source cited (publication, title, date).
Live ads (<meta_ads>): the footprint's paid-social row states the prospect's verified Meta result with its read date (e.g. "0 active Meta ads (Meta Ad Library, read Nov 2026)", or the count and what they run); never "not verified" when <meta_ads> has it. The competitors table stays by TYPE (never a name) but its "how they win" comes from the real ads in <meta_ads>: their hooks, offers, formats, how long ads have run and where they send people. State each library's result for the prospect: the paid-social row gives the Meta count and since when from <meta_ads> ("12 active Meta ads since Mar 2025", or "0 found under <names/site>"); the paid-search row gives the Google Ads Transparency Center result from <google_ads_transparency> (creatives and first/last shown, or "0 found under <domain>", or that it wasn't checked and why). Competitors' Google activity informs the competitors table by type.
The buyer and the market (<census>): market.avatar is built from the census numbers (income, households, age, homeownership, degrees for the zip, city and county), citing "U.S. Census ACS 2023". market.tam is a serviceable market, never a global or national industry figure: the relevant households or businesses in the trade area from <census> (e.g. households over $100k within the city, or county establishments of the right size in the right sectors) × a plausible annual value per customer, with the math written out, ending "[estimated]". When <census> is unavailable, say the census data wasn't read and compute the same estimate from the best counts in the research, marked "[estimated]", or give the method with one worked example.
Search numbers (the trends table, the services table's CPC column, CPC assumptions and the calendar's click-price months): when <keyword_data> has rows, use them exactly (CPC as the top-of-page bid range, e.g. "$4.10-$12.80"; volume as average monthly searches, summed per theme), say in the table note "Google Keyword Planner, <area>, read <month year>", and name the busiest and quietest months from its 12-month searches. When it's unavailable, give a reasoned range for every cell (published benchmarks for the category, or the closest category) and mark each "[estimated]"; never leave a cell blank or write "not sourced", with a note that says plainly they're estimates from <source> and that Keyword Planner numbers for the area replace them in week 1. Never write "pulled in week 1" in a cell, and never say anything is "confirmed" that isn't in the data.
Rules: every number comes from the research or is clearly an estimate; never invent a statistic, review count or quote; never name a competitor; no case studies (the proposal carries those); the vertical's advertising rules apply (licensing boards, health or financial claims, Meta special ad categories).`,
      prompt: `${material}\n\n<pricing_reference note="${partner && !partner.show_fees ? "for your understanding only: do NOT show fees" : "exact fees"}">\n${rates}\n</pricing_reference>`,
    });
    const gtmRaw = await strategyCall().catch((e) => {
      console.error("[gtm] strategy, trying once more:", e instanceof Error ? e.message : e);
      return strategyCall();
    });
    let content: GtmContent = cleanGtm(gtmRaw);
    if (!content.cover.date) content.cover.date = today();
    if (partner) {
      // White-label: zero Kaizen mentions, whatever the model wrote
      if (kaizenMentions(content).length) content = scrubKaizen(content, partner.prepared_by);
    }

    // 3. The internal talking notes (never sent)
    await set({ stage: "notes", content });
    const caseStudies = ((studies ?? []) as CaseStudy[]).map((c) => `- ${c.name} (${c.vertical}): ${c.results}`).join("\n");
    const notesRaw = await askJson<Record<string, unknown>>({
      agent: "sales_gtm",
      label: "gtm notes",
      schema: NOTES_SCHEMA,
      maxTokens: 16_000,
      system: `You write the internal talking notes that go with a go-to-market strategy for ${p.name}. Never sent to the prospect; they're for ${partner ? `the ${partner.name} team pitching it (a white-label partner: no Kaizen mentions, written for them)` : "the Kaizen person running the sales call"}. Every item is one or two sentences with a tag: certain (seen in a source), likely (a strong inference), guessing (an informed estimate).
- headline: what the research says to lead with, in two sentences.
- competitors: one item per competitor in <meta_ads>, NAMED (internal only): active Meta ad count and read date, formats, the hooks and offers they run, CTAs, landing pages and the funnel those imply; plus one item verifying the prospect's own Meta ads, one item with the Meta Ad Library API's own answer (from <meta_ads>), and each competitor's Google Ads Transparency Center result (from <google_ads_transparency>). "Not checked" only where a call errored, with the error. "certain" for what <meta_ads> shows. When <meta_ads> is unavailable, one item saying so and why.
- flags: things to know before pitching (a stat that could be wrong and how to check it, e.g. Meta Ad Library searched only under one page name; anything sensitive about the prospect's current vendors or site${partner ? `; if ${partner.name} appears to have built or run their site or marketing, say so plainly and how the document words those fixes` : ""}).
- decisions: the strategy choices and why the research led there (the lead offer, what was left out and why, channel split).
- caveats: where the numbers are soft (tiers and projections are estimates; benchmarks are adjacent categories; timing assumptions like a launch month and what to switch if they sign later).
- risks: likely objections with a short answer, and the vertical's compliance rules that limit the ads (cite the rule).
- facts: firm facts for the call (credentials, numbers, names, dates) with where they came from.${partner ? "" : `\nCase studies you may mention on the call (exact numbers, internal reference):\n${caseStudies}`}`,
      prompt: `${material}\n\n<the_strategy_document>\n${JSON.stringify(content).slice(0, 30_000)}\n</the_strategy_document>`,
    });
    const notes: GtmNotes = cleanNotes(partner ? scrubKaizen(notesRaw, partner.name) : notesRaw, partner?.name ?? null);

    // 4. The PDF, filed as a document (Drive saving goes through upload_to_drive and the Drive rule)
    await set({ stage: "pdf", notes });
    const { renderGtmPdf, brandFor } = await import("@/lib/sales-gtm-pdf");
    const pdf = await renderGtmPdf(content, brandFor(partner, sender), { name: p.name, short: content.cover.short || short0 });
    const path = `prospects/${p.id}/gtm-${id}.pdf`;
    const up = await admin.storage.from("client-docs").upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (up.error) throw new Error(`The PDF couldn't be stored: ${up.error.message}`);
    const fileName = GTM_FILE(p.name, partner?.name ?? null);
    const { data: doc } = await admin
      .from("kaizen_documents")
      .insert({ profile_id: owner, kind: "gtm", template: "gtm", title: `${p.name} · Go-to-market strategy${partner ? ` (${partner.name})` : ""}`, content: { gtm_id: id, partner: partner?.key ?? null }, bucket: "client-docs", path, file_name: fileName, prospect_name: p.name })
      .select("id")
      .single();
    await set({ status: "done", stage: null, document_id: doc?.id ?? null, finished_at: new Date().toISOString() });
    const { data: me } = await admin.from("profiles").select("is_exec").eq("id", owner).maybeSingle();
    await admin.from("notifications").upsert(
      { profile_id: owner, kind: "prospect_search", key: `gtm:${id}`, title: `Go-to-market strategy ready: ${p.name}${partner ? ` (${partner.name})` : ""}`, body: "The PDF and your internal talking notes are on the prospect. Ask your assistant to save it to Drive or email it.", href: me?.is_exec ? `/sales/${p.id}#gtm` : null, priority: "normal" },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
    return { ran: true, ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 300) : "It didn't finish.";
    console.error("[gtm]", id, message);
    await set({ status: "failed", error: message, finished_at: new Date().toISOString() });
    return { ran: true, ok: false };
  }
}

/** The cron's pickup: queued GTMs a cut-off server never started, and runs that died part way (once more, then failed) */
export async function pickUpGtms(admin: Admin) {
  const stale = new Date(Date.now() - 90_000).toISOString();
  const dead = new Date(Date.now() - 20 * 60_000).toISOString();
  const { data: stuck } = await admin.from("prospect_gtms").select("id, attempts, stage").eq("status", "running").lt("started_at", dead).limit(5);
  for (const s of stuck ?? []) {
    if ((s.attempts as number) >= 3) await admin.from("prospect_gtms").update({ status: "failed", error: "It took too long. Try again.", finished_at: new Date().toISOString() }).eq("id", s.id);
    // Died while writing: the research is in, so the retry goes straight to writing
    else await admin.from("prospect_gtms").update({ status: "queued", stage: s.stage && s.stage !== "researching" ? "researched" : null }).eq("id", s.id).eq("status", "running");
  }
  const { data: queued } = await admin.from("prospect_gtms").select("id").eq("status", "queued").lt("created_at", stale).order("created_at").limit(1);
  let ran = 0;
  for (const q of queued ?? []) if ((await runGtm(admin, q.id as string)).ran) ran++;
  return { requeued: stuck?.length ?? 0, ran };
}

export { feeMentions };
