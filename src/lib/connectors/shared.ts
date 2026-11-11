// Connectors, the parts the browser needs too (no Node imports): what a connector is, how it signs in, its key, and
// the links to connect it.

/** How a connector signs in: OAuth 2.1 per the MCP spec (with dynamic client registration), OAuth with a client the exec registered, a token each person pastes, or nothing */
export type AuthKind = "oauth" | "oauth_client" | "token" | "none";
export const AUTH_KINDS: { key: AuthKind; label: string; about: string }[] = [
  { key: "oauth", label: "OAuth (automatic)", about: "The server registers Kaizen Ads itself (dynamic client registration). Each person signs in with their own account." },
  { key: "oauth_client", label: "OAuth (our app)", about: "You registered an app with the service: paste its client id and secret. Each person signs in with their own account." },
  { key: "token", label: "Personal token", about: "Each person pastes an API token from their own account." },
  { key: "none", label: "No sign in", about: "A public server. Nothing to connect: people just switch it on in a chat." },
];

export type Connector = {
  id: string;
  key: string; // lowercase, e.g. "shopify": what projects list and the MCP server name
  name: string;
  icon_url: string | null;
  url: string; // the remote MCP server (streamable HTTP or SSE)
  auth: AuthKind;
  client_id: string | null; // oauth_client
  scopes: string | null; // space separated; empty = what the server asks for
  note: string | null; // what it's for
  roles: string[] | null; // null or empty = everyone
  enabled: boolean;
  /** Offered from the registry: its entry (keeps the URL and version current) */
  registry_name?: string | null;
  registry_version?: string | null;
};

export const KEY_RE = /^[a-z][a-z0-9_-]{1,39}$/;

/** A connector's key from its name: "Google Drive" → "google-drive" */
export function keyFrom(name: string) {
  const k = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(k) ? k : `c-${k}`.slice(0, 40);
}

/** A key from a name that no other connector uses ("Shopify" → "shopify", or "shopify-2" when that's taken) */
export function uniqueKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = keyFrom(name || "connector").slice(0, 36).replace(/-+$/, "") || "connector";
  const root = KEY_RE.test(base) ? base : keyFrom(`c ${base}`);
  let key = root;
  for (let n = 2; used.has(key); n++) key = `${root}-${n}`;
  return key;
}

/**
 * How a server signs people in, from what it says about itself (MCP authorization spec): it answered without asking
 * for a sign in (nothing to set up), it registers apps itself (OAuth, automatic), it has OAuth but no registration (an
 * app must be registered with the service first: client id and secret), or it asks for a sign in with no OAuth at all
 * (each person pastes a token). Null when it didn't answer.
 */
export function authFromProbe(p: { reachable: boolean; signIn: boolean; dcr: boolean; meta: unknown }): AuthKind | null {
  if (!p.reachable) return null;
  if (!p.signIn) return "none";
  if (p.dcr) return "oauth";
  return p.meta ? "oauth_client" : "token";
}

/** Can this person use this connector in a chat: connected (a no-sign-in one once they switched it on) and active */
export function usable(c: Pick<Connector, "id" | "auth">, mine: { connector_id: string; status: string }[]) {
  return mine.some((m) => m.connector_id === c.id && (c.auth === "none" || m.status === "active"));
}

// ─── Links ─────────────────────────────────────────────────────────────────

/** Settings › Your connections (optionally opened on one connector): where Connect, Reconnect and Disconnect live */
export const connectionsHref = (key?: string | null) => `/settings?tab=connections&section=yours${key ? `&connector=${encodeURIComponent(key)}` : ""}`;
/** Starts connecting (OAuth) and comes back to `ret` (a path in the app) */
export const connectHref = (key: string, ret?: string | null) => `/api/connectors/connect?key=${encodeURIComponent(key)}${ret ? `&return=${encodeURIComponent(ret)}` : ""}`;
