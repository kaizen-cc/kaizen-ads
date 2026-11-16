import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { holdersOf, unique, type SeatRow } from "@/lib/buyer-seats";

// Who hears about a client's email account: the email strategists seated on the client (the primary first), or, when
// nobody holds that seat, the Head of Email. Roles, not names: a person is only ever an id here.

export type EmailTeam = { strategists: string[]; heads: string[] };

export async function emailTeamFor(admin: SupabaseClient, clientId: string): Promise<EmailTeam> {
  const [{ data: seats }, { data: heads }] = await Promise.all([
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").eq("client_id", clientId).eq("role", "email_strategist"),
    admin.from("profiles").select("id").eq("role", "head_of_email").eq("is_active", true),
  ]);
  return { strategists: holdersOf((seats ?? []) as SeatRow[], "email_strategist", clientId), heads: unique((heads ?? []).map((h) => h.id as string)) };
}

/** Who is told: the seated strategists, else the Head of Email (so a client with no seat is never silent) */
export const whoHears = (t: EmailTeam): string[] => (t.strategists.length ? t.strategists : t.heads);
