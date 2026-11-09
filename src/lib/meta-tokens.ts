import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { bareAccount, checkDebugToken, encryptionKey, last4, NO_KEY, pickToken, redactTokens, seal, tasksCanManage, unseal, type DebugToken, type TokenReach } from "@/lib/meta-token-core";

// Client Business Manager tokens: one per client business whose ad accounts Kaizen's own system user can't reach.
// Stored encrypted (TOKEN_ENCRYPTION_KEY), decrypted only here on the server, never logged, never sent to a browser,
// an AI prompt or the chat. metaTokenFor() says which token a Graph call to an ad account uses.

export const tokenEncryptionConfigured = () => Boolean(encryptionKey(process.env.TOKEN_ENCRYPTION_KEY));

type Row = {
  id: string;
  business_id: string | null;
  business_name: string | null;
  label: string | null;
  token_iv: string | null;
  token_tag: string | null;
  token_ciphertext: string | null;
  token_last4: string | null;
  scopes: string[] | null;
  expires_at: string | null;
  app_id: string | null;
  system_user_id: string | null;
  system_user_name: string | null;
  client_id: string | null;
  created_by: string | null;
  created_at: string;
  last_checked_at: string | null;
  last_error: string | null;
  status: "active" | "invalid" | "revoked";
};

// ─── Resolution, cached a minute ─────────────────────────────────────────

type Cache = { at: number; reach: TokenReach[]; tokens: Map<string, { token: string; businessId: string | null; businessName: string | null }> };
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
const TTL = 60_000;

/** Forget what's cached (after a token is saved, replaced, checked or removed). */
export function clearTokenCache() {
  cache = null;
  loading = null;
}

async function load(): Promise<Cache> {
  const empty: Cache = { at: Date.now(), reach: [], tokens: new Map() };
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key || !adminConfigured()) return empty;
  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("meta_business_tokens").select("id, business_id, business_name, token_iv, token_tag, token_ciphertext, created_at, status").eq("status", "active");
  // The tables not there yet (migration not applied) or unreadable: Kaizen's own token everywhere
  if (error || !rows?.length) return empty;
  const tokens = new Map<string, { token: string; businessId: string | null; businessName: string | null }>();
  for (const r of rows) {
    if (!r.token_iv || !r.token_tag || !r.token_ciphertext) continue;
    try {
      tokens.set(r.id as string, { token: unseal({ iv: r.token_iv, tag: r.token_tag, ciphertext: r.token_ciphertext }, key), businessId: (r.business_id as string) ?? null, businessName: (r.business_name as string) ?? null });
    } catch {
      console.error(`[meta-tokens] token ${r.id} couldn't be decrypted (TOKEN_ENCRYPTION_KEY changed?); Kaizen's own token is used instead`);
    }
  }
  if (!tokens.size) return empty;
  const created = new Map(rows.map((r) => [r.id as string, r.created_at as string]));
  const { data: acc } = await admin.from("meta_business_token_accounts").select("business_token_id, ad_account_id, can_manage").in("business_token_id", [...tokens.keys()]);
  const reach: TokenReach[] = (acc ?? []).map((a) => ({ tokenId: a.business_token_id as string, account: bareAccount(a.ad_account_id as string), canManage: a.can_manage === true, status: "active", createdAt: created.get(a.business_token_id as string) ?? null }));
  return { at: Date.now(), reach, tokens };
}

async function current(): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  if (!loading)
    loading = load()
      .catch(() => ({ at: Date.now(), reach: [], tokens: new Map() }) as Cache)
      .then((c) => {
        cache = c;
        loading = null;
        return c;
      });
  return loading;
}

export type TokenVia = { tokenId: string; businessId: string | null; businessName: string | null };

/**
 * The client business token for a Graph call to this ad account, or null for Kaizen's own. write: only a token that
 * can manage the account.
 */
