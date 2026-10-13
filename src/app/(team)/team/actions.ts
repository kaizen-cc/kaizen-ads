"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { ROLES, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const isRole = (v: unknown): v is TeamRole => ROLES.some((r) => r.value === v);

/** Execs: change someone's role (which sets their access tier). */
export async function setRole(profileId: string, role: string): Promise<ActionResult> {
  const me = await requireExec();
  if (!isRole(role)) return { ok: false, error: "Pick a role from the list." };
  if (profileId === me.id && role !== "executive") return { ok: false, error: "You can't remove your own executive access." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ role }).eq("id", profileId);
  revalidatePath("/team");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: turn someone's access on or off (history stays). */
export async function setActive(profileId: string, active: boolean): Promise<ActionResult> {
  const me = await requireExec();
  if (profileId === me.id && !active) return { ok: false, error: "You can't deactivate yourself." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ is_active: active }).eq("id", profileId);
  revalidatePath("/team");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: invite a teammate. Creating the profile is the invite; they sign in with Google. */
export async function invitePerson(form: FormData): Promise<ActionResult> {
  await requireExec();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const fullName = String(form.get("full_name") ?? "").trim();
  const role = form.get("role");
  if (!fullName) return { ok: false, error: "Add their name." };
  if (!email.endsWith("@kaizenmarketing.agency")) return { ok: false, error: "Use their @kaizenmarketing.agency email." };
  if (!isRole(role)) return { ok: false, error: "Pick a role." };
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").insert({ email, full_name: fullName, role });
  revalidatePath("/team");
  if (error?.code === "23505") return { ok: false, error: `${email} is already on the team.` };
  return error ? { ok: false, error: error.message } : { ok: true };
}
