import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Whether the app may reach a client on its own (the welcome at enrollment, the presentation sent after a business day,
// "you're live"). Off until Kaizen launches the portal to clients: until then only the sandbox client gets them, and
// anything a person sends by hand from the app still goes. Settings → app_settings "client_outreach" {on}.

export const SANDBOX_SLUG = "kaizen-sandbox";

export async function autoOutreach(admin: SupabaseClient, clientId: string) {
  const [{ data: s }, { data: c }] = await Promise.all([admin.from("app_settings").select("value").eq("key", "client_outreach").maybeSingle(), admin.from("clients").select("slug").eq("id", clientId).maybeSingle()]);
  return Boolean((s?.value as { on?: boolean } | null)?.on) || c?.slug === SANDBOX_SLUG;
}
