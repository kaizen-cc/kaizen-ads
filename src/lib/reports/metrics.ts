import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickType, resultsOf, toDays, nyParts, type Day } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { accountRows, goalsFor } from "@/lib/kpi/sync";
import type { Diagnosis, Opportunity } from "./diagnose";

// A report's numbers, from the same daily rows the KPI board reads, with the campaigns left out of the KPI left out here
// too. On Meta, results are what each campaign is optimized for, read from the ad account (submit application, schedule,
// purchase…), so the report talks about the result the client is actually buying; campaigns run for reach or engagement
// count their spend but not as results. ROAS accounts, and accounts whose goals aren't known, keep the KPI's conversion. Weekly: the last 7 days against the 7 before, and
// the month so far against the same days last month. Monthly: last month against the month before.

export type Period = {
  label: string;
  start: string;
  end: string;
  days: number; // days with data in it
  spend: number;
  impressions: number;
  clicks: number; // link clicks
  ctr: number | null; // link clicks / impressions, %
  cpc: number | null;
  cpm: number | null;
  results: number;
  costPerResult: number | null;
  revenue: number;
  roas: number | null;
};

export type CampaignLine = { name: string; spend: number; results: number; costPerResult: number | null; roas: number | null; ctr: number | null };
export type TopAd = { id: string; name: string; campaign: string | null; spend: number; results: number; costPerResult: number | null; ctr: number | null; clicks: number; link: string | null; image: string | null };

export type ReportMetrics = {
  platform: "meta" | "google";
  kind: "weekly" | "monthly" | "custom";
  conversion: string; // "Leads", "Purchases"
  roasKpi: boolean;
  target: number | null;
  monthlyBudget: number | null;
  main: Period;
  compare: Period;
  mtd: Period | null; // weekly only
  mtdCompare: Period | null;
  campaigns: CampaignLine[];
  topAds: TopAd[];
  dataThrough: string | null;
  gaps: string[]; // days in the period with no data at all (a sync gap, or the account off)
  /** Each result the campaigns are optimized for, in the main period (when read from the ad account) */
  goals?: { label: string; spend: number; results: number; costPerResult: number | null }[];
  /** Where performance is weak and why (set when the report is drafted) */
  diagnosis?: Diagnosis;
  /** One other Kaizen service worth raising, when the timing and the numbers make it natural */
  opportunity?: Opportunity | null;
};

type Target = { id: string; client_id: string; platform: string; ad_account_id: string | null; conversion: string; custom_action: string | null; campaign_match: string | null; target: number | null; monthly_budget: number | null; excluded_campaigns?: string[] | null; campaign_results?: Record<string, string> | null };

// What a campaign can be optimized for that isn't a business result
const NOT_A_RESULT = /^(post_engagement|page_engagement|post_reaction|post_interaction|like|comment|onsite_conversion\.post_save|video_view|thruplay|link_click|landing_page_view|omni_landing_page_view|reach|impressions|photo_view)/;
// A goal's name as the thing counted, plural
const PLURAL: [RegExp, string][] = [
  [/application/i, "Applications"],
  [/schedul|appoint|book/i, "Bookings"],
  [/purchase|order|sale/i, "Purchases"],
  [/registration|sign.?up/i, "Registrations"],
  [/lead/i, "Leads"],
  [/contact|call/i, "Contacts"],
  [/message|conversation/i, "Conversations"],
  [/subscri/i, "Subscriptions"],
  [/trial/i, "Trials"],
];
const pluralOf = (label: string) => PLURAL.find(([re]) => re.test(label))?.[1] ?? `${label} results`;

