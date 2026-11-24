import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asana, asanaAll, asanaWrite } from "@/lib/asana";
import { resolveAsanaProject, type ProjectSource } from "@/lib/asana-project";
import { emailStageForColumn, EMAIL_BOARD_ORDER, isDoneColumn, ownerFor, pickEmailProject, type EmailKind, type EmailStage } from "@/lib/email-board-core";
import { changedRows } from "@/lib/unchanged";
import { cleanTitle, normalizePriority, type PriorityLevel } from "@/lib/task-title";
import { mapAttachments, mapSubtasks, readList, type AsanaAttachment, type AsanaSubtask } from "@/lib/asana-context";

// Asana's email board, mirrored while the email team moves over to Kaizen (the creative board's mirror, for email).
// The project is ASANA_EMAIL_PROJECT_GID, else the app setting asana_email_project ({"gid": "..."}), else the
// workspace's project named like "Email" (see pickEmailProject), else the one the last sync found. Every sync reads the open
// tasks (and ones finished since last month began), keeps each in the Email Board stage its column maps to, and reads
// each changed task's history (column moves, reassignments, due dates) and comments. Open tasks show as outline cards
// on the Email Board; dragging one moves it in Asana; migrating one makes a Kaizen ticket that keeps its history and
// comments.

type Admin = SupabaseClient;

/** Where the email board lives (shared with the deliverable flow's email requests, src/lib/asana-project.ts) */
export const EMAIL_PROJECT_SOURCE: ProjectSource = { env: "ASANA_EMAIL_PROJECT_GID", setting: "asana_email_project", pick: pickEmailProject, syncSource: "asana_email" };

export async function emailProjectGid(admin: Admin): Promise<string | null> {
  return (await resolveAsanaProject(admin, EMAIL_PROJECT_SOURCE))?.gid ?? null;
}

type Task = {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  completed_at: string | null;
  assignee: { name: string; email?: string } | null;
  due_on: string | null;
  start_on?: string | null;
  created_by?: { name: string } | null;
  permalink_url: string;
  created_at: string;
  modified_at: string;
  memberships: { project: { gid: string }; section: { name: string } | null }[];
  custom_fields: { name: string; display_value: string | null }[];
};

export type EmailHistory =
  | { at: string; kind: "moved"; from: string | null; to: string | null; by: string | null }
  | { at: string; kind: "assigned"; to: string | null; by: string | null }
  | { at: string; kind: "due"; from: string | null; to: string | null; by: string | null };
export type EmailTaskComment = { at: string; by: string | null; text: string };

const monthStart = (offset = 0) => {
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1, 5)).toISOString();
};

