import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The plain parts of TikTok Ads, kept apart from the database and TikTok's API so they can be tested: whether TikTok is
// set up at all (dormant until Kaizen's TikTok Marketing API app is approved), the OAuth state that stops a forged
// callback, the URLs, how TikTok's report rows become Kaizen's daily rows, and the metric math (CPA, ROAS, hook rate).

// ─── Set up or dormant ─────────────────────────────────────────────────────

export const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_AUTH = "https://business-api.tiktok.com/portal/auth";
export const TIKTOK_REDIRECT_PATH = "/api/tiktok/callback";
export const WAITING_TEXT = "Waiting on TikTok approval: add TIKTOK_APP_ID and TIKTOK_APP_SECRET in Vercel";
/** What the chat says when someone asks to change something in TikTok */
export const READ_ONLY_TEXT = "TikTok changes aren't connected yet: Kaizen Ads reads TikTok's numbers but can't change anything there. Make the change in TikTok Ads Manager.";

type Env = Record<string, string | undefined>;

/** TikTok runs only once Kaizen's app is approved and both of its keys are in Vercel; before that nothing runs. */
export function tiktokConfigured(env: Env = process.env): boolean {
  return Boolean(env.TIKTOK_APP_ID?.trim() && env.TIKTOK_APP_SECRET?.trim());
}

export function tiktokMissing(env: Env = process.env): string[] {
  return [!env.TIKTOK_APP_ID?.trim() && "TIKTOK_APP_ID", !env.TIKTOK_APP_SECRET?.trim() && "TIKTOK_APP_SECRET"].filter(Boolean) as string[];
}

/** The redirect URL registered with TikTok (TIKTOK_REDIRECT_URI wins; otherwise this site's own callback). */
export function tiktokRedirect(origin: string, env: Env = process.env): string {
  return env.TIKTOK_REDIRECT_URI?.trim() || `${origin.replace(/\/$/, "")}${TIKTOK_REDIRECT_PATH}`;
}

export function authorizeUrl(appId: string, state: string, redirectUri: string): string {
  const u = new URL(TIKTOK_AUTH);
  u.searchParams.set("app_id", appId);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", redirectUri);
  return u.toString();
}

// ─── OAuth state (CSRF) ────────────────────────────────────────────────────

/**
 * The state sent to TikTok: who started it, a random nonce and when it expires, signed with the app secret. The same
 * value is kept in an httpOnly cookie, so the callback only accepts the answer to a connect this browser started, by
 * the same exec, within ten minutes.
 */
export function makeState(secret: string, by: string, now = Date.now(), ttlMs = 10 * 60_000): string {
  const payload = Buffer.from(JSON.stringify({ by, n: randomBytes(16).toString("base64url"), exp: now + ttlMs })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`tiktok-oauth:${payload}`).digest("base64url");

export type StateCheck = { ok: true } | { ok: false; reason: string };

/** Whether the state TikTok sent back is the one this browser's cookie holds, signed by us, for this exec, not expired. */
export function checkState(secret: string, returned: string | null | undefined, cookie: string | null | undefined, by: string, now = Date.now()): StateCheck {
  if (!returned || !cookie) return { ok: false, reason: "The sign-in didn't match. Try connecting again." };
  const a = Buffer.from(returned);
  const b = Buffer.from(cookie);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "The sign-in didn't match. Try connecting again." };
  const [payload, sig] = returned.split(".");
  if (!payload || !sig) return { ok: false, reason: "The sign-in didn't match. Try connecting again." };
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "The sign-in didn't match. Try connecting again." };
  let body: { by?: string; exp?: number };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "The sign-in didn't match. Try connecting again." };
  }
  if (!body.exp || body.exp < now) return { ok: false, reason: "The sign-in took too long. Try connecting again." };
  if (body.by !== by) return { ok: false, reason: "Someone else started this sign-in. Try connecting again." };
  return { ok: true };
}

// ─── TikTok's answers ──────────────────────────────────────────────────────

/** TikTok's envelope: code 0 is success; anything else carries a message. */
export type TikTokEnvelope<T> = { code?: number; message?: string; request_id?: string; data?: T };

/** Too many requests (QPS or daily limits) and TikTok's own hiccups: worth a retry after a pause. */
export const isRetryable = (code: number | null | undefined, status?: number) => code === 40100 || code === 40016 || code === 50000 || code === 50002 || status === 429 || (status != null && status >= 500);

/** The token was revoked, expired or lacks the permission: the connection needs an exec to reconnect. */
export const isAuthError = (code: number | null | undefined) => code === 40001 || code === 40102 || code === 40104 || code === 40105 || code === 40106;

