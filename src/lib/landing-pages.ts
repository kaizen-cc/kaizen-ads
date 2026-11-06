import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cachedRead } from "@/lib/launch-cache";
import { isPublicHost } from "@/lib/references";
import type { LaunchQuestion } from "@/lib/launch-sheet/types";
import {
  ABOUT_LANDING,
  homeOf,
  isJunk,
  kindOf,
  labelOf,
  landingVerdict,
  matchPage,
  normalizeUrl,
  parseSitemap,
  robotsSitemaps,
  sameSite,
  sitemapOrder,
  urlIn,
  type LandingPage,
  type LandingSet,
  type Reach,
} from "./landing-pages-core";

// The landing-page finder: the pages a launch can send people to, so the launch chat offers them by name instead of
// asking the buyer to paste a link. Found from
//   the homepage       the client's website field (the homepage in the form Google wants, trailing slash)
//   live ads           the final URLs of the live Google ads (and PMax asset groups) and the links of the live Meta ads,
//                      with how many ads use each and their last 30 days of conversions and spend
//   the Brand Bible    the client's own pages it links (bible_links)
//   the sitemap        robots.txt's Sitemap lines, else /sitemap.xml or /sitemap_index.xml, an index followed one level
//                      (Shopify's collections, pages and products sitemaps first), at most 300 pages
// and named by their <title> for the 15 that matter most. Kept a day per client and account (keyword_research_cache,
// keys "pages:…"), so every launch, retry and chat turn reads it at once.

const DAY = 24 * 3_600_000;
const MAX_PAGES = 300;
const UA = "Mozilla/5.0 (compatible; KaizenAdsBot/1.0; landing page finder)";

/** A text resource, read up to `max` bytes, or null (not public, not found, too slow) */
async function fetchText(url: string, ms: number, max: number): Promise<string | null> {
  try {
    if (!isPublicHost(url)) return null;
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms), headers: { "User-Agent": UA, accept: "text/html,application/xml,text/xml,text/plain,*/*" }, cache: "no-store" });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => undefined);
    return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  } catch {
    return null;
  }
}

const within = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** The site's pages from its sitemaps (an index followed one level), same site only, no carts or policies */
export async function sitemapPages(home: string): Promise<string[]> {
  const origin = home.replace(/\/+$/, "");
  const robots = await fetchText(`${origin}/robots.txt`, 3500, 100_000);
  const listed = robots ? robotsSitemaps(robots).filter((u) => sameSite(u, home)) : [];
  const roots = listed.length ? listed.slice(0, 3) : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const read = await Promise.all(roots.map((u) => fetchText(u, 4500, 3_000_000)));
  const urls: string[] = [];
  let children: string[] = [];
  for (const xml of read) {
    if (!xml) continue;
    const p = parseSitemap(xml);
    urls.push(...p.urls);
    children.push(...p.index);
  }
  // Nothing at the usual places: Shopify's own sitemap names
  if (!urls.length && !children.length) children = ["collections", "pages", "products"].map((k) => `${origin}/sitemap_${k}_1.xml`);
  const kids = sitemapOrder([...new Set(children)].filter((u) => sameSite(u, home))).slice(0, 6);
  const more = await Promise.all(kids.map((u) => fetchText(u, 4500, 3_000_000)));
  for (const xml of more) if (xml) urls.push(...parseSitemap(xml).urls);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = normalizeUrl(raw);
    if (!u || !sameSite(u, home) || isJunk(u)) continue;
    const k = u.replace(/\/+$/, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= MAX_PAGES) break;
  }
  return out;
}

/** A page's <title> (or og:title), read from its first 150 KB */
async function titleOf(url: string): Promise<string | null> {
  const html = await fetchText(url, 3000, 150_000);
  if (!html) return null;
  const raw = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  const t = raw
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 120) : null;
}

type Usage = { url: string; ads: number; conversions: number; spend: number };

/** The live Google ads' final URLs (and PMax asset groups'), with how many use each and their last 30 days */
async function googleUsage(account: string): Promise<Usage[]> {
  const { googleQuery } = await import("@/lib/context/google-ads");
  type Row = { adGroupAd?: { ad?: { finalUrls?: string[] } }; assetGroup?: { finalUrls?: string[] }; metrics?: { conversions?: number | string; costMicros?: number | string } };
  const live = "ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'";
  const [ads, perf, groups] = await Promise.all([
    (googleQuery(account, `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ${live}`) as Promise<Row[]>).catch(() => [] as Row[]),
    (googleQuery(account, `SELECT ad_group_ad.ad.final_urls, metrics.conversions, metrics.cost_micros FROM ad_group_ad WHERE ${live} AND segments.date DURING LAST_30_DAYS`) as Promise<Row[]>).catch(() => [] as Row[]),
    (googleQuery(account, "SELECT asset_group.final_urls FROM asset_group WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'") as Promise<Row[]>).catch(() => [] as Row[]),
  ]);
  const by = new Map<string, Usage>();
  const at = (raw: string | undefined) => {
    const u = normalizeUrl(raw);
    if (!u) return null;
    const x = by.get(u) ?? { url: u, ads: 0, conversions: 0, spend: 0 };
    by.set(u, x);
    return x;
  };
  for (const list of [...ads.map((r) => r.adGroupAd?.ad?.finalUrls), ...groups.map((r) => r.assetGroup?.finalUrls)])
    for (const u of new Set(list ?? [])) {
      const x = at(u);
      if (x) x.ads += 1;
    }
  for (const r of perf) {
    const x = at(r.adGroupAd?.ad?.finalUrls?.[0]);
    if (!x) continue;
    x.conversions += Number(r.metrics?.conversions) || 0;
    x.spend += (Number(r.metrics?.costMicros) || 0) / 1e6;
  }
  return [...by.values()];
}

