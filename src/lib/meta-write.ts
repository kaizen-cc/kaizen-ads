import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaConfigured, metaGraph, withMetaAccount } from "@/lib/context/meta";

// Every write Kaizen Ads makes to Meta goes through here: the launcher creating ads, and audit or sprint changes
// (pausing, budgets). Two guards, whatever asked:
// - the sandbox: while it's on (Settings), only Kaizen's own ad account can be written to; client accounts are refused
// - validate first: each write can be sent to Meta as a dry run (validate_only), which checks it in full and changes nothing

/** Kaizen's UTM template: Meta fills the {{…}} tags in with each ad's own source, campaign, ad set and ad. */
export const DEFAULT_URL_TAGS = "utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}";

/** urlTags: Kaizen's UTM template, added to every launched ad's link (e.g. utm_source=facebook&utm_medium=paid) */
export type MetaWriteSetting = { sandbox: boolean; sandboxAccount: string; urlTags?: string | null };

const bare = (a: string) => a.replace(/^act_/, "").replace(/\D/g, "");

export async function metaWriteSetting(admin: SupabaseClient): Promise<MetaWriteSetting> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "meta_write").maybeSingle();
  const v = (data?.value ?? {}) as Partial<MetaWriteSetting>;
  // Missing or unreadable: the safe side
  return { sandbox: v.sandbox !== false, sandboxAccount: bare(v.sandboxAccount ?? "795029519154776"), urlTags: v.urlTags === undefined || v.urlTags === null ? DEFAULT_URL_TAGS : v.urlTags.trim() || null };
}

/** Each platform's own per-client switch (Team & setup): live_ad_writes is Meta, live_google_writes is Google Ads */
export const LIVE_COLUMN = { meta: "live_ad_writes", google: "live_google_writes" } as const;

/**
 * The ad accounts of clients an exec switched live changes on for, on this platform. Meta and Google Ads are switched
 * separately: a client live in Meta isn't live in Google Ads.
 */
export async function liveAccounts(admin: SupabaseClient, platform: "meta" | "google") {
  const { data: on } = await admin.from("clients").select("id").eq(LIVE_COLUMN[platform], true).is("archived_at", null);
  const ids = (on ?? []).map((c) => c.id as string);
  if (!ids.length) return new Set<string>();
  const { data: t } = await admin.from("kpi_targets").select("ad_account_id").in("client_id", ids).eq("platform", platform);
  return new Set((t ?? []).map((x) => bare(String(x.ad_account_id ?? ""))).filter(Boolean));
}

export type WriteAccount = { account: string; label: string | null; targetId: string; active: boolean };

/**
 * The ad accounts on this platform that a client's live switch opens: read exactly as liveAccounts reads them (the
 * client's KPI targets on the platform, any with an account), so what Team & setup shows is where writes can go.
 */
export async function clientWriteAccounts(admin: SupabaseClient, clientId: string, platform: "meta" | "google"): Promise<WriteAccount[]> {
  const { data: t } = await admin.from("kpi_targets").select("id, ad_account_id, label, active").eq("client_id", clientId).eq("platform", platform);
  const out = new Map<string, WriteAccount>();
  for (const x of t ?? []) {
    const account = bare(String(x.ad_account_id ?? ""));
    if (!account) continue;
    const prev = out.get(account);
    // One line per account: the active target's label wins
    if (!prev || (!prev.active && x.active)) out.set(account, { account, label: (x.label as string | null) || prev?.label || null, targetId: x.id as string, active: x.active !== false || Boolean(prev?.active) });
  }
  return [...out.values()];
}

/**
 * Whether changes may be written to this Google Ads account: only when an exec switched live changes in Google Ads on
 * for the client that owns it. There's no switch for everyone: each client is switched on by hand.
 */
export async function googleWritesOn(admin: SupabaseClient, account?: string | null) {
  const id = String(account ?? "").replace(/\D/g, "");
  if (!id) return false;
  return (await liveAccounts(admin, "google")).has(id);
}