/** Reads the Asana email board and updates the mirror */
export async function syncAsanaEmail(admin: Admin) {
  const project = await emailProjectGid(admin);
  if (!project) {
    await admin.from("sync_state").upsert({ source: "asana_email", last_run_at: new Date().toISOString(), last_result: { ok: false, error: 'No Asana project named like "Email". Set ASANA_EMAIL_PROJECT_GID.' } });
    return { skipped: "no email project" };
  }
  try {
    const tasks = await asanaAll<Task>(`/projects/${project}/tasks`, {
      completed_since: monthStart(-1),
      opt_fields: "name,notes,completed,completed_at,assignee.name,assignee.email,due_on,start_on,created_by.name,permalink_url,created_at,modified_at,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value",
    });
    const [{ data: clients }, { data: people }, { data: mirror }] = await Promise.all([
      admin.from("clients").select("id, name, kaizen_id").is("archived_at", null),
      admin.from("profiles").select("id, email, full_name").eq("is_active", true),
      admin.from("email_asana_tasks").select("gid, name, section, stage, client_id, kind, priority, assignee_name, assignee_email, profile_id, due_on, start_on, created_by_name, url, fields, moves, open, asana_created_at, asana_modified_at, completed_at"),
    ]);
    const byKaizen = new Map((clients ?? []).filter((c) => c.kaizen_id != null).map((c) => [String(c.kaizen_id), c.id as string]));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const before = new Map((mirror ?? []).map((m) => [m.gid as string, m]));
    const seen: string[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const task of tasks) {
      const section = task.memberships.find((m) => m.project?.gid === project)?.section?.name ?? null;
      const fields = Object.fromEntries(task.custom_fields.filter((f) => f.display_value).map((f) => [f.name, f.display_value!]));
      const idField = Object.entries(fields).find(([k]) => /client\s*id|^id$|client #/i.test(k))?.[1] ?? Object.values(fields).find((v) => /^\d{2,5}$/.test(String(v).trim()));
      let clientId = idField ? byKaizen.get(String(idField).trim()) : undefined;
      if (!clientId) {
        const title = norm(task.name);
        clientId = (clients ?? []).filter((c) => norm(c.name).length >= 4 && title.includes(norm(c.name))).sort((a, b) => b.name.length - a.name.length)[0]?.id;
      }
      const email = task.assignee?.email?.toLowerCase() ?? null;
      const profile = (people ?? []).find((p) => (email && p.email?.toLowerCase() === email) || (task.assignee?.name && p.full_name.toLowerCase().startsWith(task.assignee.name.toLowerCase())));
      const prev = before.get(task.gid);
      const moves = ((prev?.moves ?? []) as { from: string | null; to: string | null; at: string }[]).slice();
      if (prev && prev.section !== section) moves.push({ from: (prev.section as string | null) ?? null, to: section, at: new Date().toISOString() });
      rows.push({
        gid: task.gid,
        name: task.name,
        notes: task.notes?.slice(0, 20000) ?? null,
        section,
        stage: task.completed || isDoneColumn(section) ? null : emailStageForColumn(section),
        client_id: clientId ?? null,
        kind: /\bflow|automation|series|sequence\b/i.test(task.name) ? "flow" : "batch",
        priority: ((p) => (p === "normal" ? null : p))(normalizePriority(Object.entries(fields).find(([k]) => /priority/i.test(k))?.[1], task.name)),
        assignee_name: task.assignee?.name ?? null,
        assignee_email: email,
        profile_id: profile?.id ?? null,
        due_on: task.due_on,
        start_on: task.start_on ?? null,
        created_by_name: task.created_by?.name ?? null,
        url: task.permalink_url,
        fields,
        moves: moves.slice(-30),
        open: !task.completed,
        asana_created_at: task.created_at,
        asana_modified_at: task.modified_at,
        completed_at: task.completed ? (task.completed_at ?? task.modified_at) : null,
        synced_at: new Date().toISOString(),
      });
      seen.push(task.gid);
    }
    // Only the tasks that changed are written (notes ride on asana_modified_at)
    const changedTasks = changedRows(rows, new Map((mirror ?? []).map((m) => [m.gid as string, m as Record<string, unknown>])), (r) => r.gid as string, ["synced_at", "notes"]);
    for (let i = 0; i < changedTasks.length; i += 100) await admin.from("email_asana_tasks").upsert(changedTasks.slice(i, i + 100), { onConflict: "gid" });
    const seenSet = new Set(seen);
    const gone = (mirror ?? []).filter((m) => m.open && !seenSet.has(m.gid as string)).map((m) => m.gid as string);
    for (let i = 0; i < gone.length; i += 200) await admin.from("email_asana_tasks").update({ open: false, synced_at: new Date().toISOString() }).in("gid", gone.slice(i, i + 200));
    const histories = await readHistory(admin).catch(() => 0);
    await admin.from("sync_state").upsert({ source: "asana_email", cursor_at: new Date().toISOString(), last_run_at: new Date().toISOString(), last_result: { ok: true, project, tasks: seen.length, closed: gone.length, histories } });
    return { project, mirrored: seen.length, closed: gone.length, histories };
  } catch (e) {
    await admin.from("sync_state").upsert({ source: "asana_email", last_run_at: new Date().toISOString(), last_result: { ok: false, project, error: e instanceof Error ? e.message : String(e) } });
    throw e;
  }
}

/** Each changed task's history and comments from its Asana stories, a batch per sync */
async function readHistory(admin: Admin, max = 60) {
  const { data } = await admin.from("email_asana_tasks").select("gid, asana_modified_at, history_read_at, details_read_at").order("asana_modified_at", { ascending: false }).limit(1000);
  // Also the ones whose attachments and subtasks were never read (rows mirrored before they were kept)
  const todo = (data ?? []).filter((t) => !t.history_read_at || !t.details_read_at || (t.asana_modified_at && t.asana_modified_at > t.history_read_at)).slice(0, max);
  type Story = { created_at: string; resource_subtype: string; created_by: { name: string } | null; old_section?: { name: string } | null; new_section?: { name: string } | null; assignee?: { name: string } | null; text?: string; old_dates?: { due_on?: string | null } | null; new_dates?: { due_on?: string | null } | null };
  for (const t of todo) {
    try {
      const stories = await asanaAll<Story>(`/tasks/${t.gid}/stories`, { opt_fields: "created_at,resource_subtype,created_by.name,old_section.name,new_section.name,assignee.name,text,old_dates.due_on,new_dates.due_on" });
      const history: EmailHistory[] = stories.flatMap((s): EmailHistory[] => {
        const by = s.created_by?.name ?? null;
        if (s.resource_subtype === "section_changed") return [{ at: s.created_at, kind: "moved", from: s.old_section?.name ?? null, to: s.new_section?.name ?? null, by }];
        if (s.resource_subtype === "assigned") return [{ at: s.created_at, kind: "assigned", to: s.assignee?.name ?? null, by }];
        if (s.resource_subtype === "unassigned") return [{ at: s.created_at, kind: "assigned", to: null, by }];
        if (s.resource_subtype === "due_date_changed") return [{ at: s.created_at, kind: "due", from: s.old_dates?.due_on ?? null, to: s.new_dates?.due_on ?? null, by }];
        return [];
      });
      const comments: EmailTaskComment[] = stories.filter((s) => s.resource_subtype === "comment_added" && s.text?.trim()).map((s) => ({ at: s.created_at, by: s.created_by?.name ?? null, text: s.text!.trim().slice(0, 4000) }));
      // Attachments (name and Asana link: the download link expires in minutes) and subtasks; a hiccup on either leaves what was kept
      const [files, subs] = await Promise.all([
        asanaAll<Record<string, unknown>>(`/tasks/${t.gid}/attachments`, { opt_fields: "name,permanent_url,view_url,host,size,created_at,resource_subtype" }).then(mapAttachments).catch(() => null),
        asanaAll<Record<string, unknown>>(`/tasks/${t.gid}/subtasks`, { opt_fields: "name,completed,assignee.name,due_on,permalink_url" }).then(mapSubtasks).catch(() => null),
      ]);
      const now = new Date().toISOString();
      await admin
        .from("email_asana_tasks")
        .update({ history: history.slice(-200), comments: comments.slice(-100), history_read_at: now, ...(files ? { attachments: files } : {}), ...(subs ? { subtasks: subs } : {}), ...(files && subs ? { details_read_at: now } : {}) })
        .eq("gid", t.gid);
    } catch {
      // A task deleted in Asana, or a hiccup: tried again next run
    }
  }
  return todo.length;
}

export type EmailShadow = {
  gid: string;
  name: string;
  title: string;
  stage: EmailStage;
  section: string | null;
  clientId: string | null;
  clientName: string | null;
  clientSlug: string | null;
  kind: EmailKind;
  priority: PriorityLevel;
  assignee: string | null;
  profileId: string | null;
  dueOn: string | null;
  url: string | null;
  notes: string | null;
  comments: EmailTaskComment[];
  history: EmailHistory[];
  fields: Record<string, string>;
  startOn: string | null;
  createdBy: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  attachments: AsanaAttachment[];
  subtasks: AsanaSubtask[];
};

/** The open Asana email tasks not migrated yet, for the Email Board's outline cards (the reader's own rights) */
export async function loadEmailShadows(db: SupabaseClient): Promise<EmailShadow[]> {
  const base = "gid, name, stage, section, client_id, kind, priority, assignee_name, profile_id, due_on, url, notes, fields, comments, history, asana_created_at, asana_modified_at, clients(name, slug)";
  const query = (cols: string) => db.from("email_asana_tasks").select(cols).eq("open", true).is("ticket_id", null).not("stage", "is", null).order("asana_created_at", { ascending: false }).limit(400);
  let res = await query(`${base}, start_on, created_by_name, attachments, subtasks`);
  // Before the columns for the attachments and subtasks exist, the board still loads
  if (res.error) res = await query(base);
  const rows = (res.data ?? []) as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    return {
      gid: r.gid as string,
      name: r.name as string,
      title: cleanTitle(r.name as string).title,
      stage: r.stage as EmailStage,
      section: (r.section as string | null) ?? null,
      clientId: (r.client_id as string | null) ?? null,
      clientName: c?.name ?? null,
      clientSlug: c?.slug ?? null,
      kind: ((r.kind as EmailKind | null) ?? "batch") as EmailKind,
      priority: normalizePriority(r.priority as string | null, r.name as string),
      assignee: (r.assignee_name as string | null) ?? null,
      profileId: (r.profile_id as string | null) ?? null,
      dueOn: (r.due_on as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      comments: readList<EmailTaskComment>(r.comments),
      history: readList<EmailHistory>(r.history),
      fields: (r.fields ?? {}) as Record<string, string>,
      startOn: (r.start_on as string | null) ?? null,
      createdBy: (r.created_by_name as string | null) ?? null,
      createdAt: (r.asana_created_at as string | null) ?? null,
      modifiedAt: (r.asana_modified_at as string | null) ?? null,
      attachments: readList<AsanaAttachment>(r.attachments),
      subtasks: readList<AsanaSubtask>(r.subtasks),
    };
  });
}

