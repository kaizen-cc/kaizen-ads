// Each person's own work accounts as the assistant uses them: their Slack and their Asana (their own sign-ins), and
// Gmail, Drive and Calendar (through Kaizen's Google Workspace: nothing for them to connect, an admin setting when
// Google refuses). What's usable, what isn't and why, and the one-tap fix: said in the conversation with a Connect or
// Reconnect card that picks the ask back up once they're connected. Pure: no keys, no network, tested on its own.

export type Service = "slack" | "gmail" | "drive" | "calendar" | "asana";
export const SERVICE_NAME: Record<Service, string> = { slack: "Slack", gmail: "Gmail", drive: "Google Drive", calendar: "Google Calendar", asana: "Asana" };

/** connected: works; missing: never connected; reconnect: the connection stopped working; missing_scope: works, but not for this; admin: the company setting is missing (nothing for them to do) */
export type ConnState = "connected" | "missing" | "reconnect" | "missing_scope" | "admin" | "off";

/** What the assistant needs to read Slack as them (search, threads in channels, private channels, DMs and group DMs, and listing their DMs) */
export const SLACK_READ_NEEDS = ["search:read", "channels:history", "groups:history", "im:history", "mpim:history", "im:read", "mpim:read"] as const;
export const SLACK_POST_NEEDS = ["chat:write"] as const;

/** Scopes as Slack stores them ("chat:write,files:write" or space separated) */
export const scopesOf = (s: string | null | undefined) =>
  String(s ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Errors from Slack that mean the token itself is dead: connect again */
export const SLACK_DEAD = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "user_removed_from_team", "team_disabled"]);

/** A person's Slack from what's stored (and, when it was checked, what Slack's auth.test said) */
export function slackState(row: { scopes: string | null } | null, authError?: string | null): { state: ConnState; missing: string[] } {
  if (!row) return { state: "missing", missing: [...SLACK_READ_NEEDS] };
  if (authError && SLACK_DEAD.has(authError)) return { state: "reconnect", missing: [] };
  const have = scopesOf(row.scopes);
  const missing = [...SLACK_POST_NEEDS, ...SLACK_READ_NEEDS].filter((s) => !have.includes(s));
  return { state: missing.length ? "missing_scope" : "connected", missing };
}

/** Where connecting sends them: Slack's sign-in, back to `back` (a conversation lands on /connected, which tells it) */
export function connectHref(service: Service, back = `/connected?service=${service}`): string | null {
  if (service === "slack") return `/api/slack/connect?read=1&next=${encodeURIComponent(back)}`;
  if (service === "asana") return `/api/asana/connect?next=${encodeURIComponent(back)}`; // their own Asana (OAuth)
  return null; // Gmail, Drive and Calendar go through Kaizen's Google Workspace: nothing for them to connect
}

export type NeedsConnection = {
  needs_connection: { service: Service; state: ConnState; fix: "connect" | "reconnect" | "admin"; link: string | null; missing?: string[]; for_the_admin?: string };
  say: string;
};

/** The structured answer every Slack, Gmail, Drive, Calendar and Asana tool gives when the account isn't usable */
export function needsConnection(service: Service, state: ConnState, opts: { missing?: string[]; forAdmin?: string; what?: string } = {}): NeedsConnection {
  const name = SERVICE_NAME[service];
  const what = opts.what ?? (service === "slack" ? "read your Slack" : `use your ${name}`);
  if (state === "admin" || state === "off") {
    return {
      needs_connection: { service, state, fix: "admin", link: null, ...(opts.forAdmin ? { for_the_admin: opts.forAdmin } : {}) },
      say: `I can't ${what} yet: it needs a company setting an admin turns on, nothing for you to connect. Say that in one short line; the executives have been told.`,
    };
  }
  const fix = state === "missing" ? "connect" : "reconnect";
  return {
    needs_connection: { service, state, fix, link: connectHref(service), ...(opts.missing?.length ? { missing: opts.missing } : {}) },
    say:
      state === "missing_scope"
        ? `Their ${name} is connected for posting only, so I can't ${what}. Say so in one short line: the Reconnect card on screen fixes it in one tap (then approve in ${name}), and you'll pick this up as soon as they're back.`
        : state === "reconnect"
          ? `Their ${name} connection stopped working. Say so in one short line: the Reconnect card on screen fixes it in one tap, and you'll pick this up as soon as they're back.`
          : `Their ${name} isn't connected to Kaizen OS yet. Say so in one short line: the Connect card on screen does it in one tap, and you'll pick this up as soon as they're back.`,
  };
}

/** The card shown in the conversation (call or chat) for a fix they can make themselves */
export function connectCard(n: NeedsConnection): { id: string; title: string; detail: string; href: string; external: true; cta: string; connect: { service: Service } } | null {
  const c = n.needs_connection;
  if (!c.link) return null;
  const name = SERVICE_NAME[c.service];
  return {
    id: `connect-${c.service}`,
    title: c.fix === "connect" ? `Connect your ${name}` : `Reconnect your ${name}`,
    detail: c.state === "missing_scope" ? "Posting only, reading off: reconnect so I can search and read it" : c.state === "reconnect" ? "The connection stopped working" : "One tap, then approve",
    href: c.link,
    external: true,
    cta: c.fix === "connect" ? "Connect" : "Reconnect",
    connect: { service: c.service },
  };
}

/** The hello's one line about a broken connection (not for one never set up: that's asked for when it's needed) */
export function helloConnectionLine(service: Service, state: ConnState): string | null {
  const name = SERVICE_NAME[service];
  if (state === "missing_scope") return `By the way, your ${name} is connected for posting only, so I can't search or read it for you. Want to reconnect it? It's one tap.`;
  if (state === "reconnect") return `By the way, your ${name} connection stopped working, so I can't use it for you right now. Want to reconnect it? It's one tap.`;
  return null;
}

/** The words the conversation sends once they've connected, so the assistant picks the ask back up */
export const resumeLine = (service: Service) => `I've connected my ${SERVICE_NAME[service]}. Go ahead with what I asked.`;
