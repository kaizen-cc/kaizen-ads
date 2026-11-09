import { cookies } from "next/headers";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { checkState, tiktokConfigured, WAITING_TEXT } from "@/lib/tiktok/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 800; // the first pull starts right after connecting

// Back from TikTok's consent screen (?auth_code=…&state=…): the state checked against this browser's cookie, the code
// exchanged for the token (stored encrypted), the advertisers listed, and their first pull started.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (msg: string) => Response.redirect(`${url.origin}/settings?tab=sync&view=tiktok&tiktok=${encodeURIComponent(msg)}`, 302);
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return new Response("Only execs can connect TikTok.", { status: 403 });
  if (!tiktokConfigured()) return back(WAITING_TEXT);
  if (!adminConfigured()) return back("Server key missing.");
  const jar = await cookies();
  const saved = jar.get("tiktok_oauth")?.value ?? null;
  jar.delete("tiktok_oauth");
  const check = checkState(process.env.TIKTOK_APP_SECRET!, url.searchParams.get("state"), saved, viewer.id);
  if (!check.ok) return back(check.reason);
  // TikTok sends the code as auth_code (and also as code on newer redirects)
  const code = url.searchParams.get("auth_code") ?? url.searchParams.get("code");
  if (!code) return back("TikTok didn't send an authorization code. Try connecting again.");
  try {
    const admin = createAdminClient();
    const { connectTikTok, syncAllTikTok } = await import("@/lib/tiktok/store");
    const r = await connectTikTok(admin, code, viewer.id);
    after(async () => {
      await syncAllTikTok(admin).catch(() => null);
      const { refreshAllKpis } = await import("@/lib/kpi/sync");
      await refreshAllKpis(admin).catch(() => null);
    });
    return back(`connected:${r.advertisers}`);
  } catch (e) {
    return back(e instanceof Error ? e.message : "Couldn't connect TikTok.");
  }
}
