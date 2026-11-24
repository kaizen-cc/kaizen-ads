"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { actOnTasks, undoActs, closeChange, headsUpFor, loadChange, logChange, openChanges, type ActHow, type ActResult, type ChangeLine, type ChangeView, type LoggedResult } from "@/lib/direction-changes";
import { CHANGE_LINES, type ChangeLineId } from "@/lib/direction-core";

// A client changing direction: the sheet (?direction=<id>, from any page), the flags on the boards and tickets, the
// client page's list and the request form's heads-up. Everything reads and writes with the person's own session (only
// clients they can see); moving Asana tasks and writing timelines use the server's key after that check.

/** One change, whole, for the sheet */
export async function loadDirectionChange(id: string): Promise<ChangeView | null> {
  await requireStaff();
  return loadChange(await createClient(), id);
}

export type Choice = { taskId: string; how: ActHow; to?: string | null };

/** Apply: every task with what was chosen for it (send back to a stage, keep, stop) */
export async function applyDirection(choices: Choice[], note?: string | null): Promise<ActResult> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const db = await createClient();
  const admin = createAdminClient();
  const out = { done: 0, failed: [] as { title: string; error: string }[], handled: false, acted: [] as string[] };
  for (const how of ["send_back", "keep", "stop"] as ActHow[]) {
    const mine = choices.filter((c) => c.how === how);
    if (!mine.length) continue;
    const to = Object.fromEntries(mine.filter((c) => c.to).map((c) => [c.taskId, c.to as string]));
    const r = await actOnTasks(db, admin, me, mine.map((c) => c.taskId), how, { to, note });
    if (!r.ok) return r;
    out.done += r.done;
    out.failed.push(...r.failed);
    out.handled = out.handled || r.handled;
    out.acted.push(...r.acted);
  }
  revalidatePath("/", "layout");
  return { ok: true, ...out };
}

/** Undo, right after Apply: the comments and files taken off, every task back where it was, flagged again */
export async function undoDirection(taskIds: string[]) {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false as const, error: "Not set up here." };
  const r = await undoActs(await createClient(), createAdminClient(), me, taskIds);
  revalidatePath("/", "layout");
  return r;
}

/** Whether the person's own Asana is connected (the Apply preview offers Connect when it isn't) */
export async function myAsanaReady(): Promise<boolean> {
  const me = await requireStaff();
  if (!adminConfigured()) return false;
  const { hasMyAsana } = await import("@/lib/asana-user");
  return hasMyAsana(createAdminClient(), me.id);
}

/** The AI misread it (dismissed), or there's nothing to do (handled) */
export async function closeDirection(changeId: string, status: "dismissed" | "handled"): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const r = await closeChange(await createClient(), me, changeId, status);
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

/** "Client changed direction": logged by a person, matched to the client's open tasks */
export async function logDirectionChange(clientId: string, said: string, line: ChangeLineId | null = null): Promise<LoggedResult> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const team = line && (CHANGE_LINES as readonly string[]).includes(line) ? line : null;
  const r = await logChange(await createClient(), createAdminClient(), me, clientId, said, "team", team);
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

/** The request form: a heads-up when the client has flagged tasks waiting */
export async function directionHeadsUp(clientId: string) {
  await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  return headsUpFor(await createClient(), clientId).catch(() => null);
}

/** The client page: their open changes */
export async function clientDirectionChanges(clientId: string): Promise<ChangeLine[]> {
  await requireStaff();
  return openChanges(await createClient(), { clientId }).catch(() => []);
}
