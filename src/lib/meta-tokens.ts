import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  bareAccount,
  checkDebugToken,
  encryptionKey,
  last4,
  NO_KEY,
  ownersFrom,
  reachLine,
  redactTokens,
  routeToken,
  seal,
  tasksCanManage,
  unseal,
  type BmState,
  type BmStatus,
  type DebugToken,
  type RouteCtx,
  type TokenReach,
} from "@/lib/meta-token-core";

// The Business Managers Kaizen works through: Kaizen's own (the default, META_SYSTEM_USER_TOKEN in Vercel) and the
// white-label partners (ZenChange, Get Me Friends, Blue Cherry Group), each with a token from a system user in its own
// Business Manager. Each client picks one in Team & setup (clients.meta_business); every Graph call for that client's
// ad accounts goes through its token. Partner tokens are stored encrypted (TOKEN_ENCRYPTION_KEY), decrypted only here
// on the server, never logged, never sent to a browser, an AI prompt or the chat.

export const tokenEncryptionConfigured = () => Boolean(encryptionKey(process.env.TOKEN_ENCRYPTION_KEY));

type Row = {
  id: string;
  name: string;
  is_default: boolean;
  sort: number;
  business_id: string | null;
  business_name: string | null;
  token_iv: string | null;
  token_tag: string | null;
  token_ciphertext: string | null;
  token_last4: string | null;
  scopes: string[] | null;
  expires_at: string | null;
  app_id: string | null;
  system_user_id: string | null;
  system_user_name: string | null;
  connected_by: string | null;
  connected_at: string | null;
  created_at: string;
  last_checked_at: string | null;
  last_error: string | null;
  status: BmStatus;
};

// ─── Resolution, cached a minute ─────────────────────────────────────────

type Held = { token: string; name: string; businessId: string | null; businessName: string | null };
type Cache = { at: number; ctx: RouteCtx; tokens: Map<string, Held> };
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
const TTL = 60_000;
const emptyCache = (): Cache => ({ at: Date.now(), ctx: { owners: new Map(), bms: new Map(), reach: [] }, tokens: new Map() });

/** Forget what's cached (after a token is connected, replaced, checked or removed, or a client's choice changes). */
export function clearTokenCache() {
  cache = null;
  loading = null;
}

async function load(): Promise<Cache> {
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key || !adminConfigured()) return emptyCache();
  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("meta_business_tokens").select("id, name, is_default, business_id, business_name, token_iv, token_tag, token_ciphertext, status");
  // The tables not there yet (migration not applied) or unreadable: Kaizen's own token everywhere
  if (error || !rows?.length) return emptyCache();
  const tokens = new Map<string, Held>();
  for (const r of rows) {
    if (r.is_default || r.status !== "active" || !r.token_iv || !r.token_tag || !r.token_ciphertext) continue;
    try {
      tokens.set(r.id as string, { token: unseal({ iv: r.token_iv, tag: r.token_tag, ciphertext: r.token_ciphertext }, key), name: r.name as string, businessId: (r.business_id as string) ?? null, businessName: (r.business_name as string) ?? null });
    } catch {
      console.error(`[meta-tokens] ${r.name}'s token couldn't be decrypted (TOKEN_ENCRYPTION_KEY changed?); Kaizen's own token is used instead`);
    }
  }
  // No partner connected: Kaizen's own for every call, nothing more to read
  if (!tokens.size) return emptyCache();
  const bms = new Map<string, BmState>(rows.map((r) => [r.id as string, { id: r.id as string, isDefault: r.is_default === true, status: r.status as BmStatus, hasToken: tokens.has(r.id as string) }]));
  const [{ data: acc }, { data: clients }, { data: targets }] = await Promise.all([
    admin.from("meta_business_token_accounts").select("business_token_id, ad_account_id, can_manage").in("business_token_id", [...tokens.keys()]),
    admin.from("clients").select("id, meta_ad_account_id, meta_business"),
    admin.from("kpi_targets").select("client_id, ad_account_id").eq("platform", "meta"),
  ]);
  const reach: TokenReach[] = (acc ?? []).map((a) => ({ tokenId: a.business_token_id as string, account: bareAccount(a.ad_account_id as string), canManage: a.can_manage === true }));
  const pick = new Map((clients ?? []).map((c) => [c.id as string, (c.meta_business as string | null) ?? null]));
  const owners = ownersFrom([
    ...(clients ?? []).map((c) => ({ account: c.meta_ad_account_id as string | null, bm: (c.meta_business as string | null) ?? null })),
    ...(targets ?? []).map((t) => ({ account: t.ad_account_id as string | null, bm: pick.get(t.client_id as string) ?? null })),
  ]);
  return { at: Date.now(), ctx: { owners, bms, reach }, tokens };
}

