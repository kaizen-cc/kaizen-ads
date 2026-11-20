import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { asana, asanaConfigured, asanaUpdate, asanaWrite } from "@/lib/asana";
import { changeNote, sortTasks, type AsanaPatch, type FieldValue, type LiveTask, type TaskDetail } from "@/lib/asana-live-core";

// Kaizen OS as an extension of Asana (the owner, Nov 20 2026): the team still works in Asana, so every role sees its
// next Asana tasks on the Overview and can open, change and comment on any of them here, written straight back to
// Asana. The token is shared, so each change also leaves an Asana comment naming who made it from the OS; per-person
// Asana sign-in would attribute it properly. Pure parts in ./asana-live-core.ts.

const TASK_FIELDS = "name,notes,due_on,start_on,completed,permalink_url,assignee.name,assignee.email,memberships.project.name,memberships.project.gid,memberships.section.name,memberships.section.gid,custom_fields.gid,custom_fields.name,custom_fields.resource_subtype,custom_fields.type,custom_fields.enum_options.gid,custom_fields.enum_options.name,custom_fields.enum_options.enabled,custom_fields.enum_value.gid,custom_fields.enum_value.name,custom_fields.text_value,custom_fields.number_value,custom_fields.date_value.date,custom_fields.display_value,custom_fields.is_formula_field";

let workspace: string | null = null;
async function ws() {
  if (workspace) return workspace;
  workspace = (await asana<{ gid: string }[]>("/workspaces")).data[0]?.gid ?? null;
  return workspace;
}

type RawTask = {
  gid: string;
  name: string;
  notes?: string;
  due_on: string | null;
  start_on?: string | null;
  completed?: boolean;
  permalink_url?: string;
  assignee?: { name?: string; email?: string } | null;
  memberships?: { project?: { gid?: string; name?: string }; section?: { gid?: string; name?: string } }[];
  custom_fields?: { gid: string; name: string; resource_subtype?: string; type?: string; enum_options?: { gid: string; name: string; enabled?: boolean }[]; enum_value?: { gid: string; name: string } | null; text_value?: string | null; number_value?: number | null; date_value?: { date?: string } | null; display_value?: string | null; is_formula_field?: boolean }[];
};

/** Someone's open Asana tasks (assigned to them), overdue first then by due date */
export async function myAsanaTasks(email: string | null, db?: SupabaseClient): Promise<LiveTask[]> {
  if (!asanaConfigured() || !email) return [];
  const w = await ws().catch(() => null);
  if (!w) return [];
  const res = await asana<RawTask[]>("/tasks", { assignee: email, workspace: w, completed_since: "now", limit: "100", opt_fields: "name,due_on,completed,permalink_url,memberships.project.name,memberships.section.name" }).catch(() => null);
  if (!res) return [];
  const clients = db ? (((await db.from("clients").select("id, name, slug").is("archived_at", null).limit(1000)).data ?? []) as { id: string; name: string; slug: string }[]).filter((c) => c.name.length >= 4).sort((a, b) => b.name.length - a.name.length) : [];
  return sortTasks(
    res.data
      .filter((t) => t.name?.trim() && !t.completed)
      .map((t) => {
        const project = t.memberships?.find((m) => m.project?.name)?.project?.name ?? null;
        const section = t.memberships?.find((m) => m.section?.name)?.section?.name ?? null;
        const hay = `${project ?? ""} ${t.name}`.toLowerCase();
        const c = clients.find((x) => hay.includes(x.name.toLowerCase())) ?? null;
        return { gid: t.gid, name: t.name, due: t.due_on, project, section, client: c?.name ?? null, clientSlug: c?.slug ?? null, url: t.permalink_url ?? `https://app.asana.com/0/0/${t.gid}` };
      }),
  );
}

