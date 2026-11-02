import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Which of the portal's sections a client has: setup while onboarding, how we see them once it's been sent */
export async function portalSections(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: p }] = await Promise.all([
    admin.from("clients").select("status").eq("id", clientId).single(),
    admin.from("client_presentations").select("status").eq("client_id", clientId).maybeSingle(),
  ]);
  return { setup: c?.status === "onboarding", plan: ["sent", "approved"].includes((p?.status as string) ?? "") };
}
