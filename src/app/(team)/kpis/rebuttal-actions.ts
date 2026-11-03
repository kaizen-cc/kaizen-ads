"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { canRebut, saveRebuttal } from "@/lib/audit-rebuttals";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Disagree with one finding of an account audit or a business audit, and say why */
export async function rebutFinding(input: { kind: "account" | "business"; auditId: string; itemKey: string; finding: string; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  if (!(await canRebut(admin, me.id))) return { ok: false, error: "Only the people given this permission can push back on audits." };
  if (!input.reason.trim()) return { ok: false, error: "Say why you disagree." };
  // Read with the viewer's own access, so only an audit they can see
  const db = await createClient();
  const { data: a } = await db.from(input.kind === "business" ? "business_audits" : "account_audits").select("id, client_id").eq("id", input.auditId).maybeSingle();
  if (!a) return { ok: false, error: "Audit not found." };
  try {
    await saveRebuttal(admin, { clientId: a.client_id as string, kind: input.kind, auditId: input.auditId, itemKey: input.itemKey, finding: input.finding, reason: input.reason, by: me.id });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
  revalidatePath(input.kind === "business" ? "/clients" : `/kpis/audit/${input.auditId}`);
  return { ok: true };
}