async function current(): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  if (!loading)
    loading = load()
      .catch(() => emptyCache())
      .then((c) => {
        cache = c;
        loading = null;
        return c;
      });
  return loading;
}

export type TokenVia = { tokenId: string; name: string; businessId: string | null; businessName: string | null };

/**
 * Which token a Graph call to this ad account uses: hit is the Business Manager's token its client picked, or null for
 * Kaizen's own. owned: a client owns the account (no client: Kaizen's, and reads it can't see may try the others).
 * write: a partner token the last check saw as view only on this account isn't used for changes.
 */
export async function metaRoute(account: string, opts: { write?: boolean } = {}): Promise<{ hit: ({ token: string } & TokenVia) | null; owned: boolean }> {
  const c = await current();
  if (!c.tokens.size) return { hit: null, owned: false };
  const r = routeToken(account, Boolean(opts.write), c.ctx);
  const t = r.tokenId ? c.tokens.get(r.tokenId) : null;
  return { hit: r.tokenId && t ? { token: t.token, tokenId: r.tokenId, name: t.name, businessId: t.businessId, businessName: t.businessName } : null, owned: r.owned };
}

/** The partner Business Manager's token for a call to this account, or null for Kaizen's own. */
export async function metaTokenFor(account: string, opts: { write?: boolean } = {}) {
  return (await metaRoute(account, opts)).hit;
}

/** Which Business Manager a call to this account goes through (no token): for the access checks on screen. */
export async function metaTokenVia(account: string, opts: { write?: boolean } = {}): Promise<TokenVia | null> {
  const hit = await metaTokenFor(account, opts);
  return hit ? { tokenId: hit.tokenId, name: hit.name, businessId: hit.businessId, businessName: hit.businessName } : null;
}

