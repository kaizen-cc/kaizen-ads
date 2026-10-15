import "server-only";
import { driveToken } from "@/lib/context/google";

// Reads the reference links on a request so the AI can use them, not just see the address:
// - Google Drive: opened with the Workspace connection. Images (and video thumbnails) are passed to the AI as
//   pictures; Docs and text files as text; folders as a list of what's inside.
// - Websites: the page's title, description and visible text (offer, prices, claims, wording).
// - Facebook Ads Library: whatever the page exposes without a login; usually little, and then it says so.
// Anything unreadable is reported as such, so nobody assumes the AI took it into account.

export type RefKind = "drive" | "website" | "ads_library" | "other";
export type RefRead = {
  url: string;
  kind: RefKind;
  ok: boolean;
  label: string; // what it is, in a few words ("Drive image · Hero_4x5.png")
  text: string; // what the AI reads
  note?: string; // why it couldn't be read
};
export type RefImage = { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };

const TIMEOUT = 9000;
const MAX_TEXT = 6000;
const MAX_IMAGE_BYTES = 3_500_000;

const withTimeout = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });

export function classify(url: string): RefKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "drive.google.com" || host === "docs.google.com") return "drive";
  if ((host === "facebook.com" || host.endsWith(".facebook.com")) && u.pathname.startsWith("/ads/library")) return "ads_library";
  if (u.protocol === "http:" || u.protocol === "https:") return "website";
  return "other";
}

const driveId = (url: string) => url.match(/\/d\/([\w-]{20,})/)?.[1] ?? url.match(/\/folders\/([\w-]{20,})/)?.[1] ?? url.match(/[?&]id=([\w-]{20,})/)?.[1] ?? null;

const decode = (t: string) =>
  t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;|&#8217;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/** Visible text of an HTML page, without scripts, styles or markup. */
function pageText(html: string) {
  const meta = (name: string) => decode(html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)`, "i"))?.[1] ?? "");
  const title = decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "");
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title, description: meta("description") || meta("og:description"), ogTitle: meta("og:title"), body: decode(body) };
}

/** Only public websites: never the server's own network. */
function isPublicHost(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false; // raw IPs (incl. private and metadata addresses)
  return true;
}

async function readWebsite(url: string): Promise<RefRead> {
  if (!isPublicHost(url)) return { url, kind: "website", ok: false, label: "Link", text: "", note: "Only public websites can be read" };
  try {
    const res = await withTimeout(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenAds/1.0; reference reader)", accept: "text/html,*/*" } });
    if (!res.ok) return { url, kind: "website", ok: false, label: "Website", text: "", note: `The page returned ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return { url, kind: "website", ok: false, label: "Website", text: "", note: `Not a web page (${type.split(";")[0] || "unknown"})` };
    const p = pageText(await res.text());
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (p.body.length < 80) return { url, kind: "website", ok: false, label: host, text: "", note: "The page has almost no readable text (it may need JavaScript)" };
    return {
      url,
      kind: "website",
      ok: true,
      label: `${host}${p.title ? ` · ${p.title.slice(0, 60)}` : ""}`,
      text: [p.title && `Title: ${p.title}`, p.description && `Description: ${p.description}`, `Page text:\n${p.body.slice(0, MAX_TEXT)}`].filter(Boolean).join("\n"),
    };
  } catch (e) {
    return { url, kind: "website", ok: false, label: "Website", text: "", note: e instanceof Error && e.name === "TimeoutError" ? "The page took too long to load" : "Couldn't open the page" };
  }
}

async function readAdsLibrary(url: string): Promise<RefRead> {
  const id = new URL(url).searchParams.get("id");
  const base = { url, kind: "ads_library" as const, label: id ? `Ads Library ad ${id}` : "Ads Library search" };
  try {
    const res = await withTimeout(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenAds/1.0)", "accept-language": "en-US" } });
    const p = pageText(await res.text());
    const text = [p.ogTitle, p.description].filter((x) => x && !/log in|facebook/i.test(x)).join("\n");
    if (text.length > 30) return { ...base, ok: true, text: `From the Ads Library page:\n${text}` };
  } catch {
    // Falls through to "couldn't read"
  }
  return {
    ...base,
    ok: false,
    text: "",
    note: "Facebook doesn't show Ads Library pages without a login. Say in the brief what to take from this ad (layout, hook, format).",
  };
}

type DriveFile = { id: string; name: string; mimeType: string; size?: string; thumbnailLink?: string; description?: string };

