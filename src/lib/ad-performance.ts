import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { completeDays } from "@/lib/kpi/calc";
import { MAIN_RESULTS, actionMap, conversionFor, reportedType } from "@/lib/kpi/conversions";
import { videoMetrics } from "@/lib/kpi/video";
import { videoLengths } from "@/lib/video-length";

// Each ad in a Meta account over its last 7 complete days, for the KPI card's Creative tab: spend and the KPI's result
// (counted the way the card counts it), CTR, and for video ads the hook rate and how much of the video people watch.

export type AdPerf = {
  id: string;
  name: string;
  thumbnail: string | null;
  spend: number;
  results: number;
  /** Cost per result, or ROAS on a ROAS card */
  value: number | null;
  ctr: number | null;
  hookRate: number | null;
  avgWatchSec: number | null;
  videoSeconds: number | null;
  watchPct: number | null;
};

const n = (v: unknown) => Number(v) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;

export async function adPerformance(db: SupabaseClient, admin: SupabaseClient | null, clientId: string, account: string, t: { conversion: string; custom_action: string | null }, limit = 12) {
  const w = completeDays(7, new Date());
  const acct = account.replace(/^act_/, "");
  type Row = { date: string; ad_id: string; ad_name: string | null; metrics: Record<string, unknown> };
  const rows: Row[] = [];
  for (let page = 0; page < 10; page++) {
    const { data } = await db.from("meta_ad_daily").select("date, ad_id, ad_name, metrics").eq("client_id", clientId).eq("ad_account_id", acct).gte("date", w.from).lte("date", w.to).order("date").order("ad_id").range(page * 1000, page * 1000 + 999);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const conv = conversionFor(t.conversion);
  const listed = conv.key === "custom" && t.custom_action ? [t.custom_action] : (conv.types ?? []).filter((x) => x !== "campaign_goal");
  const acts = rows.map((r) => ({ r, a: actionMap(r.metrics.actions), v: actionMap(r.metrics.action_values) }));
  const type = conv.field ? null : reportedType(acts.map((x) => x.a), listed.length ? listed : MAIN_RESULTS);
  const byAd = new Map<string, typeof acts>();
  for (const x of acts) byAd.set(x.r.ad_id, [...(byAd.get(x.r.ad_id) ?? []), x]);
  const top = [...byAd]
    .map(([id, list]) => ({ id, list, spend: list.reduce((s, x) => s + n(x.r.metrics.spend), 0) }))
    .filter((x) => x.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit);
  const videos = top.filter((x) => videoMetrics(x.list.map((y) => y.r.metrics)).plays > 0).map((x) => x.id);
  const [lengths, { data: snap }] = await Promise.all([
    admin ? videoLengths(admin, videos).catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
    db.from("meta_snapshots").select("ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const thumbs = new Map(((snap?.ads ?? []) as { id: string; image?: string | null; thumbnail?: string | null }[]).map((a) => [a.id, a.image ?? a.thumbnail ?? null]));
  const ads: AdPerf[] = top.map(({ id, list, spend }) => {
    const results = conv.field ? list.reduce((s, x) => s + n(x.r.metrics.inline_link_clicks), 0) : type ? list.reduce((s, x) => s + (x.a[type] ?? 0), 0) : 0;
    const revenue = type ? list.reduce((s, x) => s + (x.v[type] ?? 0), 0) : 0;
    const imp = list.reduce((s, x) => s + n(x.r.metrics.impressions), 0);
    const clicks = list.reduce((s, x) => s + n(x.r.metrics.inline_link_clicks), 0);
    const v = videoMetrics(list.map((x) => x.r.metrics), lengths.get(id) ?? null);
    return {
      id,
      name: list[list.length - 1].r.ad_name ?? id,
      thumbnail: thumbs.get(id) ?? null,
      spend: r2(spend),
      results: Math.round(results * 10) / 10,
      value: conv.roas ? (spend ? r2(revenue / spend) : null) : results ? r2(spend / results) : null,
      ctr: imp ? r2((clicks / imp) * 100) : null,
      hookRate: v.hookRate,
      avgWatchSec: v.avgWatchSec,
      videoSeconds: v.videoSeconds,
      watchPct: v.watchPct,
    };
  });
  return { ads, window: w, roas: Boolean(conv.roas), result: conv.label };
}
