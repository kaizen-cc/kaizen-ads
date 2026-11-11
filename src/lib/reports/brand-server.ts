import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { colorFromPixels, colorsFromBible, isLightLogo, pickBrandColor } from "./brand";

// The client's look on their report: their logo and brand colour, found once and kept on the client
// (clients.report_brand), so a report never waits on their website. Where the logo comes from, in order: the one
// uploaded on the client page (Team & setup › Report logo), a logo linked in the Brand Bible, the logo on their website
// (the header's logo image, then the touch icon, then a large favicon, then the share image when it reads as a logo), a
// file called "logo" in their Drive folder. The colour: the one set on the client page, the Brand Bible's colours,
// else the logo's own. Nothing found: the report's own look (see brand.ts).

/** logo: a PNG data URI; light: a white logo, shown on a dark chip; color: the brand colour (hex) */
export type ReportBrand = { logo: string | null; light: boolean; color: string | null; source: string | null };

/** What's kept on the client (clients.report_brand) */
type Kept = { logo?: string | null; light?: boolean; color?: string | null; source?: string | null; colorSource?: string | null; uploaded?: boolean; colorSet?: boolean; checkedAt?: string };

const KEEP_DAYS = 30;
const UA = "Mozilla/5.0 (compatible; KaizenAds/1.0; report logo)";

