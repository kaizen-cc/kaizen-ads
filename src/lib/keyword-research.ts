import "server-only";
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, aiEnabled } from "@/lib/ai";
import { US_GEO, accountKeywordTexts, campaignLocations, geoNames, keywordIdeas, suggestGeo } from "@/lib/context/google-ads";
import { googleAccountOf, tidyPlan, type DeployPlan, type DeployTarget, type Kw, type Match } from "@/lib/google-deploy";

// Keyword research for one client (Ideas › Google › In the market): Keyword Planner ideas seeded by their site, what
// converts in their account and their sub-vertical (or the buyer's own seeds and a page of their site), in the places
// they advertise instead of the whole US. A relevance pass sorts each idea: relevant (grouped into themes), another
// business's name (kept apart: negatives or conquesting) or off-topic (hidden). Ideas already in their account are
// marked. Results are kept 24 hours (Basic access allows 15,000 operations a day). The buyer picks keywords, saves them
// as a named list on the client, or adds them to an ad group, paused, when live changes are on for that client.

export type IdeaGroup = "relevant" | "competitor" | "irrelevant";
export type ResearchIdea = { text: string; searches: number; competition: string; competitionIndex: number; bidLow: number; bidHigh: number; months: number[]; theme: string; group: IdeaGroup; inAccount: boolean; seeded: boolean };
export type Research = {
  clientId: string | null;
  client: string | null;
  account: string | null;
  geo: { label: string; source: "campaigns" | "client" | "us" };
  seeds: string[];
  url: string | null;
  ideas: ResearchIdea[];
  themes: { name: string; count: number; searches: number }[];
  readAt: string;
  cached: boolean;
  sorted: boolean;
};
export type ListKeyword = { text: string; match: Match; negative: boolean; searches?: number; competition?: string; bidLow?: number; bidHigh?: number; theme?: string };
export type KeywordList = { id: string; clientId: string; name: string; keywords: ListKeyword[]; createdAt: string; updatedAt: string };

const DAY = 86_400_000;
/** Fresh Keyword Planner reads per person per hour (cached reads don't count) */
const HOURLY_LIMIT = 40;
const KEEP = 150;

/** Big chains and brands people search by name: another business, never a keyword for our client (the AI's backstop) */
const CHAINS =
  /\b(mcdonald'?s?|starbucks|chick[- ]?fil[- ]?a|taco bell|wendy'?s|subway|domino'?s|pizza hut|burger king|kfc|chipotle|dunkin|olive garden|applebee'?s|panera|papa john'?s|little caesars|sonic|arby'?s|popeyes|ihop|denny'?s|cracker barrel|red lobster|outback|buffalo wild wings|texas roadhouse|chili'?s|five guys|in[- ]n[- ]out|whataburger|jersey mike'?s|jimmy john'?s|panda express|shake shack|waffle house|home depot|lowe'?s|walmart|target|amazon|costco|sam'?s club|best buy|ikea|wayfair|sephora|ulta|cvs|walgreens|planet fitness|la fitness|orangetheory|massage envy|hello ?fresh|blue apron|home ?chef|butcher ?box|thrive market|uber ?eats|doordash|grubhub|instacart|yelp|angi|home ?advisor|thumbtack)\b/i;
export const looksLikeChain = (text: string) => CHAINS.test(text);

/** Any Google Ads account we can ask Keyword Planner through (it isn't tied to whose account it is) */
async function anyGoogleAccount(admin: SupabaseClient) {
  const { data } = await admin.from("kpi_targets").select("ad_account_id").eq("platform", "google").eq("active", true).not("ad_account_id", "is", null).limit(1).maybeSingle();
  return data?.ad_account_id ? String(data.ad_account_id).replace(/\D/g, "") : null;
}

