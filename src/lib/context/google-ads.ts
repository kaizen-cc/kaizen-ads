import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JWT } from "google-auth-library";

// Google Ads: campaign numbers per day for every client account with a Google KPI target, read through Kaizen's
// manager (MCC) account. The same shape as Meta's daily rows, so the KPI board, audits, the daily recap and
// notifications treat both alike. Reads, plus the changes someone confirms in Kaizen Ads (see ad-changes.ts): never
// a change on its own.
//
// Access belongs to the Google Cloud project that owns the sign-in (developer tokens were retired on Sep 9, 2026):
// enable the Google Ads API in that project and apply for Explorer access (production accounts, 2,880 operations a
// day; this uses roughly two per account every two hours) on its Google Ads API Overview page.
// What it needs in Vercel:
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID the manager (MCC) account's ID, digits only
//   GOOGLE_ADS_DEVELOPER_TOKEN   optional: still sent if set, ignored by Google since the sunset
// and one way to sign in, either:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN   (OAuth, as a user with MCC access), or
//   GOOGLE_ADS_USER   a Workspace user with MCC access (and any client accounts not linked to it), signed in as
//                     through the existing service account
//                     (add the https://www.googleapis.com/auth/adwords scope to its domain-wide delegation)
// Optional: GOOGLE_ADS_API_VERSION (default below).

const VERSION = process.env.GOOGLE_ADS_API_VERSION || "v26";
const SCOPE = "https://www.googleapis.com/auth/adwords";
const BACKFILL_DAYS = 200;

const env = (k: string) => process.env[k]?.trim() || "";
const oauth = () => Boolean(env("GOOGLE_ADS_CLIENT_ID") && env("GOOGLE_ADS_CLIENT_SECRET") && env("GOOGLE_ADS_REFRESH_TOKEN"));
const delegated = () => Boolean(env("GOOGLE_ADS_USER") && env("GOOGLE_SERVICE_ACCOUNT_JSON"));
export const googleAdsConfigured = () => Boolean(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") && (oauth() || delegated()));
/** What's still missing, in plain words, for Sync health and the KPI board. */
export function googleAdsMissing(): string[] {
  const out: string[] = [];
  if (!env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")) out.push("GOOGLE_ADS_LOGIN_CUSTOMER_ID (the MCC's ID)");
  if (!oauth() && !delegated()) out.push("a sign-in: GOOGLE_ADS_USER, or the OAuth client ID, secret and refresh token");
  return out;
}
export const digits = (id: string) => id.replace(/\D/g, "");

let cached: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  if (oauth()) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: env("GOOGLE_ADS_CLIENT_ID"), client_secret: env("GOOGLE_ADS_CLIENT_SECRET"), refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN") }),
      cache: "no-store",
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    cached = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3000) * 1000 };
    return cached.token;
  }
  const key = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON")) as { client_email: string; private_key: string };
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject: env("GOOGLE_ADS_USER") });
  const t = await jwt.getAccessToken();
  if (!t.token) throw new Error("Google sign-in failed");
  cached = { token: t.token, until: Date.now() + 50 * 60_000 };
  return cached.token;
}

type Row = Record<string, Record<string, unknown>>;

