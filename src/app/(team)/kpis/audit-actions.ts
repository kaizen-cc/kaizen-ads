"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Audits start through /api/audits (three at a time per person, the rest queued): see lib/audit-queue.ts

/** Ticks an action item off (or back on). */
export async function tickAuditAction(auditId: string, index: number, done: boolean): Promise<{ ok: true } | { error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase.from("account_audits").select("done").eq("id", auditId).maybeSingle();
  if (!a) return { error: "Audit not found" };
  const next = { ...((a.done ?? {}) as Record<string, unknown>) };
  if (done) next[String(index)] = { by: me.fullName, at: new Date().toISOString() };
  else delete next[String(index)];
  const { error } = await supabase.from("account_audits").update({ done: next }).eq("id", auditId);
  if (error) return { error: error.message };
  revalidatePath(`/kpis/audit/${auditId}`);
  return { ok: true };
}
