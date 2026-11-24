import { requireStaff } from "@/lib/auth";
import { disconnectAsana } from "@/lib/asana-user";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNext, withParams } from "../../slack/shared";

// Disconnects their own Asana (the shared view comes back: tasks assigned to their email, no private ones). switch=1:
// then straight to Asana's sign-in to connect another account (back to `next`)
export async function POST(request: Request) {
  const staff = await requireStaff();
  const url = new URL(request.url);
  if (!staff.viewAs) await disconnectAsana(createAdminClient(), staff.id);
  if (url.searchParams.get("switch") === "1") return Response.redirect(withParams(url.origin, "/api/asana/connect", { next: safeNext(url.searchParams.get("next") ?? "/settings?tab=connections&section=yours") }), 303);
  return Response.redirect(withParams(url.origin, safeNext(url.searchParams.get("next") ?? "/settings?tab=connections"), { asana: "disconnected" }), 303);
}