/** One task in full: fields, its project's sections, subtasks, comments and attachments */
export async function taskDetail(gid: string): Promise<TaskDetail> {
  const [t, subs, stories, files] = await Promise.all([
    asana<RawTask>(`/tasks/${gid}`, { opt_fields: TASK_FIELDS }),
    asana<{ gid: string; name: string; completed: boolean }[]>(`/tasks/${gid}/subtasks`, { opt_fields: "name,completed", limit: "100" }).catch(() => ({ data: [] })),
    asana<{ gid: string; type: string; text?: string; created_at: string; created_by?: { name?: string } | null }[]>(`/tasks/${gid}/stories`, { opt_fields: "type,text,created_at,created_by.name", limit: "100" }).catch(() => ({ data: [] })),
    asana<{ gid: string; name: string; permanent_url?: string; view_url?: string; download_url?: string }[]>(`/tasks/${gid}/attachments`, { opt_fields: "name,permanent_url,view_url", limit: "50" }).catch(() => ({ data: [] })),
  ]);
  const task = t.data;
  const project = task.memberships?.find((m) => m.project?.gid);
  const sections = project?.project?.gid ? ((await asana<{ gid: string; name: string }[]>(`/projects/${project.project.gid}/sections`, { opt_fields: "name" }).catch(() => ({ data: [] }))).data ?? []) : [];
  return {
    gid,
    name: task.name,
    notes: task.notes ?? "",
    due: task.due_on,
    start: task.start_on ?? null,
    completed: Boolean(task.completed),
    url: task.permalink_url ?? `https://app.asana.com/0/0/${gid}`,
    assignee: task.assignee ? { name: task.assignee.name ?? null, email: task.assignee.email ?? null } : null,
    project: project?.project?.name ?? null,
    section: project?.section ? { gid: project.section.gid ?? "", name: project.section.name ?? "" } : null,
    sections: sections.map((s) => ({ gid: s.gid, name: s.name })),
    fields: (task.custom_fields ?? [])
      .filter((f) => !f.is_formula_field)
      .map((f) => {
        const kind = (f.resource_subtype ?? f.type ?? "text") as FieldValue["kind"];
        return { gid: f.gid, name: f.name, kind: ["enum", "text", "number", "date"].includes(kind) ? kind : "other", options: (f.enum_options ?? []).filter((o) => o.enabled !== false).map((o) => ({ gid: o.gid, name: o.name })), value: kind === "enum" ? (f.enum_value?.gid ?? null) : kind === "number" ? (f.number_value ?? null) : kind === "date" ? (f.date_value?.date ?? null) : (f.text_value ?? f.display_value ?? null), display: f.display_value ?? null } as FieldValue;
      }),
    subtasks: (subs.data ?? []).map((s) => ({ gid: s.gid, name: s.name, completed: Boolean(s.completed) })),
    comments: (stories.data ?? []).filter((s) => s.type === "comment" && s.text).map((s) => ({ gid: s.gid, text: s.text ?? "", at: s.created_at, by: s.created_by?.name ?? null })),
    attachments: (files.data ?? []).map((a) => ({ gid: a.gid, name: a.name, url: a.permanent_url ?? a.view_url ?? null })),
  };
}

/**
 * Whether this person may change a task: it's theirs, it's on a client they can see, they're an exec, or the person it's
 * assigned to answers to them (a lead or head of that teammate's line).
 */
export async function mayEditTask(db: SupabaseClient, admin: SupabaseClient, me: Staff, d: Pick<TaskDetail, "gid" | "assignee" | "project" | "name">): Promise<boolean> {
  if (me.isExec) return true;
  const mail = d.assignee?.email?.toLowerCase() ?? null;
  if (mail && me.email && mail === me.email.toLowerCase()) return true;
  // On a client they can see (their own session decides): the task as the OS has it, else the client's name in it
  const { data: cached } = await admin.from("asana_tasks").select("client_id").eq("gid", d.gid).maybeSingle();
  if (cached?.client_id) {
    const { data } = await db.from("clients").select("id").eq("id", cached.client_id).maybeSingle();
    if (data) return true;
  } else {
    const { data: clients } = await db.from("clients").select("name").is("archived_at", null).limit(1000);
    const hay = `${d.project ?? ""} ${d.name}`.toLowerCase();
    if ((clients ?? []).some((c) => String(c.name).length >= 4 && hay.includes(String(c.name).toLowerCase()))) return true;
  }
  // A lead or head of the assignee's line
  if (mail && (me.isLead || me.role === "lead_graphic_designer" || me.role === "lead_video_editor")) {
    const { data: p } = await admin.from("profiles").select("role").ilike("email", mail).maybeSingle();
    const { ladderFor } = await import("@/lib/escalation-ladder-core");
    if (p && ladderFor(String(p.role)).includes(me.role)) return true;
  }
  return false;
}