const shortPlace = (canonical: string) => canonical.split(",")[0]?.trim() || canonical;
const placesLabel = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3} more`);

/** Where the client advertises: their live campaigns' locations, else the places in their intake, else the US. */
export async function clientGeo(admin: SupabaseClient, clientId: string | null, account: string | null, plannerAccount: string): Promise<{ geo: string[]; label: string; source: Research["geo"]["source"] }> {
  if (account) {
    try {
      const geo = (await campaignLocations(account)).slice(0, 10);
      if (geo.length) {
        const names = await geoNames(account, geo);
        return { geo, label: placesLabel(geo.map((g) => shortPlace(names.get(g) ?? g.replace("geoTargetConstants/", "#")))), source: "campaigns" };
      }
    } catch {
      /* fall through to what the client told us */
    }
  }
  if (clientId) {
    const { data: intake } = await admin.from("client_intakes").select("summary").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle();
    const where = String((intake?.summary as { locations?: string } | null)?.locations ?? "").trim();
    const national = !where || /not given|nationwide|national|anywhere|all of the us|^(the )?(us|usa|united states)$/i.test(where);
    if (!national) {
      const names = where
        .split(/[;\n/]|,(?!\s*(?:[A-Z]{2}|Texas|Florida|California|New York|New Jersey)\b)|\band\b|&/)
        .map((x) => x.replace(/\b(within|around|near|radius|miles?|mi|the|area|metro|greater)\b/gi, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim())
        .filter((x) => x.length >= 2)
        .slice(0, 10);
      try {
        const found = await suggestGeo(names);
        if (found.length) return { geo: found.map((f) => f.geo).slice(0, 10), label: placesLabel(found.map((f) => shortPlace(f.name))), source: "client" };
      } catch {
        /* the US below */
      }
    }
  }
  void plannerAccount;
  return { geo: [US_GEO], label: "United States", source: "us" };
}

const SORT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, g: { type: "string", enum: ["relevant", "competitor", "irrelevant"] }, t: { type: "string" } },
        required: ["i", "g", "t"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/**
 * The relevance pass: each idea relevant (with a short theme), another business's name, or off-topic for this
 * business. Falls back to keeping everything (chains set apart) when the AI isn't available.
 */
export async function sortIdeas(about: string, label: string, texts: string[]): Promise<{ map: Map<string, { group: IdeaGroup; theme: string }>; sorted: boolean }> {
  const fallback = () => new Map(texts.map((t) => [t, { group: (looksLikeChain(t) ? "competitor" : "relevant") as IdeaGroup, theme: "Ideas" }]));
  if (!texts.length) return { map: new Map(), sorted: false };
  if (!aiEnabled()) return { map: fallback(), sorted: false };
  try {
    const out = await askJson<{ items: { i: number; g: IdeaGroup; t: string }[] }>({
      agent: "google_launcher",
      label: `keyword relevance ${label}`,
      bare: true,
      override: { model: "haiku", effort: "low" },
      maxTokens: 6000,
      system: `You sort Google Ads keyword ideas for one business. For each idea (by its number):
