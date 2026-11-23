import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { asanaOAuthConfigured } from "@/lib/asana-user";
import { safeNext, withParams } from "../../slack/shared";

// A teammate connects their own Asana (owner, Nov 23 2026), so "Next for me in Asana" mirrors their My tasks (private
// ones too) and what they change from Kaizen OS goes out as them. Asana sends them back to /api/asana/callback.
export async function GET(request: Request) {
  await requireStaff();
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next") ?? "/pipeline?block=asana");
  if (!asanaOAuthConfigured()) return Response.redirect(withParams(url.origin, next, { asana: "not_configured" }), 302);
  // A random state kept in an httpOnly cookie: the callback only accepts the answer to a sign-in this browser started
  const state = randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("asana_oauth", JSON.stringify({ state, next }), { httpOnly: true, secure: true, sameSite: "lax", path: "/api/asana", maxAge: 600 });
  const authorize = new URL("https://app.asana.com/-/oauth_authorize");
  authorize.searchParams.set("client_id", process.env.ASANA_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/asana/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  return Response.redirect(authorize.toString(), 302);
}
