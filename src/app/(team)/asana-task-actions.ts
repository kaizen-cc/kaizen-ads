"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AsanaPatch, TaskDetail } from "@/lib/asana-live-core";

// An Asana task opened in Kaizen OS (?task=<gid>): read it whole, change any field, tick and add subtasks, read and add
// comments, all written straight back to Asana. Every write is checked here: the task is theirs, on a client they can
// see, or assigned to someone on their team (src/lib/asana-live.ts mayEditTask).

type R<T> = ({ ok: true } & T) | { ok: false; error: string };

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

export async function asanaTask(gid: string): Promise<R<{ task: TaskDetail; canEdit: boolean }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't open it." };
  return { ok: true, task: g.detail, canEdit: g.may };
}

export async function saveAsanaTask(gid: string, patch: AsanaPatch): Promise<R<{ task: TaskDetail }>> {
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
    return { ok: false, error: e instanceof Error ? e.message.replace(/^Asana: /, "Asana said: ") : "Asana didn't take it. Try again." };
  }
  revalidatePath("/pipeline");
  return { ok: true, task: await taskDetail(gid) };
}

export async function commentAsanaTask(gid: string, text: string): Promise<R<{ task: TaskDetail }>> {
  const g = await guard(gid);
  if ("error" in g) return { ok: false, error: g.error ?? "Couldn't comment." };
  if (!g.may) return { ok: false, error: "You can comment on tasks that are yours, on clients you work on, or your team's." };
  if (!text.trim()) return { ok: false, error: "Write the comment first." };
  const { addComment, taskDetail } = await import("@/lib/asana-live");
  try {
    await addComment(g.me, gid, text);
  } catch {
    return { ok: false, error: "Asana didn't take the comment. Try again." };
  }
  return { ok: true, task: await taskDetail(gid) };
}

export async function subtaskAsanaTask(gid: string, op: { add?: string; tick?: { gid: string; done: boolean } }): Promise<R<{ task: TaskDetail }>> {
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
  } catch {
    return { ok: false, error: "Asana didn't take it. Try again." };
  }
  return { ok: true, task: await taskDetail(gid) };
}