/** Move a task to the Asana column for a stage (the first column that maps to it), and the mirror with it */
export async function moveEmailTaskInAsana(admin: Admin, gid: string, stage: EmailStage) {
  const project = await emailProjectGid(admin);
  if (!project) throw new Error("No Asana email project is set.");
  const { data: sections } = await asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" });
  const to = sections.find((s) => !isDoneColumn(s.name) && emailStageForColumn(s.name) === stage);
  if (!to) throw new Error(`The email board in Asana has no column for ${stage.replace(/_/g, " ")}.`);
  await asanaWrite(`/sections/${to.gid}/addTask`, { task: gid });
  const { data: task } = await admin.from("email_asana_tasks").select("section, moves").eq("gid", gid).maybeSingle();
  const moves = [...((task?.moves ?? []) as { from: string | null; to: string | null; at: string }[]), { from: (task?.section as string | null) ?? null, to: to.name, at: new Date().toISOString() }].slice(-30);
  await admin.from("email_asana_tasks").update({ section: to.name, stage, moves, synced_at: new Date().toISOString() }).eq("gid", gid);
}

/**
 * Migrate an Asana email task into a Kaizen ticket: same client, stage, assignee, due date and priority; its notes
 * become the brief; one message to start (the team adds the rest); its Asana history becomes the ticket's history and
 * its comments the ticket's comments. The Asana task is left as it is (with a comment linking to Kaizen when it can).
 */
