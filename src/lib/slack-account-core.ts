// Their own Slack on Settings › Connections › Your accounts. Slack is connected natively (/api/slack/connect, a user
// token in slack_user_tokens), not as a Kaizen AI connector, so the connector list never had a row for it. Pure, so
// it's tested.

/** Where Your accounts lives: Slack sends them back here after they approve */
export const YOUR_ACCOUNTS = "/settings?tab=connections&section=yours";

/** What their assistant needs to read their Slack (searching, their DMs): the same scopes the assistant's tools check */
export const SLACK_READING = ["search:read", "im:history"];

export type SlackAccountState = "reading" | "posting" | "not_connected";

/** Connected for reading (and posting), for posting only (an older connection), or not at all */
export function slackAccountState(conn: { scopes: string | null } | null): SlackAccountState {
  if (!conn) return "not_connected";
  const scopes = String(conn.scopes ?? "").split(/[\s,]+/).filter(Boolean);
  return SLACK_READING.every((s) => scopes.includes(s)) ? "reading" : "posting";
}

/** Connecting always asks for reading too, so one tap lets their assistant search their Slack and DMs */
export const slackConnectHref = (next = YOUR_ACCOUNTS) => `/api/slack/connect?read=1&next=${encodeURIComponent(next)}`;

/** The note after Slack sends them back (?slack=connected|error|not_configured), or null */
export function slackFlash(slack: string | null, reason: string | null): { text: string; bad: boolean } | null {
  if (slack === "connected") return { text: "Slack is connected. Your assistant can search your channels and DMs.", bad: false };
  if (slack === "not_configured") return { text: "Slack connecting isn't set up yet. An admin adds the Slack app's client id and secret first.", bad: true };
  if (slack === "error") return { text: reason === "access_denied" ? "Slack wasn't connected: it was cancelled on Slack's screen." : `Slack wasn't connected${reason ? ` (${reason})` : ""}. Try again.`, bad: true };
  return null;
}
