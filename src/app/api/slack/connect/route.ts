import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { SLACK_USER_SCOPES, slackOAuthConfigured } from "@/lib/slack-user";
import { safeNext, withParams } from "../shared";

// A team member connects their own Slack, so reports can go out from them. Slack sends them back to /api/slack/callback.
export async function GET(request: Request) {
  await requireStaff();
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (!slackOAuthConfigured()) return Response.redirect(withParams(url.origin, next, { slack: "not_configured" }), 302);

  // A random state kept in an httpOnly cookie: the callback only accepts the answer to a sign-in this browser started
  const state = randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("slack_oauth", JSON.stringify({ state, next }), { httpOnly: true, secure: true, sameSite: "lax", path: "/api/slack", maxAge: 600 });

  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
  // Only user scopes: the bot's own scopes are untouched by this
  authorize.searchParams.set("user_scope", SLACK_USER_SCOPES);
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/slack/callback`);
  authorize.searchParams.set("state", state);
  return Response.redirect(authorize.toString(), 302);
}