export const GOOGLE_OFF = "Live changes in Google Ads are off for this client: an exec switches them on in the client's Team & setup. Until then, do it by hand from the checklist.";

/** Why this account can't be written to right now, or null when it can. */
export async function writeBlocked(admin: SupabaseClient, account: string): Promise<string | null> {
  if (!metaConfigured()) return "Meta isn't connected.";
  const s = await metaWriteSetting(admin);
  if (s.sandbox && bare(account) !== s.sandboxAccount && !(await liveAccounts(admin, "meta")).has(bare(account)))
    return "Live changes in Meta are off for this client: an exec switches them on in the client's Team & setup (or for everyone in Settings → Sync health).";
  return null;
}

/**
 * A write to Meta (POST), gated by the sandbox. validateOnly: Meta checks it completely and changes nothing.
 * `account` is the ad account the write belongs to (the gate checks it even when the path is an ad or ad set ID).
 */
export async function metaWrite<T = { id?: string; success?: boolean }>(admin: SupabaseClient, account: string, path: string, params: Record<string, string>, validateOnly: boolean): Promise<T> {
  const blocked = await writeBlocked(admin, account);
  if (blocked) throw new Error(blocked);
  // The token that can manage this account: a client business's when one does, otherwise Kaizen's own
  return metaGraph<T>(path, { ...params, ...(validateOnly ? { execution_options: JSON.stringify(["validate_only"]) } : {}) }, "POST", { account, write: true });
}

/**
 * The object an ID belongs to, read fresh: which ad account owns it (so a write can't be aimed at another account).
 * account: the account it's expected in, so it's read with the token that reaches that account.
 */
export async function ownerAccount(objectId: string, account?: string | null): Promise<string | null> {
  const r = await metaGraph<{ account_id?: string }>(objectId, { fields: "account_id" }, "GET", { account: account ?? null }).catch(() => null);
  return r?.account_id ? bare(r.account_id) : null;
}

/**
 * Can Kaizen Ads write to this account? A dry run of creating a paused campaign there: Meta checks the token's
 * permission (ads_management), the system user's role on the account, and the account's state, and creates nothing.
 */
// What the system user's token must carry: ads for the account, and the Page permissions Meta needs to create the
// hidden Page post behind every ad with text options or per-placement sizes
const NEEDED = ["ads_management", "ads_read", "business_management", "pages_manage_ads", "pages_read_engagement", "pages_show_list"];

