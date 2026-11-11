// How a remote MCP server signs people in, read from what it says about itself (MCP authorization spec, 2025-06 and
// 2025-11): the 401's WWW-Authenticate points at its protected resource metadata (or the well-known paths, path-aware
// first), which names the authorization server; that server's metadata (RFC 8414 or OpenID Connect, issuers with paths
// too) has the endpoints and says how a client gets an id: a Client ID Metadata Document (our own URL is the client
// id, nothing to register), dynamic client registration, or neither (an app registered with the service by hand, once
// for the whole team). The network is passed in, so recorded metadata shapes can be tested without it. No Node imports.

export type AuthMeta = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  scopes: string | null;
  token_auth_methods: string[];
  /** The authorization server takes a Client ID Metadata Document URL as the client id */
  cimd?: boolean;
  /** Endpoints guessed from the server's origin (the 2025-03 spec's defaults), not read from metadata */
  guessed?: boolean;
};

/** How Kaizen AI gets an OAuth client id for a server: our metadata document, registering itself, or an app an exec set up */
export type ClientRoute = "cimd" | "dcr" | "app";

export type Probe = { reachable: boolean; signIn: boolean; meta: AuthMeta | null; dcr: boolean; cimd: boolean; route: ClientRoute | null };

/** A GET that answers JSON (null when it doesn't), and the unauthenticated MCP initialize */
export type Net = {
  json: (url: string) => Promise<Record<string, unknown> | null>;
  probe: (url: string) => Promise<{ status: number; wwwAuthenticate: string | null } | null>;
};

/** resource_metadata="…" from a 401's WWW-Authenticate header */
export function resourceMetadataFrom(header: string | null | undefined): string | null {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(String(header ?? "")) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(String(header ?? ""));
  return m ? m[1] : null;
}

/** Where a server's protected resource metadata may be: path-aware first, then the root */
export function protectedResourceUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const out = path && path !== "/" ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : [];
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/** Where an authorization server's metadata may be (RFC 8414 and OpenID Connect, with and without a path) */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
const httpsUrl = (v: unknown) => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1" ? u.toString() : null;
  } catch {
    return null;
  }
};

/** An authorization server's metadata as we keep it (null when it lacks the two endpoints every sign in needs) */
export function authMetaFrom(as: Record<string, unknown> | null, issuer: string, scopes: string | null): AuthMeta | null {
  if (!as) return null;
  const authorization = httpsUrl(as.authorization_endpoint);
  const token = httpsUrl(as.token_endpoint);
  if (!authorization || !token) return null;
  return {
    issuer: typeof as.issuer === "string" && as.issuer ? as.issuer : issuer,
    authorization_endpoint: String(as.authorization_endpoint),
    token_endpoint: String(as.token_endpoint),
    registration_endpoint: httpsUrl(as.registration_endpoint) ? String(as.registration_endpoint) : null,
    scopes,
    token_auth_methods: strings(as.token_endpoint_auth_methods_supported),
    cimd: as.client_id_metadata_document_supported === true,
  };
}

/**
 * How Kaizen AI gets a client id from this server: an app the exec set up wins when there is one; otherwise our
 * Client ID Metadata Document when the server takes one (and our address is https, which the server must fetch);
 * otherwise registering itself; only then an app set up by hand.
 */
export function clientRoute(meta: Pick<AuthMeta, "cimd" | "registration_endpoint"> | null, opts: { hasApp?: boolean; httpsOrigin?: boolean } = {}): ClientRoute {
  if (opts.hasApp) return "app";
  if (meta?.cimd && opts.httpsOrigin !== false) return "cimd";
  if (meta?.registration_endpoint) return "dcr";
  return "app";
}

/**
 * Discovery, start to finish. Every authorization server the resource lists is tried in turn, each at its RFC 8414 and
 * OpenID paths. With no metadata at all, a server that asked for a sign in is looked up at its own origin, and failing
 * that the earlier spec's default endpoints are assumed (marked guessed).
 */
export async function discoverWith(net: Net, url: string): Promise<Probe> {
  const p = await net.probe(url);
  const signIn = p ? p.status === 401 || p.status === 403 : false;
  const fromHeader = resourceMetadataFrom(p?.wwwAuthenticate);
  let prm: Record<string, unknown> | null = null;
  const tried = new Set<string>();
  for (const u of [...(fromHeader ? [fromHeader] : []), ...protectedResourceUrls(url)]) {
    if (tried.has(u)) continue;
    tried.add(u);
    prm = await net.json(u);
    if (prm && (Array.isArray(prm.authorization_servers) || typeof prm.resource === "string")) break;
    prm = null;
  }
  const origin = new URL(url).origin;
  const issuers = strings(prm?.authorization_servers);
  const scopes = strings(prm?.scopes_supported).join(" ") || null;
  let meta: AuthMeta | null = null;
  for (const issuer of issuers.length ? issuers : [origin]) {
    for (const u of authServerMetadataUrls(issuer)) {
      meta = authMetaFrom(await net.json(u), issuer, scopes);
      if (meta) break;
    }
    if (meta) break;
  }
  if (!meta && signIn && !prm) {
    meta = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, scopes: null, token_auth_methods: [], cimd: false, guessed: true };
  }
  const reachable = Boolean(p);
  const asks = signIn || Boolean(prm);
  return { reachable, signIn: asks, meta, dcr: Boolean(meta?.registration_endpoint), cimd: Boolean(meta?.cimd), route: reachable && asks && meta ? clientRoute(meta) : null };
}

/** The Client ID Metadata Document Kaizen AI is known by: its URL is the client id, so it lists that same URL */
export function clientMetadataDocument(origin: string) {
  const base = origin.replace(/\/+$/, "");
  return {
    client_id: `${base}${CLIENT_METADATA_PATH}`,
    client_name: "Kaizen AI",
    client_uri: base,
    logo_uri: `${base}/kaizen-logo.png`,
    redirect_uris: [`${base}${CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export const CALLBACK_PATH = "/api/connectors/callback";
export const CLIENT_METADATA_PATH = "/api/connectors/client-metadata.json";