export async function metaTokenFor(account: string, opts: { write?: boolean } = {}): Promise<({ token: string } & TokenVia) | null> {
  const c = await current();
  if (!c.tokens.size) return null;
  const id = pickToken(account, c.reach, Boolean(opts.write));
  const t = id ? c.tokens.get(id) : null;
  return id && t ? { token: t.token, tokenId: id, businessId: t.businessId, businessName: t.businessName } : null;
}

/** Which business a call to this account goes through (no token): for the access checks on screen. */
export async function metaTokenVia(account: string, opts: { write?: boolean } = {}): Promise<TokenVia | null> {
  const hit = await metaTokenFor(account, opts);
  return hit ? { tokenId: hit.tokenId, businessId: hit.businessId, businessName: hit.businessName } : null;
}

/** Every active client business token: tried, read only, on an object Kaizen's own token can't see. */
export async function clientTokens(): Promise<string[]> {
  return [...(await current()).tokens.values()].map((t) => t.token);
}

// ─── Asking Meta about a token ───────────────────────────────────────────

const graphAs = async <T>(token: string, path: string, params: Record<string, string> = {}) => (await import("@/lib/context/meta")).metaGraphAs<T>(token, path, params);

/** What Meta says about a token, asked with the token itself (Kaizen has no app secret to ask with). */
async function debugToken(token: string): Promise<DebugToken | null> {
  const r = await graphAs<{ data?: DebugToken }>(token, "debug_token", { input_token: token });
  return r.data ?? null;
}

let kaizenApp: { at: number; id: string | null } | null = null;

/** Kaizen's app: the app Kaizen's own token was made with (asked of Meta, kept 6 hours). */
export async function kaizenAppId(): Promise<string | null> {
  if (kaizenApp && Date.now() - kaizenApp.at < (kaizenApp.id ? 6 * 3_600_000 : 300_000)) return kaizenApp.id;
  const own = process.env.META_SYSTEM_USER_TOKEN;
  const id = own ? ((await debugToken(own).catch(() => null))?.app_id ?? null) : null;
  kaizenApp = { at: Date.now(), id: id ? String(id) : null };
  return kaizenApp.id;
}

type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };
type Acct = { account_id?: string; id?: string; name?: string; user_tasks?: string[] };

async function allPages<T>(token: string, path: string, params: Record<string, string>, max = 10): Promise<T[]> {
  const out: T[] = [];
  let after = "";
  for (let i = 0; i < max; i++) {
    const r = await graphAs<Paged<T>>(token, path, { ...params, limit: "200", ...(after ? { after } : {}) });
    out.push(...(r.data ?? []));
    after = r.paging?.next ? (r.paging.cursors?.after ?? "") : "";
    if (!after) break;
  }
  return out;
}

export type Inspected = {
  scopes: string[];
  expiresAt: string | null;
  appId: string;
  missingSuggested: string[];
  systemUser: { id: string | null; name: string | null };
  business: { id: string | null; name: string | null };
  accounts: { account: string; name: string | null; canManage: boolean }[];
};

/**
 * Everything about a pasted token, or why it can't be used: valid, Kaizen's app, the right permissions, the system
 * user and its business, and the ad accounts it reaches (the system user's own, plus the business's owned and client
 * accounts it has a role on).
 */