/** One call to a customer's endpoint, through our manager account, or directly when it isn't linked under it. */
async function post(customer: string, path: string, body: unknown): Promise<string> {
  const token = await accessToken();
  const call = (login: string) =>
    fetch(`https://googleads.googleapis.com/${VERSION}/customers/${digits(customer)}${path.startsWith(":") ? "" : "/"}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(env("GOOGLE_ADS_DEVELOPER_TOKEN") ? { "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN") } : {}),
        "login-customer-id": login,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  const mcc = digits(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID"));
  let res = await call(mcc);
  let text = await res.text();
  // Not linked under our manager account, but the signed-in person was added to the account itself: go directly
  if (!res.ok && digits(customer) !== mcc && /PERMISSION_DENIED|permission/i.test(text)) {
    res = await call(digits(customer));
    text = await res.text();
  }
  if (!res.ok) throw new Error(explain(text, res.status));
  return text;
}

/** A GAQL query against one customer, every row (searchStream sends them all in one response). */
async function search(customer: string, query: string): Promise<Row[]> {
  const chunks = JSON.parse(await post(customer, "googleAds:searchStream", { query })) as { results?: Row[] }[];
  return chunks.flatMap((c) => c.results ?? []);
}

/**
 * A change to the account (campaigns, campaignBudgets, adGroups, campaignCriteria). validateOnly: Google checks it
 * fully and says whether it would go through, without changing anything.
 */
export async function googleMutate(customer: string, service: "campaigns" | "campaignBudgets" | "adGroups" | "campaignCriteria", operations: unknown[], validateOnly: boolean) {
  await post(customer, `${service}:mutate`, { operations, validateOnly, partialFailure: false });
}

export type WritableSetup = {
  campaigns: { id: string; name: string; status: string; type: string; bidding: string; portfolio: boolean; targetCpa: number | null; targetRoas: number | null; budget: number | null; budgetResource: string | null; sharedBudget: boolean }[];
  adGroups: { id: string; name: string; status: string; campaignId: string; campaign: string }[];
  wasteTerms: { term: string; campaignId: string; campaign: string; spend: number; clicks: number }[];
};

/** What a change can touch, with the IDs it needs: campaigns (bidding, targets, budget), ad groups, and search terms spending with no conversions. */
export async function googleWritableSetup(account: string): Promise<WritableSetup> {
  const micros = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(v) / 10_000) / 100);
  const [camps, groups, terms] = await Promise.all([
    search(account, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'"),
    search(account, "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT 300").catch(() => [] as Row[]),
    search(account, "SELECT search_term_view.search_term, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.conversions = 0 AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 40").catch(() => [] as Row[]),
  ]);
  return {
    campaigns: camps.map((r) => {
      const c = r.campaign as Record<string, Record<string, unknown> | unknown>;
      const tc = (c.targetCpa as Record<string, unknown> | undefined)?.targetCpaMicros ?? (c.maximizeConversions as Record<string, unknown> | undefined)?.targetCpaMicros;
      const tr = (c.targetRoas as Record<string, unknown> | undefined)?.targetRoas ?? (c.maximizeConversionValue as Record<string, unknown> | undefined)?.targetRoas;
      return {
        id: String(c.id),
        name: String(c.name),
        status: String(c.status),
        type: String(c.advertisingChannelType ?? ""),
        bidding: String(c.biddingStrategyType ?? ""),
        portfolio: Boolean(c.biddingStrategy),
        targetCpa: micros(tc),
        targetRoas: tr == null ? null : Number(tr),
        budget: micros(r.campaignBudget?.amountMicros),
        budgetResource: (r.campaignBudget?.resourceName as string | undefined) ?? null,
        sharedBudget: Boolean(r.campaignBudget?.explicitlyShared),
      };
    }),
    adGroups: groups.map((r) => ({ id: String(r.adGroup?.id), name: String(r.adGroup?.name), status: String(r.adGroup?.status), campaignId: String(r.campaign?.id), campaign: String(r.campaign?.name) })),
    wasteTerms: terms.map((r) => ({ term: String(r.searchTermView?.searchTerm ?? ""), campaignId: String(r.campaign?.id), campaign: String(r.campaign?.name), spend: Math.round(num(r.metrics?.costMicros) / 10_000) / 100, clicks: num(r.metrics?.clicks) })).filter((t) => t.term),
  };
}

/** Google's errors, in words someone can act on. */
function explain(text: string, status: number) {
  let msg = text.slice(0, 300);
  try {
    const e = JSON.parse(text) as { error?: { message?: string; details?: { errors?: { errorCode?: Record<string, string>; message?: string }[] }[] } } | { error?: { message?: string } }[];
    const err = Array.isArray(e) ? e[0]?.error : e.error;
    const detail = (err as { details?: { errors?: { errorCode?: Record<string, string>; message?: string }[] }[] } | undefined)?.details?.[0]?.errors?.[0];
    const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : "";
    msg = detail?.message ?? err?.message ?? msg;
    if (code === "USER_PERMISSION_DENIED" || /permission/i.test(msg)) return "Google Ads can't see this account through our manager account. Link it to the MCC (or check the customer ID).";
    if (/test account|not approved|access level/i.test(msg) || code === "DEVELOPER_TOKEN_NOT_APPROVED") return "Our Google Cloud project only has Test access. Apply for Explorer access on the Google Ads API Overview page in Cloud Console.";
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return "Turn on the Google Ads API in the Google Cloud project our service account belongs to.";
    if (/unauthorized_client|delegation/i.test(msg)) return "Add the https://www.googleapis.com/auth/adwords scope to the service account's domain-wide delegation in Google Admin.";
    if (code === "CUSTOMER_NOT_ENABLED") return "This Google Ads account isn't enabled (cancelled or suspended).";
    if (status === 404 || /unsupported|deprecated/i.test(msg)) return `Google Ads API ${VERSION} isn't available. Set GOOGLE_ADS_API_VERSION to a current version. (${msg})`;
  } catch {
    /* not JSON: keep the raw text */
  }
  return `Google Ads: ${msg}`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Search impression share as counts that add up: the impressions the campaign could have had (eligible), and how many
 * of those it lost to budget and to rank. Share = impressions / eligible. Only search campaigns report it.
 */
function shareOf(r: Row): Record<string, number> {
  const share = Number(r.metrics?.searchImpressionShare);
  const imp = Number(r.metrics?.impressions) || 0;
  if (!share || !imp) return {};
  const eligible = imp / share;
  return {
    "_is:impressions": imp,
    "_is:eligible": eligible,
    "_is:lost_budget": eligible * (Number(r.metrics?.searchBudgetLostImpressionShare) || 0),
    "_is:lost_rank": eligible * (Number(r.metrics?.searchRankLostImpressionShare) || 0),
  };
}
const num = (v: unknown) => Number(v) || 0;

/** New and revised days for one Google Ads account (the last 3 days are re-read: conversions keep coming in). */
export async function syncGoogleCampaigns(admin: SupabaseClient, account: string) {
  const id = digits(account);
  const { data: last } = await admin.from("google_campaign_daily").select("date").eq("ad_account_id", id).order("date", { ascending: false }).limit(1).maybeSingle();
  const now = new Date();
  const since = last ? new Date(new Date(`${last.date}T12:00:00Z`).getTime() - 3 * 86_400_000) : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const range = `segments.date BETWEEN '${ymd(since)}' AND '${now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}'`;
  const [base, byAction] = await Promise.all([
    search(id, `SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE ${range}`),
    // The same, split by conversion action, for targets that count one in particular
    search(id, `SELECT segments.date, campaign.id, segments.conversion_action_name, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${range} AND metrics.conversions > 0`),
  ]);
  const key = (r: Row) => `${r.campaign?.id}|${r.segments?.date}`;
  const actions = new Map<string, { a: Record<string, number>; v: Record<string, number> }>();
  for (const r of byAction) {
    const name = String(r.segments?.conversionActionName ?? "");
    if (!name) continue;
    const e = actions.get(key(r)) ?? { a: {}, v: {} };
    e.a[`action:${name}`] = (e.a[`action:${name}`] ?? 0) + num(r.metrics?.conversions);
    e.v[`action:${name}`] = (e.v[`action:${name}`] ?? 0) + num(r.metrics?.conversionsValue);
    actions.set(key(r), e);
  }
  const records = base.map((r) => {
    const extra = actions.get(key(r)) ?? { a: {}, v: {} };
    const clicks = num(r.metrics?.clicks);
    return {
      ad_account_id: id,
      campaign_id: String(r.campaign?.id),
      date: String(r.segments?.date),
      campaign_name: (r.campaign?.name as string | undefined) ?? null,
      campaign_type: (r.campaign?.advertisingChannelType as string | undefined) ?? null,
      spend: num(r.metrics?.costMicros) / 1_000_000,
      impressions: num(r.metrics?.impressions),
      clicks,
      link_clicks: clicks,
      unique_link_clicks: clicks,
      actions: { conversions: num(r.metrics?.conversions), ...extra.a, ...shareOf(r) },
      action_values: { conversions: num(r.metrics?.conversionsValue), ...extra.v },
      updated_at: now.toISOString(),
    };
  });
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await admin.from("google_campaign_daily").upsert(records.slice(i, i + 500), { onConflict: "ad_account_id,campaign_id,date" });
    if (error) throw new Error(`Saving Google campaign days: ${error.message}`);
  }
  return { from: ymd(since), rows: records.length };
}

