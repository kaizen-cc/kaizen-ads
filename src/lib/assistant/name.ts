import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** What a person calls their assistant (null: the default; also null before the profiles migration, so nothing breaks) */
export async function assistantNameOf(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("assistant_name").eq("id", profileId).maybeSingle();
  if (error) return null;
  return (data?.assistant_name as string | null) ?? null;
}