export async function inspectToken(token: string): Promise<{ ok: true; info: Inspected } | { ok: false; reason: string }> {
  try {
    const appId = await kaizenAppId();
    if (!appId) return { ok: false, reason: "Couldn't read Kaizen's own Meta token to confirm which app is Kaizen's. Check Meta is connected (Settings › Sync health), then try again." };
    const check = checkDebugToken(await debugToken(token), appId);
    if (!check.ok) return check;
    const me = await graphAs<{ id?: string; name?: string }>(token, "me", { fields: "id,name" }).catch(() => null);
    const biz =
      (await graphAs<Paged<{ id: string; name?: string }>>(token, "me/businesses", { fields: "id,name", limit: "5" }).catch(() => null))?.data?.[0] ??
      (await graphAs<{ business?: { id: string; name?: string } }>(token, "me", { fields: "business{id,name}" }).catch(() => null))?.business ??
      null;
    const found = new Map<string, Inspected["accounts"][number]>();
    const add = (a: Acct, assigned: boolean) => {
      const id = bareAccount(a.account_id ?? a.id);
      if (!id) return;
      // Seen through the business, it only counts when the system user has a role on it
      if (!assigned && !(a.user_tasks ?? []).length) return;
      const prev = found.get(id);
      found.set(id, { account: id, name: a.name ?? prev?.name ?? null, canManage: tasksCanManage(a.user_tasks) || Boolean(prev?.canManage) });
    };
    for (const a of await allPages<Acct>(token, "me/adaccounts", { fields: "account_id,name,user_tasks" })) add(a, true);
    if (biz?.id)
      for (const edge of ["owned_ad_accounts", "client_ad_accounts"])
        for (const a of await allPages<Acct>(token, `${biz.id}/${edge}`, { fields: "account_id,name,user_tasks" }).catch(() => [] as Acct[])) add(a, false);
    return {
      ok: true,
      info: {
        scopes: check.scopes,
        expiresAt: check.expiresAt,
        appId: check.appId,
        missingSuggested: check.missingSuggested,
        systemUser: { id: me?.id ?? null, name: me?.name ?? null },
        business: { id: biz?.id ?? null, name: biz?.name ?? null },
        accounts: [...found.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      },
    };
  } catch (e) {
    return { ok: false, reason: redactTokens(e instanceof Error ? e.message : String(e), [token]) };
  }
}

// ─── Saving, checking, removing ───────────────────────────────────────────

async function saveAccounts(admin: SupabaseClient, tokenId: string, accounts: Inspected["accounts"]) {
  const at = new Date().toISOString();
  await admin.from("meta_business_token_accounts").delete().eq("business_token_id", tokenId);
  if (accounts.length)
    await admin.from("meta_business_token_accounts").insert(accounts.map((a) => ({ business_token_id: tokenId, ad_account_id: a.account, account_name: a.name, can_manage: a.canManage, checked_at: at })));
}

/**
 * Save a client business's token after Meta confirms it. A token for a business that already has one replaces it
 * (same row). replaceId: the row an exec chose to replace.
 */
export async function saveBusinessToken(admin: SupabaseClient, o: { token: string; label?: string | null; clientId?: string | null; by: string; replaceId?: string | null }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key) return { ok: false, error: NO_KEY };
  const token = o.token.trim().replace(/^Bearer\s+/i, "");
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return { ok: false, error: "That doesn't look like a Meta access token. Copy the whole token the system user generated." };
  if (token === process.env.META_SYSTEM_USER_TOKEN) return { ok: false, error: "That's Kaizen's own token. Paste the token from the system user in the client's Business Manager." };
  const seen = await inspectToken(token);
  if (!seen.ok) return { ok: false, error: seen.reason };
  const i = seen.info;
  if (!i.accounts.length) return { ok: false, error: "The token works, but its system user has no ad accounts. In the client's Business Manager, assign their ad accounts to the system user (Manage campaigns), then paste it again." };
  const s = seal(token, key);
  const now = new Date().toISOString();
  const fields = {
    business_id: i.business.id,
    business_name: i.business.name,
    token_iv: s.iv,
    token_tag: s.tag,
    token_ciphertext: s.ciphertext,
    token_last4: last4(token),
    scopes: i.scopes,
    expires_at: i.expiresAt,
    app_id: i.appId,
    system_user_id: i.systemUser.id,
    system_user_name: i.systemUser.name,
    last_checked_at: now,
    last_error: null,
    status: "active",
  };
  let existing: string | null = o.replaceId ?? null;
  if (!existing && i.business.id) {
    const { data } = await admin.from("meta_business_tokens").select("id").eq("business_id", i.business.id).neq("status", "revoked").maybeSingle();
    existing = (data?.id as string) ?? null;
  }
  let id: string;
  if (existing) {
    const { error } = await admin.from("meta_business_tokens").update({ ...fields, ...(o.label !== undefined ? { label: o.label?.trim() || null } : {}) }).eq("id", existing);
    if (error) return { ok: false, error: redactTokens(error.message, [token]) };
    id = existing;
  } else {
    const { data, error } = await admin.from("meta_business_tokens").insert({ ...fields, label: o.label?.trim() || null, client_id: o.clientId ?? null, created_by: o.by }).select("id").single();
    if (error || !data) return { ok: false, error: redactTokens(error?.message ?? "Couldn't save.", [token]) };
    id = data.id as string;
  }
  await saveAccounts(admin, id, i.accounts);
  clearTokenCache();
  return { ok: true, id };
}

