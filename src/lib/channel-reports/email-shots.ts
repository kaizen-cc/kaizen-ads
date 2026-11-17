import "server-only";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

// Pictures of a campaign's email for the report's campaign cards: the email's HTML (the saved preview, klaviyo_previews)
// drawn in a headless Chrome 640 wide with JavaScript off, the top 640x960 kept and made a ~400 wide JPEG. Drawn once per
// version of the email and kept in the private report-sends bucket at email-previews/<client>/<campaign>-<hash>.jpg, so
// the PDF, the studio's preview and the live page read the file instead of drawing again. On Vercel the browser is
// @sparticuz/chromium; on a laptop it's the installed Chrome or Edge. With no browser at all nothing is drawn and the
// card falls back to the email's first picture.

const BUCKET = "report-sends";
const FOLDER = "email-previews";
const VIEW = { width: 640, height: 960 };
const OUT_WIDTH = 400;

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);
const safeId = (id: string) => id.replace(/[^\w-]/g, "").slice(0, 64);
const hashOf = (html: string) => createHash("sha256").update(html).digest("hex").slice(0, 16);
const folderOf = (clientId: string) => `${FOLDER}/${safeId(clientId)}`;
export const shotPath = (clientId: string, campaignId: string, html: string) => `${folderOf(clientId)}/${safeId(campaignId)}-${hashOf(html)}.jpg`;

// ─── The browser ───────────────────────────────────────────────────────────

const LOCAL_BROWSERS = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

type Browser = import("puppeteer-core").Browser;

/** A headless browser, or null when there's none to be had here (the cards then use the email's first picture) */
async function launch(): Promise<Browser | null> {
  try {
    const puppeteer = (await import("puppeteer-core")).default;
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const chromium = (await import("@sparticuz/chromium")).default;
      return await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true, defaultViewport: VIEW });
    }
    const local = LOCAL_BROWSERS.find((p) => p && existsSync(p));
    if (!local) return null;
    return await puppeteer.launch({ executablePath: local, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio"], defaultViewport: VIEW });
  } catch {
    return null;
  }
}

/** Addresses the page may load: images, styles and fonts from the open web, never this machine or a private network */
function allowed(url: string): boolean {
  if (url.startsWith("data:")) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return !(h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd"));
  } catch {
    return false;
  }
}

/** The top of one email as a JPEG about 400 wide (null when it can't be drawn) */
async function draw(browser: Browser, html: string): Promise<Buffer | null> {
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setViewport(VIEW);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (!allowed(req.url()) || !["document", "image", "stylesheet", "font"].includes(type)) void req.abort().catch(() => null);
      else void req.continue().catch(() => null);
    });
    // The pictures get a few seconds to arrive; an email still waiting on one is drawn as it stands
    await page.setContent(html, { waitUntil: "load", timeout: 12_000 }).catch(() => null);
    await page.evaluate(() => document.fonts?.ready).catch(() => null);
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, ...VIEW } });
    const img = sharp(Buffer.from(png));
    const { channels } = await img.clone().stats();
    // A blank page (nothing loaded) is never a preview
    if (channels.slice(0, 3).every((c) => c.stdev < 2)) return null;
    return await img.resize(OUT_WIDTH).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  } catch {
    return null;
  } finally {
    await page.close().catch(() => null);
  }
}

/** One email drawn on its own (a fresh browser, closed after): what the tests and a one-off check use */
export async function renderEmailShot(html: string): Promise<Buffer | null> {
  const browser = await launch();
  if (!browser) return null;
  try {
    return await draw(browser, html);
  } finally {
    await browser.close().catch(() => null);
  }
}

// ─── The store ─────────────────────────────────────────────────────────────

/** The client's saved pictures, by file name */
async function savedFiles(admin: SupabaseClient, clientId: string): Promise<{ name: string; updated: string }[]> {
  const { data } = await admin.storage.from(BUCKET).list(folderOf(clientId), { limit: 1000, sortBy: { column: "updated_at", order: "desc" } });
  return (data ?? []).map((f) => ({ name: f.name, updated: String(f.updated_at ?? f.created_at ?? "") }));
}

