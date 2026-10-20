import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JWT } from "google-auth-library";

// Google Ads: campaign numbers per day for every client account with a Google KPI target, read through Kaizen's
// manager (MCC) account. The same shape as Meta's daily rows, so the KPI board, audits, the daily recap and
// notifications treat both alike. Read-only.
//
// What it needs in Vercel:
//   GOOGLE_ADS_DEVELOPER_TOKEN   from the manager account's API Center (needs Basic access to read client accounts)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID the manager (MCC) account's ID, digits only
// and one way to sign in, either:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN   (OAuth, as a user with MCC access), or
//   GOOGLE_ADS_USER   a Workspace user with MCC access, signed in as through the existing service account
//                     (add the https://www.googleapis.com/auth/adwords scope to its domain-wide delegation)
// Optional: GOOGLE_ADS_API_VERSION (default below).

const VERSION = process.env.GOOGLE_ADS_API_VERSION || "v26";
const SCOPE = "https://www.googleapis.com/auth/adwords";
const BACKFILL_DAYS = 200;

const env = (k: string) => process.env[k]?.trim() || "";
const oauth = () => Boolean(env("GOOGLE_ADS_CLIENT_ID") && env("GOOGLE_ADS_CLIENT_SECRET") && env("GOOGLE_ADS_REFRESH_TOKEN"));
const delegated = () => Boolean(env("GOOGLE_ADS_USER") && env("GOOGLE_SERVICE_ACCOUNT_JSON"));
export const googleAdsConfigured = () => Boolean(env("GOOGLE_ADS_DEVELOPER_TOKEN") && env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") && (oauth() || delegated()));
/** What's still missing, in plain words, for Sync health and the KPI board. */
export function googleAdsMissing(): string[] {
  const out: string[] = [];
  if (!env("GOOGLE_ADS_DEVELOPER_TOKEN")) out.push("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (!env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")) out.push("GOOGLE_ADS_LOGIN_CUSTOMER_ID (the MCC's ID)");
  if (!oauth() && !delegated()) out.push("a sign-in: GOOGLE_ADS_USER, or the OAuth client ID, secret and refresh token");
  return out;
}
export const digits = (id: string) => id.replace(/\D/g, "");

let cached: { token: string; until: number } | null = null;
async function accessToken() {
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

/** A GAQL query against one customer, every row (searchStream sends them all in one response). */
async function search(customer: string, query: string): Promise<Row[]> {
  const res = await fetch(`https://googleads.googleapis.com/${VERSION}/customers/${digits(customer)}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"),
      "login-customer-id": digits(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(explain(text, res.status));
  const chunks = JSON.parse(text) as { results?: Row[] }[];
  return chunks.flatMap((c) => c.results ?? []);
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
    if (code === "DEVELOPER_TOKEN_NOT_APPROVED" || /developer token is only approved for use with test accounts/i.test(msg)) return "The developer token only has test access. Apply for Basic access in the MCC's API Center.";
    if (code === "CUSTOMER_NOT_ENABLED") return "This Google Ads account isn't enabled (cancelled or suspended).";
    if (status === 404 || /unsupported|deprecated/i.test(msg)) return `Google Ads API ${VERSION} isn't available. Set GOOGLE_ADS_API_VERSION to a current version. (${msg})`;
  } catch {
    /* not JSON: keep the raw text */
  }
  return `Google Ads: ${msg}`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => Number(v) || 0;

/** New and revised days for one Google Ads account (the last 3 days are re-read: conversions keep coming in). */
export async function syncGoogleCampaigns(admin: SupabaseClient, account: string) {
  const id = digits(account);
  const { data: last } = await admin.from("google_campaign_daily").select("date").eq("ad_account_id", id).order("date", { ascending: false }).limit(1).maybeSingle();
  const now = new Date();
  const since = last ? new Date(new Date(`${last.date}T12:00:00Z`).getTime() - 3 * 86_400_000) : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const range = `segments.date BETWEEN '${ymd(since)}' AND '${now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}'`;
  const [base, byAction] = await Promise.all([
    search(id, `SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${range}`),
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
      actions: { conversions: num(r.metrics?.conversions), ...extra.a },
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
