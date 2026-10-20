import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { saveSlackConnection, slackOAuthConfigured } from "@/lib/slack-user";
import { safeNext, withParams } from "../shared";

type OAuthAccess = { ok: boolean; error?: string; authed_user?: { id?: string; access_token?: string; scope?: string }; team?: { id?: string } };

// Back from Slack: check it's the sign-in this browser started, swap the code for the person's token and keep it.
export async function GET(request: Request) {
  const staff = await requireStaff();
  const url = new URL(request.url);
  const jar = await cookies();
  const saved = jar.get("slack_oauth")?.value;
  jar.delete({ name: "slack_oauth", path: "/api/slack" }); // one use only
  let started: { state?: string; next?: string } = {};
  try {
    started = saved ? JSON.parse(saved) : {};
  } catch {
    // A mangled cookie is treated like no cookie: the state check below fails
  }
  const next = safeNext(started.next);
  const back = (params: Record<string, string>) => Response.redirect(withParams(url.origin, next, params), 302);

  if (!slackOAuthConfigured()) return back({ slack: "not_configured" });
  // Cancelling on Slack's screen comes back as error=access_denied
  const denied = url.searchParams.get("error");
  if (denied) return back({ slack: "error", reason: denied });
  const code = url.searchParams.get("code");
  if (!code || !started.state || url.searchParams.get("state") !== started.state) return back({ slack: "error", reason: "state_mismatch" });

  try {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code,
        redirect_uri: `${url.origin}/api/slack/callback`,
      }),
      cache: "no-store",
    });
    const body = (await res.json()) as OAuthAccess;
    if (!body.ok) return back({ slack: "error", reason: body.error ?? "exchange_failed" });
    const user = body.authed_user;
    if (!user?.id || !user.access_token) return back({ slack: "error", reason: "no_user_token" });
    await saveSlackConnection(staff.id, { slackUserId: user.id, teamId: body.team?.id ?? "", token: user.access_token, scopes: user.scope ?? "" });
    return back({ slack: "connected" });
  } catch (e) {
    return back({ slack: "error", reason: e instanceof Error ? e.message : "exchange_failed" });
  }
}
