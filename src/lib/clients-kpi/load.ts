import "server-only";
import { unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOARD_KPIS_TAG } from "@/lib/board-kpis-cache";
import { loadChannelBoard } from "@/lib/channel-kpis/load";
import { atRiskClients, RISK_DAYS, RISK_PREFIX } from "@/lib/client-risk";
import { campaignIncluded, nyParts, shownStatus, toDays, resultsOf, pickType, type Agg, type Status, type Trend } from "@/lib/kpi/calc";
import { conversionFor } from "@/lib/kpi/conversions";
import { dailyTable } from "@/lib/kpi/platform";
import { servicesOf } from "@/lib/services";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { adChip, adReasons, creativeChip, emailReasons, scoreChip, socialReasons, worstChip, type DayNumbers, type LineKpi } from "./core";

// What the Clients list shows under each card, for every client in one go: the KPI of each line (the boards' own
// numbers and status), and the reasons behind it from stored data. One batched query per table for all clients, never
// per card; the result is shared and kept three minutes with the Board's KPI tabs (BOARD_KPIS_TAG), so opening the
// list is instant and a dismissal or an error check refreshes it. The email and social numbers come from the boards'
// own loader (loadChannelBoard), so they're the same numbers.

export type ClientKpis = { kpis: LineKpi[]; atRisk: boolean };
export type AllClientKpis = Record<string, ClientKpis>;

type TargetRow = { id: string; client_id: string; platform: string; ad_account_id: string | null; conversion: string; custom_action: string | null; campaign_match: string | null; excluded_campaigns: string[] | null; target: number | string | null };
type SnapRow = { target_id: string; status: Status | null; deviation: number | string | null; vs_month: number | string | null; trend: Trend | null; windows: Partial<Record<string, Agg>> | null; budget: { status?: string; pace?: number } | null };
type DailyRow = { ad_account_id: string; campaign_id: string; campaign_name: string | null; date: string; spend: number | string; impressions: number | string; link_clicks: number | string; unique_link_clicks: number | string; actions: Record<string, number>; action_values: Record<string, number> };

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A KPI's campaigns' rows as per-campaign, per-day numbers with the KPI's own result counted */
function dayNumbers(t: TargetRow, rows: DailyRow[]): DayNumbers[] {
  const conv = conversionFor(t.conversion);
  const scope = { campaign_match: t.campaign_match, excluded_campaigns: t.excluded_campaigns };
  const mine = rows.filter((r) => campaignIncluded(scope, { id: r.campaign_id, name: r.campaign_name }));
  const type = pickType(toDays(mine, null, null, undefined, t.platform), conv, t.custom_action);
  const out: DayNumbers[] = [];
  for (const r of mine) {
    const d = toDays([r], null, null, undefined, t.platform)[0];
    if (!d) continue;
    out.push({ date: r.date, campaign: r.campaign_name ?? r.campaign_id, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, linkClicks: Number(r.link_clicks) || 0, results: resultsOf(d, conv, type) });
  }
  return out;
}

