import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { encryptionKey, last4, NO_KEY, redactTokens, seal, unseal, type Sealed } from "@/lib/meta-token-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  authorizeUrl,
  authServerMetadataUrls,
  expiryFrom,
  offeredTo,
  pkcePair,
  protectedResourceUrls,
  resourceMetadataFrom,
  resourceOf,
  signState,
  tokenDecision,
  toolMetaFrom,
  verifyState,
  type AuthMeta,
  type Connector,
  type Ready,
  type ToolMeta,
  usable,
} from "./core";

// Connectors on the server: the catalog, each person's connections, the OAuth dance (MCP authorization spec: protected
// resource metadata, authorization server metadata, dynamic client registration, authorization code with PKCE and a
// resource indicator), tokens encrypted at rest and refreshed before they run out, and the tools each server offers.
// Every function that touches a token takes the person it's for and only ever reads that person's rows. Before the
// migration is applied, reads come back empty and nothing breaks.

export const CALLBACK_PATH = "/api/connectors/callback";
export const COOKIE = "kz_connector_oauth";
const TIMEOUT = 10_000;
const TOOLS_FRESH_MS = 24 * 3600_000;
const META_FRESH_MS = 7 * 24 * 3600_000;
const COLS = "id, key, name, icon_url, url, auth, client_id, scopes, note, roles, enabled, registry_name, registry_version";

export type Connection = {
  id: string;
  connector_id: string;
  status: "active" | "needs_reconnect";
  token_last4: string | null;
  expires_at: string | null;
  tools: ToolMeta[];
  tools_checked_at: string | null;
  last_error: string | null;
  last_used_at: string | null;
  connected_at: string;
};

const key = () => encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
const stateSecret = () => {
  const k = key();
  return k ? createHash("sha256").update(Buffer.concat([Buffer.from("kaizen connectors state:"), k])).digest() : null;
};
const sealedOf = (iv: unknown, tag: unknown, ciphertext: unknown): Sealed | null => (typeof iv === "string" && typeof tag === "string" && typeof ciphertext === "string" ? { iv, tag, ciphertext } : null);
const open = (s: Sealed | null) => {
  const k = key();
  if (!s || !k) return null;
  try {
    return unseal(s, k);
  } catch {
    return null;
  }
};
const clean = (e: unknown, secrets: (string | null | undefined)[] = []) => redactTokens(e instanceof Error ? e.message : String(e), secrets).slice(0, 300);

// ─── The catalog ───────────────────────────────────────────────────────────

/** Every connector in the catalog (empty before the migration) */
export async function listConnectors(admin: SupabaseClient): Promise<Connector[]> {
  const { data, error } = await admin.from("ai_connectors").select(COLS).order("name");
  if (error) return [];
  return (data ?? []) as Connector[];
}

export async function connectorByKey(admin: SupabaseClient, k: string): Promise<Connector | null> {
  const { data, error } = await admin.from("ai_connectors").select(COLS).eq("key", k).maybeSingle();
  return error ? null : ((data as Connector | null) ?? null);
}

/** The connectors offered to this person */
export async function offeredConnectors(admin: SupabaseClient, me: Pick<Staff, "role" | "isExec">): Promise<Connector[]> {
  return (await listConnectors(admin)).filter((c) => offeredTo(c, me.role, me.isExec));
}

/** This person's connections (empty before the migration) */
export async function myConnections(admin: SupabaseClient, profileId: string): Promise<Connection[]> {
  const { data, error } = await admin.from("ai_connections").select("id, connector_id, status, token_last4, expires_at, tools, tools_checked_at, last_error, last_used_at, connected_at").eq("profile_id", profileId);
  if (error) return [];
  return ((data ?? []) as Connection[]).map((c) => ({ ...c, tools: Array.isArray(c.tools) ? c.tools : [] }));
}

/**
 * The keys of the connectors this person can use in a chat right now ("shopify", ...): offered to them and connected
 * (or needing no sign in). For Projects, to say which of the connectors a project expects are missing.
 */
