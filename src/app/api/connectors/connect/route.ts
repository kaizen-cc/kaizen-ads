import { cookies } from "next/headers";
import { getViewer } from "@/lib/auth";
import { connectionsHref, safeReturn } from "@/lib/connectors/core";
import { adminConfigured } from "@/lib/supabase/admin";

// Connect a connector (OAuth; one that needs no sign in is just switched on): the person is sent to the service's own sign in with PKCE and a signed state; the PKCE
// verifier waits in an httpOnly cookie (sealed) until /api/connectors/callback. ?return= brings them back to the chat
// they connected from.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const k = url.searchParams.get("key") ?? "";
  const ret = safeReturn(url.searchParams.get("return"));
  const back = (msg: string) => Response.redirect(`${url.origin}${ret ?? connectionsHref(k)}${(ret ?? connectionsHref(k)).includes("?") ? "&" : "?"}connect_error=${encodeURIComponent(msg)}`, 302);
  const viewer = await getViewer();
  if (viewer.kind !== "staff") return new Response("Only the team can connect services.", { status: 403 });
  if (!adminConfigured()) return back("Server key missing.");
  try {
    const { connectOpen, connectorByKey, startConnect, COOKIE } = await import("@/lib/connectors/server");
    // Nothing to sign in to: connecting just switches it on for this person
    const { createAdminClient } = await import("@/lib/supabase/admin");
    if ((await connectorByKey(createAdminClient(), k))?.auth === "none") {
      const c = await connectOpen(viewer, k);
      const to = ret ?? connectionsHref(c.key);
      return Response.redirect(`${url.origin}${to}${to.includes("?") ? "&" : "?"}connected=${encodeURIComponent(c.key)}`, 302);
    }
    const s = await startConnect(viewer, k, url.origin, ret);
    const jar = await cookies();
    jar.set(COOKIE, s.cookie, { httpOnly: true, secure: url.protocol === "https:", sameSite: "lax", path: "/api/connectors", maxAge: 600 });
    return Response.redirect(s.url, 302);
  } catch (e) {
    return back(e instanceof Error ? e.message : "Couldn't start connecting.");
  }
}