/** Every client's line chips and risk flag, read with the server's rights (callers filter to what a person may see) */
export async function loadAllClientKpis(admin: SupabaseClient): Promise<AllClientKpis> {
  const out: AllClientKpis = {};
  const slot = (id: string) => (out[id] ??= { kpis: [], atRisk: false });
  const today = nyParts(new Date()).date;
  const since = shift(today, -29);
  const me = { id: "", role: "", isExec: false, isLead: false };

  const [targetsRes, snapsRes, auditsRes, fatigueRes, riskRes, email, social] = await Promise.all([
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, excluded_campaigns, target, clients!inner(archived_at, services, services_extra, services_removed, strategy_only)").eq("active", true).is("clients.archived_at", null),
    admin.from("kpi_snapshots").select("target_id, status, deviation, vs_month, trend, windows, budget"),
    // The latest finished audit per account: its verdict's headline is the one reason an agent already wrote
    admin.from("account_audits").select("target_id, created_at, verdict:result->verdict").eq("status", "ready").order("created_at", { ascending: false }).limit(800),
    admin.from("ad_fatigue").select("client_id").eq("state", "open").eq("severity", "tired"),
    admin.from("client_memory").select("client_id, body, created_at").eq("status", "active").like("body", `${RISK_PREFIX} (said%`).gte("created_at", new Date(Date.now() - RISK_DAYS * 86_400_000).toISOString()).limit(300),
    loadChannelBoard(admin, "email", me, null).catch(() => null),
    loadChannelBoard(admin, "social", me, null).catch(() => null),
  ]);

  // Only lines the client actually buys: a leftover TikTok or Google target on a client without that service shows nothing
  const SERVICE_OF = { meta: "facebook-ads", google: "google-ads", tiktok: "tiktok-ads" } as const;
  const buys = (t: TargetRow) => {
    const c = (t as unknown as { clients?: { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null } | null }).clients;
    return servicesOf(c ?? {}).includes(SERVICE_OF[t.platform as keyof typeof SERVICE_OF]);
  };
  const targets = ((targetsRes.data ?? []) as unknown as TargetRow[]).filter((t) => (t.platform === "meta" || t.platform === "google" || t.platform === "tiktok") && buys(t));
  const snapBy = new Map(((snapsRes.data ?? []) as unknown as SnapRow[]).map((s) => [s.target_id, s]));
  const auditBy = new Map<string, { headline: string; status: string }>();
  for (const a of (auditsRes.data ?? []) as unknown as { target_id: string; verdict: { status?: string; headline?: string } | null }[]) {
    if (!auditBy.has(a.target_id) && a.verdict?.headline) auditBy.set(a.target_id, { headline: String(a.verdict.headline), status: String(a.verdict.status ?? "") });
  }
  const tired = new Map<string, number>();
  for (const f of (fatigueRes.data ?? []) as { client_id: string }[]) tired.set(f.client_id, (tired.get(f.client_id) ?? 0) + 1);
  for (const id of atRiskClients((riskRes.data ?? []) as { client_id: string; body: string; created_at: string }[])) slot(id).atRisk = true;

  // The synced days, only for the accounts that aren't on target (the others need no "why"): one query per platform
  const judged = (t: TargetRow) => shownStatus(snapBy.get(t.id)?.status, t.target);
  const down = targets.filter((t) => t.ad_account_id && ["off", "close"].includes(judged(t)));
  const daysBy = new Map<string, DailyRow[]>();
  for (const platform of ["meta", "google", "tiktok"] as const) {
    const ids = [...new Set(down.filter((t) => t.platform === platform).map((t) => t.ad_account_id as string))];
    if (!ids.length) continue;
    const rows = await readAll<DailyRow>((a, b) =>
      admin.from(dailyTable(platform)).select("ad_account_id, campaign_id, campaign_name, date, spend, impressions, link_clicks, unique_link_clicks, actions, action_values").in("ad_account_id", ids).gte("date", since).order("ad_account_id").order("campaign_id").order("date").range(a, b),
    ).catch(() => [] as DailyRow[]);
    for (const r of rows) {
      const k = `${platform}:${r.ad_account_id}`;
      (daysBy.get(k) ?? daysBy.set(k, []).get(k)!).push(r);
    }
  }

  // Ads: one chip per platform per client, the worst account when there are several
  const chips = new Map<string, LineKpi[]>();
  for (const t of targets) {
    const snap = snapBy.get(t.id);
    const status = judged(t);
    const conv = conversionFor(t.conversion);
    const target = num(t.target);
    const d14 = (snap?.windows?.d14 ?? null) as Agg | null;
    const deviation = num(snap?.deviation);
    const days = t.ad_account_id ? dayNumbers(t, daysBy.get(`${t.platform}:${t.ad_account_id}`) ?? []) : [];
    const reasons = adReasons({ status, deviation, trend: snap?.trend ?? null, vsMonth: num(snap?.vs_month), budget: snap?.budget ?? null, roas: Boolean(conv.roas), audit: auditBy.get(t.id) ?? null, tiredAds: t.platform === "meta" ? (tired.get(t.client_id) ?? 0) : 0, days, today });
    const chip: LineKpi = {
      ...adChip({ line: t.platform as "meta" | "google" | "tiktok", conversion: t.conversion, roas: Boolean(conv.roas), target, status, deviation, d14, href: `/kpis?target=${t.id}`, reasons }),
      // For the executive summary and business size: the tracked value, where the account is heading, its budget pace
      revenue: d14?.revenue ?? null,
      trend: snap?.trend ?? null,
      // A budget under $20 a month is a typo (a "k" lost from the sheet), not a budget: no pace from it
      pace: Number((snap?.budget as { budget?: number } | null)?.budget ?? 0) >= 20 ? (snap?.budget?.pace ?? null) : null,
    };
    const k = `${t.client_id}:${t.platform}`;
    (chips.get(k) ?? chips.set(k, []).get(k)!).push(chip);
  }
  for (const [k, list] of chips) {
    const [clientId] = k.split(":");
    const w = worstChip(list);
    // The worst account is shown, but the line's money is every account's (a client's size counts all of it)
    if (w) slot(clientId).kpis.push({ ...w, spend: list.some((x) => x.spend != null) ? list.reduce((s, x) => s + (x.spend ?? 0), 0) : null, revenue: list.reduce((s, x) => s + (x.revenue ?? 0), 0) || null });
  }

  // Email and social: the boards' own rows (score, band and checks)
  for (const r of email?.rows ?? []) {
    const href = `/kpis?p=email&open=${r.clientId}`;
    const s = r.score;
    // Email's money: last month's attributed revenue scaled to 14 days (this month so far when there's no last month),
    // and the month's pace against its target
    const goal = r.revenueTarget?.target ?? r.target ?? null;
    const extra = {
      revenue: r.revenueMeasured === false ? null : r.prev != null ? (r.prev * 14) / 30 : (r.value ?? null),
      trend: r.projected != null && r.prev ? (r.projected >= r.prev * 1.05 ? "improving" : r.projected <= r.prev * 0.95 ? "slipping" : "steady") : null,
      pace: r.projected != null && goal && goal >= 50 ? Math.round((r.projected / goal) * 100) / 100 : null,
    } as const;
    slot(r.clientId).kpis.push({
      ...extra,
      ...scoreChip({
        line: "email",
        score: s ? s.score : null,
        band: s ? s.band : null,
        reasons: s ? emailReasons(s, r.currency) : r.problem ? [{ tone: "info", text: r.problem.message }] : [],
        href,
        note: r.data === "missing" ? "Email · not connected" : r.data === "failing" ? "Email · data failing" : "Email · not read yet",
      }),
    });
  }
  for (const r of social?.rows ?? []) {
    const href = `/kpis?p=social&open=${r.clientId}`;
    const s = r.socialScore ?? null;
    slot(r.clientId).kpis.push(
      scoreChip({
        line: "social",
        score: s ? s.score : null,
        band: s ? s.band : null,
        reasons: s ? socialReasons(s) : r.problem ? [{ tone: "info", text: r.problem.message }] : [],
        href,
        note: r.data === "missing" ? "Social · not linked" : r.data === "failing" ? "Social · data failing" : "Social · not read yet",
      }),
    );
  }
  await creativeChips(admin, slot, today).catch((e) => console.error("[clients kpi] creative", e instanceof Error ? e.message : e));
  return out;
}