export async function connectedKeys(profileId: string): Promise<string[]> {
  if (!adminConfigured()) return [];
  const admin = createAdminClient();
  const { data: p } = await admin.from("profiles").select("role, is_exec").eq("id", profileId).maybeSingle();
  if (!p) return [];
  const [offered, mine] = await Promise.all([offeredConnectors(admin, { role: p.role as Staff["role"], isExec: Boolean(p.is_exec) }), myConnections(admin, profileId)]);
  return offered.filter((c) => usable(c, mine)).map((c) => c.key);
}

// ─── Discovery ─────────────────────────────────────────────────────────────

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
    if (!r.ok) return null;
    const j = (await r.json()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The server without a token: does it ask for one, and where its resource metadata is (from the 401) */
async function probe(url: string): Promise<{ status: number; resourceMetadata: string | null } | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Kaizen Ads", version: "1.0" } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    void r.body?.cancel().catch(() => {});
    return { status: r.status, resourceMetadata: resourceMetadataFrom(r.headers.get("www-authenticate")) };
  } catch {
    return null;
  }
}

export type Probe = { reachable: boolean; signIn: boolean; meta: AuthMeta | null; dcr: boolean };

/**
 * How a server signs people in, per the MCP authorization spec: its protected resource metadata (from the 401's
 * WWW-Authenticate, or the well-known paths) names the authorization server; that server's metadata has the endpoints
 * and whether it registers clients itself. A server with neither falls back to the endpoints at its own origin.
 */
export async function discover(url: string): Promise<Probe> {
  const p = await probe(url);
  const signIn = p ? p.status === 401 || p.status === 403 : false;
  let prm: Record<string, unknown> | null = null;
  for (const u of [...(p?.resourceMetadata ? [p.resourceMetadata] : []), ...protectedResourceUrls(url)]) {
    prm = await getJson(u);
    if (prm) break;
  }
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const issuer = servers[0] ?? new URL(url).origin;
  let as: Record<string, unknown> | null = null;
  for (const u of authServerMetadataUrls(issuer)) {
    as = await getJson(u);
    if (as?.authorization_endpoint && as?.token_endpoint) break;
    as = null;
  }
  const scopes = Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string").join(" ") : null;
  let meta: AuthMeta | null = null;
  if (as) {
    meta = {
      issuer: String(as.issuer ?? issuer),
      authorization_endpoint: String(as.authorization_endpoint),
      token_endpoint: String(as.token_endpoint),
      registration_endpoint: typeof as.registration_endpoint === "string" ? as.registration_endpoint : null,
      scopes: scopes || null,
      token_auth_methods: Array.isArray(as.token_endpoint_auth_methods_supported) ? (as.token_endpoint_auth_methods_supported as unknown[]).map(String) : [],
    };
  } else if (signIn && !prm) {
    // The earlier spec: no metadata at all means the default paths at the server's origin
    const o = new URL(url).origin;
    meta = { issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, scopes: null, token_auth_methods: [] };
  }
  return { reachable: Boolean(p), signIn: signIn || Boolean(prm), meta, dcr: Boolean(meta?.registration_endpoint) };
}

type Secrets = {
  client_secret_iv: string | null;
  client_secret_tag: string | null;
  client_secret_ciphertext: string | null;
  reg_client_id: string | null;
  reg_redirect_uri: string | null;
  reg_secret_iv: string | null;
  reg_secret_tag: string | null;
  reg_secret_ciphertext: string | null;
  auth_meta: AuthMeta | null;
  auth_meta_at: string | null;
};

async function secretsOf(admin: SupabaseClient, connectorId: string): Promise<Secrets | null> {
  const { data } = await admin.from("ai_connector_secrets").select("*").eq("connector_id", connectorId).maybeSingle();
  return (data as Secrets | null) ?? null;
}
const saveSecrets = (admin: SupabaseClient, connectorId: string, patch: Partial<Secrets>) =>
  admin.from("ai_connector_secrets").upsert({ connector_id: connectorId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "connector_id" });

