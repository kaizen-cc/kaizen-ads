import { cookies } from "next/headers";
import { getViewer } from "@/lib/auth";
import { authorizeUrl, makeState, tiktokConfigured, tiktokRedirect, WAITING_TEXT } from "@/lib/tiktok/core";

// Execs: connect Kaizen's TikTok ad accounts. TikTok asks them to authorize Kaizen's app for the advertisers they pick,
// then sends them back to /api/tiktok/callback with an auth_code and the state set here.
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const back = (msg: string) => Response.redirect(`${origin}/settings?tab=sync&view=tiktok&tiktok=${encodeURIComponent(msg)}`, 302);
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return new Response("Only execs can connect TikTok.", { status: 403 });
  if (!tiktokConfigured()) return back(WAITING_TEXT);
  // Signed with the app secret and kept in an httpOnly cookie: the callback only takes an answer to this browser's own request
  const state = makeState(process.env.TIKTOK_APP_SECRET!, viewer.id);
  const jar = await cookies();
  jar.set("tiktok_oauth", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/tiktok", maxAge: 600 });
  return Response.redirect(authorizeUrl(process.env.TIKTOK_APP_ID!, state, tiktokRedirect(origin)), 302);
}
