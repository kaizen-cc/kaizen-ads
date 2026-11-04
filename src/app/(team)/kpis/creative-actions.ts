"use server";

import { requireStaff } from "@/lib/auth";
import { adPerformance, type AdPerf } from "@/lib/ad-performance";
import { loadWatchList, type WatchRow } from "@/lib/fatigue";
import { industryLabel } from "@/lib/industries";
import { loadLedger, type LedgerItem } from "@/lib/ledger";
import { loadClientMarket, type MarketAd } from "@/lib/market";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Creative tab on a KPI card, read when it's opened: the account's ads this week (with hook rate and watch time on
// video), the ads wearing out, what has worked and what hasn't for this client (the playbook), and their market.

export type KpiAds = { ads: AdPerf[]; from: string; to: string; roas: boolean; result: string };
export type KpiCreative = { fatigue: WatchRow[]; winners: LedgerItem[]; losers: LedgerItem[]; market: MarketAd[]; industry: string | null; industryLabel: string; ads: KpiAds | null };

export async function kpiCreative(clientId: string, targetId?: string): Promise<KpiCreative> {
  await requireStaff();
  const db = await createClient();
  const { data: t } = targetId ? await db.from("kpi_targets").select("platform, ad_account_id, conversion, custom_action").eq("id", targetId).maybeSingle() : { data: null };
  const [fatigue, ledger, marketAll, { data: c }, perf] = await Promise.all([
    loadWatchList(db, { clientId }).catch(() => [] as WatchRow[]),
    loadLedger(db, clientId).catch(() => [] as LedgerItem[]),
    loadClientMarket(db, clientId, { limit: 120 }).catch(() => [] as MarketAd[]),
    db.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle(),
    t?.platform === "meta" && t.ad_account_id
      ? adPerformance(db, adminConfigured() ? createAdminClient() : null, clientId, String(t.ad_account_id), { conversion: t.conversion as string, custom_action: (t.custom_action as string | null) ?? null }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const seen = new Set<string>();
  const market = marketAll.filter((a) => (seen.has(a.brand) ? false : (seen.add(a.brand), true))).slice(0, 8);
  const bySpend = (a: LedgerItem, b: LedgerItem) => b.spend - a.spend;
  return {
    fatigue,
    winners: ledger.filter((i) => i.verdict === "winner" && i.kind !== "audience").sort(bySpend).slice(0, 6),
    losers: ledger.filter((i) => i.verdict === "loser" && i.kind === "angle").sort(bySpend).slice(0, 3),
    market,
    industry: (c?.industry as string | null) ?? null,
    industryLabel: (c?.industry_detail as string | null) ?? industryLabel(c?.industry as string | null) ?? "their industry",
    ads: perf ? { ads: perf.ads, from: perf.window.from, to: perf.window.to, roas: perf.roas, result: perf.result } : null,
  };
}