/** The exec's OAuth client secret, sealed (or cleared with null) */
export async function setClientSecret(admin: SupabaseClient, connectorId: string, secret: string | null) {
  if (secret === null) return saveSecrets(admin, connectorId, { client_secret_iv: null, client_secret_tag: null, client_secret_ciphertext: null });
  const k = key();
  if (!k) throw new Error(NO_KEY.replace("a Business Manager's token", "a connector's secret"));
  const s = seal(secret, k);
  return saveSecrets(admin, connectorId, { client_secret_iv: s.iv, client_secret_tag: s.tag, client_secret_ciphertext: s.ciphertext });
}

/** Whether the exec's secret is set (never the secret) */
export async function hasClientSecret(admin: SupabaseClient, connectorId: string) {
  const s = await secretsOf(admin, connectorId).catch(() => null);
  return Boolean(s?.client_secret_ciphertext);
}

/** The server's OAuth endpoints, from the cache when it's fresh */
async function authMeta(admin: SupabaseClient, c: Connector, sec: Secrets | null): Promise<AuthMeta> {
  if (sec?.auth_meta && sec.auth_meta_at && Date.now() - Date.parse(sec.auth_meta_at) < META_FRESH_MS) return sec.auth_meta;
  const d = await discover(c.url);
  if (!d.meta) throw new Error(`${c.name} didn't say how to sign in (no OAuth metadata). Check the URL in Settings, Connectors.`);
  await saveSecrets(admin, c.id, { auth_meta: d.meta, auth_meta_at: new Date().toISOString() });
  return d.meta;
}

type Client = { id: string; secret: string | null };