const r2 = (x: number) => Math.round(x * 100) / 100;
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const prevMonth = (day: string) => shift(monthStart(day), -1);
const lastDay = (day: string) => {
  const d = new Date(`${monthStart(day)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;
const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

/** The periods a report covers, as of a day (the day it's written; data runs through the day before). Custom: the
 * dates asked for, against the same number of days just before them. */
export function periodsFor(kind: "weekly" | "monthly" | "custom", today: string, range?: { start: string; end: string }) {
  if (kind === "custom" && range) {
    const n = span(range.start, range.end);
    const cEnd = shift(range.start, -1);
    const cStart = shift(cEnd, -(n - 1));
    const sameMonth = range.start === monthStart(range.start) && range.end.slice(0, 7) === range.start.slice(0, 7);
    return {
      main: { start: range.start, end: range.end, label: sameMonth && range.end === lastDay(range.start) ? monthName(range.start) : sameMonth ? `${monthName(range.start)} 1 – ${fmt(range.end)}` : `${fmt(range.start)} – ${fmt(range.end)}` },
      compare: { start: cStart, end: cEnd, label: `${fmt(cStart)} – ${fmt(cEnd)}` },
      mtd: null,
      mtdCompare: null,
    };
  }
  const end = shift(today, -1);
  if (kind === "monthly") {
    const mEnd = monthStart(today) === today ? end : lastDay(prevMonth(today)); // last month
    const mStart = monthStart(mEnd);
    const pEnd = shift(mStart, -1);
    return { main: { start: mStart, end: mEnd, label: monthName(mStart) }, compare: { start: monthStart(pEnd), end: pEnd, label: monthName(pEnd) }, mtd: null, mtdCompare: null };
  }
  const start = shift(end, -6);
  const cEnd = shift(start, -1);
  const mStart = monthStart(end);
  const n = span(mStart, end);
  const lmStart = monthStart(prevMonth(mStart));
  const lmEnd = shift(lmStart, Math.min(n, span(lmStart, lastDay(lmStart))) - 1);
  return {
    main: { start, end, label: `${fmt(start)} – ${fmt(end)}` },
    compare: { start: shift(cEnd, -6), end: cEnd, label: `${fmt(shift(cEnd, -6))} – ${fmt(cEnd)}` },
    mtd: { start: mStart, end, label: `${monthName(mStart)} 1 – ${fmt(end)}` },
    mtdCompare: { start: lmStart, end: lmEnd, label: `${monthName(lmStart)} 1 – ${fmt(lmEnd)}` },
  };
}

type Row = Awaited<ReturnType<typeof accountRows>>[number] & { impressions?: number | string | null };

function period(rows: Row[], days: Day[], p: { start: string; end: string; label: string }, conv: ReturnType<typeof conversionFor>, type: string | null): Period {
  const inside = (d: string) => d >= p.start && d <= p.end;
  const ds = days.filter((d) => inside(d.date));
  let spend = 0;
  let results = 0;
  let revenue = 0;
  let clicks = 0;
  for (const d of ds) {
    spend += d.spend;
    results += resultsOf(d, conv, type);
    clicks += d.linkClicks ?? 0;
    if (type) revenue += d.values[type] ?? 0;
  }
  const impressions = rows.filter((r) => inside(r.date)).reduce((n, r) => n + (Number(r.impressions) || 0), 0);
  return {
    label: p.label,
    start: p.start,
    end: p.end,
    days: ds.length,
    spend: r2(spend),
    impressions,
    clicks,
    ctr: impressions ? r2((clicks / impressions) * 100) : null,
    cpc: clicks ? r2(spend / clicks) : null,
    cpm: impressions ? r2((spend / impressions) * 1000) : null,
    results: Math.round(results * 10) / 10,
    costPerResult: results ? r2(spend / results) : null,
    revenue: r2(revenue),
    roas: spend && revenue ? r2(revenue / spend) : null,
  };
}

/** Every number a report shows, for one KPI target, as of `today` (New York). */
export async function reportMetrics(admin: SupabaseClient, t: Target, kind: "weekly" | "monthly" | "custom", today = nyParts(new Date()).date, range?: { start: string; end: string }): Promise<ReportMetrics> {
  const platform = t.platform === "google" ? "google" : "meta";
  const left = new Set(t.excluded_campaigns ?? []);
  const all = ((await accountRows(admin, t.ad_account_id ?? "", platform)) as Row[]).filter((r) => (!t.campaign_match || (r.campaign_name ?? "").toLowerCase().includes(t.campaign_match.toLowerCase())) && !left.has(String(r.campaign_id)));
  const ps = periodsFor(kind, today, range);
  const kpiConv = conversionFor(t.conversion);

  // What each campaign is optimized for, read from the ad account (Meta). Reports count those, unless it's a ROAS KPI
  let goals: Map<string, string[]> | undefined;
  let labels = new Map<string, string>();
  if (platform === "meta" && !kpiConv.roas && t.ad_account_id) {
    const account = String(t.ad_account_id).replace(/^act_/, "");
    const [read, { data: named }] = await Promise.all([goalsFor(admin, account, platform, t.campaign_results), admin.from("campaign_goals").select("campaign_id, label").eq("ad_account_id", account)]);
    labels = new Map((named ?? []).map((g) => [String(g.campaign_id), String(g.label ?? "")]));
    const spent = new Set(all.filter((r) => r.date >= ps.main.start && r.date <= ps.main.end && Number(r.spend) > 0).map((r) => String(r.campaign_id)));
    const isResult = (types: string[]) => types.some((x) => !NOT_A_RESULT.test(x));
    // Campaigns run for reach or engagement don't count as results, when others in the period run for a real one
    const anyReal = [...read.entries()].some(([id, types]) => spent.has(id) && isResult(types));
    if (read.size && anyReal) goals = new Map([...read.entries()].map(([id, types]) => [id, isResult(types) ? types : []]));
    else if (read.size) goals = read;
  }
  // A KPI set to a custom event that was never picked can't count anything: each campaign's own result instead
  const useGoals = Boolean(goals) || (t.conversion === "custom" && !t.custom_action);
  const conv = useGoals ? conversionFor("campaign_goal") : kpiConv;
  const days = toDays(all, null, null, useGoals ? (goals ?? new Map()) : undefined, platform);
  const type = useGoals ? "campaign_goal" : pickType(days, conv, t.custom_action);
  const main = period(all, days, ps.main, conv, type);

  // Each goal's results in the main period, and the one most of the spend goes to (what the report talks about)
  const byGoal = new Map<string, Row[]>();
  if (useGoals)
    for (const r of all) {
      if (r.date < ps.main.start || r.date > ps.main.end) continue;
      const id = String(r.campaign_id);
      if (goals?.get(id)?.length === 0) continue;
      const label = labels.get(id) || "Result";
      byGoal.set(label, [...(byGoal.get(label) ?? []), r]);
    }
  const goalLines = [...byGoal.entries()]
    .map(([label, rows]) => {
      const p = period(rows, toDays(rows, null, null, goals ?? new Map(), platform), ps.main, conv, type);
      return { label, spend: p.spend, results: p.results, costPerResult: p.costPerResult };
    })
    .filter((g) => g.spend > 0 || g.results > 0)
    .sort((a, b) => b.spend - a.spend);
  const goalSpend = goalLines.reduce((n, g) => n + g.spend, 0);
  const lead = goalLines[0];
  const resultName = useGoals ? (lead && goalSpend && lead.spend / goalSpend >= 0.6 && lead.label !== "Result" ? pluralOf(lead.label) : "Results") : conversionLabel(t.conversion, t.custom_action);

  // Campaigns in the main period, biggest spend first
  const byCampaign = new Map<string, Row[]>();
  for (const r of all) if (r.date >= ps.main.start && r.date <= ps.main.end) byCampaign.set(r.campaign_name ?? r.campaign_id, [...(byCampaign.get(r.campaign_name ?? r.campaign_id) ?? []), r]);
  const campaigns: CampaignLine[] = [...byCampaign.entries()]
    .map(([name, rows]) => {
      const p = period(rows, toDays(rows, null, null, useGoals ? (goals ?? new Map()) : undefined, platform), ps.main, conv, type);
      return { name, spend: p.spend, results: p.results, costPerResult: p.costPerResult, roas: p.roas, ctr: p.ctr };
    })
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  // Top ads (Meta): the most results in the period, then the cheapest; with a preview link and image
  let topAds: TopAd[] = [];
  if (platform === "meta" && t.ad_account_id) {
    const { data: ads } = await admin
      .from("meta_ad_daily")
      .select("ad_id, ad_name, campaign_id, campaign_name, metrics")
      .eq("ad_account_id", String(t.ad_account_id).replace(/^act_/, ""))
      .gte("date", ps.main.start)
      .lte("date", ps.main.end)
      .limit(5000);
    const per = new Map<string, TopAd & { impressions: number }>();
    for (const a of ads ?? []) {
      if (t.campaign_match && !(a.campaign_name ?? "").toLowerCase().includes(t.campaign_match.toLowerCase())) continue;
      if (left.has(String(a.campaign_id))) continue;
      const m = a.metrics as { spend?: string; impressions?: string; inline_link_clicks?: string; actions?: { action_type: string; value: string }[] };
      const e = per.get(a.ad_id) ?? { id: a.ad_id, name: a.ad_name, campaign: a.campaign_name, spend: 0, results: 0, costPerResult: null, ctr: null, clicks: 0, link: null, image: null, impressions: 0 };
      e.spend += Number(m.spend) || 0;
      e.impressions += Number(m.impressions) || 0;
      e.clicks += Number(m.inline_link_clicks) || 0;
      const day: Day = { date: "", spend: 0, actions: Object.fromEntries((m.actions ?? []).map((x) => [x.action_type, Number(x.value) || 0])), values: {}, linkClicks: Number(m.inline_link_clicks) || 0 };
      if (useGoals) {
        // The ad counts its campaign's own result
        const own = goals?.get(String(a.campaign_id)) ?? [];
        const hit = own.find((x) => day.actions[x] != null);
        e.results += hit ? day.actions[hit] : 0;
      } else e.results += resultsOf(day, conv, type);
      per.set(a.ad_id, e);
    }
    const ranked = [...per.values()]
      .filter((a) => a.spend > 0)
      .map((a) => ({ ...a, spend: r2(a.spend), results: Math.round(a.results * 10) / 10, costPerResult: a.results ? r2(a.spend / a.results) : null, ctr: a.impressions ? r2((a.clicks / a.impressions) * 100) : null }))
      .sort((a, b) => b.results - a.results || (a.costPerResult ?? 1e9) - (b.costPerResult ?? 1e9) || b.clicks - a.clicks)
      .slice(0, kind === "monthly" ? 3 : 3);
    const { adPreviews } = await import("@/lib/context/meta");
    const previews = await adPreviews(ranked.map((a) => a.id)).catch(() => new Map());
    topAds = ranked.map(({ impressions: _i, ...a }) => ({ ...a, link: previews.get(a.id)?.link ?? null, image: previews.get(a.id)?.image ?? null }));
  }

  const dates = new Set(days.filter((d) => d.date >= ps.main.start && d.date <= ps.main.end).map((d) => d.date));
  const gaps: string[] = [];
  for (let d = ps.main.start; d <= ps.main.end; d = shift(d, 1)) if (!dates.has(d)) gaps.push(d);
  return {
    platform,
    kind,
    conversion: resultName,
    roasKpi: Boolean(conv.roas),
    target: t.target == null ? null : Number(t.target),
    monthlyBudget: t.monthly_budget == null || Number(t.monthly_budget) < 20 ? null : Number(t.monthly_budget),
    main,
    compare: period(all, days, ps.compare, conv, type),
    mtd: ps.mtd ? period(all, days, ps.mtd, conv, type) : null,
    mtdCompare: ps.mtdCompare ? period(all, days, ps.mtdCompare, conv, type) : null,
    campaigns,
    topAds,
    dataThrough: [...days].map((d) => d.date).sort().at(-1) ?? null,
    gaps,
    ...(useGoals && goalLines.length ? { goals: goalLines } : {}),
  };
}

/** The numbers as lines for the writer and the QA. */
export function metricsText(m: ReportMetrics) {
  const money = (x: number | null) => (x == null ? "—" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const line = (p: Period) =>
    `${p.label}: spend ${money(p.spend)}, ${p.results} ${m.conversion.toLowerCase()}, cost per result ${money(p.costPerResult)}${p.revenue ? `, revenue ${money(p.revenue)}, ROAS ${p.roas ?? "—"}` : ""}, impressions ${p.impressions.toLocaleString("en-US")}, link clicks ${p.clicks.toLocaleString("en-US")}, CTR ${p.ctr ?? "—"}%, CPC ${money(p.cpc)}, CPM ${money(p.cpm)} (${p.days} days with data)`;
  return [
    `Platform: ${m.platform === "google" ? "Google Ads" : "Meta Ads"}. KPI: ${m.conversion}${m.roasKpi ? " (judged on ROAS)" : ""}${m.target != null ? `, target ${m.roasKpi ? `${m.target}x ROAS` : money(m.target)}` : ", no target set"}${m.monthlyBudget ? `, monthly budget ${money(m.monthlyBudget)}` : ""}. Data through ${m.dataThrough ?? "?"}.`,
    line(m.main),
    line(m.compare),
    ...(m.mtd ? [line(m.mtd)] : []),
    ...(m.mtdCompare ? [line(m.mtdCompare)] : []),
    "Campaigns (main period, by spend):",
    ...m.campaigns.map((c) => `- ${c.name}: ${money(c.spend)}, ${c.results} results, ${money(c.costPerResult)} each${c.roas ? `, ROAS ${c.roas}` : ""}, CTR ${c.ctr ?? "—"}%`),
    ...(m.topAds.length ? ["Top ads (main period):", ...m.topAds.map((a, i) => `${i + 1}. ${a.name} (${a.campaign ?? "?"}): ${a.results} results at ${money(a.costPerResult)}, ${money(a.spend)} spent, ${a.clicks} link clicks, CTR ${a.ctr ?? "—"}%${a.link ? `, preview ${a.link}` : ""}`)] : []),
    ...(m.goals && m.goals.length > 1 ? ["Results by what the campaigns are optimized for (main period):", ...m.goals.map((g) => `- ${g.label}: ${g.results} at ${money(g.costPerResult)} each, ${money(g.spend)} spent`)] : m.goals?.length ? [`The campaigns are optimized for: ${m.goals[0].label}.`] : []),
    ...(m.gaps.length ? [`Days with no data in the main period: ${m.gaps.join(", ")}`] : []),
  ].join("\n");
}
