"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The names a team member shows under in Meta's activity log and Google's change history ("Luriel Rt", an old email):
// change history then shows them by their own name, and the account watch knows the change was ours. The person
// themselves, a lead or an exec edits them.

export async function savePlatformAliases(profileId: string, aliases: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.id !== profileId && !me.isExec && !me.isLead) return { ok: false, error: "Only they, a lead or an exec can change these." };
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const clean = [...new Set(aliases.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a.length >= 2 && a.length <= 120))].slice(0, 20);
  const { error } = await createAdminClient().from("profiles").update({ platform_aliases: clean }).eq("id", profileId);
  if (error) return { ok: false, error: /platform_aliases/.test(error.message) ? "Needs a database update first." : "Couldn't save that. Try again." };
  revalidatePath("/profile/[id]", "page");
  revalidatePath("/watch");
  return { ok: true };
}