// ─── Change history, the live setup, and an audit's detail ─────────────────

const gdate = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/**
 * Who changed what in the account lately (Google's change history), newest first, in the same shape as Meta's activity
 * log. Google keeps 30 days of it; changes Google made itself (automated) are left out.
 */
export async function googleActivity(account: string, sinceDays = 29) {
  const to = new Date();
  const from = new Date(Date.now() - Math.min(29, sinceDays) * 86_400_000);
  const rows = await search(
    account,
    `SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, campaign.name, ad_group.name FROM change_event WHERE change_event.change_date_time >= '${gdate(from)}' AND change_event.change_date_time <= '${gdate(to)}' ORDER BY change_event.change_date_time DESC LIMIT 60`,
  );
  const words = (x: unknown) => String(x ?? "").toLowerCase().replaceAll("_", " ");
  return rows
    .filter((r) => r.changeEvent?.userEmail && !/^(google_ads_automated|internal_tool)/i.test(String(r.changeEvent?.clientType ?? "")))
    .map((r) => {
      const e = r.changeEvent!;
      const fields = String(e.changedFields ?? "")
        .split(",")
        .map((f) => f.trim().split(".").pop())
        .filter(Boolean)
        .slice(0, 4)
        .join(", ");
      const op = words(e.resourceChangeOperation);
      const what = `${op === "create" ? "Created" : op === "remove" ? "Removed" : "Changed"} ${words(e.changeResourceType)}${fields && op === "update" ? ` (${fields.replaceAll("_", " ")})` : ""}`;
      return {
        at: new Date(`${String(e.changeDateTime).replace(" ", "T")}Z`).toISOString(),
        who: String(e.userEmail),
        what,
        type: String(e.changeResourceType ?? ""),
        object: String(r.adGroup?.name ?? r.campaign?.name ?? "") || null,
        objectType: r.adGroup?.name ? "ad group" : r.campaign?.name ? "campaign" : null,
      };
    });
}
export type GoogleActivity = Awaited<ReturnType<typeof googleActivity>>;