export async function migrateEmailTask(admin: Admin, gid: string, by: { id: string; name: string }) {
  const { data: t } = await admin.from("email_asana_tasks").select("*").eq("gid", gid).maybeSingle();
  if (!t) throw new Error("That Asana task isn't mirrored.");
  if (t.ticket_id) {
    const { data: n } = await admin.from("email_tickets").select("number").eq("id", t.ticket_id).maybeSingle();
    return { number: (n?.number as number) ?? null };
  }
  if (!t.client_id) throw new Error("Pick the client first: this task's client couldn't be matched.");
  const stage: EmailStage = EMAIL_BOARD_ORDER.includes(t.stage as EmailStage) ? (t.stage as EmailStage) : "copy_review";
  const { seatsOf, dueFor, logEvent } = await import("@/lib/email-board");
  const seats = await seatsOf(admin, t.client_id as string);
  const assignee = (t.profile_id as string | null) ?? ownerFor(stage, seats);
  const { data: ticket, error } = await admin
    .from("email_tickets")
    .insert({
      client_id: t.client_id,
      kind: t.kind ?? "batch",
      title: cleanTitle(t.name as string).title.slice(0, 200),
      brief: (t.notes as string | null)?.slice(0, 20000) ?? null,
      stage,
      priority: t.priority === "high" || t.priority === "urgent" ? t.priority : "normal",
      assignee_id: assignee,
      stage_due_at: await dueFor(admin, stage),
      due_on: t.due_on,
      copy_status: "ready",
      asana_gid: gid,
      created_by: by.id,
      created_at: t.asana_created_at ?? new Date().toISOString(),
    })
    .select("id, number")
    .single();
  if (error || !ticket) throw new Error(error?.message ?? "Couldn't make the ticket.");
  // Past the copy step in Asana: the copy is taken as approved there
  const pastCopy = stage !== "copy_review";
  await admin.from("email_messages").insert({ ticket_id: ticket.id, client_id: t.client_id, position: 0, channel: /\bsms|text\b/i.test(t.name as string) ? "sms" : "email", name: t.kind === "flow" ? "Message 1" : "Email 1", ...(pastCopy ? { copy_approved_at: new Date().toISOString(), copy_approved_by: by.id } : {}) });
  for (const h of (t.history ?? []) as EmailHistory[])
    await logEvent(admin, {
      ticketId: ticket.id as string,
      clientId: t.client_id as string,
      kind: "asana",
      actorName: h.by,
      at: h.at,
      body: h.kind === "moved" ? `In Asana: moved from ${h.from ?? "nowhere"} to ${h.to ?? "nowhere"}` : h.kind === "assigned" ? `In Asana: assigned to ${h.to ?? "nobody"}` : `In Asana: due date ${h.from ?? "none"} to ${h.to ?? "none"}`,
      data: { asana: h },
    });
  const comments = (t.comments ?? []) as EmailTaskComment[];
  if (comments.length) await admin.from("email_comments").insert(comments.map((c) => ({ ticket_id: ticket.id, client_id: t.client_id, author_kind: "asana", author_name: c.by ? `${c.by} (Asana)` : "Asana", body: c.text, created_at: c.at })));
  await logEvent(admin, { ticketId: ticket.id as string, clientId: t.client_id as string, kind: "created", actorId: by.id, body: `Moved over from Asana (${t.section ?? "no column"}).`, data: { asana: gid, url: t.url } });
  await admin.from("email_asana_tasks").update({ ticket_id: ticket.id }).eq("gid", gid);
  try {
    const { siteUrl } = await import("@/lib/site");
    const { asanaAsPerson } = await import("@/lib/asana-user");
    await asanaAsPerson(admin, by.id, () => asanaWrite(`/tasks/${gid}/stories`, { text: `Moved to Kaizen: ${siteUrl()}/board/email?t=${ticket.number}` }));
  } catch {
    // The link back is a nicety
  }
  return { number: ticket.number as number };
}
