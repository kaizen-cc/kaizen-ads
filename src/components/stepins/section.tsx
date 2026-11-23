import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { loadStepins } from "@/lib/stepins/act";
import { StepinsHero } from "./deck";

// On an exec's Overview, under the Wrapped hero: this week's step-ins (src/lib/stepins), the deck of client cards that
// need an exec, scoped to their focus lines plus company-wide fires. Nothing shows for anyone else.

export async function stepinPeople(db: SupabaseClient) {
  const { data } = await db.from("profiles").select("id, full_name, is_exec, role").eq("is_active", true).order("full_name");
  // Execs first (they take most step-ins), then the leads and owners they hand them to
  const rows = (data ?? []) as { id: string; full_name: string; is_exec: boolean | null; role: string }[];
  const lead = (r: string) => /^head_of_/.test(r) || ["media_buyer", "google_buyer", "email_strategist", "social_media_manager", "customer_success"].includes(r);
  return [...rows.filter((r) => r.is_exec), ...rows.filter((r) => !r.is_exec && lead(r.role))].map((r) => ({ id: r.id, name: r.full_name }));
}

export async function StepinsSection({ db, me }: { db: SupabaseClient; me: Staff }) {
  if (!me.isExec) return null;
  const [cards, people] = await Promise.all([loadStepins(db, me).catch(() => []), stepinPeople(db).catch(() => [])]);
  return <StepinsHero cards={cards} people={people} compact />;
}