/** A logo's bytes as a trimmed PNG (at most 600 by 200), with its colour and whether it's a light logo; null when it isn't a usable picture */
export async function processLogo(bytes: Buffer): Promise<{ logo: string; light: boolean; color: string | null } | null> {
  try {
    const img = sharp(bytes, { density: 300 }).ensureAlpha();
    const meta = await img.metadata();
    if (!meta.width || !meta.height || Math.max(meta.width, meta.height) < 48) return null;
    const png = await img
      .trim({ threshold: 12 })
      .resize(600, 200, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer()
      .catch(() => sharp(bytes).ensureAlpha().resize(600, 200, { fit: "inside" }).png().toBuffer());
    const { data, info } = await sharp(png).ensureAlpha().resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return null;
    return { logo: `data:image/png;base64,${png.toString("base64")}`, light: isLightLogo(data), color: colorFromPixels(data) };
  } catch {
    return null;
  }
}

async function fetchBytes(url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(7000), redirect: "follow", cache: "no-store" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/image|octet-stream|svg/i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 200 && buf.length < 8_000_000 ? buf : null;
  } catch {
    return null;
  }
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;

/** The pictures on a client's website that could be their logo, best first (pure, so it's tested) */
export function logoCandidates(html: string, base: string): string[] {
  const abs = (u: string | null) => {
    if (!u || u.startsWith("data:")) return null;
    try {
      return new URL(u.replace(/&amp;/g, "&"), base).href;
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  const head = html.slice(0, 300_000);
  // 1. The header's logo image (an <img> whose class, id, alt or file name says logo)
  for (const tag of head.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/logo/i.test(tag)) continue;
    const src = abs(attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "srcset")?.split(/\s+/)[0] ?? null);
    if (src) out.push(src);
    if (out.length >= 3) break;
  }
  // 2. The touch icon, then the largest favicon
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) if (/rel=["'][^"']*apple-touch-icon/i.test(tag)) out.push(abs(attr(tag, "href"))!);
  const icons = links
    .filter((tag) => /rel=["'][^"']*\bicon\b/i.test(tag) && !/apple-touch/i.test(tag))
    .map((tag) => ({ href: abs(attr(tag, "href")), size: Number(attr(tag, "sizes")?.split("x")[0]) || 0 }))
    .filter((x) => x.href && !/\.ico(\?|$)/i.test(x.href))
    .sort((a, b) => b.size - a.size);
  for (const x of icons) out.push(x.href!);
  // 3. The share image, last (often a photo: only kept when it reads as a logo, see below)
  const og = head.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1] ?? head.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] ?? null;
  if (abs(og)) out.push(`og:${abs(og)}`);
  return [...new Set(out.filter(Boolean))];
}

/** A share image is only a logo when it has see-through parts or its file name says so (a photo never does) */
async function looksLikeLogo(bytes: Buffer, url: string) {
  if (/logo/i.test(url)) return true;
  try {
    const { data } = await sharp(bytes).ensureAlpha().resize(48, 48, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 40) clear++;
    return clear > data.length / 4 / 10;
  } catch {
    return false;
  }
}

async function fromWebsite(website: string | null | undefined) {
  if (!website) return null;
  const { isPublicHost } = await import("@/lib/references");
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  try {
    if (!isPublicHost(url)) return null;
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(8000), redirect: "follow", cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    for (const c of logoCandidates(html, res.url || url).slice(0, 6)) {
      const share = c.startsWith("og:");
      const link = share ? c.slice(3) : c;
      if (!isPublicHost(link)) continue;
      const bytes = await fetchBytes(link);
      if (!bytes || (share && !(await looksLikeLogo(bytes, link)))) continue;
      const got = await processLogo(bytes);
      if (got) return { ...got, source: share ? "website share image" : "website" };
    }
  } catch {
    // no website logo
  }
  return null;
}

async function fromDrive(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("client_assets").select("file_id, name").eq("client_id", clientId).eq("kind", "image").ilike("name", "%logo%").order("created_at", { ascending: false }).limit(3);
  if (!data?.length) return null;
  try {
    const { driveToken } = await import("@/lib/context/google");
    const token = await driveToken();
    for (const f of data) {
      const bytes = await fetchBytes(`https://www.googleapis.com/drive/v3/files/${f.file_id}?alt=media&supportsAllDrives=true`, { authorization: `Bearer ${token}` });
      const got = bytes ? await processLogo(bytes) : null;
      if (got) return { ...got, source: "Drive" };
    }
  } catch {
    // Drive not reachable
  }
  return null;
}

async function fromBible(markdown: string) {
  // A logo the Brand Bible links to (a picture whose address says logo)
  const links = [...markdown.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0]).filter((u) => /logo/i.test(u) && /\.(png|jpe?g|svg|webp)(\?|$)/i.test(u));
  const { isPublicHost } = await import("@/lib/references");
  for (const u of links.slice(0, 3)) {
    if (!isPublicHost(u)) continue;
    const bytes = await fetchBytes(u);
    const got = bytes ? await processLogo(bytes) : null;
    if (got) return { ...got, source: "Brand Bible" };
  }
  return null;
}

/** What's kept on the client (an empty object before the column exists, or before anything was found) */
export async function keptBrand(admin: SupabaseClient, clientId: string): Promise<Kept> {
  const { data, error } = await admin.from("clients").select("report_brand").eq("id", clientId).maybeSingle();
  if (error) return {};
  return ((data as { report_brand?: Kept | null } | null)?.report_brand ?? {}) as Kept;
}

async function keep(admin: SupabaseClient, clientId: string, kept: Kept) {
  // Before the column exists the update fails quietly: the brand is worked out again next time
  await admin.from("clients").update({ report_brand: kept }).eq("id", clientId).then(
    () => null,
    () => null,
  );
}

/**
 * The client's logo and colour for their report, found (and kept for a month) or read from what's kept. A logo or
 * colour set by hand on the client page is never replaced by one found.
 */
export async function reportBrand(admin: SupabaseClient, clientId: string, opts: { refresh?: boolean } = {}): Promise<ReportBrand> {
  const kept = await keptBrand(admin, clientId);
  const fresh = kept.checkedAt && Date.now() - Date.parse(kept.checkedAt) < KEEP_DAYS * 86_400_000;
  if (!opts.refresh && (fresh || kept.uploaded) && (kept.logo || kept.color || fresh)) return { logo: kept.logo ?? null, light: Boolean(kept.light), color: kept.color ?? null, source: kept.source ?? null };

  const [{ data: client }, { data: bible }] = await Promise.all([admin.from("clients").select("website").eq("id", clientId).maybeSingle(), admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle()]);
  const markdown = String((bible as { markdown?: string } | null)?.markdown ?? "");
  let found: { logo: string; light: boolean; color: string | null; source: string } | null = null;
  if (!kept.uploaded) found = (await fromBible(markdown)) ?? (await fromWebsite((client as { website?: string | null } | null)?.website)) ?? (await fromDrive(admin, clientId));
  const logo = kept.uploaded ? (kept.logo ?? null) : (found?.logo ?? null);
  const light = kept.uploaded ? Boolean(kept.light) : Boolean(found?.light);
  const bibleColor = pickBrandColor(colorsFromBible(markdown));
  const color = kept.colorSet ? (kept.color ?? null) : (bibleColor ?? (kept.uploaded ? (kept.color ?? null) : (found?.color ?? null)));
  const next: Kept = { ...kept, logo, light, color, source: kept.uploaded ? (kept.source ?? "upload") : (found?.source ?? null), colorSource: kept.colorSet ? "set" : bibleColor ? "Brand Bible" : color ? "logo" : null, checkedAt: new Date().toISOString() };
  await keep(admin, clientId, next);
  return { logo, light, color, source: next.source ?? null };
}

/** A logo uploaded on the client page: processed, kept, and its colour taken unless one was set by hand */
export async function saveUploadedLogo(admin: SupabaseClient, clientId: string, bytes: Buffer): Promise<{ ok: true } | { ok: false; error: string }> {
  const got = await processLogo(bytes);
  if (!got) return { ok: false, error: "That file isn't a picture we can read. Use a PNG, JPG, SVG or WebP at least 48 pixels across." };
  const kept = await keptBrand(admin, clientId);
  const { error } = await admin
    .from("clients")
    .update({ report_brand: { ...kept, logo: got.logo, light: got.light, uploaded: true, source: "upload", ...(kept.colorSet ? {} : { color: got.color ?? kept.color ?? null, colorSource: got.color ? "logo" : (kept.colorSource ?? null) }), checkedAt: new Date().toISOString() } })
    .eq("id", clientId);
  return error ? { ok: false, error: /report_brand/.test(error.message) ? "Report logos aren't switched on yet (the database needs its update)." : error.message } : { ok: true };
}

/** The colour set by hand (a hex), or null to go back to the one found */
export async function saveReportColor(admin: SupabaseClient, clientId: string, hex: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const kept = await keptBrand(admin, clientId);
  const color = hex ? pickBrandColor([hex]) ?? (/^#?[0-9a-f]{6}$/i.test(hex) ? `#${hex.replace(/^#/, "").toLowerCase()}` : null) : null;
  if (hex && !color) return { ok: false, error: "Use a hex colour, e.g. #1F4E79." };
  const next: Kept = hex ? { ...kept, color, colorSet: true, colorSource: "set" } : { ...kept, colorSet: false, checkedAt: undefined };
  const { error } = await admin.from("clients").update({ report_brand: next }).eq("id", clientId);
  if (error) return { ok: false, error: /report_brand/.test(error.message) ? "Report colours aren't switched on yet (the database needs its update)." : error.message };
  return { ok: true };
}

/** Taking the uploaded logo off: the report finds one again */
export async function clearUploadedLogo(admin: SupabaseClient, clientId: string) {
  const kept = await keptBrand(admin, clientId);
  await admin.from("clients").update({ report_brand: { ...kept, logo: null, uploaded: false, source: null, checkedAt: undefined } }).eq("id", clientId);
}

let agency: string | null | undefined;
/** Kaizen's logo for the report's masthead, as a data URI (read once) */
export async function agencyLogo(): Promise<string | null> {
  if (agency !== undefined) return agency;
  try {
    const png = await sharp(await fs.readFile(path.join(process.cwd(), "public", "kaizen-logo.png"))).png().toBuffer();
    agency = `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    agency = null;
  }
  return agency;
}