/** Each campaign's saved email HTML (only emails: a text message has nothing to draw) */
async function htmlOf(admin: SupabaseClient, clientId: string, ids: string[], fetchMissing: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data } = await admin.from("klaviyo_previews").select("campaign_id, html, channel").eq("client_id", clientId).in("campaign_id", ids);
  for (const r of data ?? []) if (r.html && (r.channel ?? "email") !== "sms") out.set(r.campaign_id as string, r.html as string);
  const missing = fetchMissing ? ids.filter((id) => !out.has(id) && !(data ?? []).some((r) => r.campaign_id === id && r.channel === "sms")) : [];
  if (missing.length) {
    // Read once from the client's email provider (and cached there by the call)
    const { emailPreview } = await import("@/lib/email-providers");
    await Promise.all(
      missing.map(async (id) => {
        const got = await within(9_000, emailPreview(admin, clientId, id).catch(() => null), null);
        if (got && got.ok && got.preview.html && got.preview.channel !== "sms") out.set(id, got.preview.html);
      }),
    );
  }
  return out;
}

type Opts = { /** Draw what isn't saved yet (false: only read what's there) */ draw?: boolean; /** Read a missing preview from the provider */ fetch?: boolean; budgetMs?: number };

/**
 * The saved picture path for each campaign, drawing the ones missing for this version of the email when a browser is
 * available. A campaign whose current version can't be drawn keeps its last saved picture.
 */
export async function ensureEmailShots(admin: SupabaseClient, clientId: string, ids: string[], opts: Opts = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const [files, html] = await Promise.all([savedFiles(admin, clientId).catch(() => []), htmlOf(admin, clientId, want, opts.fetch ?? false).catch(() => new Map<string, string>())]);
  const names = new Set(files.map((f) => f.name));
  const latest = (id: string) => files.find((f) => f.name.startsWith(`${safeId(id)}-`))?.name ?? null;
  const todo: { id: string; path: string; html: string }[] = [];
  for (const id of want) {
    const h = html.get(id);
    const path = h ? shotPath(clientId, id, h) : null;
    if (path && names.has(path.split("/").pop()!)) out.set(id, path);
    else if (h && path && opts.draw !== false) todo.push({ id, path, html: h });
    else if (latest(id)) out.set(id, `${folderOf(clientId)}/${latest(id)}`);
  }
  if (!todo.length) return out;
  const until = Date.now() + (opts.budgetMs ?? 45_000);
  const browser = await launch();
  if (!browser) {
    for (const t of todo) if (latest(t.id)) out.set(t.id, `${folderOf(clientId)}/${latest(t.id)}`);
    return out;
  }
  try {
    // Two at a time: quick enough, and a small server never runs out of memory
    for (let i = 0; i < todo.length && Date.now() < until; i += 2) {
      await Promise.all(
        todo.slice(i, i + 2).map(async (t) => {
          const jpg = await within(20_000, draw(browser, t.html), null);
          if (jpg) {
            const { error } = await admin.storage.from(BUCKET).upload(t.path, jpg, { contentType: "image/jpeg", upsert: true });
            if (!error) return void out.set(t.id, t.path);
          }
          if (latest(t.id)) out.set(t.id, `${folderOf(clientId)}/${latest(t.id)}`);
        }),
      );
    }
  } finally {
    await browser.close().catch(() => null);
  }
  return out;
}

/** The pictures as data addresses for the PDF (by campaign id) */
export async function emailShotData(admin: SupabaseClient, clientId: string, ids: string[], opts: Opts = {}): Promise<Map<string, string>> {
  const paths = await ensureEmailShots(admin, clientId, ids, opts);
  const out = new Map<string, string>();
  await Promise.all(
    [...paths].map(async ([id, path]) => {
      const { data } = await admin.storage.from(BUCKET).download(path);
      if (data) out.set(id, `data:image/jpeg;base64,${Buffer.from(await data.arrayBuffer()).toString("base64")}`);
    }),
  );
  return out;
}

/** Signed links to the saved pictures for the live page (only what's saved: the page never draws) */
export async function emailShotLinks(admin: SupabaseClient, clientId: string, ids: string[], seconds = 6 * 3600): Promise<Record<string, string>> {
  const paths = await ensureEmailShots(admin, clientId, ids, { draw: false }).catch(() => new Map<string, string>());
  if (!paths.size) return {};
  const list = [...paths];
  const { data } = await admin.storage.from(BUCKET).createSignedUrls(list.map(([, p]) => p), seconds);
  const out: Record<string, string> = {};
  (data ?? []).forEach((d, i) => {
    if (d.signedUrl) out[list[i][0]] = d.signedUrl;
  });
  return out;
}
