"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { nudgeLeadAsExec, takeEscalated } from "@/lib/exec-overview-actions";

// An exec's Escalated cards (src/lib/exec-overview.ts): nudge the lead about the stuck work (a notice in Kaizen OS,
// never a Slack message), or take the work over (it moves to their own "Needs me").

export async function nudgeLead(o: { nudgeIds: string[]; leadId: string; text: string; client?: string | null }) {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false as const, error: "Only an exec can do that." };
  if (me.viewAs) return { ok: false as const, error: "Not while viewing as someone." };
  if (!adminConfigured()) return { ok: false as const, error: "Not available right now." };
  const r = await nudgeLeadAsExec(createAdminClient(), { id: me.id, name: me.fullName }, o);
  if (r.ok) revalidatePath("/pipeline");
  return r;
}

export async function takeItOver(nudgeIds: string[]) {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false as const, error: "Only an exec can do that." };
  if (me.viewAs) return { ok: false as const, error: "Not while viewing as someone." };
  if (!adminConfigured()) return { ok: false as const, error: "Not available right now." };
  const r = await takeEscalated(createAdminClient(), me.id, nudgeIds);
  if (r.ok) revalidatePath("/pipeline");
  return r;
}
