"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { notLive } from "@/lib/live-guard";
import { runAudit } from "@/lib/audit";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Starts an audit of one ad account; it runs on the server (leaving the page doesn't stop it) and the page follows it. */
export async function startAudit(targetId: string): Promise<{ id: string } | { error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: t } = await supabase.from("kpi_targets").select("client_id, ad_account_id, platform").eq("id", targetId).maybeSingle();
  if (!t) return { error: "You don't work on this client." };
  if (t.platform !== "meta" || !t.ad_account_id) return { error: "Audits read Meta ad accounts; this KPI has none." };
  const why = await notLive(supabase, t.client_id);
  if (why) return { error: why };
  if (!adminConfigured()) return { error: "Server key missing." };
  const admin = createAdminClient();
  // One at a time per account
  const { data: running } = await admin.from("account_audits").select("id, created_at").eq("target_id", targetId).eq("status", "running").gte("created_at", new Date(Date.now() - 15 * 60_000).toISOString()).maybeSingle();
  if (running) return { id: running.id };
  const { data, error } = await admin.from("account_audits").insert({ target_id: targetId, client_id: t.client_id, created_by: me.id, step: "Starting", progress: 2 }).select("id").single();
  if (error || !data) return { error: error?.message ?? "Couldn't start the audit" };
  after(() => runAudit(admin, data.id));
  revalidatePath("/kpis");
  return { id: data.id };
}

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
