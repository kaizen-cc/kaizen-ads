import { cookies } from "next/headers";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { syncMarket } from "@/lib/market";
import { motionConnect, motionRedirect } from "@/lib/motion";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 800; // the first market sync starts right after connecting

// Back from Motion's sign-in: keep the tokens, read Motion's tools, and start the first market sync.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => Response.redirect(`${url.origin}/settings?tab=sync&motion=${encodeURIComponent(msg)}`, 302);
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return new Response("Only execs can connect Motion.", { status: 403 });
  if (!adminConfigured()) return back("Server key missing.");
  const jar = await cookies();
  const saved = jar.get("motion_oauth")?.value;
  jar.delete("motion_oauth");
  const { verifier, state } = saved ? (JSON.parse(saved) as { verifier: string; state: string }) : { verifier: "", state: "" };
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return back(`Motion said: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
  if (!code || !verifier || url.searchParams.get("state") !== state) return back("The sign-in didn't match. Try connecting again.");
  try {
    const admin = createAdminClient();
    await motionConnect(admin, code, verifier, motionRedirect(url.origin), viewer.id);
    after(() => syncMarket(admin).then(() => undefined));
    return back("connected");
  } catch (e) {
    return back(e instanceof Error ? e.message : "Couldn't connect Motion.");
  }
}
