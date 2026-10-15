import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asyncReport, linkAdAccounts, metaConfigured, type InsightRow } from "@/lib/context/meta";
import { pool } from "@/lib/context/run";
import { computeSnapshot, nyParts, toDays } from "./calc";

// Pulls Meta numbers per campaign per day for every ad account with a KPI target, then recomputes each target.
// About six months is kept so the quarter comparison always has a full last quarter. After the first pull,
// only the last 3 days are re-read (Meta keeps revising them). No AI is involved, so running often costs nothing extra.

const BACKFILL_DAYS = 200;
const FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,unique_inline_link_clicks,actions,action_values";

type Action = { action_type: string; value: string };
const toMap = (list: unknown) => {
  const out: Record<string, number> = {};
  for (const a of (list as Action[] | undefined) ?? []) out[a.action_type] = Number(a.value) || 0;
  return out;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** New and revised days for one Meta ad account. */
export async function syncMetaCampaigns(admin: SupabaseClient, account: string) {
  const { data: last } = await admin.from("meta_campaign_daily").select("date").eq("ad_account_id", account).order("date", { ascending: false }).limit(1).maybeSingle();
  const now = new Date();
  const since = last ? new Date(new Date(`${last.date}T12:00:00Z`).getTime() - 3 * 86_400_000) : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const rows: InsightRow[] = await asyncReport(`act_${account}`, {
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since: ymd(since), until: nyParts(now).date }),
    fields: FIELDS,
  });
  const records = rows
    .filter((r) => r.campaign_id)
    .map((r) => ({
      ad_account_id: account,
      campaign_id: String(r.campaign_id),
      date: r.date_start,
      campaign_name: r.campaign_name ?? null,
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      link_clicks: Number(r.inline_link_clicks) || 0,
      unique_link_clicks: Number(r.unique_inline_link_clicks) || 0,
      actions: toMap(r.actions),
      action_values: toMap(r.action_values),
      updated_at: now.toISOString(),
    }));
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await admin.from("meta_campaign_daily").upsert(records.slice(i, i + 500), { onConflict: "campaign_id,date" });
    if (error) throw new Error(`Saving campaign days: ${error.message}`);
  }
  return { from: ymd(since), rows: records.length };
}

type Target = {
  id: string;
  client_id: string;
  platform: string;
  ad_account_id: string | null;
  conversion: string;
  custom_action: string | null;
  campaign_match: string | null;
  target: number | null;
  monthly_budget: number | null;
};

export type CampaignRow = Parameters<typeof toDays>[0][number] & { campaign_id: string; impressions: number; clicks: number; updated_at: string };