/** TikTok's error as a short line, the token never in it. */
export function errorLine(code: number | null | undefined, message: string | null | undefined, requestId?: string | null) {
  return `TikTok ${code ?? "?"}: ${(message ?? "no message").slice(0, 240)}${requestId ? ` (request ${requestId})` : ""}`;
}

// ─── Dates ─────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};

/** A date range cut into pieces of at most `max` days (TikTok's daily reports take 30 days per request). */
export function chunkRange(start: string, end: string, max = 30): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  if (!start || !end || start > end) return out;
  for (let s = start; s <= end; s = shiftDay(s, max)) {
    const e = shiftDay(s, max - 1);
    out.push({ start: s, end: e < end ? e : end });
  }
  return out;
}

/** "2026-11-08 00:00:00" (TikTok's stat_time_day) → "2026-11-08" */
export const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

// ─── Report rows → daily rows ──────────────────────────────────────────────

/** The metrics every daily pull asks for (campaign and ad level alike). */
export const REPORT_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "reach",
  "frequency",
  "conversion",
  "cost_per_conversion",
  "complete_payment",
  "complete_payment_roas",
  "total_complete_payment_rate",
  "value_per_complete_payment",
  "video_play_actions",
  "video_watched_2s",
  "video_watched_6s",
  "average_video_play",
] as const;
export const CAMPAIGN_ATTRS = ["campaign_name"] as const;
export const AD_ATTRS = ["campaign_id", "campaign_name", "adgroup_id", "adgroup_name", "ad_name"] as const;

/** One row of /report/integrated/get/: dimensions and metrics, every number a string ("-" when TikTok has none). */
export type ReportRow = { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> };

