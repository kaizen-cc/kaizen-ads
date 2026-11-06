import type { LaunchQuestion } from "@/lib/launch-sheet/types";

// The pure side of the landing-page finder (src/lib/landing-pages.ts): reading sitemaps and robots.txt, naming and
// ranking a client's pages against what's being launched, mapping "the homepage" or "the seafood box page" to a real
// link, and judging a link the buyer typed. No network here, so it's tested and the launch card can use it.

export type PageKind = "home" | "collection" | "product" | "page" | "blog" | "other";
export type LandingPage = {
  url: string;
  label: string;
  kind: PageKind;
  /** Where it was found: the client's website field, live ads, the site's sitemap, the Brand Bible */
  sources: ("home" | "ads" | "sitemap" | "bible")[];
  /** Live ads that send people here */
  ads: number;
  /** Last 30 days, from the ads that use it (when the platform gave them) */
  conversions: number;
  spend: number;
  title: string | null;
};
export type LandingSet = { site: string | null; pages: LandingPage[]; at: string };

// ─── URLs ───────────────────────────────────────────────────────────────────────────────────────────────────────

const TRACKING = /^(utm_\w+|gclid|gbraid|wbraid|fbclid|msclkid|_ga|mc_cid|mc_eid|ref|srsltid)$/i;

/** A link as Google and Meta take it: https unless it said http, no fragment, no tracking parameters; the homepage with its trailing slash */
export function normalizeUrl(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").trim().replace(/[)\].,;:!?'"]+$/, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (!/^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    // URL keeps "/" for the bare origin: exactly the homepage form Google wants
    return u.toString();
  } catch {
    return null;
  }
}

/** The client's homepage from their website field ("oceanbox.com", "https://www.oceanbox.com/about" → its origin) */
export function homeOf(website: string | null | undefined): string | null {
  const u = normalizeUrl(website);
  if (!u) return null;
  const x = new URL(u);
  return `${x.protocol}//${x.host}/`;
}

export const hostOf = (u: string | null | undefined) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

/** The same site: the same host, or a subdomain of it either way (shop.oceanbox.com and oceanbox.com) */
export function sameSite(a: string | null | undefined, b: string | null | undefined) {
  const x = hostOf(a);
  const y = hostOf(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/** "https://www.oceanbox.com/collections/salmon/" → "oceanbox.com/collections/salmon" (the homepage: "oceanbox.com") */
export function shortUrl(u: string) {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/+$/, "");
    return `${x.hostname.replace(/^www\./, "")}${path}${x.search}`;
  } catch {
    return u;
  }
}

/** The first full link in some text, normalized */
export function urlIn(text: string | null | undefined): string | null {
  const m = String(text ?? "").match(/https?:\/\/[^\s<>"')]+/i);
  return m ? normalizeUrl(m[0]) : null;
}

/** Links that are never a landing page: carts, logins, policies, feeds, files */
export function isJunk(u: string) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return /\/(cart|checkout|checkouts|account|accounts|login|logout|register|signin|sign-in|search|policies|policy|privacy|terms|tag|tags|author|feed|wp-admin|wp-json|wp-content|cdn|admin|password|thank-you|thanks)(\/|$)/.test(p) || /\.(xml|jpe?g|png|gif|webp|svg|pdf|mp4|mov|zip|css|js|json|txt)$/.test(p);
  } catch {
    return true;
  }
}

