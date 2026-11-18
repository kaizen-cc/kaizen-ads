import "server-only";
import { unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOARD_KPIS_TAG } from "@/lib/board-kpis-cache";
import { loadChannelBoard } from "@/lib/channel-kpis/load";
import { atRiskClients, RISK_DAYS, RISK_PREFIX } from "@/lib/client-risk";
import { campaignIncluded, nyParts, shownStatus, toDays, resultsOf, pickType, type Agg, type Status, type Trend } from "@/lib/kpi/calc";
import { conversionFor } from "@/lib/kpi/conversions";
import { dailyTable } from "@/lib/kpi/platform";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { adChip, adReasons, emailReasons, scoreChip, socialReasons, worstChip, type DayNumbers, type LineKpi } from "./core";

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
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, excluded_campaigns, target, clients!inner(archived_at)").eq("active", true).is("clients.archived_at", null),
    admin.from("kpi_snapshots").select("target_id, status, deviation, vs_month, trend, windows, budget"),
    // The latest finished audit per account: its verdict's headline is the one reason an agent already wrote
    admin.from("account_audits").select("target_id, created_at, verdict:result->verdict").eq("status", "ready").order("created_at", { ascending: false }).limit(800),
    admin.from("ad_fatigue").select("client_id").eq("state", "open").eq("severity", "tired"),
    admin.from("client_memory").select("client_id, body, created_at").eq("status", "active").like("body", `${RISK_PREFIX} (said%`).gte("created_at", new Date(Date.now() - RISK_DAYS * 86_400_000).toISOString()).limit(300),
    loadChannelBoard(admin, "email", me, null).catch(() => null),
    loadChannelBoard(admin, "social", me, null).catch(() => null),
  ]);

  const targets = ((targetsRes.data ?? []) as unknown as TargetRow[]).filter((t) => t.platform === "meta" || t.platform === "google" || t.platform === "tiktok");
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
    const chip = adChip({ line: t.platform as "meta" | "google" | "tiktok", conversion: t.conversion, roas: Boolean(conv.roas), target, status, deviation, d14, href: `/kpis?target=${t.id}`, reasons });
    const k = `${t.client_id}:${t.platform}`;
    (chips.get(k) ?? chips.set(k, []).get(k)!).push(chip);
  }
  for (const [k, list] of chips) {
    const [clientId] = k.split(":");
    const w = worstChip(list);
    if (w) slot(clientId).kpis.push(w);
  }

  // Email and social: the boards' own rows (score, band and checks)
  for (const r of email?.rows ?? []) {
    const href = `/kpis?p=email&open=${r.clientId}`;
    const s = r.score;
    slot(r.clientId).kpis.push(
      scoreChip({
        line: "email",
        score: s ? s.score : null,
        band: s ? s.band : null,
        reasons: s ? emailReasons(s, r.currency) : r.problem ? [{ tone: "info", text: r.problem.message }] : [],
        href,
        note: r.data === "missing" ? "Email · not connected" : r.data === "failing" ? "Email · data failing" : "Email · not read yet",
      }),
    );
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
  return out;
}

/** Shared for every viewer and kept three minutes with the Board's KPI tabs (cleared with them) */
export const cachedClientKpis = unstable_cache(
  async (): Promise<AllClientKpis> => (adminConfigured() ? loadAllClientKpis(createAdminClient()) : {}),
  ["clients-list-kpis"],
  { revalidate: 180, tags: [BOARD_KPIS_TAG] },
);
