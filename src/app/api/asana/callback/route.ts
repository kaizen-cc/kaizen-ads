import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { asanaOAuthConfigured, connectAsana } from "@/lib/asana-user";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNext, withParams } from "../../slack/shared";

// Back from Asana: check it's the sign-in this browser started, swap the code for their tokens and keep them.
export async function GET(request: Request) {
  const staff = await requireStaff();
  const url = new URL(request.url);
  const jar = await cookies();
  const saved = jar.get("asana_oauth")?.value;
  jar.delete({ name: "asana_oauth", path: "/api/asana" }); // one use only
  let started: { state?: string; next?: string } = {};
  try {
    started = saved ? JSON.parse(saved) : {};
  } catch {
    // A mangled cookie is treated like no cookie: the state check below fails
  }
  const next = safeNext(started.next ?? "/pipeline?block=asana");
  const back = (params: Record<string, string>) => Response.redirect(withParams(url.origin, next, params), 302);
  if (!asanaOAuthConfigured()) return back({ asana: "not_configured" });
  const denied = url.searchParams.get("error");
  if (denied) return back({ asana: "error", reason: denied });
  const code = url.searchParams.get("code");
  if (!code || !started.state || url.searchParams.get("state") !== started.state) return back({ asana: "error", reason: "state_mismatch" });
  if (staff.viewAs) return back({ asana: "error", reason: "view_as" });
  try {
    const r = await connectAsana(createAdminClient(), staff.id, code, `${url.origin}/api/asana/callback`, staff.email);
    // Signed in to Asana as someone else: Settings asks before it's used
    if (r.mismatch) return Response.redirect(withParams(url.origin, "/settings?tab=connections&section=yours", { asana: "mismatch", as: r.mismatch.slice(0, 120) }), 302);
    return back({ asana: "connected" });
  } catch (e) {
    return back({ asana: "error", reason: e instanceof Error ? e.message.slice(0, 80) : "exchange_failed" });
  }
}