/**
 * The Creative chip for every client that buys creative: this cycle's allotment delivered against the pace it needs by
 * today (the same usage the client page header and the Head of Creative's pace read), the oldest open request and the
 * last delivery. One query per table for every client.
 */
async function creativeChips(admin: SupabaseClient, slot: (id: string) => ClientKpis, today: string) {
  const [clientsRes, usageRes, openRes, doneRes] = await Promise.all([
    admin.from("clients").select("id, slug, services, services_extra, services_removed, strategy_only").is("archived_at", null),
    admin.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used, period_start, period_end"),
    admin.from("requests").select("client_id, created_at").neq("stage", "launched").is("completed_at", null).is("deleted_at", null).order("created_at", { ascending: true }).limit(3000),
    admin.from("requests").select("client_id, completed_at").not("completed_at", "is", null).is("deleted_at", null).gte("completed_at", new Date(Date.now() - 120 * 86_400_000).toISOString()).order("completed_at", { ascending: false }).limit(3000),
  ]);
  const usage = new Map(((usageRes.data ?? []) as { client_id: string; images_per_month: number | null; videos_per_month: number | null; images_used: number | null; videos_used: number | null; period_start: string | null; period_end: string | null }[]).map((u) => [u.client_id, u]));
  const oldest = new Map<string, string>();
  for (const r of (openRes.data ?? []) as { client_id: string; created_at: string }[]) if (!oldest.has(r.client_id)) oldest.set(r.client_id, r.created_at);
  const last = new Map<string, string>();
  for (const r of (doneRes.data ?? []) as { client_id: string; completed_at: string }[]) if (!last.has(r.client_id)) last.set(r.client_id, r.completed_at);
  const nyDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const c of (clientsRes.data ?? []) as { id: string; slug: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null }[]) {
    if (!servicesOf(c).includes("creative")) continue;
    const u = usage.get(c.id);
    if (!u) continue;
    const opened = oldest.get(c.id);
    const chip = creativeChip({
      images: { cap: u.images_per_month, used: Number(u.images_used) || 0 },
      videos: { cap: u.videos_per_month, used: Number(u.videos_used) || 0 },
      cycle: u.period_start && u.period_end ? { start: u.period_start, end: u.period_end } : null,
      today,
      oldestOpenDays: opened ? Math.max(0, Math.floor((Date.now() - Date.parse(opened)) / 86_400_000)) : null,
      lastDelivered: last.has(c.id) ? nyDay(last.get(c.id)!) : null,
      href: `/clients/${c.slug}?service=creative`,
    });
    if (chip) slot(c.id).kpis.push(chip);
  }
}

/** Shared for every viewer and kept three minutes with the Board's KPI tabs (cleared with them) */
export const cachedClientKpis = unstable_cache(
  async (): Promise<AllClientKpis> => (adminConfigured() ? loadAllClientKpis(createAdminClient()) : {}),
  ["clients-list-kpis"],
  { revalidate: 180, tags: [BOARD_KPIS_TAG] },
);
