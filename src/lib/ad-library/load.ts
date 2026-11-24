import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { completeDays } from "@/lib/kpi/calc";
import { MAIN_RESULTS, actionMap, conversionFor, reportedType } from "@/lib/kpi/conversions";
import { daysSince, fatigueWhy, googleStatus, metaStatus, windowNumbers, type AdFormat, type AdPlatform, type AdRow, type DayTotals, type Range } from "./core";

// Every ad running in a client's ad accounts, for the client page's Ads tab and the assistant ("what ads are running
// for X"). Meta: the daily numbers we sync (meta_ad_daily) and the ad catalog (meta_ads: status, learning, creative),
// with fatigue as a flag on the ads that are tiring. TikTok: its daily ad numbers (tiktok_ad_daily). Google: read live
// from Google Ads for the window (nothing new is stored). Counted by the client's own KPI, like the KPI board.

const n = (v: unknown) => Number(v) || 0;

export type AdList = {
  platform: AdPlatform;
  window: { from: string; to: string; days: Range };
  ads: AdRow[];
  campaigns: { id: string; name: string }[];
  target: { value: number | null; roas: boolean; result: string } | null;
  note: string | null;
};

type Target = { id: string; ad_account_id: string; conversion: string; custom_action: string | null; target: number | null };

async function targetsOf(db: SupabaseClient, clientId: string, platform: AdPlatform): Promise<Target[]> {
  const { data } = await db.from("kpi_targets").select("id, ad_account_id, conversion, custom_action, target").eq("client_id", clientId).eq("platform", platform).eq("active", true).not("ad_account_id", "is", null);
  return (data ?? []) as Target[];
}

