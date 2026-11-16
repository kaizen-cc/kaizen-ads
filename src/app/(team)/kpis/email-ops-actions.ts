"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Email audits, sprints and campaign suggestions: what the email team does from the audit page, the sprint page and the
// client page. Each action first reads the row through the person's own session (RLS: they can only see their clients),
// then writes with the server's rights. Nothing here deletes anything, and nothing touches Klaviyo.

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (e: unknown, fallback: string) => ({ ok: false as const, error: e instanceof Error ? e.message : fallback });
const refresh = () => {
  revalidatePath("/kpis");
  revalidatePath("/clients/[slug]", "page");
};

/** Ticks an audit's action off (or back on), with who and when */
export async function tickEmailAuditAction(auditId: string, index: number, done: boolean): Promise<R> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase.from("email_audits").select("done").eq("id", auditId).maybeSingle();
  if (!a) return { ok: false, error: "Audit not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const next = { ...((a.done ?? {}) as Record<string, unknown>) };
  if (done) next[String(index)] = { by: me.fullName, at: new Date().toISOString() };
  else delete next[String(index)];
  const { error } = await createAdminClient().from("email_audits").update({ done: next }).eq("id", auditId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/kpis/email-audit/${auditId}`);
  return { ok: true };
}

/** "Add to my action list" (one move) or "Follow this audit" (every move): opens the client's sprint */
export async function startEmailSprint(auditId: string, only?: number): Promise<R<{ sprintId: string }>> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase.from("email_audits").select("id").eq("id", auditId).maybeSingle();
  if (!a) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { openEmailSprint } = await import("@/lib/email-ops/sprint");
    const id = await openEmailSprint(createAdminClient(), auditId, me.id, only);
    if (!id) return { ok: false, error: "The audit isn't finished." };
    revalidatePath(`/kpis/email-audit/${auditId}`);
    refresh();
    return { ok: true, sprintId: id };
  } catch (e) {
    return fail(e, "Couldn't open the sprint.");
  }
}

/** Marks a sprint move todo, doing, done or skipped, with a note the next check reads */
export async function setEmailActionStatus(actionId: string, status: "todo" | "doing" | "done" | "skipped", note?: string): Promise<R> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase.from("email_sprint_actions").select("id, sprint_id").eq("id", actionId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { error } = await createAdminClient()
    .from("email_sprint_actions")
    .update({ status, ...(note !== undefined ? { note: note.trim().slice(0, 1000) || null } : {}), done_by: status === "done" ? me.id : null, done_at: status === "done" ? new Date().toISOString() : null })
    .eq("id", actionId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/kpis/email-sprint/${data.sprint_id}`);
  refresh();
  return { ok: true };
}

/** Re-measure now instead of waiting for the next scheduled check (runs after the reply) */
export async function checkEmailSprintNow(sprintId: string): Promise<R> {
  await requireStaff();
  const { data } = await (await createClient()).from("email_sprints").select("id").eq("id", sprintId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  after(async () => {
    const { checkEmailSprint } = await import("@/lib/email-ops/sprint");
    await checkEmailSprint(admin, sprintId).catch((e) => console.error("[email sprint] check failed:", e instanceof Error ? e.message : e));
  });
  return { ok: true };
}

/** Close the sprint: done (it worked) or closed (stopped for another reason) */
export async function closeEmailSprint(sprintId: string, status: "done" | "closed", note: string): Promise<R> {
  await requireStaff();
  const { data } = await (await createClient()).from("email_sprints").select("id").eq("id", sprintId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { error } = await createAdminClient().from("email_sprints").update({ status, closed_at: new Date().toISOString(), close_note: note.trim().slice(0, 500) || null }).eq("id", sprintId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/kpis/email-sprint/${sprintId}`);
  refresh();
  return { ok: true };
}

// ─── Campaign suggestions ──────────────────────────────────────────────────

/** Writes new suggestions for the client now (the schedule does it weekly) */
export async function writeEmailSuggestions(clientId: string): Promise<R<{ added: number; note?: string }>> {
  await requireStaff();
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { generateSuggestions } = await import("@/lib/email-ops/suggestions");
    const r = await generateSuggestions(createAdminClient(), clientId);
    refresh();
    return { ok: true, ...r };
  } catch (e) {
    return fail(e, "Couldn't write suggestions.");
  }
}

const STATUSES = ["new", "in_motion", "done", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

/** Moves a suggestion along: new, in motion, done, or dismissed (with an optional reason). A dismissed one is kept. */
export async function setSuggestionStatus(id: string, status: Status, reason?: string): Promise<R> {
  const me = await requireStaff();
  if (!STATUSES.includes(status)) return { ok: false, error: "Unknown status." };
  const { data } = await (await createClient()).from("email_suggestions").select("id").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { error } = await createAdminClient()
    .from("email_suggestions")
    .update({ status, status_by: me.id, status_at: new Date().toISOString(), dismiss_reason: status === "dismissed" ? reason?.trim().slice(0, 300) || null : null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

/** Whether it worked once it ran: worked, did not work, or cleared (null), with a note */
export async function setSuggestionOutcome(id: string, outcome: "worked" | "not_worked" | null, note?: string): Promise<R> {
  await requireStaff();
  const { data } = await (await createClient()).from("email_suggestions").select("id").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { error } = await createAdminClient()
    .from("email_suggestions")
    .update({ outcome, outcome_note: outcome ? note?.trim().slice(0, 500) || null : null, outcome_at: outcome ? new Date().toISOString() : null, ...(outcome ? { status: "done" } : {}) })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}
