"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AsanaPatch, TaskDetail } from "@/lib/asana-live-core";

// An Asana task opened in Kaizen OS (?task=<gid>): read it whole, change any field, tick and add subtasks, read and add
// comments, all written straight back to Asana. Every write is checked here: the task is theirs, on a client they can
// see, or assigned to someone on their team (src/lib/asana-live.ts mayEditTask).

type R<T> = ({ ok: true } & T) | { ok: false; error: string; /** They haven't connected their own Asana: show Connect */ connect?: boolean };

/** A failed write: "connect your Asana first" when that's why, else the plain message */
async function failed(e: unknown, plain: string): Promise<{ ok: false; error: string; connect?: boolean }> {
  const { isAsanaConnectNeeded, ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
  if (isAsanaConnectNeeded(e)) return { ok: false, error: ASANA_CONNECT_SAY, connect: true };
  return { ok: false, error: plain };
}

async function guard(gid: string) {
  const me = await requireStaff();
  if (!/^\d{6,25}$/.test(gid)) return { error: "That isn't an Asana task." } as const;
  const { asanaConfigured } = await import("@/lib/asana");
  if (!asanaConfigured()) return { error: "Asana isn't connected." } as const;
  const { taskDetail, mayEditTask } = await import("@/lib/asana-live");
  const detail = await taskDetail(gid).catch(() => null);
  if (!detail) return { error: "Asana didn't return that task." } as const;
  const may = await mayEditTask(await createClient(), createAdminClient(), me, detail);
  return { me, detail, may } as const;
}

async function asanaTaskInner(gid: string): Promise<R<{ task: TaskDetail; canEdit: boolean }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't open it." };
  return { ok: true, task: g.detail, canEdit: g.may };
}

async function saveAsanaTaskInner(gid: string, patch: AsanaPatch): Promise<R<{ task: TaskDetail }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't change it." };
  if (!g.may) return { ok: false, error: "You can change tasks that are yours, on clients you work on, or your team's." };
  if (g.me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  const { updateTask, asanaUserByEmail, taskDetail } = await import("@/lib/asana-live");
  try {
    const p = { ...patch };
    // A reassignment by email goes to that person's Asana user
    if (p.assignee && p.assignee.includes("@")) p.assignee = await asanaUserByEmail(p.assignee);
    if (p.section && !p.sectionName) p.sectionName = g.detail.sections.find((s) => s.gid === p.section)?.name;
    await updateTask(createAdminClient(), g.me, gid, p, g.detail);
  } catch (e) {
    return failed(e, e instanceof Error ? e.message.replace(/^Asana: /, "Asana said: ") : "Asana didn't take it. Try again.");
  }
  // No page-wide redraw: the card refreshes in place (src/lib/complete-card.ts refreshInPlace)
  return { ok: true, task: await taskDetail(gid) };
}

async function commentAsanaTaskInner(gid: string, text: string): Promise<R<{ task: TaskDetail }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't comment." };
  if (!g.may) return { ok: false, error: "You can comment on tasks that are yours, on clients you work on, or your team's." };
  if (!text.trim()) return { ok: false, error: "Write the comment first." };
  const { addComment, taskDetail } = await import("@/lib/asana-live");
  try {
    await addComment(g.me, gid, text);
  } catch (e) {
    return failed(e, "Asana didn't take the comment. Try again.");
  }
  return { ok: true, task: await taskDetail(gid) };
}

async function subtaskAsanaTaskInner(gid: string, op: { add?: string; tick?: { gid: string; done: boolean } }): Promise<R<{ task: TaskDetail }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't change it." };
  if (!g.may) return { ok: false, error: "You can change tasks that are yours, on clients you work on, or your team's." };
  const { addSubtask, tickSubtask, taskDetail } = await import("@/lib/asana-live");
  try {
    if (op.add?.trim()) await addSubtask(g.me, gid, op.add);
    if (op.tick) {
      const sub = g.detail.subtasks.find((s) => s.gid === op.tick!.gid);
      if (!sub) return { ok: false, error: "That subtask isn't on this task." };
      await tickSubtask(g.me, gid, sub.gid, op.tick.done, sub.name);
    }
  } catch (e) {
    return failed(e, "Asana didn't take it. Try again.");
  }
  return { ok: true, task: await taskDetail(gid) };
}

// Each one runs as the person in Asana (src/lib/asana-user.ts asanaAsPerson): they see their private tasks and every
// change goes in as them. Without their own Asana connected, reading still works but a change asks them to connect
async function asMe<T>(fn: () => Promise<T>): Promise<T> {
  const me = await requireStaff();
  const { asanaAsPerson } = await import("@/lib/asana-user");
  return asanaAsPerson(createAdminClient(), me.id, fn);
}

export async function asanaTask(gid: string) {
  return asMe(() => asanaTaskInner(gid));
}
export async function saveAsanaTask(gid: string, patch: AsanaPatch) {
  return asMe(() => saveAsanaTaskInner(gid, patch));
}
export async function commentAsanaTask(gid: string, text: string) {
  return asMe(() => commentAsanaTaskInner(gid, text));
}
export async function subtaskAsanaTask(gid: string, op: { add?: string; tick?: { gid: string; done: boolean } }) {
  return asMe(() => subtaskAsanaTaskInner(gid, op));
}

/** Who a task can go to: everyone active on the team, by their work email (Asana finds them in Kaizen's workspace) */
export async function asanaAssignees(): Promise<{ name: string; email: string; role: string }[]> {
  await requireStaff();
  const { data } = await createAdminClient().from("profiles").select("full_name, email, role").eq("is_active", true).not("email", "is", null).order("full_name").limit(300);
  // Everyone active, execs and the owner included, by role then name; role is its label for the picker
  const [{ roleRank }, { roleLabel }] = await Promise.all([import("@/lib/delegate-core"), import("@/lib/roles")]);
  return ((data ?? []) as { full_name: string | null; email: string | null; role: string | null }[])
    .filter((p) => p.full_name && p.email)
    .sort((a, b) => roleRank(a.role ?? "") - roleRank(b.role ?? "") || String(a.full_name).localeCompare(String(b.full_name)))
    .map((p) => ({ name: p.full_name as string, email: p.email as string, role: p.role ? roleLabel(p.role as Parameters<typeof roleLabel>[0]) : "" }));
}
