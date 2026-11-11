// Connectors, the parts the browser needs too (no Node imports): what a connector is, how it signs in, its key, and
// the links to connect it.

/** How a connector signs in: OAuth 2.1 per the MCP spec (Kaizen AI gets its own client id: a metadata document or dynamic registration), OAuth with an app an exec set up once, a token each person pastes, or nothing */
export type AuthKind = "oauth" | "oauth_client" | "token" | "none";
export const AUTH_KINDS: { key: AuthKind; label: string; about: string }[] = [
  { key: "oauth", label: "Sign in (automatic)", about: "Like Claude: nothing to set up. Each person just signs in with their own account." },
  { key: "oauth_client", label: "Sign in (our app)", about: "The service needs its own app, set up once for the whole team. Each person then signs in with their own account." },
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
export function authFromProbe(p: { reachable: boolean; signIn: boolean; dcr: boolean; cimd?: boolean; meta: unknown }): AuthKind | null {
  if (!p.reachable) return null;
  if (!p.signIn) return "none";
  if (p.dcr || p.cimd) return "oauth";
  return p.meta ? "oauth_client" : "token";
}

/** Can this person use this connector in a chat: connected (a no-sign-in one once they switched it on) and active */
export function usable(c: Pick<Connector, "id" | "auth">, mine: { connector_id: string; status: string }[]) {
  return mine.some((m) => m.connector_id === c.id && (c.auth === "none" || m.status === "active"));
}

// ─── Links ─────────────────────────────────────────────────────────────────

/** Settings › Your connections (optionally opened on one connector): where Connect, Reconnect and Disconnect live */
export const connectionsHref = (key?: string | null) => `/ai?connectors=manage${key ? `&connector=${encodeURIComponent(key)}` : ""}`;
/** Kaizen AI with the plug menu open on one connector, ready to Connect (where "it's ready" notices link) */
export const chatConnectHref = (key: string) => `/ai?connectors=open&connector=${encodeURIComponent(key)}`;
/** Kaizen AI's Browse connectors (the whole Directory, featured first) */
export const browseHref = (q?: string | null) => `/ai?connectors=browse${q ? `&cq=${encodeURIComponent(q)}` : ""}`;
/** Settings › Connections › Team connectors, opened on the requests (execs) */
export const requestsHref = (ref?: string | null) => `/settings?tab=connections&section=team${ref ? `&request=${encodeURIComponent(ref)}` : ""}`;
/** Starts connecting (OAuth) and comes back to `ret` (a path in the app) */
export const connectHref = (key: string, ret?: string | null) => `/api/connectors/connect?key=${encodeURIComponent(key)}${ret ? `&return=${encodeURIComponent(ret)}` : ""}`;

// ─── The one-time app step ─────────────────────────────────────────────────

/**
 * Where to create the app for a service that doesn't let apps register themselves (the way Claude has a partner app
 * with each of them), matched by the server's host. Unknown services get no link.
 */
export const APP_SETUP: { hosts: string[]; vendor: string; url: string }[] = [
  { hosts: ["box.com"], vendor: "Box", url: "https://app.box.com/developers/console" },
  { hosts: ["githubcopilot.com", "github.com"], vendor: "GitHub", url: "https://github.com/settings/applications/new" },
  { hosts: ["hubspot.com"], vendor: "HubSpot", url: "https://developers.hubspot.com/get-started" },
  { hosts: ["slack.com"], vendor: "Slack", url: "https://api.slack.com/apps" },
  { hosts: ["xero.com"], vendor: "Xero", url: "https://developer.xero.com/app/manage" },
  { hosts: ["windsor.ai"], vendor: "Windsor.ai", url: "https://onboard.windsor.ai" },
  { hosts: ["asana.com"], vendor: "Asana", url: "https://app.asana.com/0/my-apps" },
];

/** The developer page where this server's app is created, when we know it */
export function appSetupFor(serverUrl: string): { vendor: string; url: string } | null {
  let host = "";
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = APP_SETUP.find((a) => a.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  return hit ? { vendor: hit.vendor, url: hit.url } : null;
}

/** Why this service asks for an app, in plain words (no jargon, and it's once for the team, not per person) */
export const appStepText = (name: string) =>
  `${name} doesn't let apps sign in on their own, so it needs its own Kaizen AI app, the way Claude has a partner app with ${name}. You set it up once for the whole team, not per person: create the app in ${name}'s developer settings with the redirect URL below, then paste its client ID. After that everyone just signs in.`;

// ─── Requests to enable ────────────────────────────────────────────────────

/** Where a connector stands for one person in Browse connectors */
export type BrowseState = "connected" | "enabled" | "requested" | "request" | "enable";

/**
 * A Directory entry's state for this person: connected or ready to connect when it's enabled for their role; otherwise
 * an exec can enable it right there, and anyone else asks (once: a pending request shows Requested).
 */
export function browseState(p: { enabledForMe: boolean; connected: boolean; requested: boolean; isExec: boolean }): BrowseState {
  if (p.enabledForMe) return p.connected ? "connected" : "enabled";
  if (p.isExec) return "enable";
  return p.requested ? "requested" : "request";
}

// ─── Kaizen AI's plug menu ─────────────────────────────────────────────────

/** A connector in the chat's plug menu: enabled for this person's role, and where their own connection stands */
export type MenuItem = {
  key: string;
  name: string;
  icon_url: string | null;
  note: string | null;
  auth: AuthKind;
  state: "connected" | "reconnect" | "not_connected";
  since: string | null;
  last4: string | null;
  tools: number;
  error: string | null;
};

/**
 * The plug menu's connectors: the enabled ones offered to this person's role (execs see every enabled one), A to Z,
 * connected first, each with their own connection's state. Off or other roles' connectors never show.
 */
export function chatMenu(
  catalog: Pick<Connector, "id" | "key" | "name" | "icon_url" | "note" | "auth" | "roles" | "enabled">[],
  mine: { connector_id: string; status: string; connected_at?: string | null; token_last4?: string | null; tools?: unknown[] | null; last_error?: string | null }[],
  me: { role: string; isExec: boolean },
): MenuItem[] {
  const rank = { connected: 0, reconnect: 1, not_connected: 2 } as const;
  return catalog
    .filter((c) => c.enabled && (me.isExec || !c.roles?.length || c.roles.includes(me.role)))
    .map((c): MenuItem => {
      const m = mine.find((x) => x.connector_id === c.id);
      return {
        key: c.key,
        name: c.name,
        icon_url: c.icon_url,
        note: c.note,
        auth: c.auth,
        state: !m ? "not_connected" : c.auth === "none" || m.status === "active" ? "connected" : "reconnect",
        since: m?.connected_at ?? null,
        last4: m?.token_last4 ?? null,
        tools: Array.isArray(m?.tools) ? m.tools.length : 0,
        error: m?.last_error ?? null,
      };
    })
    .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}
