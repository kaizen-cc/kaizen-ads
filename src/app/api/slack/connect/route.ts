import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { SLACK_DM_SCOPES, SLACK_READ_SCOPES, SLACK_USER_SCOPES, slackOAuthConfigured } from "@/lib/slack-user";
import { safeNext, withParams } from "../shared";

/** Kaizen's Slack workspace (SLACK_WORKSPACE_URL, else the company workspace) */
const slackWorkspaceUrl = () => (process.env.SLACK_WORKSPACE_URL?.trim() || "https://kaizen-marketing-hq.slack.com").replace(/\/+$/, "");

/** The workspace's team id: SLACK_TEAM_ID, else the bot's own workspace (null when neither answers) */
async function kaizenTeamId(): Promise<string | null> {
  if (process.env.SLACK_TEAM_ID?.trim()) return process.env.SLACK_TEAM_ID.trim();
  try {
    const { slack } = await import("@/lib/context/slack");
    const r = await slack<{ team_id?: string }>("auth.test", {});
    return r.team_id ?? null;
  } catch {
    return null;
  }
}

// A team member connects their own Slack, so reports can go out from them. Slack sends them back to /api/slack/callback.
export async function GET(request: Request) {
  await requireStaff();
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (!slackOAuthConfigured()) return Response.redirect(withParams(url.origin, next, { slack: "not_configured" }), 302);

  // A random state kept in an httpOnly cookie: the callback only accepts the answer to a sign-in this browser started
  const state = randomBytes(24).toString("base64url");
  const jar = await cookies();
  // Reading is asked for every time now (Nov 23 2026: every older sign-in asked for posting only, so no one's assistant
  // could search their Slack); ?post=1 only when Slack refused the reading scopes (the callback falls back to it)
  const read = url.searchParams.get("post") !== "1";
  // ?dm=1 also asks to start DMs and group DMs as them (conversations.open), from the group-DM card
  const dm = read && url.searchParams.get("dm") === "1";
  jar.set("slack_oauth", JSON.stringify({ state, next, read, dm }), { httpOnly: true, secure: true, sameSite: "lax", path: "/api/slack", maxAge: 600 });

  // Kaizen's own workspace, never Slack's generic sign-in (Head of Social, Nov 19 2026): the authorize page on the
  // workspace's domain signs them straight into it, and the team id (the bot's own workspace) preselects it
  const authorize = new URL(`${slackWorkspaceUrl()}/oauth/v2/authorize`);
  const team = await kaizenTeamId();
  if (team) authorize.searchParams.set("team", team);
  authorize.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
  // Only user scopes: the bot's own scopes are untouched by this
  authorize.searchParams.set("user_scope", read ? `${SLACK_USER_SCOPES},${SLACK_READ_SCOPES}${dm ? `,${SLACK_DM_SCOPES}` : ""}` : SLACK_USER_SCOPES);
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/slack/callback`);
  authorize.searchParams.set("state", state);
  return Response.redirect(authorize.toString(), 302);
}