export function kindOf(u: string): PageKind {
  try {
    const p = new URL(u).pathname.toLowerCase().replace(/\/+$/, "");
    if (!p) return "home";
    if (/\/(collections?|categor(y|ies)|shop|product-category|c)\//.test(`${p}/`) && !/\/products?\//.test(p)) return "collection";
    if (/\/(products?|p|item|items)\//.test(p)) return "product";
    if (/\/(blogs?|news|articles?|posts?|journal|stories)(\/|$)/.test(p)) return "blog";
    if (/\/pages?\//.test(p) || p.split("/").length <= 2) return "page";
    return "other";
  } catch {
    return "other";
  }
}

const humanize = (s: string) => {
  const t = decodeURIComponent(s).replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

/** A short name for a page: "Homepage", its title's first part, or its last path segment ("Seafood box") */
export function labelOf(u: string, title?: string | null): string {
  if (kindOf(u) === "home") return "Homepage";
  const t = String(title ?? "")
    .split(/\s+[|·–—-]\s+/)[0]
    .trim();
  if (t && t.length <= 60 && !/^(home|404|page not found)$/i.test(t)) return t;
  try {
    const segs = new URL(u).pathname.split("/").filter(Boolean);
    return humanize(segs[segs.length - 1] ?? "") || shortUrl(u);
  } catch {
    return u;
  }
}

// ─── Sitemaps ───────────────────────────────────────────────────────────────────────────────────────────────────

const decode = (s: string) =>
  s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .trim();

/** A sitemap: the child sitemaps of an index, or the pages of a urlset (image and video tags inside a <url> ignored) */
export function parseSitemap(xml: string): { index: string[]; urls: string[] } {
  const index: string[] = [];
  const urls: string[] = [];
  for (const m of xml.matchAll(/<sitemap(?:\s[^>]*)?>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = m[1].match(/<loc>([\s\S]*?)<\/loc>/i)?.[1];
    if (loc) index.push(decode(loc));
  }
  for (const m of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi)) {
    const loc = m[1].match(/<loc>([\s\S]*?)<\/loc>/i)?.[1];
    if (loc) urls.push(decode(loc));
  }
  return { index, urls };
}

/** The Sitemap: lines of a robots.txt */
export function robotsSitemaps(txt: string) {
  return [...txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
}

/** The child sitemaps worth opening first: collections, pages, products, then the rest (blogs last) */
export function sitemapOrder(urls: string[]) {
  const rank = (u: string) => (/collection|categor/i.test(u) ? 0 : /page/i.test(u) ? 1 : /product/i.test(u) ? 2 : /blog|post|article|news|author|tag/i.test(u) ? 4 : 3);
  return [...urls].sort((a, b) => rank(a) - rank(b));
}

// ─── Ranking ────────────────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
  "the and for with from that this these those our your you into onto per new best buy shop page pages link links url urls site website landing one ones use using let lets want need ads ad campaign campaigns group groups google meta search keyword keywords launch phrase exact broad home www com http https html collections collection products product pages blog blogs".split(" "),
);
const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export const tokens = (s: string) =>
  [
    ...new Set(
      String(s)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map(stem),
    ),
  ];

const pageTokens = (p: LandingPage) => {
  let path = "";
  try {
    path = decodeURIComponent(new URL(p.url).pathname);
  } catch {
    path = p.url;
  }
  return { path: new Set(tokens(path)), text: new Set(tokens(`${p.label} ${p.title ?? ""}`)) };
};

/** How well a page fits the theme (words in its link and title), with what live ads already send there */
export function scorePage(p: LandingPage, theme: string[]) {
  const t = pageTokens(p);
  let fit = 0;
  for (const w of theme) fit += t.path.has(w) ? 3 : t.text.has(w) ? 2 : 0;
  const used = Math.min(3, Math.log2(1 + p.ads)) + Math.min(3, Math.log2(1 + p.conversions));
  const kind = { home: 0.5, collection: 1, product: 0.6, page: 0.3, other: 0, blog: -1.5 }[p.kind];
  return { fit, score: fit * 2 + used + kind };
}

export function rankPages(pages: LandingPage[], theme: string) {
  const want = tokens(theme);
  return pages
    .filter((p) => !isJunk(p.url) || p.kind === "home")
    .map((p) => ({ page: p, ...scorePage(p, want) }))
    .sort((a, b) => b.score - a.score);
}

/** The page's evidence in a few words: "4 live ads, 12 conv" / "on the site" */
export function evidence(p: LandingPage) {
  const bits = [p.ads ? `${p.ads} live ad${p.ads === 1 ? "" : "s"}` : "", p.conversions ? `${Math.round(p.conversions)} conv in 30 days` : ""].filter(Boolean);
  return bits.join(", ") || (p.kind === "home" ? "the client's homepage" : p.sources.includes("bible") ? "in the Brand Bible" : "on the client's site");
}

// ─── The buyer's words → a page ─────────────────────────────────────────────────────────────────────────────────

const HOME = /\bhome\s?-?page\b|\bthe home\b|\bmain (site|page|website|url|link)\b|\bfront page\b|\b(their|the|our) (web)?site\b|\bjust the (domain|site|website)\b|\b(root|base) (domain|url)\b/i;

/**
 * The page the buyer means: a link they pasted, "the homepage", or the one page whose link and title share their words
 * ("the seafood box page"). Null when nothing fits or two pages fit equally (then the chat asks, naming the closest).
 */
export function matchPage(text: string, set: Pick<LandingSet, "site" | "pages">): { url: string; page: LandingPage | null; typed: boolean } | null {
  const pasted = urlIn(text);
  if (pasted) return { url: pasted, page: set.pages.find((p) => p.url === pasted) ?? null, typed: !set.pages.some((p) => p.url === pasted) };
  const bare = normalizeUrl(text.trim().split(/\s+/).find((w) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(w.replace(/[.,;]+$/, ""))) ?? "");
  if (bare && set.site && sameSite(bare, set.site)) {
    const hit = set.pages.find((p) => p.url.replace(/\/$/, "") === bare.replace(/\/$/, ""));
    return { url: hit?.url ?? bare, page: hit ?? null, typed: !hit };
  }
  const home = set.pages.find((p) => p.kind === "home") ?? null;
  if (HOME.test(text)) return home ? { url: home.url, page: home, typed: false } : set.site ? { url: set.site, page: null, typed: false } : null;
  const want = tokens(text);
  if (!want.length) return null;
  const scored = set.pages
    .filter((p) => p.kind !== "home")
    .map((p) => ({ p, fit: scorePage(p, want).fit, path: p.url.length }))
    .filter((x) => x.fit > 0)
    .sort((a, b) => b.fit - a.fit || a.path - b.path);
  if (!scored.length) return null;
  // Two pages that fit equally well (a collection and a product with the same words): the shorter, broader one wins
  // only when it's a collection; otherwise it's a question for the buyer
  if (scored[1] && scored[1].fit === scored[0].fit && !(scored[0].p.kind === "collection" && scored[1].p.kind !== "collection")) return null;
  return { url: scored[0].p.url, page: scored[0].p, typed: false };
}

/** Words that say the message is about where the ads land (so a page match in it is meant as the answer) */
export const ABOUT_LANDING = /\b(page|link|url|landing|collection|product|site|website|homepage|send (them|people)|point (it|them))\b/i;

// ─── The question on the card ───────────────────────────────────────────────────────────────────────────────────

/**
 * The landing-page question follows what's being launched: its options are the client's pages that fit best (the
 * full link as the value, a short name for the button), plus the homepage, and the best one is the proposal. An
 * answer that names a page in words is turned into its link. Without pages (no website, nothing found) it's left alone.
 */
export function followLanding(questions: LaunchQuestion[], key: string, set: LandingSet | null | undefined, theme: string): LaunchQuestion[] {
  if (!set?.pages.length) return questions;
  return questions.map((q) => {
    if (q.key !== key) return q;
    const ranked = rankPages(set.pages, theme);
    const home = set.pages.find((p) => p.kind === "home") ?? null;
    const best = ranked[0] && (ranked[0].fit > 0 || ranked[0].page.ads > 0) ? ranked[0].page : (home ?? ranked[0]?.page);
    if (!best) return q;
    const picks = [best, ...ranked.map((r) => r.page).filter((p) => p.kind !== "home" && p.url !== best.url).slice(0, 3), ...(home ? [home] : [])];
    const options = [...new Set(picks.map((p) => p.url))].slice(0, 5);
    const labels = Object.fromEntries(options.map((u) => [u, set.pages.find((p) => p.url === u)?.label ?? shortUrl(u)]));
    let answer = q.answer;
    if (answer && !urlIn(answer)) {
      const m = matchPage(answer, set);
      if (m) answer = m.url;
    }
    // The pages are offered, so the question never asks for a link to be pasted
    const question = /paste|full (link|url)|exact (link|url)/i.test(q.question) ? "Which page should the ads send people to?" : q.question;
    return { ...q, question, options, labels, proposal: best.url, why: `${best.label}: ${evidence(best)}. Or pick another below.`, answer };
  });
}

/** The client's pages for the model, best first for this launch: "- Seafood box https://… (collection, 3 live ads)" */
export function pagesText(set: LandingSet | null | undefined, theme: string, max = 40) {
  if (!set?.pages.length) return set?.site ? `Only the homepage is known: ${set.site}` : "(none found: the client has no website on file)";
  return rankPages(set.pages, theme)
    .slice(0, max)
    .map(({ page: p }) => `- ${p.label}: ${p.url} (${p.kind}${p.ads ? `, ${p.ads} live ad${p.ads === 1 ? "" : "s"}` : ""}${p.conversions ? `, ${Math.round(p.conversions)} conv` : ""})`)
    .join("\n");
}

/** The rule the chat follows for the landing page (key: final_url on Google, link on Meta) */
export const landingRule = (key: string) =>
  `<landing_pages> lists the client's real pages (their site's sitemap, the pages live ads send people to, the Brand Bible), best fit first. When the buyer refers to a page by name or description ("the homepage", "the seafood box page", "the salmon collection"), answer ${key} with that page's full URL from the list, exactly: never ask them to paste a link that's in the list. Only when nothing in the list matches, say so and name the 2 or 3 closest by name. Whenever you set ${key}, say which page in a few words with its link.`;

// ─── A link the buyer typed ─────────────────────────────────────────────────────────────────────────────────────

export type Reach = { status: number; finalUrl: string | null };

/**
 * What to do with a link the buyer typed, from what the site answered: a page that's gone isn't taken, a redirect is
 * followed (its destination is used, and said), another domain than the client's is taken with a warning.
 */
export function landingVerdict(url: string, site: string | null, r: Reach): { url: string | null; note: string | null } {
  const notes: string[] = [];
  if (r.status >= 400) return { url: null, note: `${shortUrl(url)} returned ${r.status}, so I left the landing page open. Pick one of the pages on the card.` };
  let use = url;
  const final = normalizeUrl(r.finalUrl);
  const bare = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
  if (final && bare(final) !== bare(url)) {
    use = final;
    notes.push(`${shortUrl(url)} redirects to ${shortUrl(final)}, so I used that.`);
  }
  if (!r.status) notes.push(`I couldn't reach ${shortUrl(url)} to check it, so make sure it loads.`);
  if (site && !sameSite(use, site)) notes.push(`${hostOf(use)} isn't the client's site (${hostOf(site)}): make sure that's intended.`);
  return { url: use, note: notes.join(" ") || null };
}

/** The chat asked for a link anyway: its words are replaced when code took the page */
export const ASKS_FOR_LINK = /\b(paste|full (link|url)|exact (link|url)|need the (full |exact )?(link|url)|send (me )?the (link|url)|what'?s the (link|url))\b/i;