export type GoogleSetup = {
  campaigns: { id: string; name: string; status: string; type: string; bidding: string; targetCpa: number | null; targetRoas: number | null; budget: number | null; serving: string }[];
  conversions: { name: string; category: string; primary: boolean; counted: boolean; status: string }[];
};

/** Campaigns as they're set up now (status, type, bidding and its target, daily budget) and the conversion actions. */
export async function googleSetup(account: string): Promise<GoogleSetup> {
  const [camps, convs] = await Promise.all([
    search(account, "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'"),
    search(account, "SELECT conversion_action.name, conversion_action.category, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED'").catch(() => []),
  ]);
  const micros = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(v) / 10_000) / 100);
  return {
    campaigns: camps.map((r) => {
      const c = r.campaign as Record<string, Record<string, unknown> | unknown>;
      const tc = (c.targetCpa as Record<string, unknown> | undefined)?.targetCpaMicros ?? (c.maximizeConversions as Record<string, unknown> | undefined)?.targetCpaMicros;
      const tr = (c.targetRoas as Record<string, unknown> | undefined)?.targetRoas ?? (c.maximizeConversionValue as Record<string, unknown> | undefined)?.targetRoas;
      return {
        id: String(c.id),
        name: String(c.name),
        status: String(c.status),
        type: String(c.advertisingChannelType ?? ""),
        bidding: String(c.biddingStrategyType ?? ""),
        targetCpa: micros(tc),
        targetRoas: tr == null ? null : Number(tr),
        budget: micros(r.campaignBudget?.amountMicros),
        serving: String(c.servingStatus ?? ""),
      };
    }),
    conversions: convs.map((r) => ({
      name: String(r.conversionAction?.name ?? ""),
      category: String(r.conversionAction?.category ?? ""),
      primary: Boolean(r.conversionAction?.primaryForGoal),
      counted: Boolean(r.conversionAction?.includeInConversionsMetric),
      status: String(r.conversionAction?.status ?? ""),
    })),
  };
}

