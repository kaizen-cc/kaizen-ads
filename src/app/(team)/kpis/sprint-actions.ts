"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (e: unknown, fallback: string) => ({ ok: false as const, error: e instanceof Error ? e.message : fallback });

/** Can this person see the audit (and so the account)? */
async function visibleAudit(auditId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("account_audits").select("id").eq("id", auditId).maybeSingle();
  return Boolean(data);
}

/** "Add to my action list": one of the audit's moves onto the account's sprint (opening it if there isn't one). */
export async function addToActionList(auditId: string, index: number): Promise<R<{ sprintId: string }>> {
  await requireStaff();
  if (!(await visibleAudit(auditId))) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { addAuditAction } = await import("@/lib/sprints");
    const sprintId = await addAuditAction(createAdminClient(), auditId, index);
    revalidatePath(`/kpis/audit/${auditId}`);
    return { ok: true, sprintId };
  } catch (e) {
    return fail(e, "Couldn't add it");
  }
}

/** For an audit from before sprints, or one whose sprint was closed: follow it now. */
export async function startSprint(auditId: string): Promise<R<{ sprintId: string }>> {
  await requireStaff();
  if (!(await visibleAudit(auditId))) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { openSprint } = await import("@/lib/sprints");
    const id = await openSprint(createAdminClient(), auditId);
    if (!id) return { ok: false, error: "The audit isn't finished" };
    revalidatePath("/kpis");
    return { ok: true, sprintId: id };
  } catch (e) {
    return fail(e, "Couldn't start the sprint");
  }
}

/** The buyer ticks a move off (or marks it doing or skipped), with an optional note the next check reads. */
export async function setActionStatus(actionId: string, status: "todo" | "doing" | "done" | "skipped", note?: string): Promise<R> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase
    .from("sprint_actions")
    .update({ status, ...(note !== undefined ? { note: note.trim().slice(0, 1000) || null } : {}), done_by: status === "done" ? me.id : null, done_at: status === "done" ? new Date().toISOString() : null })
    .eq("id", actionId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/kpis");
  return { ok: true };
}

/** Look at the account now instead of waiting for the next scheduled check. Runs on the server. */
export async function checkNow(sprintId: string): Promise<R> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase.from("optimization_sprints").select("id").eq("id", sprintId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  await admin.from("optimization_sprints").update({ next_check_at: new Date().toISOString() }).eq("id", sprintId);
  after(async () => {
    const { checkSprint } = await import("@/lib/sprints");
    await checkSprint(admin, sprintId).catch((e) => console.error("[sprint] check failed:", e instanceof Error ? e.message : e));
  });
  return { ok: true };
}

/** Close the sprint: done (it worked) or closed (stopped for another reason). */
export async function closeSprint(sprintId: string, status: "done" | "closed", note: string): Promise<R> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("optimization_sprints").update({ status, closed_at: new Date().toISOString(), close_note: note.trim().slice(0, 500) || null }).eq("id", sprintId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/kpis");
  return { ok: true };
}

/** Add an exec or lead as a watcher (it shows on their Next for me). */
export async function watchSprint(sprintId: string, on: boolean): Promise<R> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase.from("optimization_sprints").select("watcher_ids").eq("id", sprintId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  const ids = new Set((data.watcher_ids ?? []) as string[]);
  if (on) ids.add(me.id);
  else ids.delete(me.id);
  const { error } = await supabase.from("optimization_sprints").update({ watcher_ids: [...ids] }).eq("id", sprintId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/kpis");
  return { ok: true };
}

/** The client's version of the audit, for the PDF. Written once, then kept. */
export async function prepareClientReport(auditId: string): Promise<R> {
  await requireStaff();
  if (!(await visibleAudit(auditId))) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { writeClientReport } = await import("@/lib/sprints");
    await writeClientReport(createAdminClient(), auditId);
    return { ok: true };
  } catch (e) {
    return fail(e, "Couldn't write the client version");
  }
}
