"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The final execution plan, its tasks and the kickoff message, from the client page. Anyone on the client writes the
// team's notes; the client's buyers, leads and execs sign the plan off and send the kickoff; a task's owner (or a
// buyer or lead) moves it along.

export type ActionResult = { ok: true } | { ok: false; error: string };

async function access(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const db = await createClient();
  const { data: mine } = await db.from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!mine) return { error: "You don't work on this client." } as const;
  const admin = createAdminClient();
  const { data: seat } = await admin.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", me.id).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]).limit(1).maybeSingle();
  return { me, admin, slug: mine.slug as string, buyer: Boolean(seat), lead: isExecOrLead(me) } as const;
}
const decides = (a: { buyer: boolean; lead: boolean }) => a.buyer || a.lead;
const done = (slug: string) => revalidatePath(`/clients/${slug}`);

/** The team's keep / change notes from reviewing the strategies; with `fold`, the plan is rewritten with them now */
export async function saveTeamNotes(clientId: string, notes: string, fold: boolean): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const now = new Date().toISOString();
  await a.admin.from("client_execution_plans").upsert({ client_id: clientId, notes: notes.trim().slice(0, 12000), notes_at: now, updated_at: now }, { onConflict: "client_id" });
  if (fold) {
    if (!aiEnabled()) return { ok: false, error: "The AI isn't connected here." };
    const admin = a.admin;
    await admin.from("client_execution_plans").update({ status: "building", started_at: now, error: null }).eq("client_id", clientId).neq("status", "final");
    after(() => import("@/lib/execution-plan").then(({ buildExecutionPlan }) => buildExecutionPlan(admin, clientId)).then(() => undefined));
  }
  done(a.slug);
  return { ok: true };
}

/** Write (or rewrite) the plan now */
export async function buildPlanNow(clientId: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!aiEnabled()) return { ok: false, error: "The AI isn't connected here." };
  const { planGate } = await import("@/lib/execution-plan");
  const gate = await planGate(a.admin, clientId);
  if (gate.missing.length) return { ok: false, error: `It needs ${gate.missing.join(", ")} first.` };
  const admin = a.admin;
  await admin.from("client_execution_plans").upsert({ client_id: clientId, status: "building", started_at: new Date().toISOString(), error: null }, { onConflict: "client_id" });
  after(() => import("@/lib/execution-plan").then(({ buildExecutionPlan }) => buildExecutionPlan(admin, clientId)).then(() => undefined));
  done(a.slug);
  return { ok: true };
}

/** A buyer or lead: the plan is final, and its tasks start */
export async function signOffPlanNow(clientId: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!decides(a)) return { ok: false, error: "The client's buyer or a lead signs the plan off." };
  const { signOffPlan } = await import("@/lib/execution-plan");
  const r = await signOffPlan(a.admin, clientId, a.me.id);
  done(a.slug);
  return r.ok ? { ok: true } : r;
}

/** A lead: open the signed-off plan again to change it (its tasks stay; signing off again updates them) */
export async function reopenPlan(clientId: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!a.lead) return { ok: false, error: "Only a lead can reopen a signed-off plan." };
  await a.admin.from("client_execution_plans").update({ status: "draft", updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("status", "final");
  done(a.slug);
  return { ok: true };
}

async function canMove(me: Staff, a: { buyer: boolean; lead: boolean }, ownerId: string | null) {
  return ownerId === me.id || a.buyer || a.lead;
}

/** Move a task along: started, done, or back to open */
export async function setTaskStatus(clientId: string, taskId: string, status: "in_progress" | "done" | "ready"): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { data: t } = await a.admin.from("client_tasks").select("id, owner_id, status").eq("id", taskId).eq("client_id", clientId).maybeSingle();
  if (!t) return { ok: false, error: "Not found." };
  if (!(await canMove(a.me, a, (t.owner_id as string | null) ?? null))) return { ok: false, error: "It's someone else's: their owner, the buyer or a lead moves it." };
  if (t.status === "blocked" && status !== "ready") return { ok: false, error: "It's still waiting on something before it can start." };
  const now = new Date().toISOString();
  await a.admin
    .from("client_tasks")
    .update({ status, updated_at: now, ...(status === "done" ? { done_at: now, done_by: a.me.id, done_how: "manual" } : { done_at: null, done_by: null, done_how: null }) })
    .eq("id", taskId);
  const { refreshTasks } = await import("@/lib/execution-plan");
  await refreshTasks(a.admin, clientId);
  done(a.slug);
  return { ok: true };
}

/** Save edits to the kickoff draft */
export async function saveKickoffText(clientId: string, text: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!decides(a)) return { ok: false, error: "The client's buyer or a lead edits the kickoff." };
  await a.admin.from("client_kickoffs").update({ text: text.slice(0, 12000), updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("status", "draft");
  return { ok: true };
}

/** Send the kickoff to the client's channel (never on its own) */
export async function sendKickoffNow(clientId: string, text: string): Promise<ActionResult & { as?: "person" | "app" }> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!decides(a)) return { ok: false, error: "The client's buyer or a lead sends the kickoff." };
  const { sendKickoff } = await import("@/lib/kickoff");
  const r = await sendKickoff(a.admin, clientId, a.me.id, text);
  done(a.slug);
  return r.ok ? { ok: true, as: r.sentAs } : r;
}

/** Send a held Slack message (Meet your team, a team change) by hand, as yourself */
export async function sendHeldNow(clientId: string, messageId: string, text: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!decides(a)) return { ok: false, error: "The client's buyer or a lead sends it." };
  const { sendHeldMessage } = await import("@/lib/kickoff");
  const r = await sendHeldMessage(a.admin, clientId, messageId, a.me.id, text);
  done(a.slug);
  return r.ok ? { ok: true } : r;
}

/** A lead: write it without the intake form (it never came) */
export async function writeKickoffAnyway(clientId: string): Promise<ActionResult> {
  const a = await access(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  if (!a.lead) return { ok: false, error: "Only a lead can write it without the intake form." };
  if (!aiEnabled()) return { ok: false, error: "The AI isn't connected here." };
  const { draftKickoff } = await import("@/lib/kickoff");
  const r = await draftKickoff(a.admin, clientId, { by: a.me.id });
  done(a.slug);
  if (r.status === "waiting") return { ok: false, error: `Still waiting on ${(r.missing ?? []).filter((m) => m !== "the intake form").join(" and ")}.` };
  return r.status === "failed" ? { ok: false, error: "It couldn't be written. Try again in a minute." } : { ok: true };
}