/**
 * Ask Meta about a saved token again: still valid, still Kaizen's app and permissions, and which ad accounts it
 * reaches now. Invalid tokens stop being used (status invalid). A Meta outage only notes the error.
 */
export async function checkBusinessToken(admin: SupabaseClient, id: string): Promise<{ ok: boolean; status: Row["status"]; error: string | null; becameInvalid: boolean }> {
  const { data: r } = await admin.from("meta_business_tokens").select("*").eq("id", id).maybeSingle();
  const row = r as Row | null;
  if (!row || row.status === "revoked") return { ok: false, status: "revoked", error: "This connection was removed.", becameInvalid: false };
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  if (!key) {
    await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: NO_KEY }).eq("id", id);
    return { ok: false, status: row.status, error: NO_KEY, becameInvalid: false };
  }
  let token: string;
  try {
    token = unseal({ iv: row.token_iv!, tag: row.token_tag!, ciphertext: row.token_ciphertext! }, key);
  } catch {
    const error = "The saved token can't be decrypted (TOKEN_ENCRYPTION_KEY changed). Paste the token again with Replace.";
    await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: error, status: "invalid" }).eq("id", id);
    clearTokenCache();
    return { ok: false, status: "invalid", error, becameInvalid: row.status === "active" };
  }
  const seen = await inspectToken(token);
  if (!seen.ok) {
    // Meta refusing the token itself (expired, revoked, wrong app, permissions removed) makes it invalid; a network
    // blip or Meta being busy doesn't
    const refused = /isn't valid|another app|missing|expired|session|\(#190\)|access token|OAuthException|Error validating/i.test(seen.reason);
    const status = refused ? "invalid" : row.status;
    await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: seen.reason.slice(0, 500), status }).eq("id", id);
    clearTokenCache();
    return { ok: false, status, error: seen.reason, becameInvalid: refused && row.status === "active" };
  }
  const i = seen.info;
  await admin
    .from("meta_business_tokens")
    .update({ business_id: i.business.id ?? row.business_id, business_name: i.business.name ?? row.business_name, scopes: i.scopes, expires_at: i.expiresAt, app_id: i.appId, system_user_id: i.systemUser.id, system_user_name: i.systemUser.name, last_checked_at: now, last_error: null, status: "active" })
    .eq("id", id);
  await saveAccounts(admin, id, i.accounts);
  clearTokenCache();
  return { ok: true, status: "active", error: null, becameInvalid: false };
}

