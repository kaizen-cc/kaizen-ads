import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaConfigured, metaGraph } from "@/lib/context/meta";

// Every write Kaizen Ads makes to Meta goes through here: the launcher creating ads, and audit or sprint changes
// (pausing, budgets). Two guards, whatever asked:
// - the sandbox: while it's on (Settings), only Kaizen's own ad account can be written to; client accounts are refused
// - validate first: each write can be sent to Meta as a dry run (validate_only), which checks it in full and changes nothing

/** urlTags: Kaizen's UTM template, added to every launched ad's link (e.g. utm_source=facebook&utm_medium=paid) */
export type MetaWriteSetting = { sandbox: boolean; sandboxAccount: string; urlTags?: string | null };

const bare = (a: string) => a.replace(/^act_/, "").replace(/\D/g, "");

export async function metaWriteSetting(admin: SupabaseClient): Promise<MetaWriteSetting> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "meta_write").maybeSingle();
  const v = (data?.value ?? {}) as Partial<MetaWriteSetting>;
  // Missing or unreadable: the safe side
  return { sandbox: v.sandbox !== false, sandboxAccount: bare(v.sandboxAccount ?? "795029519154776"), urlTags: v.urlTags?.trim() || null };
}

/** Why this account can't be written to right now, or null when it can. */
export async function writeBlocked(admin: SupabaseClient, account: string): Promise<string | null> {
  if (!metaConfigured()) return "Meta isn't connected.";
  const s = await metaWriteSetting(admin);
  if (s.sandbox && bare(account) !== s.sandboxAccount)
    return "Sandbox mode is on: Kaizen Ads only writes to Kaizen's own ad account until an exec switches it off in Settings → Sync health.";
  return null;
}

/**
 * A write to Meta (POST), gated by the sandbox. validateOnly: Meta checks it completely and changes nothing.
 * `account` is the ad account the write belongs to (the gate checks it even when the path is an ad or ad set ID).
 */
export async function metaWrite<T = { id?: string; success?: boolean }>(admin: SupabaseClient, account: string, path: string, params: Record<string, string>, validateOnly: boolean): Promise<T> {
  const blocked = await writeBlocked(admin, account);
  if (blocked) throw new Error(blocked);
  return metaGraph<T>(path, { ...params, ...(validateOnly ? { execution_options: JSON.stringify(["validate_only"]) } : {}) }, "POST");
}

/** The object an ID belongs to, read fresh: which ad account owns it (so a write can't be aimed at another account). */
export async function ownerAccount(objectId: string): Promise<string | null> {
  const r = await metaGraph<{ account_id?: string }>(objectId, { fields: "account_id" }).catch(() => null);
  return r?.account_id ? bare(r.account_id) : null;
}

/**
 * Can Kaizen Ads write to this account? A dry run of creating a paused campaign there: Meta checks the token's
 * permission (ads_management), the system user's role on the account, and the account's state, and creates nothing.
 */
export async function writeAccess(admin: SupabaseClient, account: string): Promise<{ ok: boolean; detail: string }> {
  const blocked = await writeBlocked(admin, account);
  if (blocked) return { ok: false, detail: blocked };
  try {
    await metaWrite(admin, account, `act_${bare(account)}/campaigns`, { name: "Kaizen Ads access check", objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]" }, true);
    return { ok: true, detail: "Kaizen Ads can create and change ads here (checked with Meta, nothing was created)." };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const hint = /permission|not authorized|ads_management|\(#200\)|\(#10\)/i.test(m)
      ? " The system user needs the ads_management permission and Manage campaigns on this ad account in Business Manager."
      : /disabled|unsettled|closed/i.test(m)
        ? " The ad account isn't active (billing or a restriction)."
        : "";
    return { ok: false, detail: `${m}${hint}` };
  }
}

export type MetaSetup = {
  campaigns: { id: string; name: string; status: string; effective: string; objective: string; dailyBudget: number | null; lifetimeBudget: number | null; bidStrategy: string | null }[];
  adsets: { id: string; name: string; status: string; effective: string; campaignId: string; campaign: string; dailyBudget: number | null; lifetimeBudget: number | null; optimization: string | null }[];
  ads: { id: string; name: string; status: string; effective: string; adsetId: string; adset: string; campaign: string; spend14: number; clicks14: number; ctr14: number | null; frequency14: number | null }[];
};

/**
 * The account as it is now, for planning a change: campaigns, ad sets and ads still in play (not deleted or archived),
 * with their own on/off setting, daily or lifetime budgets (in dollars) and each ad's last 14 days from our sync.
 */
export async function metaWritableSetup(admin: SupabaseClient, account: string): Promise<MetaSetup> {
  const act = `act_${bare(account)}`;
  const live = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED"] }]);
  type P<T> = { data: T[] };
  const cents = (v: unknown) => (v == null || v === "" ? null : Number(v) / 100);
  const [c, s, a] = await Promise.all([
    metaGraph<P<Record<string, string>>>(`${act}/campaigns`, { fields: "name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy", filtering: live, limit: "100" }),
    metaGraph<P<Record<string, string> & { campaign?: { name: string } }>>(`${act}/adsets`, { fields: "name,status,effective_status,campaign_id,campaign{name},daily_budget,lifetime_budget,optimization_goal", filtering: live, limit: "200" }),
    metaGraph<P<Record<string, string> & { adset?: { name: string }; campaign?: { name: string } }>>(`${act}/ads`, { fields: "name,status,effective_status,adset_id,adset{name},campaign{name}", filtering: live, limit: "400" }),
  ]);
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { data: days } = await admin.from("meta_ad_daily").select("ad_id, metrics").in("ad_account_id", [bare(account), act]).gte("date", since);
  const perf = new Map<string, { spend: number; clicks: number; impressions: number; reach: number }>();
  for (const d of days ?? []) {
    const m = (d.metrics ?? {}) as Record<string, string>;
    const p = perf.get(d.ad_id as string) ?? { spend: 0, clicks: 0, impressions: 0, reach: 0 };
    p.spend += Number(m.spend ?? 0);
    p.clicks += Number(m.inline_link_clicks ?? 0);
    p.impressions += Number(m.impressions ?? 0);
    p.reach += Number(m.reach ?? 0);
    perf.set(d.ad_id as string, p);
  }
  return {
    campaigns: c.data.map((x) => ({ id: x.id, name: x.name, status: x.status, effective: x.effective_status, objective: x.objective, dailyBudget: cents(x.daily_budget), lifetimeBudget: cents(x.lifetime_budget), bidStrategy: x.bid_strategy ?? null })),
    adsets: s.data.map((x) => ({ id: x.id, name: x.name, status: x.status, effective: x.effective_status, campaignId: x.campaign_id, campaign: x.campaign?.name ?? "", dailyBudget: cents(x.daily_budget), lifetimeBudget: cents(x.lifetime_budget), optimization: x.optimization_goal ?? null })),
    ads: a.data.map((x) => {
      const p = perf.get(x.id);
      return {
        id: x.id,
        name: x.name,
        status: x.status,
        effective: x.effective_status,
        adsetId: x.adset_id,
        adset: x.adset?.name ?? "",
        campaign: x.campaign?.name ?? "",
        spend14: Math.round((p?.spend ?? 0) * 100) / 100,
        clicks14: p?.clicks ?? 0,
        ctr14: p && p.impressions ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null,
        frequency14: p && p.reach ? Math.round((p.impressions / p.reach) * 100) / 100 : null,
      };
    }),
  };
}