g: "relevant" when someone searching it could become this business's customer (their products, services, problems they solve, occasions, "near me" searches for what they offer); "competitor" when it names another specific business or brand (a chain, a competitor, a marketplace), even if it's in their category; "irrelevant" when it's about something they don't offer, jobs, recipes or how-tos with no buying intent, or another place than where they sell.
t: for relevant ideas, a short theme of 1 to 3 words grouping ideas that belong in one ad group (e.g. "Catering", "Brunch", "Near me", "Gift boxes"); reuse the same theme names; 4 to 10 themes in all. For the others, "".
Return every number once.`,
      prompt: `<business>\n${about}\n</business>\n\n<ideas>\n${texts.map((t, i) => `${i}. ${t}`).join("\n")}\n</ideas>`,
      schema: SORT_SCHEMA,
    });
    const map = fallback();
    for (const x of out.items ?? []) {
      const text = texts[x.i];
      if (!text) continue;
      const group: IdeaGroup = looksLikeChain(text) ? "competitor" : x.g;
      map.set(text, { group, theme: group === "relevant" ? (x.t || "Ideas").slice(0, 40) : "" });
    }
    return { map, sorted: true };
  } catch {
    return { map: fallback(), sorted: false };
  }
}

const cacheKey = (o: { clientId: string | null; seeds: string[]; url: string | null }) =>
  createHash("sha256")
    .update(JSON.stringify({ c: o.clientId ?? "", s: [...o.seeds].map((x) => x.toLowerCase()).sort(), u: (o.url ?? "").toLowerCase() }))
    .digest("hex");

/** Seeds and the client's details, when none are typed: their site, what converts for them, their sub-vertical */
async function clientBasics(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: wins }] = await Promise.all([
    admin.from("clients").select("name, website, industry, industry_detail, services, verticals(name)").eq("id", clientId).maybeSingle(),
    admin.from("google_ideas").select("kind, content, conversions").eq("client_id", clientId).in("kind", ["search_term", "keyword"]).order("conversions", { ascending: false }).limit(12),
  ]);
  const converting = [...new Set((wins ?? []).map((w) => String((w.content as { text?: string } | null)?.text ?? "").toLowerCase()).filter((x) => x && x.length <= 80))];
  const sub = (c?.verticals as unknown as { name: string } | null)?.name ?? null;
  return { c, converting, sub };
}

/** Research for a client (or seeds alone): cached for 24 hours, `fresh` reads again. */
export async function research(admin: SupabaseClient, by: string, o: { clientId: string | null; seeds: string[]; url: string | null; fresh?: boolean }): Promise<Research> {
  const seedsIn = [...new Set(o.seeds.map((x) => x.trim().toLowerCase()).filter((x) => x && x.length <= 80))].slice(0, 20);
  const urlIn = o.url?.trim() ? (/^https?:\/\//i.test(o.url.trim()) ? o.url.trim() : `https://${o.url.trim()}`) : null;
  const key = cacheKey({ clientId: o.clientId, seeds: seedsIn, url: urlIn });
  if (!o.fresh) {
    const { data: hit } = await admin.from("keyword_research_cache").select("result, created_at").eq("key", key).gte("created_at", new Date(Date.now() - DAY).toISOString()).maybeSingle();
    if (hit?.result) return { ...(hit.result as Research), cached: true };
  }
  const { count } = await admin.from("keyword_research_cache").select("key", { count: "exact", head: true }).eq("created_by", by).gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  if ((count ?? 0) >= HOURLY_LIMIT) throw new Error("That's a lot of fresh searches this hour. Earlier ones are still here for 24 hours; try again in a bit.");

  const basics = o.clientId ? await clientBasics(admin, o.clientId) : null;
  const account = o.clientId ? await googleAccountOf(admin, o.clientId) : null;
  const planner = account ?? (await anyGoogleAccount(admin));
  if (!planner) throw new Error("There's no Google Ads account to ask Keyword Planner through yet.");

  // No seeds typed: their site, what converts for them and their sub-vertical
  let seeds = seedsIn;
  let url = urlIn;
  if (!seeds.length && basics) {
    seeds = [...basics.converting, ...[basics.sub, basics.c?.industry_detail].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase())].slice(0, 20);
    if (!url && basics.c?.website) url = /^https?:\/\//i.test(String(basics.c.website)) ? String(basics.c.website) : `https://${basics.c.website}`;
  }
  if (!seeds.length && !url) throw new Error("Type a few seed keywords (or a page of their site) to search around.");

  const geo = await clientGeo(admin, o.clientId, account, planner);
  let raw = await keywordIdeas(planner, seeds, { url, geo: geo.geo }).catch(async (e) => {
    // A page Google can't read: try the seeds alone
    if (url && seeds.length) return keywordIdeas(planner, seeds, { geo: geo.geo });
    throw e;
  });
  raw = raw.filter((r) => r.searches > 0).sort((a, b) => b.searches - a.searches).slice(0, KEEP);
  const [inAccount, sorting] = await Promise.all([
    account ? accountKeywordTexts(account).catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
    sortIdeas(
      basics?.c
        ? `${basics.c.name}${basics.sub ? `, ${basics.sub}` : ""}${basics.c.industry_detail ? ` (${basics.c.industry_detail})` : ""}. Website: ${basics.c.website ?? "unknown"}. Where they sell: ${geo.label}.${basics.converting.length ? ` Searches that convert for them: ${basics.converting.slice(0, 8).join(", ")}.` : ""}`
        : `A business searching around: ${seeds.join(", ")}${url ? ` (site ${url})` : ""}. Where: ${geo.label}.`,
      basics?.c?.name ?? seeds[0] ?? "research",
      raw.map((r) => r.text),
    ),
  ]);
  const converting = new Set([...(basics?.converting ?? []), ...seedsIn]);
  const ideas: ResearchIdea[] = raw.map((r) => {
    const s = sorting.map.get(r.text) ?? { group: "relevant" as IdeaGroup, theme: "Ideas" };
    return { ...r, theme: s.theme, group: s.group, inAccount: inAccount.has(r.text.toLowerCase()), seeded: converting.has(r.text.toLowerCase()) };
  });
  const byTheme = new Map<string, { count: number; searches: number }>();
  for (const i of ideas.filter((x) => x.group === "relevant")) {
    const t = byTheme.get(i.theme) ?? { count: 0, searches: 0 };
    t.count++;
    t.searches += i.searches;
    byTheme.set(i.theme, t);
  }
  const result: Research = {
    clientId: o.clientId,
    client: (basics?.c?.name as string | undefined) ?? null,
    account,
    geo: { label: geo.label, source: geo.source },
    seeds,
    url,
    ideas,
    themes: [...byTheme].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.searches - a.searches),
    readAt: new Date().toISOString(),
    cached: false,
    sorted: sorting.sorted,
  };
  await admin.from("keyword_research_cache").upsert({ key, client_id: o.clientId, result, created_by: by, created_at: result.readAt });
  return result;
}

