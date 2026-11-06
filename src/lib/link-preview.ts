import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPublicHost, pageText } from "@/lib/references";
import { linkKind, type LinkPreview } from "@/lib/saved-references";

// A preview card for any link someone pastes as a reference (a Motion share link, Pinterest, Instagram, TikTok, the
// Meta Ad Library, YouTube, any page): its title and picture, read on the server. YouTube, TikTok and Pinterest answer
// oEmbed; everything else is read from the page's Open Graph tags. A Motion link is matched to the market library first
// (same link), then asked of the Motion connection when one is set up. An Ad Library link keeps its ad id. Nothing here
// is required: a link that can't be read still shows as its site and address.

const TIMEOUT = 6000;
const UA = "Mozilla/5.0 (compatible; KaizenAds/1.0; link preview)";

const get = (url: string, accept = "text/html,*/*") => fetch(url, { headers: { "user-agent": UA, accept, "accept-language": "en-US" }, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store", redirect: "follow" });

const meta = (html: string, name: string) => {
  const re = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, "i"),
  ];
  for (const r of re) {
    const m = html.match(r)?.[1];
    if (m) return m.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }
  return "";
};

async function oembed(endpoint: string): Promise<{ title?: string; thumbnail_url?: string; author_name?: string; provider_name?: string } | null> {
  try {
    const res = await get(endpoint, "application/json");
    if (!res.ok) return null;
    return (await res.json()) as { title?: string; thumbnail_url?: string; author_name?: string };
  } catch {
    return null;
  }
}

async function openGraph(url: string) {
  if (!isPublicHost(url)) return null;
  try {
    const res = await get(url);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = (await res.text()).slice(0, 400_000);
    const p = pageText(html.slice(0, 200_000));
    let image = meta(html, "og:image") || meta(html, "twitter:image") || meta(html, "og:image:url");
    if (image && !/^https?:/i.test(image)) {
      try {
        image = new URL(image, url).href;
      } catch {
        image = "";
      }
    }
    return { title: meta(html, "og:title") || meta(html, "twitter:title") || p.title, description: meta(html, "og:description") || p.description, image: image || null, site: meta(html, "og:site_name") || null };
  } catch {
    return null;
  }
}

/** A Motion share link: the market library's copy of the same ad, else whatever the Motion connection says about it */
async function motionLink(admin: SupabaseClient | null, url: string): Promise<Partial<LinkPreview> | null> {
  if (!admin) return null;
  const { data: ad } = await admin.from("market_ads").select("id, headline, angle, media, market_brands(name)").eq("motion_url", url).limit(1).maybeSingle();
  if (ad) {
    const media = (ad.media ?? []) as { type?: string; url?: string; thumb?: string }[];
    return {
      title: (ad.angle as string | null) ?? (ad.headline as string | null) ?? "Motion ad",
      subtitle: (ad.market_brands as unknown as { name?: string } | null)?.name ?? "Motion",
      thumbnail: media.find((m) => m.type === "image")?.url ?? media.find((m) => m.thumb)?.thumb ?? null,
    };
  }
  try {
    const { motionConnected, openSession, argsFor } = await import("@/lib/motion");
    if (!(await motionConnected(admin))) return null;
    const s = await openSession(admin);
    const tools = await s.list();
    // A tool that takes a link (share link, url): Motion's tool names change, so it's found by what it takes
    const tool = tools.find((t) => /share|link|url/i.test(JSON.stringify(t.inputSchema?.properties ?? {})) && /creative|ad|asset|share|link|get/i.test(t.name));
    if (!tool) return null;
    const out = await Promise.race([s.call(tool.name, argsFor(tool, { "url|link|shareUrl|share_url|shareLink": url })), new Promise((r) => setTimeout(() => r(null), 12_000))]);
    const found = pick(out);
    return found.title || found.thumbnail ? { ...found, subtitle: found.subtitle ?? "Motion" } : null;
  } catch {
    return null;
  }
}

/** The first title-like and picture-like strings in whatever Motion answered */
function pick(x: unknown): { title?: string; thumbnail?: string | null; subtitle?: string } {
  const out: { title?: string; thumbnail?: string | null; subtitle?: string } = {};
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || !v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") {
        if (!out.title && /^(title|name|headline|adName)$/i.test(k) && val.trim()) out.title = val.trim().slice(0, 160);
        else if (!out.thumbnail && /thumb|image|preview|poster/i.test(k) && /^https?:\/\//.test(val)) out.thumbnail = val;
        else if (!out.subtitle && /brand|page|account/i.test(k) && val.trim()) out.subtitle = val.trim().slice(0, 80);
      } else walk(val, depth + 1);
    }
  };
  walk(x, 0);
  return out;
}

/** What a pasted link shows as: its kind, title, picture and site (never throws) */
export async function previewLink(raw: string, admin: SupabaseClient | null = null): Promise<LinkPreview> {
  const url = raw.trim();
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return { url, kind: "link", title: null, subtitle: null, thumbnail: null, site: url, adId: null };
  }
  const kind = linkKind(url);
  const base: LinkPreview = { url, kind, title: null, subtitle: null, thumbnail: null, site: host, adId: null };
  const enc = encodeURIComponent(url);
  if (kind === "meta_ad_library") {
    const id = new URL(url).searchParams.get("id");
    return { ...base, site: "Meta Ad Library", title: id ? `Ad ${id}` : "Ad Library search", adId: id && /^\d{5,25}$/.test(id) ? id : null };
  }
  if (kind === "youtube") {
    const o = await oembed(`https://www.youtube.com/oembed?url=${enc}&format=json`);
    if (o) return { ...base, site: "YouTube", title: o.title ?? null, subtitle: o.author_name ?? null, thumbnail: o.thumbnail_url ?? null };
  }
  if (kind === "tiktok") {
    const o = await oembed(`https://www.tiktok.com/oembed?url=${enc}`);
    if (o) return { ...base, site: "TikTok", title: o.title ?? null, subtitle: o.author_name ?? null, thumbnail: o.thumbnail_url ?? null };
  }
  if (kind === "pinterest") {
    const o = await oembed(`https://www.pinterest.com/oembed.json?url=${enc}`);
    if (o?.thumbnail_url || o?.title) return { ...base, site: "Pinterest", title: o.title ?? null, subtitle: o.author_name ?? null, thumbnail: o.thumbnail_url ?? null };
  }
  if (kind === "motion") {
    const m = await motionLink(admin, url);
    if (m) return { ...base, site: "Motion", title: m.title ?? null, subtitle: m.subtitle ?? null, thumbnail: m.thumbnail ?? null };
  }
  const og = await openGraph(url);
  const SITE: Partial<Record<LinkPreview["kind"], string>> = { instagram: "Instagram", tiktok: "TikTok", pinterest: "Pinterest", youtube: "YouTube", motion: "Motion" };
  return og ? { ...base, site: SITE[kind] ?? og.site ?? host, title: og.title?.slice(0, 200) || null, subtitle: og.description?.slice(0, 200) || null, thumbnail: og.image } : { ...base, site: SITE[kind] ?? host };
}
