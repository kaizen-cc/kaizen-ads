"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { ROLE_DEFS } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const flagsFrom = (form: FormData) =>
  Object.fromEntries(ROLE_DEFS.map((d) => [d.column, form.get(d.column) === "on"])) as Record<string, boolean>;

/** Execs: change someone's roles. You can't remove your own executive role (no lock-out). */
export async function saveRoles(profileId: string, form: FormData): Promise<ActionResult> {
  const me = await requireExec();
  const flags = flagsFrom(form);
  if (profileId === me.id && !flags.is_exec) return { ok: false, error: "You can't remove your own executive role." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ ...flags, is_active: form.get("is_active") === "on" || profileId === me.id })
    .eq("id", profileId);
  revalidatePath("/team");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: invite a teammate. Creating the profile is the invite; they sign in with Google. */
export async function addPerson(form: FormData): Promise<ActionResult> {
  await requireExec();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const fullName = String(form.get("full_name") ?? "").trim();
  if (!email.endsWith("@kaizenmarketing.agency")) return { ok: false, error: "Use their @kaizenmarketing.agency email." };
  if (!fullName) return { ok: false, error: "Add their name." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").insert({ email, full_name: fullName, ...flagsFrom(form) });
  revalidatePath("/team");
  if (error?.code === "23505") return { ok: false, error: `${email} is already on the team.` };
  return error ? { ok: false, error: error.message } : { ok: true };
}
