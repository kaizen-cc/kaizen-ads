"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { campaignScorecard, type CampaignPerf, type ScoreTarget } from "@/lib/kpi/campaigns";
import { CONVERSIONS } from "@/lib/kpi/conversions";
import { refreshClientKpis } from "@/lib/kpi/sync";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Campaigns section of a KPI card: one card per client, and inside it every campaign judged on its own result
// (what it's optimized for, or one picked here), with purchases and ROAS. Read when the card opens.

export type { CampaignPerf };

const COLS = "client_id, platform, ad_account_id, conversion, custom_action, campaign_match, target, excluded_campaigns, campaign_results";

/** The card's target, read with the person's own access (only someone who can see the card gets this far) */
async function mine(targetId: string) {
  await requireStaff();
  const { data } = await (await createClient()).from("kpi_targets").select(COLS).eq("id", targetId).maybeSingle();
  return data;
}

async function recompute(clientId: string) {
  await refreshClientKpis(createAdminClient(), clientId);
  revalidatePath("/kpis");
}

export async function kpiCampaigns(targetId: string): Promise<{ roas: boolean; campaigns: CampaignPerf[] }> {
  const t = await mine(targetId);
  if (!t?.ad_account_id || !adminConfigured()) return { roas: false, campaigns: [] };
  return campaignScorecard(createAdminClient(), t as ScoreTarget);
}

/**
 * Count a campaign in the KPI or leave it out (a campaign the client runs themselves: we're not on the hook for it).
 * The card's numbers (spend, results, cost, pacing, status) are worked out again straight away.
 */
export async function setCampaignCounted(targetId: string, campaignId: string, counted: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await mine(targetId);
  if (!t) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const left = new Set((t.excluded_campaigns ?? []) as string[]);
  if (counted) left.delete(campaignId);
  else left.add(campaignId);
  const { error } = await createAdminClient().from("kpi_targets").update({ excluded_campaigns: [...left] }).eq("id", targetId);
  if (error) return { ok: false, error: error.message };
  await recompute(t.client_id as string);
  return { ok: true };
}

/** The result one campaign is judged on, picked by hand (null goes back to what it's optimized for). */
export async function setCampaignResult(targetId: string, campaignId: string, type: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await mine(targetId);
  if (!t) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const picked = { ...((t.campaign_results ?? {}) as Record<string, string>) };
  if (type) picked[campaignId] = type.slice(0, 200);
  else delete picked[campaignId];
  const { error } = await createAdminClient().from("kpi_targets").update({ campaign_results: picked }).eq("id", targetId);
  if (error) return { ok: false, error: error.message };
  await recompute(t.client_id as string);
  return { ok: true };
}

/**
 * What the whole card is judged on: each campaign's own result added up (cost per result), cost per lead, cost per
 * purchase, ROAS… and the target for it (a cost target and a ROAS target aren't the same number).
 */
export async function setCardMetric(targetId: string, conversion: string, target: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await mine(targetId);
  if (!t) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const c = CONVERSIONS.find((x) => x.key === conversion && x.platforms.includes(t.platform === "google" ? "google" : "meta"));
  if (!c) return { ok: false, error: "That metric isn't available here." };
  const { error } = await createAdminClient()
    .from("kpi_targets")
    .update({ conversion, ...(target != null && target > 0 ? { target } : {}) })
    .eq("id", targetId);
  if (error) return { ok: false, error: error.message };
  await recompute(t.client_id as string);
  return { ok: true };
}