/** The live Meta ads' links (link ads, videos' buttons, dynamic creative), with how many use each and their last 30 days */
async function metaUsage(account: string): Promise<Usage[]> {
  const { metaGraph } = await import("@/lib/context/meta");
  type Creative = { link_url?: string; object_story_spec?: { link_data?: { link?: string; call_to_action?: { value?: { link?: string } } }; video_data?: { call_to_action?: { value?: { link?: string } } } }; asset_feed_spec?: { link_urls?: { website_url?: string }[] } };
  type Ad = { creative?: Creative; insights?: { data?: { spend?: string; actions?: { action_type: string; value: string }[] }[] } };
  const r = await metaGraph<{ data: Ad[] }>(`act_${account.replace(/^act_/, "")}/ads`, {
    fields: "creative{link_url,object_story_spec{link_data{link,call_to_action},video_data{call_to_action}},asset_feed_spec{link_urls}},insights.date_preset(last_30d){spend,actions}",
    effective_status: JSON.stringify(["ACTIVE"]),
    limit: "200",
  }).catch(() => ({ data: [] as Ad[] }));
  const by = new Map<string, Usage>();
  for (const ad of r.data ?? []) {
    const c = ad.creative;
    const links = [c?.object_story_spec?.link_data?.call_to_action?.value?.link, c?.object_story_spec?.link_data?.link, c?.object_story_spec?.video_data?.call_to_action?.value?.link, ...(c?.asset_feed_spec?.link_urls ?? []).map((l) => l.website_url), c?.link_url];
    const urls = [...new Set(links.map((l) => normalizeUrl(l)).filter((u): u is string => Boolean(u) && !/facebook\.com|instagram\.com|fb\.me/i.test(u!)))];
    const ins = ad.insights?.data?.[0];
    const buys = Math.max(0, ...(ins?.actions ?? []).filter((a) => ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"].includes(a.action_type)).map((a) => Number(a.value) || 0));
    urls.forEach((u, i) => {
      const x = by.get(u) ?? { url: u, ads: 0, conversions: 0, spend: 0 };
      x.ads += 1;
      // An ad's numbers go to its main link only
      if (i === 0) {
        x.conversions += buys;
        x.spend += Number(ins?.spend) || 0;
      }
      by.set(u, x);
    });
  }
  return [...by.values()];
}

async function find(admin: SupabaseClient, clientId: string, o: { google?: string | null; meta?: string | null }): Promise<LandingSet> {
  const [{ data: c }, { data: bible }, google, meta] = await Promise.all([
    admin.from("clients").select("website").eq("id", clientId).maybeSingle(),
    admin.from("bible_links").select("url, label, title, ok").eq("client_id", clientId).limit(80),
    o.google ? within(googleUsage(o.google).catch(() => [] as Usage[]), 8000, [] as Usage[]) : Promise.resolve([] as Usage[]),
    o.meta ? within(metaUsage(o.meta).catch(() => [] as Usage[]), 8000, [] as Usage[]) : Promise.resolve([] as Usage[]),
  ]);
  const used = [...google, ...meta].sort((a, b) => b.ads - a.ads);
  // No website on file: the site the live ads send people to
  const site = homeOf(c?.website as string | null | undefined) ?? homeOf(used[0]?.url ?? null);
  const fromSitemap = site ? await within(sitemapPages(site), 12_000, [] as string[]) : [];
  const pages = new Map<string, LandingPage>();
  const keyOf = (u: string) => u.replace(/\/+$/, "");
  const add = (url: string, source: LandingPage["sources"][number], u?: Partial<Usage>, label?: string | null, title?: string | null) => {
    const k = keyOf(url);
    const p = pages.get(k) ?? { url, label: "", kind: kindOf(url), sources: [], ads: 0, conversions: 0, spend: 0, title: null };
    if (!p.sources.includes(source)) p.sources.push(source);
    p.ads += u?.ads ?? 0;
    p.conversions += u?.conversions ?? 0;
    p.spend += u?.spend ?? 0;
    p.title = p.title ?? title ?? null;
    if (label && !p.label) p.label = label;
    pages.set(k, p);
  };
  if (site) add(site, "home");
  // Live ads' pages on other sites (a booking engine, a marketplace) are still where those ads go: kept, they rank on use
  for (const u of used) add(u.url, "ads", u);
  for (const b of bible ?? []) {
    const u = normalizeUrl(b.url as string);
    if (u && b.ok !== false && (!site || sameSite(u, site)) && !isJunk(u)) add(u, "bible", undefined, (b.label as string | null) ?? null, (b.title as string | null) ?? null);
  }
  for (const u of fromSitemap) add(u, "sitemap");
  const order = { home: 0, collection: 1, page: 2, product: 3, other: 4, blog: 5 };
  const list = [...pages.values()].sort((a, b) => b.ads - a.ads || order[a.kind] - order[b.kind]).slice(0, MAX_PAGES);
  // Titles for the pages most likely to be offered (the homepage, the ones live ads use, the Bible's, collections)
  const titled = list
    .filter((p) => !p.title)
    .sort((a, b) => Number(b.kind === "home") - Number(a.kind === "home") || b.ads - a.ads || Number(b.sources.includes("bible")) - Number(a.sources.includes("bible")) || order[a.kind] - order[b.kind])
    .slice(0, 15);
  const titles = await within(Promise.all(titled.map((p) => titleOf(p.url))), 5000, [] as (string | null)[]);
  titled.forEach((p, i) => (p.title = titles[i] ?? null));
  for (const p of list) {
    p.label = p.label || labelOf(p.url, p.title);
    p.conversions = Math.round(p.conversions * 10) / 10;
    p.spend = Math.round(p.spend);
  }
  return { site, pages: list, at: new Date().toISOString() };
}

/** The client's landing pages for a launch (kept a day; `fresh` reads them again) */
export async function findLandingPages(admin: SupabaseClient, clientId: string, o: { google?: string | null; meta?: string | null; fresh?: boolean } = {}): Promise<LandingSet> {
  const key = `${clientId}:${o.google ?? "-"}:${o.meta ?? "-"}`;
  const { value } = await cachedRead<LandingSet>(admin, key, () => find(admin, clientId, o), { clientId, ttl: DAY, fresh: o.fresh, prefix: "pages:" });
  return value;
}

/** The set kept on a launch run: the pages that can matter (ads, Bible, homepage first), small enough to store */
export function keepOnRun(set: LandingSet, max = 150): LandingSet {
  return { ...set, pages: set.pages.slice(0, max) };
}

/** Whether a link loads: its status and where it ends up after redirects (HEAD, else GET; 5 seconds) */
export async function reachUrl(url: string): Promise<Reach> {
  if (!isPublicHost(url)) return { status: 0, finalUrl: null };
  const go = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(5000), headers: { "User-Agent": UA }, cache: "no-store" });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, finalUrl: res.url || url };
  };
  try {
    const h = await go("HEAD");
    // Some shops refuse HEAD (or bots) on HEAD only
    if ([400, 403, 405, 501].includes(h.status)) return await go("GET").catch(() => h);
    return h;
  } catch {
    return go("GET").catch(() => ({ status: 0, finalUrl: null }));
  }
}