/** The OAuth client for this connector: the exec's own, or one registered with the server for this redirect URI */
async function clientFor(admin: SupabaseClient, c: Connector, meta: AuthMeta, sec: Secrets | null, redirectUri: string): Promise<Client> {
  if (c.auth === "oauth_client") {
    if (!c.client_id) throw new Error(`${c.name} has no OAuth client id yet. An exec adds it in Settings, Connectors.`);
    return { id: c.client_id, secret: open(sealedOf(sec?.client_secret_iv, sec?.client_secret_tag, sec?.client_secret_ciphertext)) };
  }
  if (sec?.reg_client_id && sec.reg_redirect_uri === redirectUri) return { id: sec.reg_client_id, secret: open(sealedOf(sec.reg_secret_iv, sec.reg_secret_tag, sec.reg_secret_ciphertext)) };
  if (!meta.registration_endpoint) throw new Error(`${c.name} doesn't register apps on its own. An exec registers one with ${c.name} and switches the connector to "OAuth (our app)".`);
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: "Kaizen Ads", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(c.scopes ? { scope: c.scopes } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = (await r.json().catch(() => null)) as { client_id?: string; client_secret?: string; error_description?: string } | null;
  if (!r.ok || !j?.client_id) throw new Error(`${c.name} wouldn't register Kaizen Ads${j?.error_description ? `: ${j.error_description}` : ""}.`);
  const k = key();
  const s = j.client_secret && k ? seal(j.client_secret, k) : null;
  await saveSecrets(admin, c.id, { reg_client_id: j.client_id, reg_redirect_uri: redirectUri, reg_secret_iv: s?.iv ?? null, reg_secret_tag: s?.tag ?? null, reg_secret_ciphertext: s?.ciphertext ?? null });
  return { id: j.client_id, secret: j.client_secret ?? null };
}

// ─── Tokens ────────────────────────────────────────────────────────────────

type TokenSet = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

async function tokenRequest(meta: AuthMeta, client: Client, params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const basic = client.secret && (meta.token_auth_methods.includes("client_secret_basic") || !meta.token_auth_methods.includes("client_secret_post"));
  if (client.secret && basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}`;
  else {
    body.set("client_id", client.id);
    if (client.secret) body.set("client_secret", client.secret);
  }
  const r = await fetch(meta.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await r.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    j = Object.fromEntries(new URLSearchParams(text));
  }
  if (!r.ok || typeof j.access_token !== "string") throw new Error(redactTokens(`The sign in didn't finish (${r.status}${j.error ? `, ${String(j.error)}` : ""}${j.error_description ? `: ${String(j.error_description)}` : ""}).`, [client.secret, params.code, params.refresh_token]));
  return { access_token: j.access_token, refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined, expires_in: Number(j.expires_in) || undefined, scope: typeof j.scope === "string" ? j.scope : undefined };
}

/** A person's connection saved with its tokens (sealed); replaces the old ones */
async function saveConnection(admin: SupabaseClient, profileId: string, c: Connector, t: TokenSet, keepRefresh?: string | null): Promise<string> {
  const k = key();
  if (!k) throw new Error(NO_KEY.replace("a Business Manager's token", "a connection's token"));
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("ai_connections")
    .upsert({ profile_id: profileId, connector_id: c.id, status: "active", token_last4: last4(t.access_token), expires_at: expiryFrom(t.expires_in), scope: t.scope ?? null, last_error: null, updated_at: now }, { onConflict: "profile_id,connector_id" })
    .select("id")
    .single();
  if (error || !data) throw new Error("The connection couldn't be saved.");
  const a = seal(t.access_token, k);
  const refresh = t.refresh_token ?? keepRefresh ?? null;
  const rf = refresh ? seal(refresh, k) : null;
  const { error: e2 } = await admin
    .from("ai_connection_tokens")
    .upsert({ connection_id: data.id, access_iv: a.iv, access_tag: a.tag, access_ciphertext: a.ciphertext, refresh_iv: rf?.iv ?? null, refresh_tag: rf?.tag ?? null, refresh_ciphertext: rf?.ciphertext ?? null, updated_at: now }, { onConflict: "connection_id" });
  if (e2) throw new Error("The connection's token couldn't be saved.");
  return data.id as string;
}

async function tokensOf(admin: SupabaseClient, connectionId: string): Promise<{ access: string | null; refresh: string | null }> {
  const { data } = await admin.from("ai_connection_tokens").select("access_iv, access_tag, access_ciphertext, refresh_iv, refresh_tag, refresh_ciphertext").eq("connection_id", connectionId).maybeSingle();
  if (!data) return { access: null, refresh: null };
  return { access: open(sealedOf(data.access_iv, data.access_tag, data.access_ciphertext)), refresh: open(sealedOf(data.refresh_iv, data.refresh_tag, data.refresh_ciphertext)) };
}

/** A connection that stopped working: the person sees Reconnect */
export async function markReconnect(admin: SupabaseClient, profileId: string, connectorId: string, why: string) {
  await admin.from("ai_connections").update({ status: "needs_reconnect", last_error: why.slice(0, 300), updated_at: new Date().toISOString() }).eq("profile_id", profileId).eq("connector_id", connectorId);
}

// ─── Connecting ────────────────────────────────────────────────────────────

const cookieSeal = (v: object) => {
  const s = seal(JSON.stringify(v), key()!);
  return `${s.iv}.${s.tag}.${s.ciphertext}`;
};
const cookieOpen = (v: string): { n: string; v: string; c: string } | null => {
  const [iv, tag, ciphertext] = String(v ?? "").split(".");
  const raw = open(sealedOf(iv, tag, ciphertext));
  try {
    return raw ? (JSON.parse(raw) as { n: string; v: string; c: string }) : null;
  } catch {
    return null;
  }
};

/**
 * The start of connecting: the URL to send the person to (the server's sign in, with PKCE and a signed state) and the
 * cookie that keeps the PKCE verifier in this browser until they come back.
 */
export async function startConnect(me: Staff, connectorKey: string, origin: string, ret: string | null): Promise<{ url: string; cookie: string }> {
  if (!key()) throw new Error(NO_KEY.replace("a Business Manager's token", "a connection's token"));
  const admin = createAdminClient();
  const c = await connectorByKey(admin, connectorKey);
  if (!c || !offeredTo(c, me.role, me.isExec)) throw new Error("That connector isn't offered to you.");
  if (c.auth !== "oauth" && c.auth !== "oauth_client") throw new Error(`${c.name} doesn't sign in with OAuth.`);
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  const sec = await secretsOf(admin, c.id);
  const meta = await authMeta(admin, c, sec);
  const client = await clientFor(admin, c, meta, sec, redirectUri);
  const { verifier, challenge } = pkcePair();
  const nonce = pkcePair().verifier.slice(0, 22);
  const state = signState({ p: me.id, c: c.id, n: nonce, exp: Date.now() + 10 * 60_000, ...(ret ? { r: ret } : {}) }, stateSecret()!);
  return {
    url: authorizeUrl(meta, { clientId: client.id, redirectUri, state, challenge, scope: c.scopes || meta.scopes, resource: resourceOf(c.url) }),
    cookie: cookieSeal({ n: nonce, v: verifier, c: c.id }),
  };
}

/** Back from the server's sign in: the state and the cookie must match this person and this browser */
export async function finishConnect(me: Staff, p: { code: string; state: string; cookie: string | undefined; origin: string }): Promise<{ connector: Connector; ret: string | null }> {
  const secret = stateSecret();
  if (!secret) throw new Error(NO_KEY.replace("a Business Manager's token", "a connection's token"));
  const s = verifyState(p.state, secret);
  const ck = p.cookie ? cookieOpen(p.cookie) : null;
  if (!s || !ck || s.p !== me.id || ck.n !== s.n || ck.c !== s.c) throw new Error("That sign in link expired or was started in another browser. Try Connect again.");
  const admin = createAdminClient();
  const { data } = await admin.from("ai_connectors").select(COLS).eq("id", s.c).maybeSingle();
  const c = data as Connector | null;
  if (!c || !offeredTo(c, me.role, me.isExec)) throw new Error("That connector isn't offered to you any more.");
  const redirectUri = `${p.origin}${CALLBACK_PATH}`;
  const sec = await secretsOf(admin, c.id);
  const meta = await authMeta(admin, c, sec);
  const client = await clientFor(admin, c, meta, sec, redirectUri);
  const t = await tokenRequest(meta, client, { grant_type: "authorization_code", code: p.code, redirect_uri: redirectUri, code_verifier: ck.v, resource: resourceOf(c.url) });
  const id = await saveConnection(admin, me.id, c, t);
  await refreshTools(admin, id, c, t.access_token).catch(() => {});
  return { connector: c, ret: s.r ?? null };
}

/** A personal token pasted for a token connector: checked against the server (it must list its tools), then sealed */
export async function savePersonalToken(me: Staff, connectorKey: string, token: string): Promise<void> {
  const admin = createAdminClient();
  const c = await connectorByKey(admin, connectorKey);
  if (!c || !offeredTo(c, me.role, me.isExec)) throw new Error("That connector isn't offered to you.");
  if (c.auth !== "token") throw new Error(`${c.name} doesn't take a pasted token.`);
  const t = token.trim();
  if (t.length < 8 || t.length > 4000 || /\s/.test(t)) throw new Error("That doesn't look like a token. Copy it again in full.");
  const listed = await listTools(c.url, t);
  if (!listed.ok && (listed.status === 401 || listed.status === 403)) throw new Error(`${c.name} didn't accept that token.`);
  const id = await saveConnection(admin, me.id, c, { access_token: t });
  if (listed.ok) await admin.from("ai_connections").update({ tools: listed.tools, tools_checked_at: new Date().toISOString() }).eq("id", id);
}

/** Switch on a connector that needs no sign in: a connection with no token, and the tools it offers */
export async function connectOpen(me: Staff, connectorKey: string): Promise<Connector> {
  const admin = createAdminClient();
  const c = await connectorByKey(admin, connectorKey);
  if (!c || !offeredTo(c, me.role, me.isExec)) throw new Error("That connector isn't offered to you.");
  if (c.auth !== "none") throw new Error(`${c.name} needs you to sign in.`);
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("ai_connections")
    .upsert({ profile_id: me.id, connector_id: c.id, status: "active", token_last4: null, expires_at: null, scope: null, last_error: null, connected_at: now, updated_at: now }, { onConflict: "profile_id,connector_id" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.code === "42P01" ? "Connectors need the latest database update first." : "The connection couldn't be saved.");
  await refreshTools(admin, data.id as string, c, null).catch(() => {});
  return c;
}

/** Remove this person's connection (their tokens go with it) */
export async function disconnect(me: Staff, connectorKey: string): Promise<void> {
  const admin = createAdminClient();
  const c = await connectorByKey(admin, connectorKey);
  if (!c) return;
  await admin.from("ai_connections").delete().eq("profile_id", me.id).eq("connector_id", c.id);
}

// ─── Tools (a small MCP client: initialize, then tools/list) ───────────────

async function readRpc(r: Response, id: number): Promise<Record<string, unknown> | null> {
  const type = r.headers.get("content-type") ?? "";
  const text = await r.text();
  if (type.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const j = JSON.parse(data) as Record<string, unknown>;
        if (j.id === id) return j;
      } catch {
        // not JSON: skip
      }
    }
    return null;
  }
  try {
    const j = JSON.parse(text) as unknown;
    const list = Array.isArray(j) ? j : [j];
    return (list.find((x) => (x as { id?: unknown })?.id === id) as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The server's tools with their read/write hints, using this token. Never logs the token. */
export async function listTools(url: string, token: string | null): Promise<{ ok: true; tools: ToolMeta[] } | { ok: false; status: number | null; error: string }> {
  const base: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  try {
    const init = await fetch(url, {
      method: "POST",
      headers: base,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Kaizen Ads", version: "1.0" } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!init.ok) return { ok: false, status: init.status, error: `The server answered ${init.status}.` };
    const session = init.headers.get("mcp-session-id");
    const hello = await readRpc(init, 1);
    const version = String((hello?.result as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-06-18");
    const headers = { ...base, "mcp-protocol-version": version, ...(session ? { "mcp-session-id": session } : {}) };
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(TIMEOUT) })
      .then((r) => r.body?.cancel())
      .catch(() => {});
    const tools: ToolMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} }), signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return { ok: false, status: r.status, error: `tools/list answered ${r.status}.` };
      const j = await readRpc(r, 2 + page);
      const result = j?.result as { tools?: unknown; nextCursor?: string } | undefined;
      if (!result) return { ok: false, status: null, error: "The server didn't list its tools." };
      tools.push(...toolMetaFrom(result.tools));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (session) void fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, status: null, error: clean(e, [token]) };
  }
}

async function refreshTools(admin: SupabaseClient, connectionId: string, c: Connector, token: string | null) {
  const r = await listTools(c.url, token);
  if (r.ok) await admin.from("ai_connections").update({ tools: r.tools, tools_checked_at: new Date().toISOString() }).eq("id", connectionId);
  return r;
}

// ─── A chat turn ───────────────────────────────────────────────────────────

export type Problem = { key: string; name: string; text: string; reconnect: boolean };

/**
 * The connectors this person switched on for this turn, ready for the MCP connector: each with a token that works
 * (refreshed first when it's about to run out) and its tools. Ones that can't be used say why, in plain words.
 */
export async function readyFor(admin: SupabaseClient, me: Staff, keys: string[]): Promise<{ ready: Ready[]; problems: Problem[] }> {
  const ready: Ready[] = [];
  const problems: Problem[] = [];
  if (!keys.length) return { ready, problems };
  const [offered, mine] = await Promise.all([offeredConnectors(admin, me), myConnections(admin, me.id)]);
  await Promise.all(
    keys.map(async (k) => {
      const c = offered.find((x) => x.key === k);
      if (!c) return;
      const conn = mine.find((m) => m.connector_id === c.id);
      if (!conn) return problems.push({ key: c.key, name: c.name, text: `${c.name} isn't connected yet.`, reconnect: true });
      if (c.auth === "none") {
        ready.push({ key: c.key, name: c.name, url: c.url, token: null, tools: conn.tools });
        return;
      }
      if (conn.status !== "active") return problems.push({ key: c.key, name: c.name, text: `${c.name} needs you to sign in again.`, reconnect: true });
      let { access, refresh } = await tokensOf(admin, conn.id);
      if (!access) {
        await markReconnect(admin, me.id, c.id, "The token couldn't be read (TOKEN_ENCRYPTION_KEY changed?).");
        return problems.push({ key: c.key, name: c.name, text: `${c.name} needs you to sign in again.`, reconnect: true });
      }
      const decision = tokenDecision({ expiresAt: conn.expires_at, hasRefresh: Boolean(refresh) });
      if (decision === "reconnect") {
        await markReconnect(admin, me.id, c.id, "The sign in expired.");
        return problems.push({ key: c.key, name: c.name, text: `Your ${c.name} sign in expired.`, reconnect: true });
      }
      if (decision === "refresh") {
        try {
          const sec = await secretsOf(admin, c.id);
          const meta = await authMeta(admin, c, sec);
          const client = await clientFor(admin, c, meta, sec, sec?.reg_redirect_uri ?? `${(process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "")}${CALLBACK_PATH}`);
          const t = await tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: refresh!, resource: resourceOf(c.url) });
          await saveConnection(admin, me.id, c, t, refresh);
          access = t.access_token;
          refresh = t.refresh_token ?? refresh;
        } catch (e) {
          await markReconnect(admin, me.id, c.id, clean(e, [refresh, access]));
          return problems.push({ key: c.key, name: c.name, text: `Your ${c.name} sign in expired and couldn't be renewed.`, reconnect: true });
        }
      }
      let tools = conn.tools;
      if (!conn.tools_checked_at || Date.now() - Date.parse(conn.tools_checked_at) > TOOLS_FRESH_MS) {
        const r = await refreshTools(admin, conn.id, c, access);
        if (r.ok) tools = r.tools;
        else if (r.status === 401 || r.status === 403) {
          await markReconnect(admin, me.id, c.id, `${c.name} turned the sign in down (${r.status}).`);
          return problems.push({ key: c.key, name: c.name, text: `${c.name} didn't accept your sign in.`, reconnect: true });
        }
      }
      void admin.from("ai_connections").update({ last_used_at: new Date().toISOString() }).eq("id", conn.id).then(() => {});
      ready.push({ key: c.key, name: c.name, url: c.url, token: access, tools });
    }),
  );
  return { ready: ready.sort((a, b) => a.key.localeCompare(b.key)), problems };
}

/** A thread's own list of switched on connectors (null: never set, so every connected one) */
export async function threadConnectorKeys(admin: SupabaseClient, threadId: string): Promise<string[] | null> {
  const { data, error } = await admin.from("ai_thread_connectors").select("keys").eq("thread_id", threadId).maybeSingle();
  if (error || !data) return null;
  return Array.isArray(data.keys) ? (data.keys as string[]) : null;
}

export async function setThreadConnectorKeys(admin: SupabaseClient, threadId: string, keys: string[]) {
  const clean = [...new Set(keys.filter((k) => /^[a-z][a-z0-9_-]{1,39}$/.test(k)))].slice(0, 20);
  return admin.from("ai_thread_connectors").upsert({ thread_id: threadId, keys: clean, updated_at: new Date().toISOString() }, { onConflict: "thread_id" });
}