/** Every stored day of an account (paged: there can be thousands of campaign rows). Also used by Settings → Data. */
export async function accountRows(admin: SupabaseClient, account: string): Promise<CampaignRow[]> {
  const since = ymd(new Date(Date.now() - BACKFILL_DAYS * 86_400_000));
  const out: CampaignRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("meta_campaign_daily")
      .select("date, campaign_id, campaign_name, spend, impressions, clicks, actions, action_values, link_clicks, unique_link_clicks, updated_at")
      .eq("ad_account_id", account)
      .gte("date", since)
      .order("date")
      .order("campaign_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

async function saveSnapshot(admin: SupabaseClient, t: Target, fields: Record<string, unknown>) {
  await admin.from("kpi_snapshots").upsert({ target_id: t.id, client_id: t.client_id, computed_at: new Date().toISOString(), ...fields });
}

/** Recompute the snapshots of an account's targets from what's stored. */
export async function computeAccount(admin: SupabaseClient, account: string, targets: Target[], error?: string) {
  const rows = await accountRows(admin, account);
  const now = new Date();
  for (const t of targets) {
    const s = computeSnapshot(toDays(rows, t.campaign_match), {
      conversion: t.conversion,
      custom: t.custom_action,
      target: t.target == null ? null : Number(t.target),
      budget: t.monthly_budget == null ? null : Number(t.monthly_budget),
      now,
    });
    await saveSnapshot(admin, t, {
      data_through: s.dataThrough,
      windows: s.windows,
      months: s.months,
      deviation: s.deviation,
      vs_month: s.vsMonth,
      vs_quarter: s.vsQuarter,
      status: !rows.length && error ? "setup" : s.status,
      trend: s.trend,
      budget: s.budget ?? {},
      daily: s.daily,
      error: error ?? (rows.length ? null : "No data from Meta yet"),
    });
  }
}

const TARGET_FIELDS = "id, client_id, platform, ad_account_id, conversion, custom_action, campaign_match, target, monthly_budget";

/** One client's targets now (after an edit, or the dashboard's Refresh). Recompute only unless `pull`. */
export async function refreshClientKpis(admin: SupabaseClient, clientId: string, pull = false) {
  const { data } = await admin.from("kpi_targets").select(TARGET_FIELDS).eq("client_id", clientId).eq("active", true);
  const targets = (data ?? []) as Target[];
  await refreshTargets(admin, targets, pull);
}

async function refreshTargets(admin: SupabaseClient, targets: Target[], pull: boolean, deadline = Date.now() + 600_000) {
  const byAccount = new Map<string, Target[]>();
  for (const t of targets) {
    if (t.platform !== "meta" || !t.ad_account_id) {
      await saveSnapshot(admin, t, {
        status: "setup",
        error: t.platform === "google" ? "Google Ads isn't connected yet" : "Add the ad account ID",
      });
      continue;
    }
    const account = t.ad_account_id.replace(/^act_/, "");
    byAccount.set(account, [...(byAccount.get(account) ?? []), t]);
  }

  // Stalest first, so a run that runs out of time picks up where the last one stopped
  const { data: state } = await admin.from("sync_state").select("source, last_run_at").like("source", "kpi:%");
  const ran = new Map((state ?? []).map((s) => [s.source as string, s.last_run_at as string | null]));
  const accounts = [...byAccount.keys()].sort((a, b) => (ran.get(`kpi:${a}`) ?? "").localeCompare(ran.get(`kpi:${b}`) ?? ""));

  return pool(accounts, 4, async (account) => {
    const list = byAccount.get(account)!;
    if (Date.now() > deadline) return { account, deferred: true };
    let error: string | undefined;
    let pulled: Awaited<ReturnType<typeof syncMetaCampaigns>> | null = null;
    if (pull && metaConfigured()) {
      try {
        pulled = await syncMetaCampaigns(admin, account);
      } catch (e) {
        // Usually: the account isn't assigned to the CommandCenter system user yet
        const msg = e instanceof Error ? e.message : String(e);
        error = /missing permissions|does not exist/i.test(msg) ? "Meta can't see this ad account yet. Assign it to the CommandCenter system user." : msg;
      }
    }
    await computeAccount(admin, account, list, error);
    await admin.from("sync_state").upsert({ source: `kpi:${account}`, last_run_at: new Date().toISOString(), last_result: { ...(pulled ?? {}), error: error ?? null } });
    return { account, targets: list.length, ...(pulled ?? {}), ...(error ? { error } : {}) };
  });
}

/**
 * New clients: once their ad account is shared with the agency and assigned to the system user, it's linked by
 * name and gets a KPI row (no target yet) so it shows up on the dashboard for the buyer to fill in.
 */
export async function adoptNewAccounts(admin: SupabaseClient) {
  let linked: string[] = [];
  if (metaConfigured()) linked = (await linkAdAccounts(admin).catch(() => null))?.linked ?? [];
  const [{ data: clients }, { data: targets }, { data: buyers }] = await Promise.all([
    admin.from("clients").select("id, meta_ad_account_id").neq("status", "offboarded").not("meta_ad_account_id", "is", null),
    admin.from("kpi_targets").select("client_id").eq("platform", "meta"),
    admin.from("client_assignments").select("client_id, profile_id").eq("role", "meta_buyer"),
  ]);
  const has = new Set((targets ?? []).map((t) => t.client_id));
  const buyer = new Map((buyers ?? []).map((b) => [b.client_id, b.profile_id]));
  const fresh = (clients ?? [])
    .filter((c) => !has.has(c.id))
    .map((c) => ({ client_id: c.id, platform: "meta", ad_account_id: c.meta_ad_account_id, conversion: "purchases", owner_id: buyer.get(c.id) ?? null }));
  if (fresh.length) await admin.from("kpi_targets").insert(fresh);
  return { linked, added: fresh.length };
}

/** The scheduled step: pull every account with a target and recompute everything. */
export async function refreshAllKpis(admin: SupabaseClient, budgetMs = 650_000) {
  const adopted = await adoptNewAccounts(admin);
  const { data } = await admin.from("kpi_targets").select(TARGET_FIELDS).eq("active", true);
  const results = await refreshTargets(admin, (data ?? []) as Target[], true, Date.now() + budgetMs);
  return {
    ...adopted,
    accounts: results?.length ?? 0,
    errors: (results ?? []).filter((r) => "error" in r && r.error).map((r) => `${r.account}: ${(r as { error: string }).error}`),
    deferred: (results ?? []).filter((r) => "deferred" in r).length,
  };
}