/** What an audit reads beyond the daily numbers: ad groups, keywords, search terms, devices, impression share. Last 30 days. */
export async function googleAuditDetail(account: string) {
  const range = "segments.date DURING LAST_30_DAYS";
  const safe = (q: string) => search(account, q).catch(() => [] as Row[]);
  const [groups, keywords, terms, devices, share] = await Promise.all([
    safe(`SELECT campaign.name, ad_group.name, ad_group.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM ad_group WHERE ${range} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 25`),
    safe(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM keyword_view WHERE ${range} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 30`),
    safe(`SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE ${range} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 30`),
    safe(`SELECT segments.device, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE ${range}`),
    safe(`SELECT campaign.name, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.search_top_impression_share, metrics.cost_micros FROM campaign WHERE ${range} AND campaign.advertising_channel_type = 'SEARCH' AND metrics.cost_micros > 0`),
  ]);
  const $ = (r: Row) => Math.round(num(r.metrics?.costMicros) / 10_000) / 100;
  const cpa = (r: Row) => (num(r.metrics?.conversions) ? `$${Math.round(($(r) / num(r.metrics?.conversions)) * 100) / 100}/conv` : "no conversions");
  const pct = (v: unknown) => (v == null || v === "" ? "?" : `${Math.round(Number(v) * 100)}%`);
  const lines: string[] = [];
  lines.push("AD GROUPS, last 30 days (by spend)");
  for (const r of groups) lines.push(`- ${r.campaign?.name} › ${r.adGroup?.name} [${r.adGroup?.status}]: $${$(r)}, ${num(r.metrics?.clicks)} clicks, ${Math.round(num(r.metrics?.conversions) * 10) / 10} conv, ${cpa(r)}`);
  lines.push("\nKEYWORDS, last 30 days (by spend)");
  for (const r of keywords)
    lines.push(`- "${r.adGroupCriterion && (r.adGroupCriterion as { keyword?: { text?: string } }).keyword?.text}" ${String((r.adGroupCriterion as { keyword?: { matchType?: string } } | undefined)?.keyword?.matchType ?? "").toLowerCase()} (${r.campaign?.name}), QS ${(r.adGroupCriterion as { qualityInfo?: { qualityScore?: number } } | undefined)?.qualityInfo?.qualityScore ?? "?"}: $${$(r)}, ${num(r.metrics?.clicks)} clicks, ${Math.round(num(r.metrics?.conversions) * 10) / 10} conv, ${cpa(r)}`);
  lines.push("\nSEARCH TERMS, last 30 days (by spend)");
  for (const r of terms) lines.push(`- "${r.searchTermView?.searchTerm}" (${r.campaign?.name}): $${$(r)}, ${num(r.metrics?.clicks)} clicks, ${Math.round(num(r.metrics?.conversions) * 10) / 10} conv`);
  const byDevice = new Map<string, { cost: number; clicks: number; conv: number }>();
  for (const r of devices) {
    const k = String(r.segments?.device ?? "?");
    const d = byDevice.get(k) ?? { cost: 0, clicks: 0, conv: 0 };
    d.cost += $(r);
    d.clicks += num(r.metrics?.clicks);
    d.conv += num(r.metrics?.conversions);
    byDevice.set(k, d);
  }
  lines.push(`\nDEVICES, last 30 days: ${[...byDevice].map(([k, d]) => `${k.toLowerCase()} $${Math.round(d.cost)}, ${d.clicks} clicks, ${Math.round(d.conv)} conv${d.conv ? ` ($${Math.round((d.cost / d.conv) * 100) / 100}/conv)` : ""}`).join("; ") || "?"}`);
  lines.push("\nSEARCH IMPRESSION SHARE, last 30 days");
  for (const r of share) lines.push(`- ${r.campaign?.name}: ${pct(r.metrics?.searchImpressionShare)} share, lost ${pct(r.metrics?.searchBudgetLostImpressionShare)} to budget and ${pct(r.metrics?.searchRankLostImpressionShare)} to rank, top of page ${pct(r.metrics?.searchTopImpressionShare)} ($${$(r)})`);
  return { text: lines.join("\n"), counts: { adGroups: groups.length, keywords: keywords.length, searchTerms: terms.length } };
}

/** Every client account under the manager account (for Settings: what we can see, and which clients have no target). */
export async function managedAccounts() {
  const rows = await search(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID"), "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 2");
  return rows
    .filter((r) => !r.customerClient?.manager)
    .map((r) => ({ id: String(r.customerClient?.id), name: String(r.customerClient?.descriptiveName ?? ""), status: String(r.customerClient?.status ?? "") }));
}

/** The setup check: signs in and lists the manager account's clients. Names and counts only. */
export async function checkGoogleAds() {
  if (!googleAdsConfigured()) return { ok: false, detail: `Missing: ${googleAdsMissing().join("; ")}` };
  try {
    const list = await managedAccounts();
    const enabled = list.filter((a) => a.status === "ENABLED").length;
    return { ok: true, detail: `${list.length} client accounts under the manager account (${enabled} enabled)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What the Ideas tab reads from one account: every ad's copy and keyword and converting search term, with their totals
 * over the last 180 days and the last 30 (the Hall of Fame and live winners are worked out from these).
 */
export async function googleIdeaRows(account: string) {
  const id = digits(account);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const ago = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));
  const range = (n: number) => `segments.date BETWEEN '${ago(n)}' AND '${today}'`;
  const safe = (q: string) => search(id, q).catch(() => [] as Row[]);
  const ads = (n: number) =>
    safe(
      `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, campaign.name, campaign.status, ad_group.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE ${range(n)} AND metrics.cost_micros > 0 AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`,
    );
  const keywords = (n: number) =>
    safe(
      `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, campaign.name, campaign.status, ad_group.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE ${range(n)} AND metrics.cost_micros > 0`,
    );
  const terms = (n: number) =>
    safe(
      `SELECT search_term_view.search_term, campaign.name, ad_group.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${range(n)} AND metrics.conversions > 0`,
    );
  const totals = (n: number) => safe(`SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE ${range(n)}`);
  const [ads180, ads30, kw180, kw30, st180, st30, t180, t30] = await Promise.all([ads(180), ads(30), keywords(180), keywords(30), terms(180), terms(30), totals(180), totals(30)]);
  return { ads180, ads30, kw180, kw30, st180, st30, t180, t30 };
}
export type GoogleIdeaRow = Row;

/**
 * Keyword Planner: ideas around some seed searches, in the US and in English, with their average monthly searches, the
 * last 12 months, how competitive they are and what advertisers bid for the top of the page.
 */
export async function keywordIdeas(account: string, seeds: string[]) {
  const body = {
    language: "languageConstants/1000",
    geoTargetConstants: ["geoTargetConstants/2840"],
    includeAdultKeywords: false,
    keywordPlanNetwork: "GOOGLE_SEARCH",
    keywordSeed: { keywords: seeds.slice(0, 20) },
    pageSize: 150,
  };
  const out = JSON.parse(await post(account, ":generateKeywordIdeas", body)) as {
    results?: { text: string; keywordIdeaMetrics?: { avgMonthlySearches?: string; competition?: string; competitionIndex?: string; lowTopOfPageBidMicros?: string; highTopOfPageBidMicros?: string; monthlySearchVolumes?: { month: string; year: string; monthlySearches?: string }[] } }[];
  };
  return (out.results ?? []).map((r) => ({
    text: r.text,
    searches: Number(r.keywordIdeaMetrics?.avgMonthlySearches ?? 0),
    competition: (r.keywordIdeaMetrics?.competition ?? "UNSPECIFIED").toLowerCase(),
    competitionIndex: Number(r.keywordIdeaMetrics?.competitionIndex ?? 0),
    bidLow: Number(r.keywordIdeaMetrics?.lowTopOfPageBidMicros ?? 0) / 1e6,
    bidHigh: Number(r.keywordIdeaMetrics?.highTopOfPageBidMicros ?? 0) / 1e6,
    months: (r.keywordIdeaMetrics?.monthlySearchVolumes ?? []).map((m) => Number(m.monthlySearches ?? 0)),
  }));
}

/** Auction Insights: the other advertisers in one account's search auctions over the last 30 days (when the account's access allows it). */
export async function auctionInsights(account: string) {
  const rows = await search(
    digits(account),
    "SELECT segments.auction_insight_domain, metrics.auction_insight_search_impression_share, metrics.auction_insight_search_overlap_rate, metrics.auction_insight_search_outranking_share, metrics.auction_insight_search_position_above_rate, metrics.auction_insight_search_top_impression_percentage FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.advertising_channel_type = 'SEARCH'",
  );
  const by = new Map<string, { domain: string; impressionShare: number[]; overlap: number[]; outranking: number[]; above: number[]; top: number[] }>();
  for (const r of rows) {
    const domain = String(r.segments?.auctionInsightDomain ?? "");
    if (!domain) continue;
    const d = by.get(domain) ?? { domain, impressionShare: [], overlap: [], outranking: [], above: [], top: [] };
    const m = r.metrics ?? {};
    const push = (list: number[], v: unknown) => v != null && list.push(Number(v));
    push(d.impressionShare, m.auctionInsightSearchImpressionShare);
    push(d.overlap, m.auctionInsightSearchOverlapRate);
    push(d.outranking, m.auctionInsightSearchOutrankingShare);
    push(d.above, m.auctionInsightSearchPositionAboveRate);
    push(d.top, m.auctionInsightSearchTopImpressionPercentage);
    by.set(domain, d);
  }
  const avg = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
  return [...by.values()].map((d) => ({ domain: d.domain, impressionShare: avg(d.impressionShare), overlap: avg(d.overlap), outranking: avg(d.outranking), above: avg(d.above), top: avg(d.top) }));
}
