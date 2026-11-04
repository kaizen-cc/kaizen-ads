import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { metaConfigured, metaGraph } from "@/lib/context/meta";

// The Brand Bible's review bank, collected for real before it's written: the store's own review app (Judge.me, Okendo,
// Yotpo, Stamped, Loox, Junip), Trustpilot, Google (with a Places key), comments on the client's Facebook and Instagram
// posts and ads, and the review sites their kind of business lives on (BBB, Yelp, Angi, OpenTable, Resy, marketplaces:
// read on the web). Every source says what was found and why not. Then the best 15–25 specific, claim-safe reviews and
// 3–5 honest complaints are picked, word for word, and written as the Bible's "### 4b. Review bank".

export type RawReview = { text: string; stars: number | null; who: string; source: string; date: string | null; link: string | null; product?: string | null };
export type SourceNote = { source: string; found: boolean; count: number | null; rating: number | null; note: string };
export type BankPick = { text: string; stars: string; who: string; source: string; date: string; link: string; profile: string; angle: string; use: string };
export type BankCritical = { text: string; stars: string; who: string; source: string; date: string; link: string; theme: string };
export type ReviewBank = { collectedAt: string; read: number; sources: SourceNote[]; picks: BankPick[]; critical: BankCritical[] };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const get = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "*/*", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
};
const text = (url: string, init?: RequestInit) => get(url, init).then((r) => r.text());
const json = <T>(url: string, init?: RequestInit) => get(url, init).then((r) => r.json() as Promise<T>);
const strip = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** "Alana Carter" → "Alana C.": never more than a first name and an initial */
export const initialed = (name: string) => {
  const parts = name.replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Customer";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

/** Which review apps the site runs, and the keys their public widgets use */
export function detectApps(html: string) {
  const shop = html.match(/Shopify\.shop\s*=\s*["']([a-z0-9-]+\.myshopify\.com)["']/i)?.[1] ?? html.match(/([a-z0-9-]+\.myshopify\.com)/i)?.[1] ?? null;
  return {
    shop,
    judgeme: /judge\.me|jdgm-/i.test(html),
    okendo: html.match(/data-oke-reviews-subscriber-id=["']([0-9a-f-]{36})["']/i)?.[1] ?? html.match(/okendo[^"']{0,200}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null,
    yotpo: html.match(/staticw2\.yotpo\.com\/([A-Za-z0-9]{20,})\//)?.[1] ?? html.match(/data-appkey=["']([A-Za-z0-9]{20,})["']/)?.[1] ?? null,
    stamped: html.match(/data-api-key=["'](pubkey-[A-Za-z0-9]+)["']/)?.[1] ?? html.match(/stamped\.io[^"']*apiKey=([A-Za-z0-9-]+)/)?.[1] ?? null,
    loox: html.match(/loox\.io\/widget\/([A-Za-z0-9_-]+)/)?.[1] ?? null,
    junip: html.match(/data-store-key=["']([A-Za-z0-9]+)["']/)?.[1] ?? (/junip/i.test(html) ? "" : null),
    trustpilot: html.match(/data-businessunit-id=["']([0-9a-f]{24})["']/)?.[1] ?? (/trustpilot/i.test(html) ? "" : null),
  };
}

/** The store's own review apps, from their public widget endpoints */
async function storeReviews(site: string, notes: SourceNote[]): Promise<RawReview[]> {
  const base = site.replace(/\/$/, "");
  let html = "";
  try {
    html = await text(base);
    // Review widgets often load only on product pages: the first product's page too (Shopify lists them as JSON)
    const products = await json<{ products?: { handle: string }[] }>(`${base}/products.json?limit=3`).catch(() => null);
    const handle = products?.products?.[0]?.handle;
    if (handle) html += await text(`${base}/products/${handle}`).catch(() => "");
  } catch (e) {
    notes.push({ source: "Website review app", found: false, count: null, rating: null, note: `The site couldn't be read (${e instanceof Error ? e.message : "error"})` });
    return [];
  }
  const apps = detectApps(html);
  const host = new URL(base).hostname.replace(/^www\./, "");
  const out: RawReview[] = [];
  const tried: string[] = [];

  if (apps.judgeme) {
    tried.push("Judge.me");
    const shop = apps.shop ?? host;
    try {
      const r = await json<{ html?: string; reviews?: unknown }>(`https://api.judge.me/reviews/reviews_for_widget?url=${encodeURIComponent(shop)}&shop_domain=${encodeURIComponent(shop)}&platform=shopify&page=1&per_page=100`);
      const blocks = (r.html ?? "").split(/class=['"]jdgm-rev /).slice(1);
      for (const b of blocks) {
        const body = strip(b.match(/jdgm-rev__body['"][^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
        if (!body) continue;
        out.push({
          text: body,
          stars: Number(b.match(/data-score=['"](\d)/)?.[1]) || null,
          who: initialed(strip(b.match(/jdgm-rev__author['"][^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "")),
          source: "Judge.me (website)",
          date: day(b.match(/data-content=['"]([0-9-]{10}[^'"]*)['"]/)?.[1]),
          link: base,
          product: strip(b.match(/jdgm-rev__prod-link['"][^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "") || null,
        });
      }
      notes.push({ source: "Judge.me (website)", found: blocks.length > 0, count: blocks.length || null, rating: null, note: blocks.length ? `${blocks.length} read` : "Widget found; no reviews came back" });
    } catch (e) {
      notes.push({ source: "Judge.me (website)", found: false, count: null, rating: null, note: `Widget found; its reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
    }
  }
  if (apps.okendo) {
    tried.push("Okendo");
    try {
      const r = await json<{ reviews?: { body?: string; title?: string; rating?: number; reviewer?: { displayName?: string }; dateCreated?: string; productName?: string }[] }>(`https://api.okendo.io/v1/stores/${apps.okendo}/reviews?limit=100&orderBy=date%20desc`);
      for (const x of r.reviews ?? []) if (x.body) out.push({ text: [x.title, x.body].filter(Boolean).join(". "), stars: x.rating ?? null, who: initialed(x.reviewer?.displayName ?? ""), source: "Okendo (website)", date: day(x.dateCreated), link: base, product: x.productName ?? null });
      notes.push({ source: "Okendo (website)", found: Boolean(r.reviews?.length), count: r.reviews?.length ?? null, rating: null, note: r.reviews?.length ? `${r.reviews.length} read` : "No reviews came back" });
    } catch (e) {
      notes.push({ source: "Okendo (website)", found: false, count: null, rating: null, note: `Widget found; reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
    }
  }
  if (apps.yotpo) {
    tried.push("Yotpo");
    try {
      const r = await json<{ response?: { reviews?: { content?: string; title?: string; score?: number; user?: { display_name?: string }; created_at?: string }[]; bottomline?: { total_review?: number; average_score?: number } } }>(
        `https://api-cdn.yotpo.com/v1/widget/${apps.yotpo}/products/yotpo_site_reviews/reviews.json?per_page=100&page=1`,
      );
      const list = r.response?.reviews ?? [];
      for (const x of list) if (x.content) out.push({ text: [x.title, x.content].filter(Boolean).join(". "), stars: x.score ?? null, who: initialed(x.user?.display_name ?? ""), source: "Yotpo (website)", date: day(x.created_at), link: base });
      notes.push({ source: "Yotpo (website)", found: list.length > 0, count: r.response?.bottomline?.total_review ?? (list.length || null), rating: r.response?.bottomline?.average_score ?? null, note: list.length ? `${list.length} read` : "No site reviews came back" });
    } catch (e) {
      notes.push({ source: "Yotpo (website)", found: false, count: null, rating: null, note: `Widget found; reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
    }
  }
  if (apps.stamped) {
    tried.push("Stamped");
    try {
      const r = await json<{ data?: { reviewMessage?: string; reviewTitle?: string; reviewRating?: number; author?: string; dateCreated?: string; productName?: string }[]; total?: number }>(
        `https://stamped.io/api/widget/reviews?storeUrl=${encodeURIComponent(apps.shop ?? host)}&apiKey=${apps.stamped}&take=100&sort=recent`,
      );
      for (const x of r.data ?? []) if (x.reviewMessage) out.push({ text: [x.reviewTitle, x.reviewMessage].filter(Boolean).join(". "), stars: x.reviewRating ?? null, who: initialed(x.author ?? ""), source: "Stamped (website)", date: day(x.dateCreated), link: base, product: x.productName ?? null });
      notes.push({ source: "Stamped (website)", found: Boolean(r.data?.length), count: r.total ?? (r.data?.length || null), rating: null, note: r.data?.length ? `${r.data.length} read` : "No reviews came back" });
    } catch (e) {
      notes.push({ source: "Stamped (website)", found: false, count: null, rating: null, note: `Widget found; reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
    }
  }
  if (apps.loox) {
    tried.push("Loox");
    try {
      const h = await text(`https://loox.io/widget/${apps.loox}/reviews?limit=60`);
      const bodies = [...h.matchAll(/class=["'][^"']*loox-review-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1])).filter(Boolean);
      for (const b of bodies) out.push({ text: b, stars: null, who: "Customer", source: "Loox (website)", date: null, link: base });
      notes.push({ source: "Loox (website)", found: bodies.length > 0, count: bodies.length || null, rating: null, note: bodies.length ? `${bodies.length} read` : "Widget found; its page couldn't be read as text" });
    } catch (e) {
      notes.push({ source: "Loox (website)", found: false, count: null, rating: null, note: `Widget found; reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
    }
  }
  if (apps.junip !== null) {
    tried.push("Junip");
    if (!apps.junip) notes.push({ source: "Junip (website)", found: false, count: null, rating: null, note: "Widget found, but its store key wasn't on the page" });
    else
      try {
        const r = await json<{ product_reviews?: { body?: string; title?: string; rating?: number; customer?: { first_name?: string; last_name?: string }; created_at?: string }[] }>(`https://api.juniphq.com/v1/product_reviews?page%5Bsize%5D=100`, { headers: { "Junip-Store-Key": apps.junip } });
        for (const x of r.product_reviews ?? []) if (x.body) out.push({ text: [x.title, x.body].filter(Boolean).join(". "), stars: x.rating ?? null, who: initialed(`${x.customer?.first_name ?? ""} ${x.customer?.last_name ?? ""}`), source: "Junip (website)", date: day(x.created_at), link: base });
        notes.push({ source: "Junip (website)", found: Boolean(r.product_reviews?.length), count: r.product_reviews?.length ?? null, rating: null, note: r.product_reviews?.length ? `${r.product_reviews.length} read` : "No reviews came back" });
      } catch (e) {
        notes.push({ source: "Junip (website)", found: false, count: null, rating: null, note: `Widget found; reviews couldn't be read (${e instanceof Error ? e.message : "error"})` });
      }
  }
  if (!tried.length) notes.push({ source: "Website review app", found: false, count: null, rating: null, note: "No Judge.me, Okendo, Yotpo, Stamped, Loox or Junip widget on the home or product page" });
  return out;
}

/** Trustpilot's public page, read from its page data */
async function trustpilot(site: string, notes: SourceNote[]): Promise<RawReview[]> {
  const host = new URL(site).hostname.replace(/^www\./, "");
  const url = `https://www.trustpilot.com/review/${host}`;
  try {
    const html = await text(url);
    const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    if (!data) throw new Error("no page data");
    const props = (JSON.parse(data) as { props?: { pageProps?: { reviews?: { text?: string; title?: string; rating?: number; consumer?: { displayName?: string }; dates?: { publishedDate?: string }; id?: string }[]; businessUnit?: { numberOfReviews?: number; trustScore?: number } } } }).props?.pageProps;
    const list = props?.reviews ?? [];
    notes.push({ source: "Trustpilot", found: true, count: props?.businessUnit?.numberOfReviews ?? list.length, rating: props?.businessUnit?.trustScore ?? null, note: `${list.length} recent read` });
    return list.filter((x) => x.text).map((x) => ({ text: [x.title, x.text].filter(Boolean).join(". "), stars: x.rating ?? null, who: initialed(x.consumer?.displayName ?? ""), source: "Trustpilot", date: day(x.dates?.publishedDate), link: x.id ? `https://www.trustpilot.com/reviews/${x.id}` : url }));
  } catch (e) {
    notes.push({ source: "Trustpilot", found: false, count: null, rating: null, note: /404/.test(String(e)) ? "No Trustpilot page" : `Couldn't be read (${e instanceof Error ? e.message : "error"})` });
    return [];
  }
}

/** Google reviews through the Places API (it returns up to 5 per place), when a key is set */
async function googlePlaces(query: string, notes: SourceNote[]): Promise<RawReview[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    notes.push({ source: "Google", found: false, count: null, rating: null, note: "Read on the web instead (set GOOGLE_PLACES_API_KEY to read the Business Profile directly)" });
    return [];
  }
  try {
    const r = await json<{ places?: { displayName?: { text?: string }; rating?: number; userRatingCount?: number; googleMapsUri?: string; reviews?: { text?: { text?: string }; rating?: number; authorAttribution?: { displayName?: string }; publishTime?: string }[] }[] }>(
      "https://places.googleapis.com/v1/places:searchText",
      { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.reviews" }, body: JSON.stringify({ textQuery: query }) },
    );
    const p = r.places?.[0];
    if (!p) {
      notes.push({ source: "Google", found: false, count: null, rating: null, note: "No Business Profile found" });
      return [];
    }
    notes.push({ source: "Google", found: true, count: p.userRatingCount ?? null, rating: p.rating ?? null, note: `${p.displayName?.text ?? "Profile"}: the API returns its 5 most relevant reviews` });
    return (p.reviews ?? []).filter((x) => x.text?.text).map((x) => ({ text: x.text!.text!, stars: x.rating ?? null, who: initialed(x.authorAttribution?.displayName ?? ""), source: "Google", date: day(x.publishTime), link: p.googleMapsUri ?? null }));
  } catch (e) {
    notes.push({ source: "Google", found: false, count: null, rating: null, note: `Places API failed (${e instanceof Error ? e.message : "error"})` });
    return [];
  }
}

/** A Page's own token, which reads its posts' and ads' comments when the system user's can't */
async function pageToken(pageId: string) {
  const p = await metaGraph<{ access_token?: string; instagram_business_account?: { id: string } }>(pageId, { fields: "access_token,instagram_business_account" }).catch(() => null);
  return { token: p?.access_token ?? null, ig: p?.instagram_business_account?.id ?? null };
}
async function asPage<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const proof: Record<string, string> = process.env.META_APP_SECRET ? { appsecret_proof: createHmac("sha256", process.env.META_APP_SECRET).update(token).digest("hex") } : {};
  const v = process.env.META_API_VERSION || "v24.0";
  const r = (await (await fetch(`https://graph.facebook.com/${v}/${path}?${new URLSearchParams({ ...params, ...proof, access_token: token })}`, { cache: "no-store" })).json()) as T & { error?: { message: string } };
  if (r.error) throw new Error(r.error.message);
  return r;
}

/** Comments on the client's Facebook posts and ads and their Instagram posts: what people say to them, in public */
async function metaComments(admin: SupabaseClient, clientId: string, account: string | null, notes: SourceNote[]): Promise<RawReview[]> {
  if (!metaConfigured()) {
    notes.push({ source: "Facebook and Instagram comments", found: false, count: null, rating: null, note: "Meta isn't connected" });
    return [];
  }
  const { data: o } = await admin.from("client_onboarding").select("meta").eq("client_id", clientId).maybeSingle();
  let pageId = ((o?.meta ?? {}) as { page?: string | null }).page ?? null;
  type Ad = { creative?: { effective_object_story_id?: string; object_story_spec?: { page_id?: string } } };
  const ads = account ? await metaGraph<{ data: Ad[] }>(`act_${account.replace(/\D/g, "")}/ads`, { fields: "creative{effective_object_story_id,object_story_spec{page_id}}", limit: "40", effective_status: '["ACTIVE"]' }).catch(() => ({ data: [] as Ad[] })) : { data: [] as Ad[] };
  pageId ??= ads.data.map((a) => a.creative?.object_story_spec?.page_id ?? a.creative?.effective_object_story_id?.split("_")[0]).find(Boolean) ?? null;
  if (!pageId) {
    notes.push({ source: "Facebook and Instagram comments", found: false, count: null, rating: null, note: "Their Page isn't known yet (shared through the setup guide or seen on an active ad)" });
    return [];
  }
  const { token, ig } = await pageToken(pageId);
  const out: RawReview[] = [];
  type C = { message?: string; text?: string; from?: { id?: string; name?: string }; username?: string; created_time?: string; timestamp?: string; permalink_url?: string };
  const keep = (c: C, source: string, link: string | null) => {
    const words = (c.message ?? c.text ?? "").trim();
    if (words.length < 30 || c.from?.id === pageId) return;
    out.push({ text: words, stars: null, who: initialed(c.from?.name ?? c.username ?? ""), source, date: day(c.created_time ?? c.timestamp), link });
  };
  let fb = 0;
  let igCount = 0;
  const why: string[] = [];
  if (token) {
    try {
      const posts = await asPage<{ data: { permalink_url?: string; comments?: { data: C[] } }[] }>(token, `${pageId}/posts`, { fields: "permalink_url,comments.limit(100){message,from,created_time}", limit: "25" });
      for (const p of posts.data) for (const c of p.comments?.data ?? []) {
        fb++;
        keep(c, "Facebook post comment", p.permalink_url ?? null);
      }
      // Ads run as their own (unpublished) posts: their comments are where buyers talk
      const stories = [...new Set(ads.data.map((a) => a.creative?.effective_object_story_id).filter((x): x is string => Boolean(x)))].slice(0, 20);
      for (const id of stories) {
        const r = await asPage<{ data: C[] }>(token, `${id}/comments`, { fields: "message,from,created_time", limit: "100" }).catch(() => ({ data: [] as C[] }));
        for (const c of r.data) {
          fb++;
          keep(c, "Facebook ad comment", `https://www.facebook.com/${id}`);
        }
      }
    } catch (e) {
      why.push(`Facebook: ${e instanceof Error ? e.message : "couldn't read"}`);
    }
  } else why.push("Facebook: the Page's token isn't available to our system user (the Page needs to be shared with Kaizen's Business Manager)");
  if (ig) {
    try {
      const media = await metaGraph<{ data: { permalink?: string; comments?: { data: C[] } }[] }>(`${ig}/media`, { fields: "permalink,comments.limit(100){text,username,timestamp}", limit: "25" }).catch(async () => (token ? asPage<{ data: { permalink?: string; comments?: { data: C[] } }[] }>(token, `${ig}/media`, { fields: "permalink,comments.limit(100){text,username,timestamp}", limit: "25" }) : { data: [] }));
      for (const m of media.data) for (const c of m.comments?.data ?? []) {
        igCount++;
        keep(c, "Instagram comment", m.permalink ?? null);
      }
    } catch (e) {
      why.push(`Instagram: ${e instanceof Error ? e.message : "couldn't read"} (needs instagram_basic and instagram_manage_comments)`);
    }
  } else why.push("Instagram: no business account linked to the Page");
  notes.push({ source: "Facebook and Instagram comments", found: fb + igCount > 0, count: fb + igCount || null, rating: null, note: [`${fb} Facebook and ${igCount} Instagram comments read, ${out.length} long enough to use`, ...why].join(". ") });
  return out;
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sources", "picks", "critical"],
  properties: {
    sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["source", "found", "count", "rating", "note"], properties: { source: { type: "string" }, found: { type: "boolean" }, count: { type: ["integer", "null"] }, rating: { type: ["number", "null"] }, note: { type: "string" } } } },
    picks: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["text", "stars", "who", "source", "date", "link", "profile", "angle", "use"], properties: { text: { type: "string" }, stars: { type: "string" }, who: { type: "string" }, source: { type: "string" }, date: { type: "string" }, link: { type: "string" }, profile: { type: "string" }, angle: { type: "string" }, use: { type: "string" } } },
    },
    critical: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "stars", "who", "source", "date", "link", "theme"], properties: { text: { type: "string" }, stars: { type: "string" }, who: { type: "string" }, source: { type: "string" }, date: { type: "string" }, link: { type: "string" }, theme: { type: "string" } } } },
  },
};

/**
 * Collects every review and comment we can read for a client, then picks the bank: 15–25 specific, claim-safe ones and
 * 3–5 complaints, word for word, tagged with the audience profile and angle. `profiles` are the Bible's audience profile
 * names, when it has them. Web review sites (BBB, Yelp, Angi, OpenTable, Resy, marketplaces) come from `web` (the
 * Bible's research), which is read for reviews it quotes.
 */
export async function collectReviewBank(admin: SupabaseClient, clientId: string, opts: { profiles?: string[]; web?: string; reviewSources?: string } = {}): Promise<ReviewBank> {
  const { data: c } = await admin.from("clients").select("name, website, meta_ad_account_id").eq("id", clientId).single();
  if (!c) throw new Error("No client");
  const notes: SourceNote[] = [];
  const site = c.website ? (/^https?:\/\//.test(c.website as string) ? (c.website as string) : `https://${c.website}`) : null;
  const [store, tp, google, social] = await Promise.all([
    site ? storeReviews(site, notes).catch(() => []) : Promise.resolve([] as RawReview[]),
    site ? trustpilot(site, notes).catch(() => []) : Promise.resolve([] as RawReview[]),
    googlePlaces(`${c.name}`, notes).catch(() => []),
    metaComments(admin, clientId, (c.meta_ad_account_id as string | null) ?? null, notes).catch(() => []),
  ]);
  if (!site) notes.push({ source: "Website", found: false, count: null, rating: null, note: "No website on file" });
  // Long, specific ones first; capped so the pick reads them all
  const raw = [...store, ...tp, ...google, ...social]
    .filter((r) => r.text.split(/\s+/).length >= 6)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 260)
    .map((r, i) => ({ n: i + 1, ...r, text: r.text.slice(0, 700) }));
  const out = await askJson<{ sources: SourceNote[]; picks: BankPick[]; critical: BankCritical[] }>({
    agent: "brandbible",
    label: `brand bible reviews ${c.name}`,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 12000,
    system:
      "You pick a client's review bank for Kaizen Marketing's Brand Bible: real words from real customers that creative can use. Word for word only: never edit, merge or invent a review. People are shown as first name + last initial only.",
    schema: PICK_SCHEMA,
    prompt: [
      `<client>${c.name}</client>`,
      `<what_was_read>\n${JSON.stringify(notes)}\n</what_was_read>`,
      `<reviews_and_comments count="${raw.length}">\n${JSON.stringify(raw)}\n</reviews_and_comments>`,
      opts.web ? `<web_research note="reviews it quotes from review sites (BBB, Yelp, Angi, OpenTable, Resy, Google, marketplaces) count too, word for word with their source and link">\n${opts.web.slice(0, 40000)}\n</web_research>` : "",
      opts.profiles?.length ? `<audience_profiles>\n${opts.profiles.join("\n")}\n</audience_profiles>` : "",
      `Where this kind of business gets reviews: ${opts.reviewSources ?? "Google, the website, Trustpilot, Facebook"}.`,
      `Return:
- sources: one line per source, from what_was_read plus any review site the web research quotes (found, the count and rating when known, and a short note on what was read or why it couldn't be). Keep every source from what_was_read.
- picks: the best 15–25 (fewer only if fewer exist): 4–5 stars, specific (a result, a feeling, a comparison, a moment, the words buyers search with), 15–60 words preferred, a spread across products, profiles and sources. text word for word; stars "5" or "" when not shown; who "First L."; source; date (YYYY-MM-DD or ""); link (or ""); profile: the audience profile it speaks for ("B · Name") when profiles are given, else ""; angle: the angle it opens in 2–5 words; use: "OK" when it makes no claim we'd need to check, "Needs client sign-off: <why>" for health, results, comparisons or numbers, "Can't use: <why>" otherwise.
- critical: 3–5 honest complaints or objections (any stars), word for word, with theme: the objection it shows in 2–5 words. [] when none exist.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return { collectedAt: new Date().toISOString(), read: raw.length, sources: out.sources.length ? out.sources : notes, picks: out.picks.slice(0, 25), critical: out.critical.slice(0, 5) };
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n+/g, " ").trim();

/** The bank as the Bible's "### 4b. Review bank" (the table the cover counts and the viewer turns into cards) */
export function renderReviewBank(b: ReviewBank) {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(b.collectedAt));
  const src = b.sources.map((s) => `- ${s.source}: ${s.found ? [s.count != null ? `${s.count} reviews` : null, s.rating != null ? `rated ${s.rating}` : null, s.note].filter(Boolean).join(", ") : `not found. ${s.note}`}`);
  const link = (x: { source: string; date: string; link: string }) => cell(`${x.link ? `[${x.source}](${x.link})` : x.source}${x.date ? `, ${x.date}` : ""}`);
  const lines = [
    "### 4b. Review bank",
    "",
    "**Sources and counts**",
    ...src,
    `- Collected ${when}: ${b.read} reviews and comments read, ${b.picks.length} in the bank.`,
    "",
    "| RV# | Review (word for word) | Stars | Shown as | Source, date, link | Profile | Angle | Use in ads |",
    "|---|---|---|---|---|---|---|---|",
    ...b.picks.map((p, i) => `| RV#${i + 1} | “${cell(p.text)}” | ${cell(p.stars || "Not shown")} | ${cell(`${p.who} · ${p.source}`)} | ${link(p)} | ${cell(p.profile || "–")} | ${cell(p.angle)} | ${cell(p.use)} |`),
  ];
  if (b.critical.length)
    lines.push(
      "",
      "**What critics say** (objections creative can answer)",
      "",
      "| # | Complaint (word for word) | Stars | Shown as | Source, date, link | Objection |",
      "|---|---|---|---|---|---|",
      ...b.critical.map((p, i) => `| C${i + 1} | “${cell(p.text)}” | ${cell(p.stars || "Not shown")} | ${cell(`${p.who} · ${p.source}`)} | ${link(p)} | ${cell(p.theme)} |`),
    );
  return lines.join("\n");
}

/**
 * Puts a freshly collected bank into a Bible's Markdown: replaces the "### … Review bank" subsection where it is (or its
 * own "## … Review bank" section in older Bibles), or adds it at the end of the proof section when there's none.
 */
export function placeReviewBank(markdown: string, bankMarkdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const sub = lines.findIndex((l) => /^###\s+.*review bank/i.test(l));
  if (sub >= 0) {
    let end = lines.findIndex((l, i) => i > sub && /^#{2,3}\s+/.test(l));
    if (end < 0) end = lines.length;
    return [...lines.slice(0, sub), ...bankMarkdown.split("\n"), "", ...lines.slice(end)].join("\n");
  }
  const own = lines.findIndex((l) => /^##\s+.*review bank/i.test(l));
  if (own >= 0) {
    let end = lines.findIndex((l, i) => i > own && /^##\s+/.test(l));
    if (end < 0) end = lines.length;
    return [...lines.slice(0, own + 1), "", ...bankMarkdown.split("\n").slice(2), "", ...lines.slice(end)].join("\n");
  }
  // None yet: after section 4 (proof and voice), else before the sources
  const at = lines.findIndex((l, i) => i > 0 && /^##\s+/.test(l) && lines.slice(0, i).some((x) => /^##\s+4[.)\s]/.test(x)));
  const before = at >= 0 ? at : Math.max(0, lines.findIndex((l) => /^##\s+.*(sources|change log)/i.test(l)));
  const idx = before > 0 ? before : lines.length;
  return [...lines.slice(0, idx), ...bankMarkdown.split("\n"), "", ...lines.slice(idx)].join("\n");
}

/**
 * Refreshes only the review bank: collects again, picks again, rewrites the "4b. Review bank" and logs the change.
 * Cheap next to a full rebuild (no web research, one small pick). The Bible page shows it running.
 */
export async function refreshReviewBank(admin: SupabaseClient, clientId: string) {
  const { data: b } = await admin.from("client_brand_bibles").select("markdown, research, review_bank").eq("client_id", clientId).maybeSingle();
  if (!b?.markdown) throw new Error("There's no Brand Bible yet.");
  await admin.from("client_brand_bibles").update({ review_bank: { ...((b.review_bank ?? {}) as object), status: "collecting", startedAt: new Date().toISOString(), error: null } }).eq("client_id", clientId);
  try {
    const { splitBible, audiencesOf, kindOf } = await import("@/lib/bible-sections");
    const aud = splitBible(b.markdown as string).find((s) => kindOf(s.title) === "audiences");
    const profiles = aud ? audiencesOf(aud.body).list.map((a) => a.title) : [];
    const { businessModelOf, MODEL_GUIDE } = await import("@/lib/business-model");
    const model = await businessModelOf(admin, clientId).catch(() => null);
    const bank = await collectReviewBank(admin, clientId, { profiles, web: (b.research as string | null) ?? undefined, reviewSources: model ? MODEL_GUIDE[model.model].reviews : undefined });
    const { logChange } = await import("@/lib/bible-sections");
    const markdown = logChange(placeReviewBank(b.markdown as string, renderReviewBank(bank)), `Review bank refreshed: ${bank.read} reviews and comments read, ${bank.picks.length} in the bank.`);
    await admin.from("client_brand_bibles").update({ markdown, review_bank: { ...bank, status: "ready" } }).eq("client_id", clientId);
    return bank;
  } catch (e) {
    await admin
      .from("client_brand_bibles")
      .update({ review_bank: { ...((b.review_bank ?? {}) as object), status: "failed", error: e instanceof Error ? e.message.slice(0, 300) : "Couldn't collect the reviews" } })
      .eq("client_id", clientId);
    throw e;
  }
}
