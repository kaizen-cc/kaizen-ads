"use server";

import { requireStaff } from "@/lib/auth";
import { aggregate, nyParts, pickType, toDays, worseBy } from "@/lib/kpi/calc";
import { conversionFor } from "@/lib/kpi/conversions";
import { accountRows } from "@/lib/kpi/sync";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Each campaign in a client's ad account, on its KPI card: one card per client, and inside it how every campaign is
// doing against the same target (the last 7 and 30 days, with the account's conversion). Read when the card opens.

export type CampaignPerf = {
  id: string;
  name: string;
  spend7: number;
  results7: number;
  value7: number | null;
  spend30: number;
  results30: number;
  value30: number | null;
  /** +0.2 = 20% worse than the target over 30 days */
  deviation: number | null;
  lastSpent: string | null;
};

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function kpiCampaigns(targetId: string): Promise<{ roas: boolean; campaigns: CampaignPerf[] }> {
  await requireStaff();
  const db = await createClient();
  // Read with their own access first: only someone who can see the card gets its campaigns
  const { data: t } = await db.from("kpi_targets").select("platform, ad_account_id, conversion, custom_action, campaign_match, target").eq("id", targetId).maybeSingle();
  if (!t?.ad_account_id || !adminConfigured()) return { roas: false, campaigns: [] };
  const rows = await accountRows(createAdminClient(), String(t.ad_account_id), String(t.platform)).catch(() => []);
  const conv = conversionFor(String(t.conversion));
  const type = pickType(toDays(rows), conv, t.custom_action as string | null);
  const today = nyParts(new Date()).date;
  const from7 = shift(today, -6);
  const from30 = shift(today, -29);
  const match = (t.campaign_match as string | null)?.trim().toLowerCase();
  const byCampaign = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.date < from30) continue;
    if (match && !(r.campaign_name ?? "").toLowerCase().includes(match)) continue;
    byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r]);
  }
  const target = t.target == null ? null : Number(t.target);
  const campaigns: CampaignPerf[] = [];
  for (const [id, list] of byCampaign) {
    const days = toDays(list);
    const a30 = aggregate(days, conv, type);
    if (!a30.spend && !a30.results) continue;
    const a7 = aggregate(days.filter((d) => d.date >= from7), conv, type);
    const spent = days.filter((d) => d.spend > 0).map((d) => d.date).sort();
    campaigns.push({
      id,
      name: [...list].sort((a, b) => b.date.localeCompare(a.date))[0]?.campaign_name ?? "Campaign",
      spend7: a7.spend,
      results7: a7.results,
      value7: a7.value,
      spend30: a30.spend,
      results30: a30.results,
      value30: a30.value,
      deviation: worseBy(a30.value, target, Boolean(conv.roas)),
      lastSpent: spent[spent.length - 1] ?? null,
    });
  }
  // Spending now first, then by the month's spend
  campaigns.sort((a, b) => Number(b.spend7 > 0) - Number(a.spend7 > 0) || b.spend30 - a.spend30);
  return { roas: Boolean(conv.roas), campaigns };
}
