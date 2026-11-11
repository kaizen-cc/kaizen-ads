import { cookies } from "next/headers";
import { getViewer } from "@/lib/auth";
import { connectionsHref } from "@/lib/connectors/core";
import { adminConfigured } from "@/lib/supabase/admin";

// Back from a service's sign in (?code=…&state=…): the state's signature, this person and this browser's cookie must
// all match before the code is exchanged (with the PKCE verifier) for their tokens, which are stored encrypted. Then
// back to where they connected from (the same Kaizen AI chat), errors included; Kaizen AI's plug menu otherwise.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const to = (path: string, param: string, value: string) => Response.redirect(`${url.origin}${path}${path.includes("?") ? "&" : "?"}${param}=${encodeURIComponent(value)}`, 302);
  const viewer = await getViewer();
  if (viewer.kind !== "staff") return new Response("Only the team can connect services.", { status: 403 });
  const jar = await cookies();
  const { COOKIE, finishConnect, returnOf } = await import("@/lib/connectors/server");
  const saved = jar.get(COOKIE)?.value;
  jar.delete({ name: COOKIE, path: "/api/connectors" });
  const state = url.searchParams.get("state");
  const back = returnOf(state) ?? connectionsHref();
  if (!adminConfigured()) return to(back, "connect_error", "Server key missing.");
  const err = url.searchParams.get("error");
  if (err) return to(back, "connect_error", err === "access_denied" ? "You cancelled the sign in." : `The service said: ${(url.searchParams.get("error_description") ?? err).slice(0, 200)}`);
  const code = url.searchParams.get("code");
  if (!code || !state) return to(back, "connect_error", "The service didn't send a sign in code. Try Connect again.");
  try {
    const r = await finishConnect(viewer, { code, state, cookie: saved, origin: url.origin });
    return to(r.ret ?? connectionsHref(r.connector.key), "connected", r.connector.key);
  } catch (e) {
    return to(back, "connect_error", e instanceof Error ? e.message : "Couldn't finish connecting.");
  }
}
