"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { cleanFocus, type FocusLine } from "@/lib/exec-focus/core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings → Team: each exec's focus (the lines whose notifications reach them). Any exec can set their own or another
// exec's; the list is replaced as given.

export async function setExecFocus(profileId: string, lines: string[]): Promise<{ ok: true; lines: FocusLine[] } | { ok: false; error: string }> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  if (typeof profileId !== "string" || !profileId) return { ok: false, error: "Who is this for?" };
  const admin = createAdminClient();
  const { data: who } = await admin.from("profiles").select("id, is_exec").eq("id", profileId).maybeSingle();
  if (!who?.is_exec) return { ok: false, error: "Only an exec has a focus." };
  const clean = cleanFocus(Array.isArray(lines) ? lines : []);
  const { error } = await admin.from("profiles").update({ exec_focus: clean }).eq("id", profileId);
  if (error) return { ok: false, error: /exec_focus/.test(error.message) ? "Focus isn't set up yet. Try again after the next update." : error.message };
  revalidatePath("/settings");
  revalidatePath("/pipeline");
  return { ok: true, lines: clean };
}