/**
 * The landing-page answer after a chat turn, made a real link: a page the buyer named in words ("the homepage", "the
 * salmon collection") becomes its link, even when the chat didn't take it; a link they typed is checked (gone: not
 * taken; redirected: its destination; another site: a warning). `note` is what the chat says about it.
 */
export async function settleLanding(questions: LaunchQuestion[], key: string, set: LandingSet | null | undefined, message: string, answeredNow: boolean): Promise<{ questions: LaunchQuestion[]; note: string | null; took: boolean }> {
  const q = questions.find((x) => x.key === key);
  if (!q) return { questions, note: null, took: false };
  const s: LandingSet = set ?? { site: null, pages: [], at: "" };
  let answer = q.answer;
  let typed = false;
  let took = false;
  let note: string | null = null;
  if (!answer) {
    if (ABOUT_LANDING.test(message) || urlIn(message)) {
      const m = matchPage(message, s);
      if (m) {
        answer = m.url;
        typed = m.typed;
        took = true;
      }
    }
  } else if (answeredNow) {
    const u = urlIn(answer);
    if (u) {
      answer = u;
      typed = !s.pages.some((p) => p.url === u);
    } else {
      const m = matchPage(answer, s) ?? matchPage(message, s);
      if (m) {
        answer = m.url;
        typed = m.typed;
      } else if (s.pages.length) {
        answer = null;
        note = "I couldn't match that to a page on the client's site: pick one on the card, or paste the link.";
      }
    }
  }
  if (answer && typed && (answeredNow || took)) {
    const v = landingVerdict(answer, s.site, await reachUrl(answer));
    answer = v.url;
    note = v.note;
  }
  if (took && answer) {
    const page = s.pages.find((p) => p.url === answer);
    note = [`Landing page: ${page ? `${page.label}, ` : ""}${answer}.`, note].filter(Boolean).join(" ");
  }
  return { questions: questions.map((x) => (x.key === key ? { ...x, answer } : x)), note, took };
}
