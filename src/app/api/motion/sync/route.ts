import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { syncMarket } from "@/lib/market";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 800;

// Execs: run the market sync now (it otherwise runs every morning at 6am)
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return new Response("Only execs can run the market sync.", { status: 403 });
  if (!adminConfigured()) return new Response("Server key missing.", { status: 500 });
  const admin = createAdminClient();
  after(() => syncMarket(admin).then(() => undefined));
  return Response.redirect(`${new URL(request.url).origin}/settings?tab=sync&motion=syncing`, 302);
}