/** Every connected partner Business Manager's token: tried, read only, on an object Kaizen's own token can't see. */
export async function partnerTokens(): Promise<{ id: string; name: string; token: string }[]> {
  return [...(await current()).tokens.entries()].map(([id, t]) => ({ id, name: t.name, token: t.token }));
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
 * Everything about a token, or why it can't be used: valid, Kaizen's app, the right permissions, the system user and
 * its business, and the ad accounts it reaches (the system user's own, plus the business's owned and client accounts
 * it has a role on).
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

// ─── Connecting, checking, removing ──────────────────────────────────────

async function saveAccounts(admin: SupabaseClient, bmId: string, accounts: Inspected["accounts"]) {
  const at = new Date().toISOString();
  await admin.from("meta_business_token_accounts").delete().eq("business_token_id", bmId);
  if (accounts.length)
    await admin.from("meta_business_token_accounts").insert(accounts.map((a) => ({ business_token_id: bmId, ad_account_id: a.account, account_name: a.name, can_manage: a.canManage, checked_at: at })));
}

/** Connect (or replace) a partner Business Manager's token after Meta confirms it. Never Kaizen's: that one lives in Vercel. */
export async function saveBusinessToken(admin: SupabaseClient, o: { bmId: string; token: string; by: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!key) return { ok: false, error: NO_KEY };
  const { data: bm } = await admin.from("meta_business_tokens").select("id, name, is_default").eq("id", o.bmId).maybeSingle();
  if (!bm) return { ok: false, error: "That Business Manager isn't in the list." };
  if (bm.is_default) return { ok: false, error: "Kaizen uses its own system user's token, set in Vercel (META_SYSTEM_USER_TOKEN)." };
  const token = o.token.trim().replace(/^Bearer\s+/i, "");
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return { ok: false, error: "That doesn't look like a Meta access token. Copy the whole token the system user generated." };
  if (token === process.env.META_SYSTEM_USER_TOKEN) return { ok: false, error: `That's Kaizen's own token. Paste the token from the system user in ${bm.name}'s Business Manager.` };
  const seen = await inspectToken(token);
  if (!seen.ok) return { ok: false, error: seen.reason };
  const i = seen.info;
  if (i.business.id) {
    const { data: other } = await admin.from("meta_business_tokens").select("name").eq("business_id", i.business.id).neq("id", bm.id).neq("status", "revoked").maybeSingle();
    if (other) return { ok: false, error: `This token is from ${i.business.name ?? "a Business Manager"} (${i.business.id}), which is already connected as ${other.name}. Paste the token from ${bm.name}'s own Business Manager.` };
  }
  if (!i.accounts.length) return { ok: false, error: `The token works, but its system user has no ad accounts. In ${bm.name}'s Business Manager, assign the client ad accounts to the system user (Manage campaigns), then paste it again.` };
  const s = seal(token, key);
  const now = new Date().toISOString();
  const { error } = await admin
    .from("meta_business_tokens")
    .update({
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
      connected_by: o.by,
      connected_at: now,
      last_checked_at: now,
      last_error: null,
      status: "active",
    })
    .eq("id", bm.id);
  if (error) return { ok: false, error: redactTokens(error.message, [token]) };
  await saveAccounts(admin, bm.id, i.accounts);
  clearTokenCache();
  return { ok: true };
}

/**
 * Ask Meta about a Business Manager's token again: still valid, still Kaizen's app and permissions, and which ad
 * accounts it reaches now. Kaizen's is checked with META_SYSTEM_USER_TOKEN. A partner token Meta refuses stops being
 * used (status invalid); a Meta outage only notes the error.
 */
export async function checkBusinessToken(admin: SupabaseClient, id: string): Promise<{ ok: boolean; status: BmStatus; error: string | null; becameInvalid: boolean }> {
  const { data: r } = await admin.from("meta_business_tokens").select("*").eq("id", id).maybeSingle();
  const row = r as Row | null;
  if (!row) return { ok: false, status: "not_connected", error: "That Business Manager isn't in the list.", becameInvalid: false };
  if (!row.is_default && (row.status === "not_connected" || row.status === "revoked")) return { ok: false, status: row.status, error: "Not connected yet.", becameInvalid: false };
  const now = new Date().toISOString();
  let token: string;
  if (row.is_default) {
    const own = process.env.META_SYSTEM_USER_TOKEN;
    if (!own) {
      const error = "META_SYSTEM_USER_TOKEN isn't set in Vercel.";
      await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: error }).eq("id", id);
      return { ok: false, status: row.status, error, becameInvalid: false };
    }
    token = own;
  } else {
    const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
    if (!key) {
      await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: NO_KEY }).eq("id", id);
      return { ok: false, status: row.status, error: NO_KEY, becameInvalid: false };
    }
    try {
      token = unseal({ iv: row.token_iv!, tag: row.token_tag!, ciphertext: row.token_ciphertext! }, key);
    } catch {
      const error = "The saved token can't be decrypted (TOKEN_ENCRYPTION_KEY changed). Paste the token again with Replace.";
      await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: error, status: "invalid" }).eq("id", id);
      clearTokenCache();
      return { ok: false, status: "invalid", error, becameInvalid: row.status === "active" };
    }
  }
  const seen = await inspectToken(token);
  if (!seen.ok) {
    // Meta refusing the token itself (expired, revoked, wrong app, permissions removed) makes it invalid; a network
    // blip or Meta being busy doesn't
    const refused = /isn't valid|another app|missing|expired|session|\(#190\)|access token|OAuthException|Error validating/i.test(seen.reason);
    const status = refused ? "invalid" : row.status;
    await admin.from("meta_business_tokens").update({ last_checked_at: now, last_error: seen.reason.slice(0, 500), status }).eq("id", id);
    clearTokenCache();
    return { ok: false, status, error: seen.reason, becameInvalid: refused && row.status === "active" && !row.is_default };
  }
  const i = seen.info;
  await admin
    .from("meta_business_tokens")
    .update({
      business_id: i.business.id ?? row.business_id,
      business_name: i.business.name ?? row.business_name,
      scopes: i.scopes,
      expires_at: i.expiresAt,
      app_id: i.appId,
      system_user_id: i.systemUser.id,
      system_user_name: i.systemUser.name,
      ...(row.is_default ? { token_last4: last4(token) } : {}),
      last_checked_at: now,
      last_error: null,
      status: "active",
    })
    .eq("id", id);
  await saveAccounts(admin, id, i.accounts);
  clearTokenCache();
  return { ok: true, status: "active", error: null, becameInvalid: false };
}

/**
 * Remove a partner's token: the row stays (its name, who connected it), marked revoked, with the encrypted token and
 * what it reached deleted. Its clients go back to Kaizen's own token until it's connected again.
 */
