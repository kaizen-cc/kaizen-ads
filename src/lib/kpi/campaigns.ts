import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregate, nyParts, pickType, toDays, type Day } from "./calc";
import { conversionFor } from "./conversions";
import { actionLabel } from "./explore";
import { accountRows, goalsFor } from "./sync";

// Each campaign in a client's ad account against its KPI: the result that campaign is judged on (picked by hand on the
// card, or what it's optimized for, or the card's own result), its cost, purchases and ROAS, and whether it counts
// toward the card. The KPI card shows it; the audits and the client chat read it.

export type CampaignPerf = {
  id: string;
  name: string;
  spend7: number;
  spend30: number;
  /** The result this campaign is judged on, and where that choice came from */
  result: string | null;
  resultLabel: string;
  resultFrom: "picked" | "goal" | "card";
  results7: number;
  results30: number;
  /** Cost per result (or ROAS on a ROAS card) over 30 days */
  value30: number | null;
  deviation: number | null;
  lastSpent: string | null;
  excluded: boolean;
  /** What the campaign is optimized for (Meta), when known */
  goal: string | null;
  purchases30: number;
  revenue30: number;
  roas30: number | null;
  /** The results this campaign reports, to pick from */
  options: { type: string; label: string; count: number }[];
};

export type ScoreTarget = {
  platform: string;
  ad_account_id: string | null;
  conversion: string;
  custom_action: string | null;
  campaign_match: string | null;
  target: number | string | null;
  excluded_campaigns?: string[] | null;
  campaign_results?: Record<string, string> | null;
};

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// Not results anyone runs a campaign for
const NOISE = /^(post|page|post_|onsite_conversion\.post|video_view|photo_view|comment|like|post_reaction|post_engagement|page_engagement|post_interaction|onsite_conversion\.messaging_user_depth)/;

export async function campaignScorecard(admin: SupabaseClient, t: ScoreTarget): Promise<{ roas: boolean; campaigns: CampaignPerf[] }> {
  if (!t.ad_account_id) return { roas: false, campaigns: [] };
  const platform = t.platform === "google" ? "google" : "meta";
  const account = String(t.ad_account_id);
  const [rows, goals, { data: labels }] = await Promise.all([
    accountRows(admin, account, platform).catch(() => []),
    goalsFor(admin, account, platform),
    admin.from("campaign_goals").select("campaign_id, label").eq("ad_account_id", account.replace(/^act_/, "")),
  ]);
  const picked = t.campaign_results ?? {};
  const labelOf = new Map((labels ?? []).map((l) => [l.campaign_id as string, l.label as string]));
  const conv = conversionFor(t.conversion);
  const roas = Boolean(conv.roas);
  const cardType = pickType(toDays(rows), conv, t.custom_action);
  const buy = conversionFor(platform === "google" ? "google_roas" : "roas");
  const today = nyParts(new Date()).date;
  const from7 = shift(today, -6);
  const from30 = shift(today, -29);
  const match = t.campaign_match?.trim().toLowerCase();
  const left = new Set(t.excluded_campaigns ?? []);
  const target = t.target == null ? null : Number(t.target);

  const byCampaign = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.date < from30) continue;
    if (match && !(r.campaign_name ?? "").toLowerCase().includes(match)) continue;
    byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r]);
  }

  const campaigns: CampaignPerf[] = [];
  for (const [id, list] of byCampaign) {
    const days = toDays(list);
    const total = (ds: Day[], type: string | null) => (type ? ds.reduce((n, d) => n + (d.actions[type] ?? 0), 0) : 0);
    // Its result: picked by hand, else the first of its goal's types it reports, else the card's
    const goalType = goals.get(id)?.find((x) => days.some((d) => d.actions[x] != null)) ?? null;
    const [result, resultFrom] = picked[id] ? [picked[id], "picked" as const] : goalType ? [goalType, "goal" as const] : [cardType, "card" as const];
    const spend30 = days.reduce((n, d) => n + d.spend, 0);
    const spend7 = days.filter((d) => d.date >= from7).reduce((n, d) => n + d.spend, 0);
    const results30 = total(days, result);
    const results7 = total(days.filter((d) => d.date >= from7), result);
    if (!spend30 && !results30) continue;
    const bt = pickType(days, buy, null);
    const b30 = aggregate(days, buy, bt);
    // On a ROAS card each campaign is judged on its ROAS; otherwise on the cost of its own result
    const value30 = roas ? b30.value : results30 ? spend30 / results30 : null;
    const sums = new Map<string, number>();
    for (const d of days) for (const [k, v] of Object.entries(d.actions)) if (k !== "campaign_goal" && !NOISE.test(k)) sums.set(k, (sums.get(k) ?? 0) + v);
    campaigns.push({
      id,
      name: [...list].sort((a, b) => b.date.localeCompare(a.date))[0]?.campaign_name ?? "Campaign",
      spend7: Math.round(spend7 * 100) / 100,
      spend30: Math.round(spend30 * 100) / 100,
      result,
      resultLabel: result ? (resultFrom === "goal" && labelOf.get(id) ? labelOf.get(id)! : actionLabel(result)) : "Nothing counted",
      resultFrom,
      results7: Math.round(results7 * 10) / 10,
      results30: Math.round(results30 * 10) / 10,
      value30: value30 == null ? null : Math.round(value30 * 100) / 100,
      deviation: value30 == null || target == null || !target ? null : Math.round((roas ? (target - value30) / target : (value30 - target) / target) * 1000) / 1000,
      lastSpent: days.filter((d) => d.spend > 0).map((d) => d.date).sort().pop() ?? null,
      excluded: left.has(id),
      goal: platform === "google" ? "Conversions" : (labelOf.get(id) ?? null),
      purchases30: Math.round(total(days, bt) * 10) / 10,
      revenue30: Math.round((b30.value ?? 0) * b30.spend * 100) / 100,
      roas30: b30.value,
      options: [...sums.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([type, count]) => ({ type, label: actionLabel(type), count: Math.round(count) })),
    });
  }
  campaigns.sort((a, b) => Number(a.excluded) - Number(b.excluded) || Number(b.spend7 > 0) - Number(a.spend7 > 0) || b.spend30 - a.spend30);
  return { roas, campaigns };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The scorecard as text for the AI (audits, the client chat): every campaign, what it's judged on, and how it's doing. */