// ─── Lists and adding to the account ───

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export function cleanKeywords(list: ListKeyword[]): ListKeyword[] {
  const seen = new Set<string>();
  return list
    .map((k) => ({
      text: clip(String(k.text ?? "").toLowerCase().replace(/[[\]"]/g, ""), 80),
      match: (["exact", "phrase", "broad"] as const).includes(k.match) ? k.match : ("phrase" as Match),
      negative: Boolean(k.negative),
      ...(k.searches != null ? { searches: Number(k.searches) || 0 } : {}),
      ...(k.competition ? { competition: String(k.competition).slice(0, 20) } : {}),
      ...(k.bidLow != null ? { bidLow: Number(k.bidLow) || 0 } : {}),
      ...(k.bidHigh != null ? { bidHigh: Number(k.bidHigh) || 0 } : {}),
      ...(k.theme ? { theme: clip(String(k.theme), 40) } : {}),
    }))
    .filter((k) => k.text && !seen.has(`${k.text}|${k.match}|${k.negative}`) && seen.add(`${k.text}|${k.match}|${k.negative}`))
    .slice(0, 200);
}

export const toList = (r: Record<string, unknown>): KeywordList => ({
  id: r.id as string,
  clientId: r.client_id as string,
  name: r.name as string,
  keywords: (r.keywords ?? []) as ListKeyword[],
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export async function loadLists(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("client_keyword_lists").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(30);
  return (data ?? []).map(toList);
}

/**
 * A selection added to a client: kept as a Google deploy (kind keywords, already approved by the buyer who picked it),
 * so it shows in the client's "Ideas to use" with its history and checklist, and can be pushed now or later.
 */
export async function createResearchDeploy(admin: SupabaseClient, o: { clientId: string; keywords: ListKeyword[]; finalUrl: string; target: DeployTarget; by: string; listName?: string | null; seeds: string[] }) {
  const clean = cleanKeywords(o.keywords);
  const toKw = (k: ListKeyword): Kw => ({ text: k.text, match: k.match });
  const positives = clean.filter((k) => !k.negative).map(toKw);
  const negatives = clean.filter((k) => k.negative).map(toKw);
  if (!positives.length && !negatives.length) throw new Error("Pick some keywords first.");
  const where = o.target.newAdGroup ? `a new ad group "${o.target.newAdGroup}" in "${o.target.campaign ?? "the campaign"}"` : o.target.adGroup ? `"${o.target.adGroup}" in "${o.target.campaign ?? "the campaign"}"` : "the ad group that fits";
  const searches = clean.reduce((n, k) => n + (k.searches ?? 0), 0);
  const plan: DeployPlan = tidyPlan({
    summary: `${positives.length} keyword${positives.length === 1 ? "" : "s"}${negatives.length ? ` and ${negatives.length} negative${negatives.length === 1 ? "" : "s"}` : ""} from keyword research${o.listName ? ` ("${o.listName}")` : ""}, for ${where}.`,
    why: `Picked by the buyer in keyword research${o.seeds.length ? ` around ${o.seeds.slice(0, 5).join(", ")}` : ""}${searches ? `: about ${searches.toLocaleString("en-US")} searches a month where they advertise` : ""}.`,
    headlines: [],
    descriptions: [],
    path1: "",
    path2: "",
    finalUrl: o.finalUrl,
    campaignName: o.target.campaign ?? "",
    adGroups: [],
    keywords: positives,
    negatives,
    settings: [],
    checklist: [
      o.target.newAdGroup ? `In Google Ads, open "${o.target.campaign ?? "the campaign"}" and add an ad group named "${o.target.newAdGroup}" (paused until it has an ad).` : `In Google Ads, open ${where}.`,
      `Add the keywords with their match types${o.target.status === "ENABLED" ? "" : ", paused"}${o.finalUrl ? `, with the final URL ${o.finalUrl}` : ""}.`,
      ...(negatives.length ? [`Add the negatives to "${o.target.campaign ?? "the campaign"}".`] : []),
      ...(o.target.newAdGroup ? ["Write a responsive search ad for the new ad group before turning it on."] : []),
    ],
    target: o.target,
  });
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("google_deploys")
    .insert({
      client_id: o.clientId,
      idea_id: null,
      idea: { kind: "research", text: `Keyword research${o.listName ? `: ${o.listName}` : ""}${o.seeds.length ? ` (${o.seeds.slice(0, 5).join(", ")})` : ""}`, result: searches ? `About ${searches.toLocaleString("en-US")} searches a month` : `${clean.length} keywords` },
      kind: "keywords",
      status: "approved",
      plan,
      created_by: o.by,
      decided_by: o.by,
      decided_at: now,
      updated_at: now,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save it.");
  return data.id as string;
}