async function pages<T>(make: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadAds(db: SupabaseClient, clientId: string, platform: AdPlatform, days: Range, now = new Date()): Promise<AdList> {
  const w = completeDays(days, now);
  const window = { ...w, days };
  const targets = await targetsOf(db, clientId, platform);
  const t = targets[0] ?? null;
  if (platform === "meta") return loadMeta(db, clientId, targets, window, now);
  if (platform === "tiktok") return loadTikTok(db, targets, window, now);
  return loadGoogle(t, window);
}

async function loadMeta(db: SupabaseClient, clientId: string, targets: Target[], window: AdList["window"], now: Date): Promise<AdList> {
  const t = targets[0] ?? null;
  const conv = conversionFor(t?.conversion ?? "purchases");
  const accounts = [...new Set(targets.map((x) => x.ad_account_id.replace(/^act_/, "")))];
  type Row = { date: string; ad_id: string; ad_name: string | null; adset_id: string | null; adset_name: string | null; campaign_id: string | null; campaign_name: string | null; metrics: Record<string, unknown> };
  const [rows, { data: catalog }, { data: fatigue }] = await Promise.all([
    pages<Row>((a, b) => db.from("meta_ad_daily").select("date, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, metrics").eq("client_id", clientId).gte("date", window.from).lte("date", window.to).order("date").order("ad_id").range(a, b)),
    db.from("meta_ads").select("ad_id, name, effective_status, learning, campaign_id, campaign_name, adset_id, adset_name, format, headline, created_time, ad_account_id").eq("client_id", clientId).limit(3000),
    db.from("ad_fatigue").select("ad_id, severity, signals, state").eq("client_id", clientId).in("state", ["open", "refreshing"]),
  ]);
  const listed = conv.key === "custom" && t?.custom_action ? [t.custom_action] : (conv.types ?? []).filter((x) => x !== "campaign_goal");
  const parsed = rows.map((r) => ({ r, a: actionMap(r.metrics?.actions), v: actionMap(r.metrics?.action_values) }));
  const type = conv.field ? null : reportedType(parsed.map((p) => p.a), listed.length ? listed : MAIN_RESULTS);
  const byAd = new Map<string, { last: Row; days: DayTotals[] }>();
  for (const { r, a, v } of parsed) {
    const m = r.metrics ?? {};
    const cur = byAd.get(r.ad_id) ?? { last: r, days: [] };
    cur.last = r;
    cur.days.push({ spend: n(m.spend), results: conv.field ? n(m.inline_link_clicks) : type ? (a[type] ?? 0) : 0, value: type ? (v[type] ?? 0) : 0, impressions: n(m.impressions), clicks: n(m.inline_link_clicks), reach: n(m.reach) });
    byAd.set(r.ad_id, cur);
  }
  const cat = new Map(((catalog ?? []) as { ad_id: string; name: string; effective_status: string | null; learning: string | null; campaign_id: string | null; campaign_name: string | null; adset_id: string | null; adset_name: string | null; format: string | null; headline: string | null; created_time: string | null; ad_account_id: string }[]).filter((c) => !accounts.length || accounts.includes(c.ad_account_id)).map((c) => [c.ad_id, c]));
  const tired = new Map(((fatigue ?? []) as { ad_id: string; severity: "tiring" | "tired"; signals: Parameters<typeof fatigueWhy>[0] }[]).map((f) => [f.ad_id, f]));
  const ids = new Set([...byAd.keys(), ...cat.keys()]);
  const ads: AdRow[] = [];
  for (const id of ids) {
    const d = byAd.get(id);
    const c = cat.get(id);
    const nums = windowNumbers(d?.days ?? [], Boolean(conv.roas));
    const status = c ? metaStatus(c) : "ended";
    const f = tired.get(id);
    ads.push({
      id,
      platform: "meta",
      name: c?.name ?? d?.last.ad_name ?? id,
      campaignId: c?.campaign_id ?? d?.last.campaign_id ?? null,
      campaign: c?.campaign_name ?? d?.last.campaign_name ?? null,
      adsetId: c?.adset_id ?? d?.last.adset_id ?? null,
      adset: c?.adset_name ?? d?.last.adset_name ?? null,
      status,
      format: ((c?.format as AdFormat | null) ?? "image") as AdFormat,
      thumbnail: `/api/ad-media/${id}`,
      headline: c?.headline ?? null,
      ...nums,
      daysRunning: daysSince(c?.created_time ?? null, now),
      ranInWindow: nums.spend > 0,
      fatigue: f ? { severity: f.severity, why: fatigueWhy(f.signals) } : null,
    });
  }
  return finish("meta", window, ads, t, conv, catalog?.length ? null : "Ad statuses and creatives are read with the next Meta sync; until then ads show from their spend.");
}

async function loadTikTok(db: SupabaseClient, targets: Target[], window: AdList["window"], now: Date): Promise<AdList> {
  const t = targets[0] ?? null;
  const conv = conversionFor(t?.conversion ?? "tiktok_conversions");
  const accounts = [...new Set(targets.map((x) => x.ad_account_id))];
  if (!accounts.length) return finish("tiktok", window, [], t, conv, "No TikTok ad account is linked for this client.");
  type Row = { ad_id: string; ad_name: string | null; campaign_id: string | null; campaign_name: string | null; adgroup_id: string | null; adgroup_name: string | null; date: string; spend: number; impressions: number; clicks: number; conversions: number; conversion_value: number; purchases: number; reach: number; video_plays: number };
  const rows = await pages<Row>((a, b) => db.from("tiktok_ad_daily").select("ad_id, ad_name, campaign_id, campaign_name, adgroup_id, adgroup_name, date, spend, impressions, clicks, conversions, conversion_value, purchases, reach, video_plays").in("ad_account_id", accounts).gte("date", window.from).lte("date", window.to).order("date").range(a, b));
  const { data: first } = await db.from("tiktok_ad_daily").select("ad_id, date").in("ad_account_id", accounts).in("ad_id", [...new Set(rows.map((r) => r.ad_id))].slice(0, 300)).order("date").limit(3000);
  const started = new Map<string, string>();
  for (const f of first ?? []) if (!started.has(f.ad_id as string)) started.set(f.ad_id as string, f.date as string);
  const by = new Map<string, { last: Row; days: DayTotals[]; video: boolean }>();
  for (const r of rows) {
    const cur = by.get(r.ad_id) ?? { last: r, days: [], video: false };
    cur.last = r;
    cur.video = cur.video || n(r.video_plays) > 0;
    cur.days.push({ spend: n(r.spend), results: conv.key === "purchases" ? n(r.purchases) : n(r.conversions), value: n(r.conversion_value), impressions: n(r.impressions), clicks: n(r.clicks), reach: n(r.reach) });
    by.set(r.ad_id, cur);
  }
  const yesterday = window.to;
  const ads: AdRow[] = [...by].map(([id, d]) => {
    const nums = windowNumbers(d.days, Boolean(conv.roas));
    // TikTok's daily rows carry no delivery status: an ad that spent on the last complete day is treated as live
    const live = d.last.date >= yesterday && n(d.last.spend) > 0;
    return { id, platform: "tiktok", name: d.last.ad_name ?? id, campaignId: d.last.campaign_id, campaign: d.last.campaign_name, adsetId: d.last.adgroup_id, adset: d.last.adgroup_name, status: live ? "active" : "paused", format: d.video ? "video" : "image", thumbnail: null, headline: null, ...nums, daysRunning: daysSince(started.get(id) ? `${started.get(id)}T12:00:00Z` : null, now), ranInWindow: nums.spend > 0, fatigue: null };
  });
  return finish("tiktok", window, ads, t, conv, null);
}

async function loadGoogle(t: Target | null, window: AdList["window"]): Promise<AdList> {
  const conv = conversionFor(t?.conversion ?? "conversions");
  if (!t) return finish("google", window, [], t, conv, "No Google Ads account is linked for this client.");
  const { googleAdsConfigured, googleAdsRunning } = await import("@/lib/context/google-ads");
  if (!googleAdsConfigured()) return finish("google", window, [], t, conv, "Google Ads isn't connected to Kaizen OS yet.");
  let rows: Awaited<ReturnType<typeof googleAdsRunning>> = [];
  try {
    rows = await googleAdsRunning(t.ad_account_id, window.from, window.to);
  } catch (e) {
    return finish("google", window, [], t, conv, `Google Ads didn't answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ads: AdRow[] = rows.map((r) => {
    const nums = windowNumbers([{ spend: r.cost, results: conv.field ? r.clicks : r.conversions, value: r.value, impressions: r.impressions, clicks: r.clicks, reach: 0 }], Boolean(conv.roas));
    const format: AdFormat = /VIDEO/.test(r.type) ? "video" : /IMAGE|DISPLAY|DEMAND_GEN|DISCOVERY/.test(r.type) ? "image" : "text";
    return { id: r.id, platform: "google", name: r.name || r.headline || `${r.type.toLowerCase().replace(/_/g, " ")} ${r.id}`, campaignId: r.campaignId, campaign: r.campaign, adsetId: r.adGroupId, adset: r.adGroup, status: googleStatus({ ad: r.status, campaign: r.campaignStatus, approval: r.approval }), format, thumbnail: null, headline: r.headline, ...nums, frequency: null, daysRunning: null, ranInWindow: nums.spend > 0, fatigue: null };
  });
  return finish("google", window, ads, t, conv, null);
}

function finish(platform: AdPlatform, window: AdList["window"], ads: AdRow[], t: Target | null, conv: ReturnType<typeof conversionFor>, note: string | null): AdList {
  const campaigns = new Map<string, string>();
  for (const a of ads) if (a.campaignId) campaigns.set(a.campaignId, a.campaign ?? a.campaignId);
  return {
    platform,
    window,
    ads: ads.sort((a, b) => b.spend - a.spend),
    campaigns: [...campaigns].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    target: t ? { value: t.target == null ? null : Number(t.target), roas: Boolean(conv.roas), result: conv.label } : null,
    note,
  };
}

// ─── One ad, for the sheet ─────────────────────────────────────────────────

export type AdSheet = {
  series: { d: string; spend: number; results: number; cpr: number | null; ctr: number | null; freq: number | null }[];
  creative: { text: string | null; headline: string | null; image: string | null; video: string | null; poster: string | null; preview: string | null; cta: string | null; link: string | null } | null;
  managerUrl: string | null;
};

/** The ad's last 30 days day by day, its creative read live from Meta (Google and TikTok: the numbers), and Ads Manager */
export async function loadAdSheet(db: SupabaseClient, clientId: string, platform: AdPlatform, adId: string, now = new Date()): Promise<AdSheet> {
  const w = completeDays(30, now);
  const targets = await targetsOf(db, clientId, platform);
  const t = targets[0] ?? null;
  const conv = conversionFor(t?.conversion ?? (platform === "meta" ? "purchases" : platform === "tiktok" ? "tiktok_conversions" : "conversions"));
  const account = (t?.ad_account_id ?? "").replace(/^act_/, "");
  if (platform === "meta") {
    const { data: rows } = await db.from("meta_ad_daily").select("date, metrics").eq("client_id", clientId).eq("ad_id", adId).gte("date", w.from).lte("date", w.to).order("date");
    const parsed = (rows ?? []).map((r) => ({ d: r.date as string, m: (r.metrics ?? {}) as Record<string, unknown> }));
    const listed = conv.key === "custom" && t?.custom_action ? [t.custom_action] : (conv.types ?? []).filter((x) => x !== "campaign_goal");
    const type = conv.field ? null : reportedType(parsed.map((p) => actionMap(p.m.actions)), listed.length ? listed : MAIN_RESULTS);
    const series = parsed.map(({ d, m }) => {
      const a = actionMap(m.actions);
      const results = conv.field ? n(m.inline_link_clicks) : type ? (a[type] ?? 0) : 0;
      const value = type ? (actionMap(m.action_values)[type] ?? 0) : 0;
      const x = windowNumbers([{ spend: n(m.spend), results, value, impressions: n(m.impressions), clicks: n(m.inline_link_clicks), reach: n(m.reach) }], Boolean(conv.roas));
      return { d, spend: x.spend, results: x.results, cpr: x.cpr, ctr: x.ctr, freq: x.frequency };
    });
    let creative: AdSheet["creative"] = null;
    try {
      const { adDetail, withMetaAccount } = await import("@/lib/context/meta");
      const c = await withMetaAccount(account || null, () => adDetail(adId));
      creative = { text: c.text, headline: c.headline, image: c.image, video: c.video?.source ?? null, poster: c.video?.poster ?? null, preview: c.preview, cta: c.cta, link: c.link };
    } catch {
      const { data: cat } = await db.from("meta_ads").select("headline, body").eq("ad_id", adId).maybeSingle();
      creative = cat ? { text: (cat.body as string | null) ?? null, headline: (cat.headline as string | null) ?? null, image: `/api/ad-media/${adId}`, video: null, poster: null, preview: null, cta: null, link: null } : null;
    }
    return { series, creative, managerUrl: account ? `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account}&selected_ad_ids=${adId}` : null };
  }
  if (platform === "tiktok") {
    const { data: rows } = await db.from("tiktok_ad_daily").select("date, spend, impressions, clicks, conversions, conversion_value, purchases, reach").eq("ad_id", adId).gte("date", w.from).lte("date", w.to).order("date");
    const series = (rows ?? []).map((r) => {
      const x = windowNumbers([{ spend: n(r.spend), results: conv.key === "purchases" ? n(r.purchases) : n(r.conversions), value: n(r.conversion_value), impressions: n(r.impressions), clicks: n(r.clicks), reach: n(r.reach) }], Boolean(conv.roas));
      return { d: r.date as string, spend: x.spend, results: x.results, cpr: x.cpr, ctr: x.ctr, freq: x.frequency };
    });
    return { series, creative: null, managerUrl: account ? `https://ads.tiktok.com/i18n/perf/creative?aadvid=${account}` : null };
  }
  return { series: [], creative: null, managerUrl: account ? `https://ads.google.com/aw/ads?ocid=0&__c=${account.replace(/\D/g, "")}` : null };
}
