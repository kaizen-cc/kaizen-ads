import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregate, completeDays, pickType, type Day } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel, type Conversion } from "@/lib/kpi/conversions";
import { scopeRows, type KpiScope } from "@/lib/kpi/scope";
import { videoMetrics } from "@/lib/kpi/video";
import type { FatigueSignals } from "@/lib/fatigue";
import { gapsOf, rankCreatives, type AdInput, type CreativeAnalysis } from "@/lib/creative-analysis-core";

// The creative analysis for an audit, from the ad-level days already kept to the KPI's campaigns: each ad's numbers
// over the window, its angle, avatar, hook and offer from the client playbook (client_ledger), its video length, and
// what the fatigue watcher says about it. Ranked and compared by the pure functions in creative-analysis-core.

type Row = { date: string; ad_id: string; ad_name: string | null; campaign_id?: string | null; campaign_name?: string | null; metrics: Record<string, unknown> };
const DAY = 86_400_000;
const n = (v: unknown) => Number(v) || 0;
const acts = (v: unknown) => Object.fromEntries(((v ?? []) as { action_type: string; value: string }[]).map((a) => [a.action_type, n(a.value)]));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function analyzeCreative(
  admin: SupabaseClient,
  clientId: string,
  rows: Row[],
  o: { conv: Conversion; type: string | null; target: number | null; label: string; today: string; days?: number },
): Promise<CreativeAnalysis | null> {
  const days = o.days ?? 30;
  const from = new Date(Date.parse(o.today) - days * DAY).toISOString().slice(0, 10);
  const win = rows.filter((r) => r.date > from && r.date <= o.today);
  if (!win.length) return null;
  const byAd = new Map<string, Row[]>();
  for (const r of win) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  const firstSeen = new Map<string, string>();
  for (const r of rows) if (n(r.metrics.spend) > 0 && (!firstSeen.has(r.ad_id) || r.date < firstSeen.get(r.ad_id)!)) firstSeen.set(r.ad_id, r.date);
  const ids = [...byAd.keys()];

  const [{ data: ledger }, { data: fatigue }, { data: angles }, lengths] = await Promise.all([
    admin.from("client_ledger").select("key, title, detail").eq("client_id", clientId).eq("kind", "creative").in("key", ids.slice(0, 900)),
    admin.from("ad_fatigue").select("ad_id, ad_name, severity, signals").eq("client_id", clientId).in("state", ["open", "refreshing"]).limit(60),
    admin.from("angles").select("name, kind").eq("client_id", clientId).eq("status", "active"),
    import("@/lib/video-length").then(({ videoLengths }) => videoLengths(admin, ids.slice(0, 200))).catch(() => new Map<string, number>()),
  ]);
  type Detail = { headline?: string; format?: string; angle?: string; avatar?: string; hook?: string; offer?: string };
  const detail = new Map((ledger ?? []).map((l) => [l.key as string, { title: l.title as string, ...((l.detail ?? {}) as Detail) }]));
  // Only the tiring ads in the KPI's campaigns
  const tiring = new Map((fatigue ?? []).filter((f) => byAd.has(f.ad_id as string)).map((f) => [f.ad_id as string, f]));

  const input: AdInput[] = [...byAd].map(([id, list]) => {
    const d: Day[] = list.map((r) => ({ date: r.date, spend: n(r.metrics.spend), actions: acts(r.metrics.actions), values: acts(r.metrics.action_values), linkClicks: n(r.metrics.inline_link_clicks) }));
    const agg = aggregate(d, o.conv, o.type);
    const revenue = o.type ? d.reduce((s, x) => s + (x.values[o.type!] ?? 0), 0) : 0;
    const impressions = list.reduce((s, r) => s + n(r.metrics.impressions), 0);
    const clicks = list.reduce((s, r) => s + n(r.metrics.inline_link_clicks), 0);
    const plays = list.reduce((s, r) => s + n(((r.metrics.video_play_actions ?? []) as { value: string }[])[0]?.value), 0);
    const v = videoMetrics(list.map((r) => r.metrics), lengths.get(id) ?? null);
    const x = detail.get(id);
    const f = tiring.get(id);
    return {
      id,
      name: list[list.length - 1].ad_name ?? id,
      headline: x?.headline ?? null,
      format: x?.format ?? (plays > 0 ? "video" : null),
      angle: x?.angle ?? null,
      avatar: x?.avatar ?? null,
      hook: x?.hook ?? null,
      offer: x?.offer ?? null,
      videoSeconds: v.videoSeconds,
      spend: agg.spend,
      results: agg.results,
      revenue,
      ctr: pct(clicks, impressions),
      hookRate: plays ? v.hookRate : null,
      // ThruPlays per 3-second view, as Meta defines hold (not per play start)
      holdRate: plays ? v.holdRate : null,
      watchPct: v.watchPct,
      age: Math.round((Date.parse(o.today) - Date.parse(firstSeen.get(id) ?? o.today)) / DAY),
      fatigue: f ? (f.severity as "tiring" | "tired") : null,
    };
  });
  const ranked = rankCreatives(input, { roas: Boolean(o.conv.roas), target: o.target, label: o.label, days });
  const known = { angles: (angles ?? []).filter((a) => a.kind !== "avatar").map((a) => a.name as string), avatars: (angles ?? []).filter((a) => a.kind === "avatar").map((a) => a.name as string) };
  return {
    ...ranked,
    fatiguing: [...tiring.values()].map((f) => {
      const s = (f.signals ?? {}) as Partial<FatigueSignals>;
      const p = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
      const note = [
        s.ctrChange != null && s.ctrChange <= -0.1 ? `CTR down ${p(s.ctrChange)}` : "",
        s.cprChange != null && s.cprChange >= 0.1 ? `cost per result up ${p(s.cprChange)}` : "",
        s.hookChange != null && s.hookChange <= -0.1 ? `hook rate down ${p(s.hookChange)}` : "",
        s.freqNow ? `frequency ${s.freqNow}` : "",
        s.daysRunning ? `running ${s.daysRunning} days` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return { id: f.ad_id as string, name: f.ad_name as string, thumb: `/api/ad-media/${f.ad_id}`, severity: f.severity as "tiring" | "tired", note };
    }),
    gaps: gapsOf(input, known),
  };
}

/** The analysis for one KPI target on its own (the business audit): reads the target's last 30 days of ads */
export async function creativeAnalysisForTarget(admin: SupabaseClient, targetId: string): Promise<CreativeAnalysis | null> {
  const { data: t } = await admin.from("kpi_targets").select("client_id, platform, ad_account_id, conversion, custom_action, campaign_match, excluded_campaigns, target").eq("id", targetId).maybeSingle();
  if (!t?.ad_account_id || t.platform !== "meta") return null;
  const account = String(t.ad_account_id).replace(/^act_/, "");
  const since = new Date(Date.now() - 75 * DAY).toISOString().slice(0, 10);
  const rows: Row[] = [];
  for (let page = 0; page < 30; page++) {
    const { data } = await admin.from("meta_ad_daily").select("date, ad_id, ad_name, campaign_id, campaign_name, metrics").eq("client_id", t.client_id).eq("ad_account_id", account).gte("date", since).order("date").range(page * 1000, page * 1000 + 999);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const scoped = scopeRows(rows, t as KpiScope);
  if (!scoped.length) return null;
  const conv = conversionFor(t.conversion);
  const type = pickType(scoped.map((r) => ({ date: r.date, spend: n(r.metrics.spend), actions: acts(r.metrics.actions), values: acts(r.metrics.action_values) })), conv, t.custom_action);
  const yesterday = completeDays(1, new Date()).to;
  const last = scoped[scoped.length - 1].date;
  return analyzeCreative(admin, t.client_id as string, scoped, { conv, type, target: t.target == null ? null : Number(t.target), label: conversionLabel(t.conversion, t.custom_action).toLowerCase(), today: last < yesterday ? last : yesterday });
}
