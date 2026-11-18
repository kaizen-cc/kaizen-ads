import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { holdersOf, unique, type SeatRow } from "@/lib/buyer-seats";

// Who hears about a client's social accounts: the social media managers seated on the client (the primary first), or,
// when nobody holds that seat, the Head of Organic Social. Roles, not names: a person is only ever an id here.

export type SocialTeam = { managers: string[]; heads: string[] };

export async function socialTeamFor(admin: SupabaseClient, clientId: string): Promise<SocialTeam> {
  const [{ data: seats }, { data: heads }] = await Promise.all([
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").eq("client_id", clientId).eq("role", "social_manager"),
    admin.from("profiles").select("id").eq("role", "head_of_social").eq("is_active", true),
  ]);
  return { managers: holdersOf((seats ?? []) as SeatRow[], "social_manager", clientId), heads: unique((heads ?? []).map((h) => h.id as string)) };
}

/** Who is told: the seated managers, else the Head of Organic Social (so a client with no seat is never silent) */
export const whoHearsSocial = (t: SocialTeam): string[] => (t.managers.length ? t.managers : t.heads);
