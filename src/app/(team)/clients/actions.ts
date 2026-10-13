"use server";

import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { SLOTS, type SlotRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Execs and leaders: set (or clear) who fills a slot on a client. RLS enforces the same rule. */
export async function setAssignment(clientId: string, slot: SlotRole, profileId: string | null): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only executives and leaders can assign people." };
  if (!SLOTS.some((s) => s.value === slot)) return { ok: false, error: "Unknown slot." };

  const supabase = await createClient();
  const { error: delError } = await supabase.from("client_assignments").delete().eq("client_id", clientId).eq("role", slot);
  if (delError) return { ok: false, error: delError.message };
  if (profileId) {
    const { error } = await supabase.from("client_assignments").insert({ client_id: clientId, role: slot, profile_id: profileId });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/clients", "layout");
  revalidatePath("/team");
  return { ok: true };
}
