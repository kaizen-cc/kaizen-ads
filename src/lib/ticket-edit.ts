import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { asanaDue } from "@/lib/ticket-edit-core";

/**
 * A ticket's new assignee or due date, written back to its Asana task (the Asana bridge): the open task(s) the ticket
 * came from or was sent as. Asana never blocks the change in Kaizen OS; a failure is logged and the next sync shows it.
 */
export async function asanaFollow(admin: SupabaseClient, me: Staff, requestId: string, change: { assignee?: string | null; due?: string | null }): Promise<number> {
  const { data: tasks } = await admin.from("asana_tasks").select("gid").eq("request_id", requestId).eq("open", true);
  if (!tasks?.length) return 0;
  const patch: import("@/lib/asana-live-core").AsanaPatch = {};
  if (change.assignee !== undefined) {
    if (change.assignee) {
      const { data: p } = await admin.from("profiles").select("email, full_name").eq("id", change.assignee).maybeSingle();
      if (!p?.email) return 0;
      patch.assignee = String(p.email);
      patch.assigneeName = String(p.full_name ?? "");
    } else patch.assignee = null;
  }
  if (change.due !== undefined) patch.dueAt = asanaDue(change.due).dueAt;
  const { updateTask } = await import("@/lib/asana-live");
  let n = 0;
  for (const t of tasks) {
    try {
      // An email assignee goes to that person's Asana user
      const p = { ...patch };
      if (p.assignee && p.assignee.includes("@")) {
        const { asanaUserByEmail } = await import("@/lib/asana-live");
        const gid = await asanaUserByEmail(p.assignee);
        if (!gid) delete p.assignee;
        else p.assignee = gid;
      }
      if (!Object.keys(p).filter((k) => k !== "assigneeName").length) continue;
      await updateTask(admin, me, String(t.gid), p);
      if (p.assignee !== undefined) await admin.from("asana_tasks").update({ assignee_email: change.assignee ? patch.assignee : null, assignee_name: change.assignee ? (patch.assigneeName ?? null) : null }).eq("gid", t.gid);
      n++;
    } catch (e) {
      console.error("asanaFollow", requestId, t.gid, e);
    }
  }
  return n;
}