const num = (v: unknown) => {
  const n = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
  return Number.isFinite(n) ? n : 0;
};
const optNum = (v: unknown) => (v == null || v === "" || v === "-" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (v == null || v === "" || v === "-" ? null : String(v));

/**
 * Purchase value of a row: TikTok's total complete payment value when it reports it, else ROAS times spend, else value
 * per payment times payments. Never the optimization event's value: revenue is purchase value only, as on Meta.
 */
export function paymentValue(m: Record<string, unknown>): number {
  const total = optNum(m.total_complete_payment_rate);
  if (total != null && total > 0) return total;
  const roas = optNum(m.complete_payment_roas);
  if (roas != null && roas > 0) return Math.round(roas * num(m.spend) * 100) / 100;
  const per = optNum(m.value_per_complete_payment);
  if (per != null && per > 0) return Math.round(per * num(m.complete_payment) * 100) / 100;
  return 0;
}

/** The numbers both levels share */
function common(m: Record<string, unknown>) {
  const conversions = num(m.conversion);
  const purchases = num(m.complete_payment);
  const value = paymentValue(m);
  const plays = num(m.video_play_actions);
  const v2 = num(m.video_watched_2s);
  const v6 = num(m.video_watched_6s);
  return {
    spend: num(m.spend),
    impressions: Math.round(num(m.impressions)),
    clicks: Math.round(num(m.clicks)),
    conversions,
    conversion_value: value,
    purchases,
    video_plays: Math.round(plays),
    video_2s: Math.round(v2),
    video_6s: Math.round(v6),
    avg_play_seconds: optNum(m.average_video_play),
    reach: Math.round(num(m.reach)),
    frequency: optNum(m.frequency),
    // The same shape as Meta's and Google's days, so the KPI math reads TikTok without knowing it
    actions: { tiktok_conversion: conversions, tiktok_complete_payment: purchases, tiktok_video_play: plays, tiktok_video_2s: v2, tiktok_video_6s: v6 },
    action_values: { tiktok_complete_payment: value },
  };
}

/** A campaign-level report row as a tiktok_campaign_daily row (null when it has no campaign or day). */
export function campaignDayRow(account: string, r: ReportRow, at: string) {
  const d = r.dimensions ?? {};
  const m = r.metrics ?? {};
  const campaign = str(d.campaign_id);
  const date = dayOf(d.stat_time_day);
  if (!campaign || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const c = common(m);
  return { ad_account_id: account, campaign_id: campaign, date, campaign_name: str(m.campaign_name), ...c, link_clicks: c.clicks, unique_link_clicks: 0, raw: m, updated_at: at };
}

/** An ad-level report row as a tiktok_ad_daily row. */
export function adDayRow(account: string, r: ReportRow, at: string) {
  const d = r.dimensions ?? {};
  const m = r.metrics ?? {};
  const ad = str(d.ad_id);
  const date = dayOf(d.stat_time_day);
  if (!ad || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const c: Partial<ReturnType<typeof common>> = common(m);
  delete c.actions;
  delete c.action_values;
  return { ad_account_id: account, ad_id: ad, date, ad_name: str(m.ad_name), campaign_id: str(m.campaign_id), campaign_name: str(m.campaign_name), adgroup_id: str(m.adgroup_id), adgroup_name: str(m.adgroup_name), ...c, raw: m, updated_at: at };
}

// ─── The math ──────────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;

export type TikTokTotals = { spend: number; impressions: number; clicks: number; conversions: number; purchases: number; value: number; plays: number; v2: number; v6: number };

export function addUp(rows: { spend?: unknown; impressions?: unknown; clicks?: unknown; conversions?: unknown; purchases?: unknown; conversion_value?: unknown; video_plays?: unknown; video_2s?: unknown; video_6s?: unknown }[]): TikTokTotals {
  const t: TikTokTotals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchases: 0, value: 0, plays: 0, v2: 0, v6: 0 };
  for (const r of rows) {
    t.spend += num(r.spend);
    t.impressions += num(r.impressions);
    t.clicks += num(r.clicks);
    t.conversions += num(r.conversions);
    t.purchases += num(r.purchases);
    t.value += num(r.conversion_value);
    t.plays += num(r.video_plays);
    t.v2 += num(r.video_2s);
    t.v6 += num(r.video_6s);
  }
  return t;
}

/** Cost per result: null with no results (never infinity) */
export const cpa = (spend: number, results: number) => (results > 0 ? r2(spend / results) : null);
/** Purchase value over spend: null with no spend */
export const roasOf = (value: number, spend: number) => (spend > 0 ? r2(value / spend) : null);
export const ctrOf = (clicks: number, impressions: number) => (impressions > 0 ? r2((clicks / impressions) * 100) : null);
export const cpmOf = (spend: number, impressions: number) => (impressions > 0 ? r2((spend / impressions) * 1000) : null);
/**
 * Hook rate: the share of impressions that watched 6 seconds, as a percent (TikTok's own "6-second views" over
 * impressions, the number creative is judged on). hold2 is the 2-second version.
 */
export const hookRate = (v6: number, impressions: number) => (impressions > 0 ? r2((v6 / impressions) * 100) : null);
export const hold2Rate = (v2: number, impressions: number) => (impressions > 0 ? r2((v2 / impressions) * 100) : null);

/** Every number a TikTok summary shows, from totals */
export function summarize(t: TikTokTotals) {
  return {
    spend: r2(t.spend),
    impressions: Math.round(t.impressions),
    clicks: Math.round(t.clicks),
    conversions: Math.round(t.conversions * 10) / 10,
    purchases: Math.round(t.purchases * 10) / 10,
    value: r2(t.value),
    cpa: cpa(t.spend, t.conversions),
    costPerPurchase: cpa(t.spend, t.purchases),
    roas: roasOf(t.value, t.spend),
    ctr: ctrOf(t.clicks, t.impressions),
    cpm: cpmOf(t.spend, t.impressions),
    cpc: t.clicks > 0 ? r2(t.spend / t.clicks) : null,
    views6s: Math.round(t.v6),
    hookRate: hookRate(t.v6, t.impressions),
    hold2: hold2Rate(t.v2, t.impressions),
  };
}
export type TikTokSummary = ReturnType<typeof summarize>;

/** The summary as one line for the AI (client chat, Kaizen AI, the day recap) */
export function summaryLine(label: string, s: TikTokSummary, currency = "USD") {
  const m = (x: number | null) => (x == null ? "n/a" : `${currency === "USD" ? "$" : `${currency} `}${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  return `${label}: spend ${m(s.spend)}, ${s.conversions} conversions (CPA ${m(s.cpa)}), ${s.purchases} purchases${s.value ? ` worth ${m(s.value)} (ROAS ${s.roas ?? "n/a"}x)` : ""}, CTR ${s.ctr ?? "n/a"}%, CPM ${m(s.cpm)}, ${s.views6s.toLocaleString("en-US")} 6-second views (hook rate ${s.hookRate ?? "n/a"}%)`;
}

// ─── Linking advertisers to clients ────────────────────────────────────────

/** TikTok's advertiser status as a word a person reads */
export function statusWord(s: string | null | undefined) {
  const v = String(s ?? "").toUpperCase();
  if (!v) return "unknown";
  if (v.includes("ENABLE") || v === "ACTIVE") return "active";
  if (v.includes("DISABLE") || v.includes("PUNISH") || v.includes("LIMIT")) return "limited";
  if (v.includes("PENDING") || v.includes("CONFIRM") || v.includes("REVIEW")) return "in review";
  if (v.includes("DELETE") || v.includes("CLOSE")) return "closed";
  return v.replace(/^STATUS_/, "").toLowerCase().replace(/_/g, " ");
}
