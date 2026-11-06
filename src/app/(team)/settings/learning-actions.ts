"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff, type Staff } from "@/lib/auth";
import { canTrainAgent } from "@/lib/agent-access";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EvalRow, Proposal } from "@/lib/agent-evals";
import type { LearningScope } from "@/lib/learning-rank";

// Settings › AI agents: testing a change before it's saved, and an exec's (or the line head's) hand on what each
// agent has learned.

type Result = { ok: true } | { ok: false; error: string };

// Executives, and each service line's head for their own line's agent and skills (canTrainAgent)
const NOT_YOURS = { ok: false as const, error: "Only an executive or the head of this agent's line can change it." };

/** The signed-in person when they can train this agent (a role or skill key), or null */
async function trainer(target: string | null | undefined): Promise<Staff | null> {
  const me = await requireStaff();
  return canTrainAgent(me, target) ? me : null;
}

/** The same, for one learning (by its skill) */
async function learningTrainer(id: string): Promise<Staff | null> {
  const { data } = await createAdminClient().from("agent_learnings").select("agent_key").eq("id", id).maybeSingle();
  return data ? trainer(data.agent_key as string) : null;
}

/** Replay up to 8 recent real calls with the proposed change next to what the agent does now (in the background) */
export async function testAgentChange(v: { agentKey?: string | null; roleKey?: string | null; target: string; proposal: Proposal }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!v.agentKey && !v.roleKey) return { ok: false, error: "Nothing to test." };
  const me = await trainer(v.agentKey ?? v.roleKey);
  if (!me) return NOT_YOURS;
  // A head tests their own instructions, items and core, not a model or effort change
  if (!me.isExec && (v.proposal.model || v.proposal.effort)) return { ok: false, error: "Only an executive changes the model or effort." };
  const admin = createAdminClient();
  const { startEval, runEval } = await import("@/lib/agent-evals");
  const id = await startEval(admin, { agentKey: v.agentKey ?? null, roleKey: v.roleKey ?? null, target: v.target, proposal: v.proposal, by: me.id });
  after(() => runEval(admin, id));
  return { ok: true, id };
}

/** One test, for the page to poll */
export async function agentTest(id: string): Promise<EvalRow | null> {
  const { data } = await createAdminClient().from("agent_evals").select("*, profiles:created_by(full_name)").eq("id", id).maybeSingle();
  if (!data || !(await trainer((data.agent_key as string | null) ?? (data.role_key as string | null)))) return null;
  const { toEval } = await import("@/lib/agent-evals");
  return toEval(data as Record<string, unknown>);
}

/** Tidy one agent's learnings now instead of waiting for the night */
export async function consolidateNow(agentKey: string): Promise<Result> {
  if (!(await trainer(agentKey))) return NOT_YOURS;
  const admin = createAdminClient();
  after(async () => {
    const { consolidateLearnings } = await import("@/lib/learnings");
    await consolidateLearnings(admin, { agents: [agentKey], classify: 20 });
    revalidatePath("/settings");
  });
  return { ok: true };
}

const touch = (me: { id: string }) => ({ updated_at: new Date().toISOString(), updated_by: me.id });

/** Reword a learning or its condition */
export async function editLearning(id: string, v: { lesson: string; condition: string }): Promise<Result> {
  const me = await learningTrainer(id);
  if (!me) return NOT_YOURS;
  if (v.lesson.trim().length < 6) return { ok: false, error: "Say what it should learn." };
  const { error } = await createAdminClient().from("agent_learnings").update({ lesson: v.lesson.trim().slice(0, 600), condition: v.condition.trim().slice(0, 300) || null, ...touch(me) }).eq("id", id);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Retire one (it stops being read; kept for the record) */
export async function retireLearning(id: string): Promise<Result> {
  const me = await learningTrainer(id);
  if (!me) return NOT_YOURS;
  const { error } = await createAdminClient().from("agent_learnings").update({ status: "retired", note: me.isExec ? "Retired by an exec" : "Retired by the head of its line", ...touch(me) }).eq("id", id);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Bring a retired one back */
export async function restoreLearning(id: string): Promise<Result> {
  const me = await learningTrainer(id);
  if (!me) return NOT_YOURS;
  const { error } = await createAdminClient().from("agent_learnings").update({ status: "active", note: null, last_seen: new Date().toISOString(), ...touch(me) }).eq("id", id);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Narrow or promote one: to its client (the first client behind it), their sub-vertical, their kind of business, or
 * every client. An exec can promote past the three-clients rule; a one-off exception stays with its client.
 */
export async function setLearningScope(id: string, scope: LearningScope): Promise<Result> {
  const me = await learningTrainer(id);
  if (!me) return NOT_YOURS;
  const admin = createAdminClient();
  const { data: l } = await admin.from("agent_learnings").select("kind, client_id, evidence_clients").eq("id", id).maybeSingle();
  if (!l) return { ok: false, error: "That learning isn't there any more." };
  if (l.kind === "exception" && scope !== "client") return { ok: false, error: "A one-off stays with its client. Reword it as a lesson first." };
  const anchor = (l.client_id as string | null) ?? ((l.evidence_clients ?? []) as string[])[0] ?? null;
  if (!anchor && scope !== "everyone") return { ok: false, error: "It has no client to anchor it to." };
  const { businessModelOf } = await import("@/lib/business-model");
  const [{ data: c }, m] = anchor ? await Promise.all([admin.from("clients").select("vertical_id").eq("id", anchor).maybeSingle(), businessModelOf(admin, anchor).catch(() => null)]) : [{ data: null }, null];
  const patch =
    scope === "client"
      ? { scope, client_id: anchor }
      : scope === "vertical"
        ? c?.vertical_id
          ? { scope, client_id: null, vertical_id: c.vertical_id }
          : null
        : scope === "model"
          ? m?.model
            ? { scope, client_id: null, model: m.model }
            : null
          : { scope, client_id: null };
  if (!patch) return { ok: false, error: scope === "vertical" ? "Its client has no sub-vertical yet." : "Its client's kind of business isn't known yet." };
  const { error } = await admin.from("agent_learnings").update({ ...patch, ...touch(me) }).eq("id", id);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Two contradict and nobody won: keep this one, retire the other */
export async function keepLearning(id: string): Promise<Result> {
  const me = await learningTrainer(id);
  if (!me) return NOT_YOURS;
  const admin = createAdminClient();
  const { data: l } = await admin.from("agent_learnings").select("conflict_with").eq("id", id).maybeSingle();
  await admin.from("agent_learnings").update({ status: "active", conflict_with: null, note: me.isExec ? "Kept by an exec over a contradicting lesson" : "Kept by the head of its line over a contradicting lesson", ...touch(me) }).eq("id", id);
  if (l?.conflict_with) await admin.from("agent_learnings").update({ status: "retired", note: me.isExec ? "An exec kept the contradicting lesson instead" : "The head of its line kept the contradicting lesson instead", ...touch(me) }).eq("id", l.conflict_with);
  revalidatePath("/settings");
  return { ok: true };
}