export async function removeBusinessToken(admin: SupabaseClient, id: string) {
  const { data: bm } = await admin.from("meta_business_tokens").select("is_default").eq("id", id).maybeSingle();
  if (!bm) return { ok: false as const, error: "That Business Manager isn't in the list." };
  if (bm.is_default) return { ok: false as const, error: "Kaizen's token lives in Vercel and can't be removed here." };
  const { error } = await admin.from("meta_business_tokens").update({ status: "revoked", token_iv: null, token_tag: null, token_ciphertext: null, token_last4: null, last_error: null }).eq("id", id);
  await admin.from("meta_business_token_accounts").delete().eq("business_token_id", id);
  clearTokenCache();
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

// ─── What people see (never the token) ───────────────────────────────────

export type BusinessManagerView = {
  id: string;
  name: string;
  isDefault: boolean;
  status: BmStatus;
  businessId: string | null;
  businessName: string | null;
  last4: string | null;
  scopes: string[];
  expiresAt: string | null;
  systemUser: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  accounts: { account: string; name: string | null; canManage: boolean }[];
  /** Clients on it (current ones). Kaizen's: only the count */
  clients: { id: string; name: string; slug: string }[];
  clientCount: number;
};

/** The Business Managers, in order (Kaizen first), with what each reaches and who uses it. null: the tables aren't there yet. */
export async function listBusinessManagers(admin: SupabaseClient): Promise<BusinessManagerView[] | null> {
  const { data, error } = await admin
    .from("meta_business_tokens")
    .select("id, name, is_default, sort, status, business_id, business_name, token_last4, scopes, expires_at, system_user_name, connected_at, last_checked_at, last_error, profiles(full_name)")
    .order("sort", { ascending: true })
    .order("name", { ascending: true });
  if (error) return null;
  const ids = (data ?? []).map((d) => d.id as string);
  const [{ data: acc }, { data: clients }] = await Promise.all([
    ids.length ? admin.from("meta_business_token_accounts").select("business_token_id, ad_account_id, account_name, can_manage").in("business_token_id", ids) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    admin.from("clients").select("id, name, slug, meta_business").is("archived_at", null).order("name"),
  ]);
  return (data ?? []).map((d) => {
    const by = d.profiles as unknown as { full_name?: string } | { full_name?: string }[] | null;
    const mine = (clients ?? []).filter((c) => (d.is_default ? !c.meta_business || !ids.includes(c.meta_business as string) : c.meta_business === d.id));
    return {
      id: d.id as string,
      name: d.name as string,
      isDefault: d.is_default === true,
      status: d.status as BmStatus,
      businessId: (d.business_id as string) ?? null,
      businessName: (d.business_name as string) ?? null,
      last4: (d.token_last4 as string) ?? null,
      scopes: (d.scopes as string[]) ?? [],
      expiresAt: (d.expires_at as string) ?? null,
      systemUser: (d.system_user_name as string) ?? null,
      connectedAt: (d.connected_at as string) ?? null,
      connectedBy: (Array.isArray(by) ? by[0]?.full_name : by?.full_name) ?? null,
      lastCheckedAt: (d.last_checked_at as string) ?? null,
      lastError: (d.last_error as string) ?? null,
      accounts: (acc ?? [])
        .filter((a) => a.business_token_id === d.id)
        .map((a) => ({ account: bareAccount(a.ad_account_id as string), name: (a.account_name as string) ?? null, canManage: a.can_manage === true }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      clients: d.is_default ? [] : mine.map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string })),
      clientCount: mine.length,
    };
  });
}

export type ClientBusinessManager = {
  selected: string | null;
  options: { id: string; name: string; isDefault: boolean; status: BmStatus }[];
  accounts: { account: string; label: string | null; ok: boolean; text: string }[];
};

/**
 * A client's Business Manager for Team & setup: the choice, every option and whether it's connected, and for each of
 * the client's Meta KPI accounts whether the chosen Business Manager's token reaches it. null: not set up yet.
 */
