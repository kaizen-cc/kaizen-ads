import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activePauses, type ActivePause, type PauseRow } from "./pauses-core";

/** The clients with a service paused today, with the date and the reason (empty before the account watch migration) */
export async function loadPauses(db: SupabaseClient, service: string, today: string): Promise<Map<string, ActivePause>> {
  try {
    const { data, error } = await db.from("watch_pauses").select("client_id, service, until, reason, cleared_at").eq("service", service).is("cleared_at", null).gte("until", today);
    if (error) return new Map();
    return activePauses((data ?? []) as PauseRow[], service, today);
  } catch {
    return new Map();
  }
}
