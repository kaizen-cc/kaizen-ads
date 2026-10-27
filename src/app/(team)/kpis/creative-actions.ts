"use server";

import { requireStaff } from "@/lib/auth";
import { loadWatchList, type WatchRow } from "@/lib/fatigue";
import { industryLabel } from "@/lib/industries";
import { loadLedger, type LedgerItem } from "@/lib/ledger";
import { loadClientMarket, type MarketAd } from "@/lib/market";
import { createClient } from "@/lib/supabase/server";

// The Creative tab on a KPI card, read when it's opened: the ads wearing out, what has worked and what hasn't for this
// client (the playbook), and what's live in their market right now.

export type KpiCreative = { fatigue: WatchRow[]; winners: LedgerItem[]; losers: LedgerItem[]; market: MarketAd[]; industry: string | null; industryLabel: string };

export async function kpiCreative(clientId: string): Promise<KpiCreative> {
  await requireStaff();
  const db = await createClient();
  const [fatigue, ledger, marketAll, { data: c }] = await Promise.all([
    loadWatchList(db, { clientId }).catch(() => [] as WatchRow[]),
    loadLedger(db, clientId).catch(() => [] as LedgerItem[]),
    loadClientMarket(db, clientId, { limit: 120 }).catch(() => [] as MarketAd[]),
    db.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle(),
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
  };
}
