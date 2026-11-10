import "server-only";
import { redactTokens } from "@/lib/meta-token-core";
import { TIKTOK_API, errorLine, isAuthError, isRetryable, tiktokConfigured, type ReportRow, type TikTokEnvelope } from "./core";

// TikTok's Business API (v1.3), read only. Every call is sequential with a short pause (TikTok's limits are per app and
// per advertiser), retried on its rate-limit codes, and its code and message are logged (never the token). Code 0 is
// success; anything else throws a TikTokError.

export class TikTokError extends Error {
  code: number | null;
  auth: boolean;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "TikTokError";
    this.code = code;
    this.auth = isAuthError(code);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = 250;
const RETRIES = [2_000, 5_000, 12_000];

/** Query values as TikTok wants them: arrays and objects as JSON strings */
function query(params: Record<string, unknown>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return q.toString();
}

async function call<T>(method: "GET" | "POST", path: string, params: Record<string, unknown>, token: string | null): Promise<T> {
  if (!tiktokConfigured()) throw new TikTokError("TikTok isn't set up yet (TIKTOK_APP_ID and TIKTOK_APP_SECRET).", null);
  const url = `${TIKTOK_API}${path.startsWith("/") ? path : `/${path}`}${method === "GET" && Object.keys(params).length ? `?${query(params)}` : ""}`;
  const secrets = [token, process.env.TIKTOK_APP_SECRET];
  for (let attempt = 0; ; attempt++) {
    await sleep(attempt ? RETRIES[attempt - 1] : PAUSE_MS);
    let status = 0;
    let body: TikTokEnvelope<T> | null = null;
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { "Access-Token": token } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(params) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      body = (await res.json().catch(() => null)) as TikTokEnvelope<T> | null;
    } catch (e) {
      if (attempt < RETRIES.length) continue;
      throw new TikTokError(redactTokens(`TikTok didn't answer: ${e instanceof Error ? e.message : String(e)}`, secrets), null);
    }
    const code = body?.code ?? null;
    if (status >= 200 && status < 300 && code === 0) return (body?.data ?? ({} as T)) as T;
    const line = redactTokens(errorLine(code, body?.message ?? `HTTP ${status}`, body?.request_id), secrets);
    if (isRetryable(code, status) && attempt < RETRIES.length) {
      console.warn(`[tiktok] ${path} retry ${attempt + 1}: ${line}`);
      continue;
    }
    console.error(`[tiktok] ${path} failed: ${line}`);
    throw new TikTokError(line, code);
  }
}

export const ttGet = <T>(path: string, params: Record<string, unknown>, token: string | null) => call<T>("GET", path, params, token);
export const ttPost = <T>(path: string, body: Record<string, unknown>, token: string | null) => call<T>("POST", path, body, token);

// ─── OAuth ─────────────────────────────────────────────────────────────────

/** The auth_code from TikTok's redirect, exchanged for the long-lived token and the advertisers it reaches. */
export async function exchangeCode(authCode: string): Promise<{ token: string; advertiserIds: string[]; scopes: string[] }> {
  const d = await ttPost<{ access_token?: string; advertiser_ids?: (string | number)[]; scope?: (string | number)[] }>(
    "/oauth2/access_token/",
    { app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET, auth_code: authCode },
    null,
  );
  if (!d.access_token) throw new TikTokError("TikTok didn't return an access token.", null);
  return { token: d.access_token, advertiserIds: (d.advertiser_ids ?? []).map(String), scopes: (d.scope ?? []).map(String) };
}

/** Every advertiser the token reaches (needs the app's id and secret alongside the token) */
export async function advertisersOf(token: string): Promise<{ id: string; name: string | null }[]> {
  const d = await ttGet<{ list?: { advertiser_id?: string | number; advertiser_name?: string }[] }>("/oauth2/advertiser/get/", { app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET }, token);
  return (d.list ?? []).filter((a) => a.advertiser_id != null).map((a) => ({ id: String(a.advertiser_id), name: a.advertiser_name ?? null }));
}

export type AdvertiserInfo = { id: string; name: string | null; currency: string | null; timezone: string | null; status: string | null };

/** Name, currency, timezone and status, up to 100 advertisers a call */
export async function advertiserInfo(token: string, ids: string[]): Promise<AdvertiserInfo[]> {
  const out: AdvertiserInfo[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await ttGet<{ list?: Record<string, unknown>[] }>("/advertiser/info/", { advertiser_ids: ids.slice(i, i + 100), fields: ["advertiser_id", "name", "currency", "timezone", "display_timezone", "status"] }, token);
    for (const a of d.list ?? [])
      out.push({
        id: String(a.advertiser_id),
        name: (a.name as string) ?? null,
        currency: (a.currency as string) ?? null,
        timezone: ((a.display_timezone ?? a.timezone) as string) ?? null,
        status: (a.status as string) ?? null,
      });
  }
  return out;
}

// ─── Reporting ─────────────────────────────────────────────────────────────

type PageInfo = { page?: number; page_size?: number; total_number?: number; total_page?: number };

