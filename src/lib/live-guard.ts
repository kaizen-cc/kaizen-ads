import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLive } from "@/lib/live";

/** Why nothing can be pulled or generated for this client right now (archived or paused), or null when they're live. */
export async function notLive(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("clients").select("status, archived_at").eq("id", clientId).maybeSingle();
  if (!data || isLive(data)) return null;
  return data.archived_at
    ? "This client is archived. Restore them first; until then their page is read-only."
    : "This client is paused. Set them back to active first; until then their page is read-only and nothing is pulled or generated.";
}
