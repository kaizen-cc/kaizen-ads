import "server-only";
import { tracker, type Tracker } from "@/lib/progress";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountActivity, asyncReport, linkAdAccounts, metaConfigured, type InsightRow } from "@/lib/context/meta";
import { digits, googleAdsConfigured, googleAdsMissing, syncGoogleCampaigns } from "@/lib/context/google-ads";
import { pool } from "@/lib/context/run";
import { computeSnapshot, nyParts, toDays } from "./calc";
import { LIVE } from "@/lib/live";

// Pulls Meta and Google Ads numbers per campaign per day for every ad account with a KPI target, then recomputes
// each target (the same math for both; Google's days live in google_campaign_daily).
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
export async function accountRows(admin: SupabaseClient, account: string, platform: string = "meta"): Promise<CampaignRow[]> {
  const table = platform === "google" ? "google_campaign_daily" : "meta_campaign_daily";
  const since = ymd(new Date(Date.now() - BACKFILL_DAYS * 86_400_000));
  const out: CampaignRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from(table)
      .select("date, campaign_id, campaign_name, spend, impressions, clicks, actions, action_values, link_clicks, unique_link_clicks, updated_at")
      .eq("ad_account_id", platform === "google" ? digits(account) : account)
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
export async function computeAccount(admin: SupabaseClient, account: string, targets: Target[], error?: string, platform = "meta") {
  const rows = await accountRows(admin, account, platform);
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
      error: error ?? (rows.length ? null : platform === "google" ? "No data from Google Ads yet" : "No data from Meta yet"),
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

async function refreshTargets(admin: SupabaseClient, targets: Target[], pull: boolean, deadline = Date.now() + 600_000, t?: Tracker) {
  // Keyed by platform and account ("meta:123", "google:2698564936"); Google's IDs are stored with dashes
  const byAccount = new Map<string, Target[]>();
  for (const t of targets) {
    if (!t.ad_account_id || !["meta", "google"].includes(t.platform)) {
      await saveSnapshot(admin, t, { status: "setup", error: t.platform === "google" ? "Add the Google Ads customer ID" : "Add the ad account ID" });
      continue;
    }
    const account = t.platform === "google" ? digits(t.ad_account_id) : t.ad_account_id.replace(/^act_/, "");
    if (t.platform === "google" && !googleAdsConfigured()) {
      await saveSnapshot(admin, t, { status: "setup", error: `Google Ads isn't connected yet (missing ${googleAdsMissing().join("; ")})` });
      continue;
    }
    const k = `${t.platform}:${account}`;
    byAccount.set(k, [...(byAccount.get(k) ?? []), t]);
  }

  // Stalest first, so a run that runs out of time picks up where the last one stopped
  const { data: state } = await admin.from("sync_state").select("source, last_run_at").like("source", "kpi:%");
  const ran = new Map((state ?? []).map((s) => [s.source as string, s.last_run_at as string | null]));
  const accountOf = (k: string) => k.slice(k.indexOf(":") + 1);
  const accounts = [...byAccount.keys()].sort((a, b) => (ran.get(`kpi:${accountOf(a)}`) ?? "").localeCompare(ran.get(`kpi:${accountOf(b)}`) ?? ""));

  t?.total(accounts.length);
  return pool(accounts, 4, async (k) => {
    const list = byAccount.get(k)!;
    const platform = k.slice(0, k.indexOf(":"));
    const account = accountOf(k);
    if (Date.now() > deadline) {
      t?.tick(null);
      return { account, deferred: true };
    }
    t?.on(account);
    let error: string | undefined;
    let pulled: Awaited<ReturnType<typeof syncMetaCampaigns>> | null = null;
    if (pull && platform === "google") {
      try {
        pulled = await syncGoogleCampaigns(admin, account);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else if (pull && metaConfigured()) {
      try {
        pulled = await syncMetaCampaigns(admin, account);
      } catch (e) {
        // Usually: the account isn't assigned to the CommandCenter system user yet
        const msg = e instanceof Error ? e.message : String(e);
        error = /missing permissions|does not exist/i.test(msg) ? "Meta can't see this ad account yet. Assign it to the CommandCenter system user." : msg;
      }
    }
    await computeAccount(admin, account, list, error, platform);
    // Who changed what in the account lately (Meta's activity log), so the board shows whether someone's on it
    if (pull && platform === "meta" && metaConfigured() && !error) await saveActivity(admin, account);
    await admin.from("sync_state").upsert({ source: `kpi:${account}`, last_run_at: new Date().toISOString(), last_result: { ...(pulled ?? {}), error: error ?? null } });
    t?.tick(account, !error);
    return { account, platform, targets: list.length, ...(pulled ?? {}), ...(error ? { error } : {}) };
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
    admin.from("clients").select("id, meta_ad_account_id").is("archived_at", null).in("status", LIVE).not("meta_ad_account_id", "is", null),
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

/** The account's latest changes from Meta's activity log. A failure is noted, never fatal to the KPI sync. */
async function saveActivity(admin: SupabaseClient, account: string) {
  try {
    const recent = await accountActivity(account);
    await admin.from("ad_account_activity").upsert({
      ad_account_id: account,
      last_change_at: recent[0]?.at ?? null,
      last_change: recent[0] ?? null,
      recent: recent.slice(0, 20),
      error: null,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    await admin.from("ad_account_activity").upsert({ ad_account_id: account, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), checked_at: new Date().toISOString() });
  }
}

/** One ad account now (Sync health's Retry): pull from Meta and recompute its targets. */
export async function refreshAccountKpis(admin: SupabaseClient, account: string) {
  const dashed = account.length === 10 ? `${account.slice(0, 3)}-${account.slice(3, 6)}-${account.slice(6)}` : account;
  const { data } = await admin.from("kpi_targets").select(TARGET_FIELDS).eq("active", true).in("ad_account_id", [account, `act_${account}`, dashed]);
  const [r] = await refreshTargets(admin, (data ?? []) as Target[], true);
  return r ?? { account, error: "No active KPI target uses this ad account" };
}

/** The scheduled step: pull every account with a target and recompute everything. */
export async function refreshAllKpis(admin: SupabaseClient, budgetMs = 650_000) {
  const t = await tracker(admin, "kpi", "ad accounts");
  try {
    return await refreshAll(admin, budgetMs, t);
  } catch (e) {
    await t.finish({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function refreshAll(admin: SupabaseClient, budgetMs: number, t: Tracker) {
  const adopted = await adoptNewAccounts(admin);
  const [{ data }, { data: archived }] = await Promise.all([
    admin.from("kpi_targets").select(TARGET_FIELDS).eq("active", true),
    admin.from("clients").select("id").is("archived_at", null).in("status", LIVE),
  ]);
  // Live clients only: paused and archived accounts aren't pulled until they're reactivated
  const on = new Set((archived ?? []).map((c) => c.id as string));
  const live = ((data ?? []) as Target[]).filter((t) => on.has((t as unknown as { client_id: string }).client_id));
  const results = await refreshTargets(admin, live, true, Date.now() + budgetMs, t);
  const out = {
    ...adopted,
    accounts: results?.length ?? 0,
    errors: (results ?? []).filter((r) => "error" in r && r.error).map((r) => `${r.account}: ${(r as { error: string }).error}`),
    deferred: (results ?? []).filter((r) => "deferred" in r).length,
  };
  await t.finish({ summary: `${out.accounts} accounts${out.errors.length ? `, ${out.errors.length} failed` : ""}${out.deferred ? `, ${out.deferred} left for the next run` : ""}` });
  return out;
}
