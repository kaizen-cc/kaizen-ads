import { cleanFocus } from "@/lib/exec-focus/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ExecFocusCard } from "./exec-focus-card";

/** Execs: what each exec hears about (their lines), plus what's personal to them and every client on fire */
export async function ExecFocus({ me }: { me: string }) {
  if (!adminConfigured()) return null;
  const { data, error } = await createAdminClient().from("profiles").select("id, full_name, display_name, exec_focus").eq("is_exec", true).eq("is_active", true).order("full_name");
  // An older database without the column: nothing to set yet
  if (error || !data?.length) return null;
  const execs = data.map((p) => ({ id: p.id as string, name: ((p.display_name as string | null) || (p.full_name as string)) ?? "Exec", focus: cleanFocus((p.exec_focus as string[] | null) ?? []) }));
  // Their own first
  execs.sort((a, b) => Number(b.id === me) - Number(a.id === me));
  return <ExecFocusCard execs={execs} me={me} />;
}
