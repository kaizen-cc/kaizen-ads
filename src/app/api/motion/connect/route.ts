import { cookies } from "next/headers";
import { getViewer } from "@/lib/auth";
import { motionAuthorizeUrl, motionRedirect } from "@/lib/motion";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Execs: sign in to Kaizen's Motion account. Motion sends them back to /api/motion/callback.
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return new Response("Only execs can connect Motion.", { status: 403 });
  if (!adminConfigured()) return new Response("Server key missing.", { status: 500 });
  const origin = new URL(request.url).origin;
  try {
    const { url, verifier, state } = await motionAuthorizeUrl(createAdminClient(), motionRedirect(origin));
    const jar = await cookies();
    jar.set("motion_oauth", JSON.stringify({ verifier, state }), { httpOnly: true, secure: true, sameSite: "lax", path: "/api/motion", maxAge: 600 });
    return Response.redirect(url, 302);
  } catch (e) {
    return Response.redirect(`${origin}/settings?tab=sync&motion=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't reach Motion")}`, 302);
  }
}
