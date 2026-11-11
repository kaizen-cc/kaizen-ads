import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthMeta } from "./discovery";
import type { Connector } from "./shared";

export * from "./shared";

// Connectors in Kaizen AI, the plain parts kept apart from the database and the network so they can be tested: what a
// connector is, who it's offered to, PKCE and the signed OAuth state, when a token needs refreshing, which tools write,
// how a thread's switches become the MCP connector payload of a Messages API request, and where the MCP authorization
// spec says to look for a server's OAuth details.

// ─── The catalog ───────────────────────────────────────────────────────────

/** An MCP server URL we'll call: https (http only on this machine while developing) */
export function validServerUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.toString();
    return null;
  } catch {
    return null;
  }
}

/** Is this connector offered to someone with this role? Execs see every enabled one. */
export function offeredTo(c: Pick<Connector, "roles" | "enabled">, role: string, isExec = false) {
  if (!c.enabled) return false;
  if (isExec) return true;
  return !c.roles?.length || c.roles.includes(role);
}

// ─── PKCE and the signed state ─────────────────────────────────────────────

export const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE verifier (43 characters) and its S256 challenge */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export type OAuthState = { p: string; c: string; n: string; exp: number; r?: string };

/** The state sent to the authorization server: who started it, for which connector, a nonce and an expiry, signed */
export function signState(s: OAuthState, secret: Buffer | string): string {
  const body = b64url(Buffer.from(JSON.stringify(s)));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/** The state back from the authorization server, if the signature holds and it hasn't expired */
export function verifyState(token: string, secret: Buffer | string, now = Date.now()): OAuthState | null {
  const [body, mac, extra] = String(token ?? "").split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(b64url(createHmac("sha256", secret).update(body).digest()));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as OAuthState;
    if (typeof s.p !== "string" || typeof s.c !== "string" || typeof s.n !== "string" || typeof s.exp !== "number") return null;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}

/** Where to go after connecting: only back into the app (the chat or settings), never another site */
export function safeReturn(r: string | null | undefined): string | null {
  const v = String(r ?? "");
  if (!/^\/(ai|settings)(?:[/?#]|$)/.test(v) || v.startsWith("//") || /[\\\s]/.test(v)) return null;
  return v.slice(0, 500);
}

// ─── Tokens ────────────────────────────────────────────────────────────────

export const REFRESH_SKEW_MS = 2 * 60_000;

/**
 * What to do with a stored token before a request: use it, refresh it first (expired or about to), or ask the person
 * to reconnect (expired with no refresh token). A token with no expiry is used as it is.
 */
export function tokenDecision(t: { expiresAt: string | null; hasRefresh: boolean }, now = Date.now()): "use" | "refresh" | "reconnect" {
  if (!t.expiresAt) return "use";
  const at = Date.parse(t.expiresAt);
  if (!Number.isFinite(at) || at - REFRESH_SKEW_MS > now) return "use";
  return t.hasRefresh ? "refresh" : "reconnect";
}

/** expires_in (seconds) from a token response as a time */
export const expiryFrom = (expiresIn: unknown, now = Date.now()) => {
  const s = Number(expiresIn);
  return Number.isFinite(s) && s > 0 ? new Date(now + s * 1000).toISOString() : null;
};

// ─── Tools: which ones write ───────────────────────────────────────────────

/** A tool as we keep it from the server's tools/list: its name, a short description, and whether it only reads */
export type ToolMeta = { name: string; title?: string | null; about?: string | null; readOnly: boolean | null; destructive: boolean | null };

const WRITE_VERB = /(^|[_\-.\s])(create|update|delete|remove|cancel|refund|send|post|publish|write|set|add|edit|modify|archive|close|fulfill|fulfil|capture|void|move|upload|insert|replace|patch|put|assign|invite|approve|complete|pay|charge|transfer|disable|enable|duplicate|merge|tag|untag|reply|comment)([_\-.\s]|$)/i;

/**
 * Does running this tool change something? The server's own annotations decide when it gives them (readOnlyHint,
 * destructiveHint); otherwise a name that starts with or contains a write verb counts as a write. Asking first when
 * unsure is the safe side.
 */
export function isWriteTool(t: ToolMeta) {
  if (t.readOnly === true) return false;
  if (t.destructive === true) return true;
  return WRITE_VERB.test(t.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** tools/list's tools as we keep them */
export function toolMetaFrom(list: unknown): ToolMeta[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((t) => {
    const x = t as { name?: unknown; title?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; title?: unknown } };
    if (typeof x?.name !== "string" || !x.name) return [];
    const a = x.annotations ?? {};
    return [
      {
        name: x.name.slice(0, 128),
        title: typeof x.title === "string" ? x.title.slice(0, 120) : typeof a.title === "string" ? a.title.slice(0, 120) : null,
        about: typeof x.description === "string" ? x.description.replace(/\s+/g, " ").slice(0, 240) : null,
        readOnly: typeof a.readOnlyHint === "boolean" ? a.readOnlyHint : null,
        destructive: typeof a.destructiveHint === "boolean" ? a.destructiveHint : null,
      },
    ];
  });
}

// ─── The request payload ───────────────────────────────────────────────────

export const MCP_BETA = "mcp-client-2025-11-20";

/** A connector ready for this turn: on in the thread, connected, with a token that works */
export type Ready = { key: string; name: string; url: string; token: string | null; tools: ToolMeta[] };

export type McpServer = { type: "url"; url: string; name: string; authorization_token?: string };
export type McpToolset = { type: "mcp_toolset"; mcp_server_name: string; configs?: Record<string, { enabled: boolean }> };

/**
 * The connectors switched on for a thread, as the Messages API's MCP connector takes them: one server per connector
 * (named by its key, with the person's token) and one toolset for it. Tools that write are switched off unless the
 * person approved that exact tool on that connector for this turn.
 */
export function mcpPayload(ready: Ready[], approved: { key: string; tool: string } | null = null): { servers: McpServer[]; toolsets: McpToolset[] } {
  const servers: McpServer[] = [];
  const toolsets: McpToolset[] = [];
  const seen = new Set<string>();
  for (const r of ready) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    servers.push({ type: "url", url: r.url, name: r.key, ...(r.token ? { authorization_token: r.token } : {}) });
    const off = r.tools.filter((t) => isWriteTool(t) && !(approved && approved.key === r.key && approved.tool === t.name));
    toolsets.push({ type: "mcp_toolset", mcp_server_name: r.key, ...(off.length ? { configs: Object.fromEntries(off.map((t) => [t.name, { enabled: false }])) } : {}) });
  }
  return { servers, toolsets };
}

/** Which of the offered connectors are on in a thread: its own list when it has one, else every connected one */
export function threadKeys(saved: string[] | null | undefined, connected: string[]): string[] {
  const on = saved ?? connected;
  return connected.filter((k) => on.includes(k));
}

// ─── Discovery (MCP authorization spec) ────────────────────────────────────

export { authServerMetadataUrls, protectedResourceUrls, resourceMetadataFrom } from "./discovery";

/** The resource indicator sent with authorization and token requests: the server's URL without a fragment */
export const resourceOf = (serverUrl: string) => {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString();
};

export type { AuthMeta } from "./discovery";

/** The authorization URL a person is sent to */
export function authorizeUrl(meta: Pick<AuthMeta, "authorization_endpoint">, p: { clientId: string; redirectUri: string; state: string; challenge: string; scope: string | null; resource: string }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", p.resource);
  if (p.scope) u.searchParams.set("scope", p.scope);
  return u.toString();
}

// ─── Errors in plain words ─────────────────────────────────────────────────

/** An MCP connector error as the person should read it, and whether reconnecting is the fix */
export function connectorError(message: string, name: string): { text: string; reconnect: boolean } {
  const m = String(message ?? "");
  if (/\b401\b|unauthori[sz]ed|invalid[_ ]token|expired|forbidden|\b403\b|authenticat/i.test(m)) return { text: `${name} didn't accept your sign in. Reconnect it from the plug menu in Kaizen AI.`, reconnect: true };
  if (/timed? ?out|timeout|ECONN|ENOTFOUND|unreachable|connect|5\d\d|unavailable/i.test(m)) return { text: `${name} isn't answering right now. Try again in a bit.`, reconnect: false };
  return { text: `${name} had a problem with this request. Try again, or switch it off for this chat.`, reconnect: false };
}

/** Which of these server names an API error message is about (none: it doesn't say) */
export function serversNamed(message: string, keys: string[]): string[] {
  const m = String(message ?? "").toLowerCase();
  return keys.filter((k) => new RegExp(`(^|[^a-z0-9_-])${k.replace(/[-]/g, "\\-")}([^a-z0-9_-]|$)`).test(m));
}