/** The permissions the token was generated with, and the ones the launcher needs that it's missing (account: the token that changes it). */
export async function tokenScopes(account?: string | null) {
  const r = await metaGraph<{ data: { permission: string; status: string }[] }>("me/permissions", {}, "GET", account ? { account, write: true } : {}).catch(() => null);
  const granted = (r?.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
  return { granted, missing: r ? NEEDED.filter((n) => !granted.includes(n)) : [] };
}

const TASKS: Record<string, string> = { MANAGE: "manage the account", ADVERTISE: "manage campaigns", ANALYZE: "view performance", DRAW: "create ads (no publishing)" };

/** Meta's permission errors are vague: ask Meta what the token's user may do on this account, and who owns it, in plain words. */
export async function diagnoseAccess(account: string): Promise<string> {
  const id = bare(account);
  type Acct = { name?: string; user_tasks?: string[]; business?: { name?: string; id?: string } };
  // Asked with the token a change to this account actually uses
  const on = { account: id, write: true };
  const [acct, me, scopes, via] = await Promise.all([
    metaGraph<Acct>(`act_${id}`, { fields: "name,user_tasks,business{name,id}" }, "GET", on).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    metaGraph<{ name?: string; id?: string }>("me", { fields: "id,name" }, "GET", on).catch(() => null),
    tokenScopes(id),
    viaBusiness(id),
  ]);
  const who = `${me?.name ? `The system user "${me.name}" (${me.id})` : "The system user"} ${via.label}`;
  if (scopes.missing.includes("ads_management"))
    return via.client
      ? `${who}: its token was generated without ads_management (it has ${scopes.granted.join(", ") || "nothing readable"}). In ${via.name}'s Business Manager: Users → System users → Generate new token with ads_management ticked, then Replace it in the client's Team & setup.`
      : `${who}: its token was generated without ads_management (it has ${scopes.granted.join(", ") || "nothing readable"}). In Business Manager: Users → System users → Generate new token with ads_management ticked, then replace META_SYSTEM_USER_TOKEN in Vercel and redeploy.`;
  if ("error" in acct) return `${who} can't even read ad account ${id}: ${acct.error}`;
  const tasks = acct.user_tasks ?? [];
  const owner = acct.business?.name ? `owned by the business "${acct.business.name}" (${acct.business.id})` : "owner not visible";
  const can = tasks.length ? tasks.map((t) => TASKS[t] ?? t.toLowerCase()).join(", ") : "nothing";
  if (!tasks.includes("ADVERTISE") && !tasks.includes("MANAGE"))
    return `${who} can only ${can} on "${acct.name ?? id}" (${id}, ${owner}). It needs Manage campaigns: Business settings → Accounts → Ad accounts → this account → Assign people → the system user → turn on Manage campaigns. If the account is shared to us as a partner, the partner share must include Manage campaigns first (the owner raises it). No new token is needed.`;
  return `${who} has ${can} on "${acct.name ?? id}" (${id}, ${owner}) and the token has ads_management, so Meta is refusing for another reason: often the app itself isn't approved for ads_management (Advanced Access) or the system user's role in our Business Manager is Employee instead of Admin.`;
}

/** Which business a change to this account goes through: a connected client business, or Kaizen's own. */
export async function viaBusiness(account: string): Promise<{ client: boolean; name: string; label: string }> {
  const { metaTokenVia } = await import("@/lib/meta-tokens");
  const v = await metaTokenVia(bare(account), { write: true }).catch(() => null);
  if (v) {
    const name = v.businessName || "the client";
    return { client: true, name, label: `via ${name}'s business` };
  }
  return { client: false, name: "Kaizen", label: "via Kaizen's business" };
}

export async function writeAccess(admin: SupabaseClient, account: string): Promise<{ ok: boolean; detail: string }> {
  const blocked = await writeBlocked(admin, account);
  if (blocked) return { ok: false, detail: blocked };
  const [scopes, via] = await Promise.all([tokenScopes(account), viaBusiness(account)]);
  if (scopes.missing.length)
    return {
      ok: false,
      detail: via.client
        ? `The token ${via.label} is missing ${scopes.missing.join(", ")}. In ${via.name}'s Business Manager, generate a new token for the system user with those permissions ticked, then Replace it in the client's Team & setup. It has now: ${scopes.granted.join(", ") || "nothing readable"}.`
        : `The system user's token is missing ${scopes.missing.join(", ")}. Generate a new token for the system user in Business Manager (Users → System users → Generate new token) with those permissions ticked, then replace META_SYSTEM_USER_TOKEN in Vercel. It has now: ${scopes.granted.join(", ") || "nothing readable"}.`,
    };
  try {
    await metaWrite(admin, account, `act_${bare(account)}/campaigns`, { name: "Kaizen Ads access check", objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" }, true);
    return { ok: true, detail: `Kaizen Ads can create and change ads here, ${via.label} (checked with Meta, nothing was created).` };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const hint = /permission|not authorized|ads_management|\(#200\)|\(#10\)/i.test(m)
      ? " The system user needs the ads_management permission and Manage campaigns on this ad account in Business Manager."
      : /disabled|unsettled|closed/i.test(m)
        ? " The ad account isn't active (billing or a restriction)."
        : "";
    return { ok: false, detail: `${m}${hint}${/permission|not authorized|\(#200\)|\(#10\)/i.test(m) ? `

${await diagnoseAccess(account).catch(() => "")}` : ""}` };
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

/** Kaizen's own Business Manager: the business our system user acts through when it changes a client's account. */
export type KaizenBusiness = { id: string; name: string; source: "env" | "graph" };

let businessCache: { at: number; value: KaizenBusiness | null } | null = null;

/**
 * Which Business Manager is ours. META_BUSINESS_ID when it's set (its name read from Meta); otherwise asked of Meta: the
 * businesses the system user belongs to (a system user belongs to exactly one), then its own business field. Kept in
 * memory for 6 hours (a miss for 10 minutes), so a page of 60 accounts asks once.
 */
export async function kaizenBusiness(): Promise<KaizenBusiness | null> {
  if (businessCache && Date.now() - businessCache.at < (businessCache.value ? 6 * 3_600_000 : 600_000)) return businessCache.value;
  let value: KaizenBusiness | null = null;
  const env = (process.env.META_BUSINESS_ID ?? "").replace(/\D/g, "");
  if (env) {
    const r = metaConfigured() ? await metaGraph<{ name?: string }>(env, { fields: "name" }).catch(() => null) : null;
    value = { id: env, name: r?.name || "Kaizen Marketing", source: "env" };
  } else if (metaConfigured()) {
    const list = await metaGraph<{ data?: { id: string; name?: string }[] }>("me/businesses", { fields: "id,name", limit: "5" }).catch(() => null);
    const first = list?.data?.[0];
    if (first?.id) value = { id: first.id, name: first.name || "Kaizen Marketing", source: "graph" };
    else {
      const me = await metaGraph<{ business?: { id?: string; name?: string } }>("me", { fields: "business{id,name}" }).catch(() => null);
      if (me?.business?.id) value = { id: me.business.id, name: me.business.name || "Kaizen Marketing", source: "graph" };
    }
  }
  businessCache = { at: Date.now(), value };
  return value;
}

/**
 * Where Meta's Custom Audience terms are accepted for an ad account. With business_id they're accepted on behalf of
 * Kaizen's Business Manager, the business our system user changes the account through. Accepted as the client's own
 * business, Meta can still refuse our changes, because the terms are held per business.
 */
export const audienceTermsUrl = (account: string, businessId?: string | null) =>
  `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${bare(account)}${businessId ? `&business_id=${businessId}` : ""}`;

/** none: not assigned · view: view only · terms: uses customer lists without the terms · ready: every change goes through */
export type AccessStatus = "none" | "view" | "terms" | "ready";

/**
 * access: what our system user may do on the account. "manage" (Manage campaigns or full control: changes go through),
 * "view" (assigned but view-only: Meta refuses every change), "none" (not assigned: Meta won't even show it to us).
 * usesLists: whether the account has any customer-list audience (null: not looked up, or couldn't tell). Without one,
 * missing terms block nothing. status: the one group the account belongs in, worked out here so every count and list
 * reads the same thing.
 */
export type AudienceTerms = {
  account: string;
  name: string | null;
  accepted: boolean | null;
  usesLists: boolean | null;
  tosKeys: string[];
  error: string | null;
  url: string;
  /** The client business a change goes through (its own connected token), or null for Kaizen's */
  via: string | null;
  access: "manage" | "view" | "none";
  tasks: string[];
  owner: string | null;
  assignUrl: string;
  status: AccessStatus;
};

/** Business settings for the ad account, where the system user is assigned (Assign people → Manage campaigns) */
export const assignUrl = (account: string) => `https://business.facebook.com/settings/ad-accounts/${bare(account)}`;

// The tos_accepted keys that mean the customer-list (Custom Audience) terms. custom_audience_tos is the one Meta checks
// for uploaded lists; value_based_custom_audience_tos is read too in case Meta reports it under that name
const LIST_TOS = ["custom_audience_tos", "value_based_custom_audience_tos"];

/** Does the account have any customer-list audience? Filtered by Meta first, by hand if the filter is refused. */
async function hasCustomerLists(id: string): Promise<boolean | null> {
  type L = { data?: { subtype?: string }[]; paging?: { next?: string } };
  const filtered = await metaGraph<L>(`act_${id}/customaudiences`, { fields: "subtype", filtering: JSON.stringify([{ field: "subtype", operator: "EQUAL", value: "CUSTOM" }]), limit: "1" }).catch(() => null);
  // Something other than a list back means Meta ignored the filter: read them all instead
  if (filtered?.data && filtered.data.every((a) => !a.subtype || a.subtype === "CUSTOM")) return filtered.data.length > 0;
  const all = await metaGraph<L>(`act_${id}/customaudiences`, { fields: "subtype", limit: "200" }).catch(() => null);
  if (!all?.data) return null;
  // More than one page and no list on the first: can't tell, so it counts as used
  return all.data.some((a) => a.subtype === "CUSTOM") ? true : all.paging?.next ? null : false;
}

/**
 * Can our system user change each ad account, and does it hold Meta's Custom Audience terms? Without the terms Meta
 * refuses any change to an ad set that targets an uploaded customer list, pausing included, so they only matter on
 * accounts that use customer lists: every account missing them is checked for one. A few accounts at a time.
 */
export async function audienceTerms(accounts: string[]): Promise<AudienceTerms[]> {
  const ids = [...new Set(accounts.map(bare).filter(Boolean))];
  const business = await kaizenBusiness().catch(() => null);
  const keysSeen = new Map<string, number>();
  const out: AudienceTerms[] = [];
  for (let i = 0; i < ids.length; i += 8)
    out.push(
      ...(await Promise.all(
        ids.slice(i, i + 8).map(async (id): Promise<AudienceTerms> => {
          // Checked with the token a change to this account uses: a client business's own, or Kaizen's. Through a
          // client's token, the terms are the client business's to accept
          const { metaTokenVia } = await import("@/lib/meta-tokens");
          const via = await metaTokenVia(id, { write: true }).catch(() => null);
          const url = audienceTermsUrl(id, via ? via.businessId : business?.id);
          const viaName = via ? via.businessName || "the client" : null;
          try {
            const r = await metaGraph<{ name?: string; tos_accepted?: Record<string, number | boolean> | null; user_tasks?: string[]; business?: { name?: string } }>(`act_${id}`, { fields: "name,tos_accepted,user_tasks,business{name}" }, "GET", { account: id, write: true });
            const tasks = r.user_tasks ?? [];
            const access = tasks.includes("ADVERTISE") || tasks.includes("MANAGE") ? ("manage" as const) : ("view" as const);
            const tos = r.tos_accepted && typeof r.tos_accepted === "object" ? r.tos_accepted : {};
            const tosKeys = Object.keys(tos).sort();
            for (const k of tosKeys) keysSeen.set(k, (keysSeen.get(k) ?? 0) + 1);
            const accepted = LIST_TOS.some((k) => Boolean(tos[k]));
            const usesLists = access === "manage" && !accepted ? await withMetaAccount(id, () => hasCustomerLists(id)) : null;
            const status: AccessStatus = access === "view" ? "view" : !accepted && usesLists !== false ? "terms" : "ready";
            return { account: id, name: r.name ?? null, accepted, usesLists, tosKeys, error: null, url, via: viaName, access, tasks, owner: r.business?.name ?? null, assignUrl: assignUrl(id), status };
          } catch (e) {
            // Unreadable: almost always the system user isn't assigned to the account (or it was removed)
            return { account: id, name: null, accepted: null, usesLists: null, tosKeys: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200), url, via: viaName, access: "none", tasks: [], owner: null, assignUrl: assignUrl(id), status: "none" };
          }
        }),
      )),
    );
  // What Meta actually reports in tos_accepted, to check against accounts the terms were accepted on
  if (ids.length)
    console.info(`[audience-terms] ${ids.length} accounts · business ${business ? `${business.id} (${business.source})` : "unknown"} · tos_accepted keys: ${[...keysSeen].map(([k, n]) => `${k}=${n}`).join(", ") || "none"}`);
  return out;
}