export async function clientBusinessManager(admin: SupabaseClient, clientId: string): Promise<ClientBusinessManager | null> {
  const [{ data: rows, error }, { data: client }, { data: targets }] = await Promise.all([
    admin.from("meta_business_tokens").select("id, name, is_default, sort, status, last_checked_at").order("sort", { ascending: true }),
    admin.from("clients").select("meta_business").eq("id", clientId).maybeSingle(),
    admin.from("kpi_targets").select("ad_account_id, label, active").eq("client_id", clientId).eq("platform", "meta"),
  ]);
  if (error || !rows?.length) return null;
  const def = rows.find((r) => r.is_default) ?? null;
  const chosen = rows.find((r) => r.id === (client?.meta_business as string | null)) ?? def;
  const selected = chosen && !chosen.is_default ? (chosen.id as string) : null;
  const accounts = new Map<string, string | null>();
  for (const t of targets ?? []) {
    const a = bareAccount(t.ad_account_id as string);
    if (a && (!accounts.has(a) || (!accounts.get(a) && t.label))) accounts.set(a, (t.label as string | null) ?? null);
  }
  let reach = new Map<string, { canManage: boolean }>();
  if (chosen && !chosen.is_default && accounts.size) {
    const { data: acc } = await admin.from("meta_business_token_accounts").select("ad_account_id, can_manage").eq("business_token_id", chosen.id);
    reach = new Map((acc ?? []).map((a) => [bareAccount(a.ad_account_id as string), { canManage: a.can_manage === true }]));
  }
  const bm = chosen ? { name: chosen.name as string, isDefault: chosen.is_default === true, status: chosen.status as BmStatus, checked: Boolean(chosen.last_checked_at) } : { name: "Kaizen", isDefault: true, status: "active" as BmStatus, checked: true };
  return {
    selected,
    options: rows.map((r) => ({ id: r.id as string, name: r.name as string, isDefault: r.is_default === true, status: r.status as BmStatus })),
    accounts: [...accounts.entries()].map(([account, label]) => ({ account, label, ...reachLine(account, bm, reach.get(account) ?? null) })),
  };
}

/** Set a client's Business Manager (null or Kaizen's: the default). Only a connected one can be picked. */
export async function setClientBusinessManager(admin: SupabaseClient, clientId: string, bmId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  let value: string | null = null;
  if (bmId) {
    const { data: bm } = await admin.from("meta_business_tokens").select("id, name, is_default, status").eq("id", bmId).maybeSingle();
    if (!bm) return { ok: false, error: "That Business Manager isn't in the list." };
    if (!bm.is_default) {
      if (bm.status !== "active") return { ok: false, error: `${bm.name} isn't connected yet. An exec connects it in Settings › Sync health first.` };
      value = bm.id as string;
    }
  }
  const { error } = await admin.from("clients").update({ meta_business: value }).eq("id", clientId);
  clearTokenCache();
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ─── Daily check ──────────────────────────────────────────────────────────

/** Once a day: every Business Manager's token checked with Meta; a partner token that stopped working is told to the execs. */
export async function checkAllBusinessTokens(admin: SupabaseClient) {
  const { data, error } = await admin.from("meta_business_tokens").select("id, name, is_default, last_checked_at, status").in("status", ["active", "invalid"]);
  if (error) return { skipped: "Business Managers aren't set up yet." };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const out: { id: string; ok: boolean; status: string }[] = [];
  let told = 0;
  for (const t of data ?? []) {
    if (t.is_default && !process.env.META_SYSTEM_USER_TOKEN) continue;
    // Once a day: a token checked in the last 20 hours waits
    if (t.last_checked_at && Date.now() - Date.parse(t.last_checked_at as string) < 20 * 3_600_000) continue;
    const r = await checkBusinessToken(admin, t.id as string);
    out.push({ id: t.id as string, ok: r.ok, status: r.status });
    if (r.becameInvalid) told += await tellExecs(admin, t.id as string, t.name as string, r.error ?? "Meta refused it.", today);
  }
  return { checked: out.length, invalid: out.filter((o) => o.status === "invalid").length, told };
}

async function tellExecs(admin: SupabaseClient, bmId: string, name: string, why: string, today: string) {
  const { data } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
  const ids = (data ?? []).map((p) => p.id as string);
  if (!ids.length) return 0;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "connection",
      title: `${name}'s Meta connection stopped working`.slice(0, 200),
      body: `Clients on ${name}'s Business Manager went back to Kaizen's own token, which may not reach their ad accounts. Meta said: ${redactTokens(why)}. Generate a new token for the system user in ${name}'s Business Manager and Replace it in Settings › Sync health.`.slice(0, 1000),
      href: "/settings?tab=sync&view=meta",
      key: `connection:meta-token:${bmId}:${today}`,
      priority: "critical",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
  return ids.length;
}