/** Writes a change to Asana, notes who made it as an Asana comment, and updates the OS's cache of the task */
export async function updateTask(admin: SupabaseClient, me: Staff, gid: string, patch: AsanaPatch, before?: TaskDetail | null): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name.slice(0, 1000);
  if (patch.notes !== undefined) body.notes = patch.notes.slice(0, 60000);
  if (patch.due !== undefined) body.due_on = patch.due;
  if (patch.start !== undefined) body.start_on = patch.start;
  if (patch.completed !== undefined) body.completed = patch.completed;
  if (patch.assignee !== undefined) body.assignee = patch.assignee;
  if (patch.fields && Object.keys(patch.fields).length) body.custom_fields = patch.fields;
  if (Object.keys(body).length) await asanaUpdate(`/tasks/${gid}`, body);
  if (patch.section) await asanaWrite(`/sections/${patch.section}/addTask`, { task: gid });
  const note = changeNote(patch, before ?? null, me.fullName);
  if (note) await asanaWrite(`/tasks/${gid}/stories`, { text: note }).catch(() => null);
  // The OS's copy, at once (the next sync confirms it)
  const cache: Record<string, unknown> = {};
  if (patch.name !== undefined) cache.name = patch.name;
  if (patch.notes !== undefined) cache.notes = patch.notes;
  if (patch.due !== undefined) cache.due_on = patch.due;
  if (patch.start !== undefined) cache.start_on = patch.start;
  if (patch.completed !== undefined) {
    cache.open = !patch.completed;
    cache.completed_at = patch.completed ? new Date().toISOString() : null;
  }
  if (patch.sectionName) cache.section = patch.sectionName;
  if (Object.keys(cache).length) await admin.from("asana_tasks").update(cache).eq("gid", gid);
}

export async function addComment(me: Staff, gid: string, text: string) {
  await asanaWrite(`/tasks/${gid}/stories`, { text: `${text.trim().slice(0, 5000)}\n\n(${me.fullName} via Kaizen OS)` });
}

export async function addSubtask(me: Staff, gid: string, name: string) {
  const sub = await asanaWrite<{ gid: string }>(`/tasks/${gid}/subtasks`, { name: name.trim().slice(0, 500) });
  await asanaWrite(`/tasks/${gid}/stories`, { text: `Subtask "${name.trim().slice(0, 200)}" added by ${me.fullName} via Kaizen OS` }).catch(() => null);
  return sub.gid;
}

export async function tickSubtask(me: Staff, parent: string, gid: string, done: boolean, name: string) {
  await asanaUpdate(`/tasks/${gid}`, { completed: done });
  await asanaWrite(`/tasks/${parent}/stories`, { text: `Subtask "${name.slice(0, 200)}" ${done ? "ticked" : "unticked"} by ${me.fullName} via Kaizen OS` }).catch(() => null);
}

/** A teammate's Asana user, by their work email, for a reassignment */
export async function asanaUserByEmail(email: string): Promise<string | null> {
  const w = await ws().catch(() => null);
  if (!w) return null;
  const res = await asana<{ gid: string; email?: string }[]>(`/workspaces/${w}/users`, { opt_fields: "email", limit: "100" }).catch(() => null);
  return res?.data.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.gid ?? email;
}