/** Remove: the row stays (who connected what, when), marked revoked, with the encrypted token deleted. */
export async function removeBusinessToken(admin: SupabaseClient, id: string) {
  const { error } = await admin.from("meta_business_tokens").update({ status: "revoked", token_iv: null, token_tag: null, token_ciphertext: null }).eq("id", id);
  await admin.from("meta_business_token_accounts").delete().eq("business_token_id", id);
  clearTokenCache();
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

// ─── What execs see (never the token) ─────────────────────────────────────

export type BusinessTokenView = {
  id: string;
  businessId: string | null;
  businessName: string | null;
  label: string | null;
  last4: string | null;
  scopes: string[];
  expiresAt: string | null;
  systemUser: string | null;
  clientId: string | null;
  createdAt: string;
  createdBy: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  status: Row["status"];
  accounts: { account: string; name: string | null; canManage: boolean }[];
};

export async function listBusinessTokens(admin: SupabaseClient, opts: { includeRevoked?: boolean } = {}): Promise<BusinessTokenView[]> {
  let q = admin
    .from("meta_business_tokens")
    .select("id, business_id, business_name, label, token_last4, scopes, expires_at, system_user_name, client_id, created_at, last_checked_at, last_error, status, profiles(full_name)")
    .order("created_at", { ascending: false });
  if (!opts.includeRevoked) q = q.neq("status", "revoked");
  const { data, error } = await q;
  if (error || !data?.length) return [];
  const { data: acc } = await admin.from("meta_business_token_accounts").select("business_token_id, ad_account_id, account_name, can_manage").in("business_token_id", data.map((d) => d.id as string));
  return data.map((d) => {
    const by = d.profiles as unknown as { full_name?: string } | { full_name?: string }[] | null;
    return {
      id: d.id as string,
      businessId: (d.business_id as string) ?? null,
      businessName: (d.business_name as string) ?? null,
      label: (d.label as string) ?? null,
      last4: (d.token_last4 as string) ?? null,
      scopes: (d.scopes as string[]) ?? [],
      expiresAt: (d.expires_at as string) ?? null,
      systemUser: (d.system_user_name as string) ?? null,
      clientId: (d.client_id as string) ?? null,
      createdAt: d.created_at as string,
      createdBy: (Array.isArray(by) ? by[0]?.full_name : by?.full_name) ?? null,
      lastCheckedAt: (d.last_checked_at as string) ?? null,
      lastError: (d.last_error as string) ?? null,
      status: d.status as Row["status"],
      accounts: (acc ?? [])
        .filter((a) => a.business_token_id === d.id)
        .map((a) => ({ account: bareAccount(a.ad_account_id as string), name: (a.account_name as string) ?? null, canManage: a.can_manage === true }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    };
  });
}

// ─── Daily check ──────────────────────────────────────────────────────────

/** Once a day: every connected client business checked with Meta; a token that stopped working is told to the execs. */
export async function checkAllBusinessTokens(admin: SupabaseClient) {
  const { data, error } = await admin.from("meta_business_tokens").select("id, business_name, label, client_id, last_checked_at, status").neq("status", "revoked");
  if (error) return { skipped: "Client business connections aren't set up yet." };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const out: { id: string; ok: boolean; status: string }[] = [];
  let told = 0;
  for (const t of data ?? []) {
    // Once a day: a token checked in the last 20 hours waits
    if (t.last_checked_at && Date.now() - Date.parse(t.last_checked_at as string) < 20 * 3_600_000) continue;
    const r = await checkBusinessToken(admin, t.id as string);
    out.push({ id: t.id as string, ok: r.ok, status: r.status });
    if (r.becameInvalid) told += await tellExecs(admin, t.id as string, (t.business_name as string) || (t.label as string) || "A client business", r.error ?? "Meta refused it.", today, (t.client_id as string) ?? null);
  }
  return { checked: out.length, invalid: out.filter((o) => o.status === "invalid").length, told };
}

async function tellExecs(admin: SupabaseClient, tokenId: string, name: string, why: string, today: string, clientId: string | null) {
  const { data } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
  const ids = (data ?? []).map((p) => p.id as string);
  if (!ids.length) return 0;
  let href = "/settings?tab=sync&view=meta";
  if (clientId) {
    const { data: c } = await admin.from("clients").select("slug").eq("id", clientId).maybeSingle();
    if (c?.slug) href = `/clients/${c.slug}?tab=team`;
  }
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "connection",
      title: `${name}'s Meta connection stopped working`.slice(0, 200),
      body: `Kaizen Ads went back to Kaizen's own token for its ad accounts, which may not reach them. Meta said: ${redactTokens(why)}. Generate a new token for the system user in their Business Manager and Replace it.`.slice(0, 1000),
      href,
      key: `connection:meta-token:${tokenId}:${today}`,
      priority: "critical",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
  return ids.length;
}