export function campaignsText(s: { roas: boolean; campaigns: CampaignPerf[] }, target: number | string | null) {
  if (!s.campaigns.length) return "";
  return s.campaigns
    .map((c) => {
      const judged = s.roas ? `ROAS ${c.value30 == null ? "none" : `${c.value30}x`}` : `${c.results30} ${c.resultLabel.toLowerCase()} at ${c.value30 == null ? "no results" : `$${c.value30} each`}`;
      return `- ${c.name}${c.excluded ? " [left out of the KPI: the client runs it]" : ""}: ${money(c.spend30)} in 30 days (${money(c.spend7)} in 7), ${c.goal ? `optimized for ${c.goal}, ` : ""}judged on ${c.resultLabel}${c.resultFrom === "picked" ? " (picked by the buyer)" : ""}: ${judged}${target != null && c.deviation != null ? ` (${c.deviation > 0 ? `${Math.round(c.deviation * 100)}% worse than` : `${Math.round(-c.deviation * 100)}% better than`} the target)` : ""}; ${c.purchases30} purchases${c.revenue30 ? `, ${money(c.revenue30)} purchase value, ROAS ${c.roas30}x` : ""}`;
    })
    .join("\n");
}

/** Every active KPI's campaign scorecard for a client, as text for the client chat. */
export async function clientCampaignsText(admin: SupabaseClient, clientId: string) {
  const { data: targets } = await admin.from("kpi_targets").select("platform, ad_account_id, conversion, custom_action, campaign_match, target, excluded_campaigns, campaign_results").eq("client_id", clientId).eq("active", true);
  const parts: string[] = [];
  for (const t of targets ?? []) {
    if (!t.ad_account_id) continue;
    const s = await campaignScorecard(admin, t as ScoreTarget).catch(() => null);
    if (s?.campaigns.length) parts.push(`${t.platform === "google" ? "Google Ads" : "Meta"} campaigns, last 30 days:\n${campaignsText(s, t.target)}`);
  }
  return parts.join("\n\n");
}