async function readDrive(url: string, images: RefImage[]): Promise<RefRead> {
  const id = driveId(url);
  const base = { url, kind: "drive" as const };
  if (!id) return { ...base, ok: false, label: "Drive link", text: "", note: "Couldn't find a file in this link" };
  let token: string;
  try {
    token = await driveToken();
  } catch {
    return { ...base, ok: false, label: "Drive link", text: "", note: "Google Drive isn't connected" };
  }
  const api = (path: string, params: Record<string, string> = {}) =>
    withTimeout(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams({ supportsAllDrives: "true", ...params })}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    const metaRes = await api(`files/${id}`, { fields: "id,name,mimeType,size,thumbnailLink,description" });
    if (!metaRes.ok) return { ...base, ok: false, label: "Drive link", text: "", note: metaRes.status === 404 ? "Kaizen's Drive can't see this file (it may not be shared with the agency)" : `Drive said ${metaRes.status}` };
    const f = (await metaRes.json()) as DriveFile;

    if (f.mimeType === "application/vnd.google-apps.folder") {
      const list = await api("files", { q: `'${id}' in parents and trashed = false`, fields: "files(name,mimeType)", pageSize: "40", includeItemsFromAllDrives: "true", corpora: "allDrives" });
      const files = list.ok ? ((await list.json()) as { files: DriveFile[] }).files : [];
      return { ...base, ok: true, label: `Drive folder · ${f.name}`, text: `Folder "${f.name}" contains:\n${files.map((x) => `- ${x.name}`).join("\n") || "(empty)"}` };
    }
    if (f.mimeType.startsWith("application/vnd.google-apps.")) {
      const exportType = f.mimeType.endsWith(".spreadsheet") ? "text/csv" : "text/plain";
      const res = await api(`files/${id}/export`, { mimeType: exportType });
      const text = res.ok ? (await res.text()).slice(0, MAX_TEXT) : "";
      return text ? { ...base, ok: true, label: `Google Doc · ${f.name}`, text: `"${f.name}":\n${text}` } : { ...base, ok: false, label: f.name, text: "", note: "Couldn't export this Google file" };
    }
    if (f.mimeType.startsWith("image/") && Number(f.size ?? 0) <= MAX_IMAGE_BYTES && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(f.mimeType)) {
      const res = await api(`files/${id}`, { alt: "media" });
      if (res.ok) {
        images.push({ mediaType: f.mimeType as RefImage["mediaType"], data: Buffer.from(await res.arrayBuffer()).toString("base64") });
        return { ...base, ok: true, label: `Drive image · ${f.name}`, text: `Image "${f.name}" (attached, picture ${images.length}).` };
      }
    }
    // Large images and videos: Drive's thumbnail is enough to see the composition
    if (f.thumbnailLink && (f.mimeType.startsWith("image/") || f.mimeType.startsWith("video/"))) {
      const res = await withTimeout(f.thumbnailLink.replace(/=s\d+$/, "=s1200"), { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
        images.push({ mediaType: (["image/png", "image/webp", "image/gif"].includes(type) ? type : "image/jpeg") as RefImage["mediaType"], data: Buffer.from(await res.arrayBuffer()).toString("base64") });
        return { ...base, ok: true, label: `Drive ${f.mimeType.startsWith("video/") ? "video" : "image"} · ${f.name}`, text: `${f.mimeType.startsWith("video/") ? "Video" : "Image"} "${f.name}" (a still is attached, picture ${images.length}).` };
      }
    }
    if (f.mimeType.startsWith("text/")) {
      const res = await api(`files/${id}`, { alt: "media" });
      if (res.ok) return { ...base, ok: true, label: `Drive file · ${f.name}`, text: `"${f.name}":\n${(await res.text()).slice(0, MAX_TEXT)}` };
    }
    return { ...base, ok: true, label: `Drive file · ${f.name}`, text: `A ${f.mimeType} file named "${f.name}"${f.description ? `: ${f.description}` : ""}. Its contents can't be read here.` };
  } catch (e) {
    return { ...base, ok: false, label: "Drive link", text: "", note: e instanceof Error && e.name === "TimeoutError" ? "Drive took too long" : "Couldn't open the file" };
  }
}

// Read once, reuse for 10 minutes: the review, "Make this change" and suggestions often read the same links
const cache = new Map<string, { at: number; read: RefRead; images: RefImage[] }>();

async function readOne(url: string): Promise<{ read: RefRead; images: RefImage[] }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const images: RefImage[] = [];
  const kind = classify(url);
  const read =
    kind === "drive"
      ? await readDrive(url, images)
      : kind === "ads_library"
        ? await readAdsLibrary(url)
        : kind === "website"
          ? await readWebsite(url)
          : { url, kind, ok: false, label: "Link", text: "", note: "Not a link we can open" };
  const out = { at: Date.now(), read, images };
  if (read.ok) cache.set(url, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return out;
}

/** Read every reference link (at most 6) in parallel. Images come back separately, to attach to the AI call. */
export async function readReferences(urls: string[]): Promise<{ reads: RefRead[]; images: RefImage[] }> {
  const list = [...new Set(urls)].slice(0, 6);
  const results = await Promise.all(list.map(readOne));
  // Number the pictures in the order they're attached
  const images: RefImage[] = [];
  const reads = results.map(({ read, images: own }) => {
    const first = images.length + 1;
    images.push(...own);
    return own.length ? { ...read, text: read.text.replace(/picture \d+/, `picture ${first}`) } : read;
  });
  return { reads, images: images.slice(0, 4) };
}

/** The references as the AI reads them. */
export function referencesBlock(reads: RefRead[]) {
  if (!reads.length) return "";
  return `<references>
What the person linked, read for you. Use what's relevant (layout, offer, wording, visual style); the attached pictures are the image references in order. Where a reference couldn't be read, don't guess what's in it.
${reads.map((r, i) => `Reference ${i + 1} · ${r.label} · ${r.url}\n${r.ok ? r.text : `Couldn't be read: ${r.note}`}`).join("\n\n")}
</references>`;
}
