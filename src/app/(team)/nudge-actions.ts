"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dismissNudge, sendNudge } from "@/lib/escalation-ladder";

// The escalation ladder's card on a lead's Overview: send the drafted nudge to the teammate (as the lead, from their own
// Slack), or set it aside. Only the lead it was made for can do either.

export async function sendLadderNudge(id: string, text: string) {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false as const, error: "Not while viewing as someone." };
  const r = await sendNudge(createAdminClient(), me.id, id, text);
  if (r.ok) revalidatePath("/pipeline");
  return r;
}

export async function dismissLadderNudge(id: string) {
  const me = await requireStaff();
  await dismissNudge(createAdminClient(), me.id, id);
  revalidatePath("/pipeline");
}
