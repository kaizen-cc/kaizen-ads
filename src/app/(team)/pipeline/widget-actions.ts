"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { cleanChoice } from "@/lib/widgets-core";

/** The person's own Overview widgets, in their order (only ones they may add: src/lib/widgets-core.ts) */
export async function saveWidgets(ids: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs || !adminConfigured()) return { ok: false, error: "Only you can change your own Overview." };
  const { error } = await createAdminClient().from("profiles").update({ overview_widgets: cleanChoice(ids, me) }).eq("id", me.id);
  if (error) return { ok: false, error: "Couldn't save that. Try again." };
  revalidatePath("/pipeline");
  return { ok: true };
}
