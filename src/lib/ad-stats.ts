import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metrics } from "@/lib/chat-change-core";
import { completeDays } from "@/lib/kpi/calc";
import { MAIN_RESULTS, actionMap, conversionFor, reportedType } from "@/lib/kpi/conversions";

// Each ad's, ad set's and campaign's last 7 and 30 days from our Meta sync, counted by the account's own KPI. One place
// for it: the chat's change plans and the sprint/audit change plans read the same numbers, so a plan card never quotes a
// number the KPI board wouldn't. Complete days only (ending yesterday), like Ads Manager's "last 7 days"; one result type
// for the whole account and period, so a purchase is never counted twice under its aliases.

export type StatsTarget = { conversion: string; custom_action: string | null; target: number | null } | null;

export async function targetOf(admin: SupabaseClient, targetId: string | null): Promise<StatsTarget> {
  if (!targetId) return null;
  const { data } = await admin.from("kpi_targets").select("conversion, custom_action, target").eq("id", targetId).maybeSingle();
  return data ? { conversion: data.conversion as string, custom_action: (data.custom_action as string | null) ?? null, target: data.target == null ? null : Number(data.target) } : null;
}

const n = (v: unknown) => Number(v) || 0;
const r2 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

type Row = { date: string; ad_id: string; adset_id: string | null; campaign_id: string | null; metrics: Record<string, unknown> };

export async function adStats(admin: SupabaseClient, account: string, t: StatsTarget, now = new Date()) {
  const d30 = completeDays(30, now);
  const d7 = completeDays(7, now);
  // Paged: the API returns at most 1000 rows a request, and a busy account has thousands of ad-days in 30
  const rows: Row[] = [];
  for (let page = 0; page < 40; page++) {
    const { data } = await admin
      .from("meta_ad_daily")
      .select("date, ad_id, adset_id, campaign_id, metrics")
      .in("ad_account_id", [account, `act_${account}`])
      .gte("date", d30.from)
      .lte("date", d30.to)
      .order("date")
      .order("ad_id")
      .range(page * 1000, page * 1000 + 999);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const conv = conversionFor(t?.conversion ?? "purchases");
  const parsed = rows.map((r) => ({ r, acts: actionMap(r.metrics?.actions), vals: actionMap(r.metrics?.action_values) }));
  // The KPI's own types; "each campaign's goal" and unknown KPIs fall back to the account's strongest result
  const listed = conv.key === "custom" && t?.custom_action ? [t.custom_action] : (conv.types ?? []).filter((x) => x !== "campaign_goal");
  const type = conv.field ? null : reportedType(parsed.map((p) => p.acts), listed.length ? listed : MAIN_RESULTS);
  type Acc = { spend: number; results: number; value: number; imp: number; clicks: number; reach: number };
  const blank = (): Acc => ({ spend: 0, results: 0, value: 0, imp: 0, clicks: 0, reach: 0 });
  const by = { d7: new Map<string, Acc>(), d30: new Map<string, Acc>() };
  for (const { r, acts, vals } of parsed) {
    const m = r.metrics ?? {};
    const add = (map: Map<string, Acc>, key: string | null) => {
      if (!key) return;
      const a = map.get(key) ?? blank();
      a.spend += n(m.spend);
      a.results += conv.field ? n(m.inline_link_clicks) : type ? (acts[type] ?? 0) : 0;
      a.value += type ? (vals[type] ?? 0) : 0;
      a.imp += n(m.impressions);
      a.clicks += n(m.inline_link_clicks);
      a.reach += n(m.reach);
      map.set(key, a);
    };
    for (const k of [r.ad_id, r.adset_id, r.campaign_id]) {
      add(by.d30, k);
      if (r.date >= d7.from) add(by.d7, k);
    }
  }
  const metrics = (a: Acc | undefined): Metrics | null =>
    a ? { spend: r2(a.spend) ?? 0, results: Math.round(a.results * 10) / 10, cpr: conv.roas ? r2(a.spend ? a.value / a.spend : null) : r2(a.results ? a.spend / a.results : null), ctr: r2(a.imp ? (a.clicks / a.imp) * 100 : null), freq: r2(a.reach ? a.imp / a.reach : null) } : null;
  return { of: (id: string) => ({ m7: metrics(by.d7.get(id)), m30: metrics(by.d30.get(id)) }), result: conv.label, roas: Boolean(conv.roas), d7, d30 };
}

export type AdStats = Awaited<ReturnType<typeof adStats>>;

export const statsText = (m: Metrics | null, roas: boolean) => (m ? `$${m.spend} spent, ${m.results} results, ${roas ? "ROAS" : "cost per result"} ${m.cpr ?? "–"}, CTR ${m.ctr ?? "–"}%, frequency ${m.freq ?? "–"}` : "no spend");

/** "Oct 28 to Nov 3": the dates a window covers, so a quoted number says when it's from. */
export const windowLabel = (w: { from: string; to: string }) => {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(w.from)} to ${f(w.to)}`;
};