/** Every row of a BASIC report for one advertiser and range (paged, 1000 a page) */
export async function report(token: string, p: { advertiserId: string; dataLevel: "AUCTION_ADVERTISER" | "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP" | "AUCTION_AD"; dimensions: string[]; metrics: readonly string[]; start: string; end: string }): Promise<ReportRow[]> {
  const out: ReportRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const d = await ttGet<{ list?: ReportRow[]; page_info?: PageInfo }>(
      "/report/integrated/get/",
      { advertiser_id: p.advertiserId, report_type: "BASIC", data_level: p.dataLevel, dimensions: p.dimensions, metrics: p.metrics, start_date: p.start, end_date: p.end, page, page_size: 1000 },
      token,
    );
    out.push(...(d.list ?? []));
    const total = d.page_info?.total_page ?? 1;
    if (page >= total || !(d.list ?? []).length) break;
  }
  return out;
}

// ─── Ads and their creative ────────────────────────────────────────────────

export type TikTokAd = {
  ad_id: string;
  ad_name?: string;
  campaign_id?: string;
  adgroup_id?: string;
  operation_status?: string;
  secondary_status?: string;
  ad_text?: string;
  call_to_action?: string;
  landing_page_url?: string;
  video_id?: string | null;
  image_ids?: string[] | null;
  create_time?: string;
};

/** Every ad in the account (paged) */
export async function ads(token: string, advertiserId: string): Promise<TikTokAd[]> {
  const out: TikTokAd[] = [];
  for (let page = 1; page <= 40; page++) {
    const d = await ttGet<{ list?: TikTokAd[]; page_info?: PageInfo }>("/ad/get/", { advertiser_id: advertiserId, page, page_size: 1000 }, token);
    out.push(...(d.list ?? []).map((a) => ({ ...a, ad_id: String(a.ad_id) })));
    if (page >= (d.page_info?.total_page ?? 1) || !(d.list ?? []).length) break;
  }
  return out;
}

/** Video covers (thumbnails), 60 a call */
export async function videoCovers(token: string, advertiserId: string, videoIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < videoIds.length; i += 60) {
    const d = await ttGet<{ list?: { video_id?: string; video_cover_url?: string; poster_url?: string }[] }>("/file/video/ad/info/", { advertiser_id: advertiserId, video_ids: videoIds.slice(i, i + 60) }, token);
    for (const v of d.list ?? []) if (v.video_id && (v.video_cover_url || v.poster_url)) out.set(String(v.video_id), (v.video_cover_url || v.poster_url)!);
  }
  return out;
}

/** Image URLs, 100 a call */
export async function imageUrls(token: string, advertiserId: string, imageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < imageIds.length; i += 100) {
    const d = await ttGet<{ list?: { image_id?: string; image_url?: string }[] }>("/file/image/ad/info/", { advertiser_id: advertiserId, image_ids: imageIds.slice(i, i + 100) }, token);
    for (const v of d.list ?? []) if (v.image_id && v.image_url) out.set(String(v.image_id), v.image_url);
  }
  return out;
}

// ─── Tracking and delivery checks ──────────────────────────────────────────
// Raw data blocks, parsed defensively in ./diagnostics-core.ts (these answers aren't documented field by field)

/** The pixels on an advertiser and their events (paged, 20 a page as TikTok allows) */
export async function pixelList(token: string, advertiserId: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await ttGet<{ pixels?: unknown[]; list?: unknown[]; page_info?: PageInfo }>("/pixel/list/", { advertiser_id: advertiserId, page, page_size: 20 }, token);
    const list = d.pixels ?? d.list ?? [];
    out.push(...list);
    if (page >= (d.page_info?.total_page ?? 1) || !list.length) break;
  }
  return out;
}

/** Each pixel's event counts over a date range */
export async function pixelEventStats(token: string, advertiserId: string, pixelIds: string[], start: string, end: string): Promise<unknown> {
  return ttGet<unknown>("/pixel/event/stats/", { advertiser_id: advertiserId, pixel_ids: pixelIds, date_range: { start_date: start, end_date: end } }, token);
}

export type TikTokAdGroup = { adgroup_id: string; adgroup_name?: string; campaign_id?: string; operation_status?: string; secondary_status?: string };

/** The ad groups (with their secondary status: learning, limited, rejected), paged */
export async function adGroups(token: string, advertiserId: string): Promise<TikTokAdGroup[]> {
  const out: TikTokAdGroup[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = await ttGet<{ list?: (Omit<TikTokAdGroup, "adgroup_id" | "campaign_id"> & { adgroup_id: string | number; campaign_id?: string | number })[]; page_info?: PageInfo }>("/adgroup/get/", { advertiser_id: advertiserId, page, page_size: 1000 }, token);
    out.push(...(d.list ?? []).map((g) => ({ ...g, adgroup_id: String(g.adgroup_id), campaign_id: g.campaign_id != null ? String(g.campaign_id) : undefined })));
    if (page >= (d.page_info?.total_page ?? 1) || !(d.list ?? []).length) break;
  }
  return out;
}

/** TikTok's own diagnosis of up to 20 ad groups a call (delivery, creative, bid and budget, and tracking issues) */
export async function adDiagnosis(token: string, advertiserId: string, adgroupIds: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < adgroupIds.length; i += 20) out.push(await ttGet<unknown>("/tool/diagnosis/get/", { advertiser_id: advertiserId, filtering: { adgroup_ids: adgroupIds.slice(i, i + 20) } }, token));
  return out;
}
