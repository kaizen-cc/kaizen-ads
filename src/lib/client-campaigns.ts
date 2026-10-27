import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversionFor } from "@/lib/kpi/conversions";
import { pickType, resultsOf, toDays, type Day } from "@/lib/kpi/calc";

// A client's campaigns on each platform over the last 30 days (against the 30 before), counted the way their KPI
// counts results: for the whole-business view and each service's own tab.

export type CampaignRow = {
  id: string;
  name: string;
  type: string | null; // Google: SEARCH, PERFORMANCE_MAX…
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
  value: number; // revenue, for ROAS
  prevSpend: number;
  prevResults: number;
  /** Google: share of the impressions it could have had, and what it lost to budget and to rank (0–1) */
  share?: { is: number | null; lostBudget: number | null; lostRank: number | null };
};

export type PlatformSummary = {
  platform: "meta" | "google";
  accounts: string[];
  resultLabel: string;
  roas: boolean;
  spend: number;
  results: number;
  value: number;
  prevSpend: number;
  prevResults: number;
  campaigns: CampaignRow[];
};

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Raw = { ad_account_id: string; campaign_id: string; campaign_name: string | null; campaign_type?: string | null; date: string; spend: number | string; impressions: number | string; clicks: number | string; link_clicks: number | string; unique_link_clicks: number | string; actions: Record<string, number>; action_values: Record<string, number> };

/** Each platform the client runs, from its KPI targets' ad accounts (read with the server's rights). */
export async function loadCampaigns(admin: SupabaseClient, clientId: string): Promise<PlatformSummary[]> {
  const { data: targets } = await admin.from("kpi_targets").select("platform, ad_account_id, conversion, custom_action").eq("client_id", clientId).eq("active", true).not("ad_account_id", "is", null);
  const out: PlatformSummary[] = [];
  for (const platform of ["meta", "google"] as const) {
    const mine = (targets ?? []).filter((t) => t.platform === platform);
    if (!mine.length) continue;
    const accounts = [...new Set(mine.map((t) => String(t.ad_account_id)))];
    const conv = conversionFor(String(mine[0].conversion));
    const { data } = await admin
      .from(platform === "google" ? "google_campaign_daily" : "meta_campaign_daily")
      .select(`ad_account_id, campaign_id, campaign_name, ${platform === "google" ? "campaign_type, " : ""}date, spend, impressions, clicks, link_clicks, unique_link_clicks, actions, action_values`)
      .in("ad_account_id", accounts)
      .gte("date", day(60))
      .limit(20000);
    const rows = (data ?? []) as unknown as Raw[];
    const type = pickType(toDays(rows), conv, mine[0].custom_action as string | null);
    const cut = day(30);
    const byCampaign = new Map<string, CampaignRow & { is: number; eligible: number; lostBudget: number; lostRank: number }>();
    for (const r of rows) {
      const c = byCampaign.get(r.campaign_id) ?? { id: r.campaign_id, name: r.campaign_name ?? r.campaign_id, type: r.campaign_type ?? null, spend: 0, impressions: 0, clicks: 0, results: 0, value: 0, prevSpend: 0, prevResults: 0, is: 0, eligible: 0, lostBudget: 0, lostRank: 0 };
      const d: Day = { date: r.date, spend: Number(r.spend) || 0, actions: r.actions ?? {}, values: r.action_values ?? {}, linkClicks: Number(r.link_clicks) || 0, uniqueLinkClicks: Number(r.unique_link_clicks) || 0 };
      const res = resultsOf(d, conv, type);
      if (r.date >= cut) {
        c.spend += d.spend;
        c.impressions += Number(r.impressions) || 0;
        c.clicks += Number(r.clicks) || 0;
        c.results += res;
        c.value += type ? Number(d.values[type] ?? 0) : 0;
        c.is += Number(d.actions["_is:impressions"] ?? 0);
        c.eligible += Number(d.actions["_is:eligible"] ?? 0);
        c.lostBudget += Number(d.actions["_is:lost_budget"] ?? 0);
        c.lostRank += Number(d.actions["_is:lost_rank"] ?? 0);
      } else {
        c.prevSpend += d.spend;
        c.prevResults += res;
      }
      if (r.campaign_name) c.name = r.campaign_name;
      byCampaign.set(r.campaign_id, c);
    }
    const campaigns: CampaignRow[] = [...byCampaign.values()]
      .filter((c) => c.spend > 0 || c.prevSpend > 0)
      .map(({ is, eligible, lostBudget, lostRank, ...c }) => ({
        ...c,
        spend: Math.round(c.spend * 100) / 100,
        results: Math.round(c.results * 10) / 10,
        ...(platform === "google" ? { share: { is: eligible ? is / eligible : null, lostBudget: eligible ? lostBudget / eligible : null, lostRank: eligible ? lostRank / eligible : null } } : {}),
      }))
      .sort((a, b) => b.spend - a.spend);
    const sum = (k: "spend" | "results" | "value" | "prevSpend" | "prevResults") => campaigns.reduce((n, c) => n + c[k], 0);
    out.push({ platform, accounts, resultLabel: conv.key === "custom" ? "Results" : conv.label, roas: Boolean(conv.roas), spend: sum("spend"), results: sum("results"), value: sum("value"), prevSpend: sum("prevSpend"), prevResults: sum("prevResults"), campaigns });
  }
  return out;
}
