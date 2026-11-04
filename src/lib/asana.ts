import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Stage } from "@/lib/stages";

// Asana's Creative board, mirrored while the team moves over to Kaizen Ads. Every few minutes the open tasks are read
// (column, assignee, due date, Client ID, priority, description) and kept as "shadow" tickets in the matching stage.
// Moves and edits in Asana show up here; tasks completed or removed in Asana drop off the board (completed ones are
// kept, counted against the month's allotment with what they asked for: see countUnits). Organic social requests are
// left out (this app is paid ads and creative). Written to Asana: tasks for teams not yet in Kaizen Ads (createAsanaTask,
// e.g. reviewing a new client's intake), and creative requests briefed in Kaizen Ads and sent to the Creative board built
// exactly like the Google Form's (src/lib/asana-request.ts).

export const asanaConfigured = () => Boolean(process.env.ASANA_TOKEN);
const API = "https://app.asana.com/api/1.0";

export async function asana<T>(path: string, params: Record<string, string> = {}): Promise<{ data: T; next_page?: { offset: string } | null }> {
  const url = `${API}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.ASANA_TOKEN}`, Accept: "application/json" }, cache: "no-store" });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
      continue;
    }
    const body = (await res.json()) as { data: T; next_page?: { offset: string } | null; errors?: { message: string }[] };
    if (!res.ok) throw new Error(`Asana: ${body.errors?.[0]?.message ?? res.status}`);
    return body;
  }
  throw new Error("Asana: rate limited");
}

export async function asanaWrite<T>(path: string, data: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${process.env.ASANA_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ data }), cache: "no-store" });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
      continue;
    }
    const body = (await res.json()) as { data: T; errors?: { message: string }[] };
    if (!res.ok) throw new Error(`Asana: ${body.errors?.[0]?.message ?? res.status}`);
    return body.data;
  }
  throw new Error("Asana: rate limited");
}

/**
 * A task for someone on a team that isn't in Kaizen Ads yet, assigned by their email. In a project when one is given,
 * otherwise in the workspace (it lands in their My Tasks). Someone Asana doesn't know by that email: the task is made
 * unassigned with their name at the top, so it isn't lost.
 */
export async function createAsanaTask(t: { name: string; notes: string; assignee: string | null; project?: string | null; dueOn?: string | null }) {
  const where: Record<string, unknown> = t.project ? { projects: [t.project] } : { workspace: (await asana<{ gid: string }[]>("/workspaces")).data[0]?.gid };
  const base = { ...where, name: t.name.slice(0, 250), notes: t.notes.slice(0, 60000), ...(t.dueOn ? { due_on: t.dueOn } : {}) };
  try {
    const task = await asanaWrite<{ gid: string; permalink_url?: string }>("/tasks?opt_fields=permalink_url", { ...base, ...(t.assignee ? { assignee: t.assignee } : {}) });
    return { gid: task.gid, url: task.permalink_url ?? null, assigned: Boolean(t.assignee) };
  } catch (e) {
    if (!t.assignee) throw e;
    const task = await asanaWrite<{ gid: string; permalink_url?: string }>("/tasks?opt_fields=permalink_url", { ...base, notes: `For ${t.assignee} (Asana doesn't know this email)\n\n${t.notes}`.slice(0, 60000) });
    return { gid: task.gid, url: task.permalink_url ?? null, assigned: false };
  }
}

/**
 * A client's own Asana project: its title carries the client's name and Kaizen Client ID. Matched on the ID first (as
 * a whole number in the title), then on the name; null when nothing matches.
 */
export async function findClientProject(kaizenId: number | null, name: string) {
  const ws = (await asana<{ gid: string }[]>("/workspaces")).data[0]?.gid;
  if (!ws) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const search = async (query: string) => (await asana<{ gid: string; name: string }[]>(`/workspaces/${ws}/typeahead`, { resource_type: "project", query, count: "100", opt_fields: "name,archived" })).data;
  if (kaizenId != null) {
    const id = new RegExp(`(^|\\D)${kaizenId}(\\D|$)`);
    const hits = (await search(String(kaizenId))).filter((p) => id.test(p.name));
    // Several with the ID: the one that also has the name
    const hit = hits.find((p) => norm(p.name).includes(norm(name))) ?? (hits.length === 1 ? hits[0] : null);
    if (hit) return { gid: hit.gid, name: hit.name, by: "id" as const };
  }
  const n = norm(name);
  if (n.length < 4) return null;
  const byName = (await search(name)).filter((p) => norm(p.name).includes(n));
  return byName.length === 1 ? { gid: byName[0].gid, name: byName[0].name, by: "name" as const } : null;
}

async function all<T>(path: string, params: Record<string, string>) {
  const out: T[] = [];
  let offset: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await asana<T[]>(path, { ...params, limit: "100", ...(offset ? { offset } : {}) });
    out.push(...r.data);
    offset = r.next_page?.offset;
    if (!offset) break;
  }
  return out;
}

/** Asana's columns → our stages (only stages on the board). "Launched" isn't mirrored: it's done. */
export const COLUMN_STAGE: [RegExp, Stage | null][] = [
  [/^creative brief/i, "requested"],
  [/^in progress/i, "in_production"],
  [/^creative for review/i, "internal_review"],
  [/^ready for copy/i, "copy"],
  [/^copy for review/i, "copy_review"],
  [/^copy/i, "copy"],
  // No "Ready for client" in the new flow: approving the copy sends it to the client, so it sits with the client
  [/^ready for client/i, "client_review"],
  [/^sent to client/i, "client_review"],
  [/^client revision/i, "client_revision"],
  [/^ready for launch/i, "ready_for_launch"],
  [/^launched/i, null],
];
export const stageForColumn = (name: string | null) => (name ? (COLUMN_STAGE.find(([re]) => re.test(name.trim()))?.[1] ?? null) : null);

/** The Creative project: ASANA_PROJECT_GID, or the project named "Creative" in the token's workspaces. */
export async function projectGid(admin: SupabaseClient) {
  if (process.env.ASANA_PROJECT_GID) return process.env.ASANA_PROJECT_GID;
  const { data: state } = await admin.from("sync_state").select("cursor_at, last_result").eq("source", "asana").maybeSingle();
  const known = (state?.last_result as { project?: string } | null)?.project;
  if (known) return known;
  const { data: spaces } = await asana<{ gid: string }[]>("/workspaces");
  for (const w of spaces) {
    const projects = await all<{ gid: string; name: string }>("/projects", { workspace: w.gid, archived: "false", opt_fields: "name" });
    const p = projects.find((x) => x.name.trim().toLowerCase() === "creative");
    if (p) return p.gid;
  }
  throw new Error('Couldn\'t find an Asana project named "Creative". Set ASANA_PROJECT_GID.');
}

type AsanaTask = {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  completed_at: string | null;
  assignee: { name: string; email?: string } | null;
  due_on: string | null;
  permalink_url: string;
  created_at: string;
  modified_at: string;
  memberships: { project: { gid: string }; section: { name: string } | null }[];
  custom_fields: { name: string; display_value: string | null }[];
};

const PLATFORM = /(meta ads|facebook|instagram|google ads|tiktok|organic social|organic)/i;
const FORMAT = /\b(image|video|carousel|static|reel)s?\b/i;

/** The first day of the month (New York) a moment falls in, as YYYY-MM-01. */
const monthOf = (iso: string) => `${new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7)}-01`;

/** The first moment of this month in New York (or of a month before/after), as an ISO string. */
function monthStart(offset = 0) {
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1, 5)); // 5am UTC is midnight or 1am in New York
  return first.toISOString();
}

const UNITS_SYSTEM = `You count what each Asana task from Kaizen's creative board asks the design team to make, for the client's monthly creative allotment. For each task: newImages and newVideos, the net-new paid ads creatives it asks for. A carousel counts as one image. Resizes, iterations, edits, captions or optimizations of an existing ad or video, and copy-only work, are 0 (they don't draw on the allotment). Print and in-store work (mailers, postcards, flyers, signs, menus) and organic-only posts are 0. When the task names one creative ("Video 02", "Image"), that's 1. When it asks for several ("5 statics", "both videos"), count them. A range ("3-4 statics") counts its low end. If it's unclear, count 1 of the format it names. note: a few words on why ("2 new videos", "resize of an existing ad", "print mailer").`;
const UNITS_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, newImages: { type: "integer" }, newVideos: { type: "integer" }, note: { type: "string" } }, required: ["id", "newImages", "newVideos", "note"], additionalProperties: false },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

/** Reads how many new images and videos each of this month's tasks asks for (once, and again when it's edited). */
async function countUnits(admin: SupabaseClient, max = 60) {
  const { createHash } = await import("node:crypto");
  const { askJson } = await import("@/lib/ai");
  const { data } = await admin
    .from("asana_tasks")
    .select("gid, name, notes, format, units_key")
    .is("request_id", null)
    .not("client_id", "is", null)
    .or(`counted_at.gte.${new Date(Date.now() - 35 * 86_400_000).toISOString()},and(open.eq.true,counted_month.is.null)`)
    .limit(400);
  const keyOf = (t: { name: string; notes: string | null }) => createHash("sha1").update(`${t.name}\n${t.notes ?? ""}`).digest("hex");
  const todo = (data ?? []).filter((t) => t.units_key !== keyOf(t)).slice(0, max);
  for (let i = 0; i < todo.length; i += 15) {
    const batch = todo.slice(i, i + 15);
    const out = await askJson<{ tasks: { id: string; newImages: number; newVideos: number; note: string }[] }>({
      agent: "strategist",
      label: "asana allotment count",
      system: UNITS_SYSTEM,
      schema: UNITS_SCHEMA,
      maxTokens: 4000,
      prompt: batch.map((t) => `<task id="${t.gid}">\nTitle: ${t.name}\n${(t.notes ?? "").slice(0, 2500)}\n</task>`).join("\n\n"),
    });
    for (const t of batch) {
      const r = out.tasks.find((x) => x.id === t.gid);
      if (!r) continue;
      await admin
        .from("asana_tasks")
        .update({ new_images: Math.max(0, Math.min(50, r.newImages)), new_videos: Math.max(0, Math.min(50, r.newVideos)), units_note: r.note.slice(0, 200), units_key: keyOf(t), units_read_at: new Date().toISOString() })
        .eq("gid", t.gid);
    }
  }
  return todo.length;
}

export type HistoryEvent =
  | { at: string; kind: "moved"; from: string | null; to: string | null; by: string | null }
  | { at: string; kind: "assigned"; to: string | null; by: string | null }
  /** The due date changed (from → to, YYYY-MM-DD), and who changed it */
  | { at: string; kind: "due"; from: string | null; to: string | null; by: string | null };
/** A comment on the task (the team's or the client's feedback), kept to read for real errors */
export type TaskComment = { at: string; by: string | null; text: string };

/**
 * Each task's history from its Asana stories: every column move and reassignment, with when and by whom. Read for
 * tasks not read yet or changed since, a batch per sync, so the full history fills in over a few runs.
 */
async function readHistory(admin: SupabaseClient, max = 60) {
  const { data } = await admin.from("asana_tasks").select("gid, asana_modified_at, history_read_at").order("asana_modified_at", { ascending: false }).limit(1000);
  const todo = (data ?? []).filter((t) => !t.history_read_at || (t.asana_modified_at && t.asana_modified_at > t.history_read_at)).slice(0, max);
  type Story = { created_at: string; resource_subtype: string; created_by: { name: string } | null; old_section?: { name: string } | null; new_section?: { name: string } | null; assignee?: { name: string } | null; text?: string; old_dates?: { due_on?: string | null } | null; new_dates?: { due_on?: string | null } | null };
  for (const t of todo) {
    try {
      const stories = await all<Story>(`/tasks/${t.gid}/stories`, { opt_fields: "created_at,resource_subtype,created_by.name,old_section.name,new_section.name,assignee.name,text,old_dates.due_on,new_dates.due_on" });
      const history: HistoryEvent[] = stories.flatMap((s): HistoryEvent[] => {
        const by = s.created_by?.name ?? null;
        if (s.resource_subtype === "section_changed") return [{ at: s.created_at, kind: "moved", from: s.old_section?.name ?? null, to: s.new_section?.name ?? null, by }];
        if (s.resource_subtype === "assigned") return [{ at: s.created_at, kind: "assigned", to: s.assignee?.name ?? null, by }];
        if (s.resource_subtype === "unassigned") return [{ at: s.created_at, kind: "assigned", to: null, by }];
        if (s.resource_subtype === "due_date_changed") return [{ at: s.created_at, kind: "due", from: s.old_dates?.due_on ?? null, to: s.new_dates?.due_on ?? null, by }];
        return [];
      });
      const comments: TaskComment[] = stories.filter((s) => s.resource_subtype === "comment_added" && s.text?.trim()).map((s) => ({ at: s.created_at, by: s.created_by?.name ?? null, text: s.text!.trim().slice(0, 2000) }));
      await admin.from("asana_tasks").update({ history: history.slice(-200), comments: comments.slice(-60), history_read_at: new Date().toISOString() }).eq("gid", t.gid);
    } catch {
      // A task deleted in Asana, or a hiccup: tried again next run
    }
  }
  return todo.length;
}

/** Reads the Asana board and updates the mirror. */
export async function syncAsana(admin: SupabaseClient) {
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "asana", "tasks");
  try {
    const project = await projectGid(admin);
    t.on("Reading the Creative board in Asana");
    const tasks = await all<AsanaTask>(`/projects/${project}/tasks`, {
      // Open tasks, and ones completed since last month began (they count against this month's allotment)
      completed_since: monthStart(-1),
      opt_fields: "name,notes,completed,completed_at,assignee.name,assignee.email,due_on,permalink_url,created_at,modified_at,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value",
    });
    t.total(tasks.length);
    const [{ data: clients }, { data: people }, { data: mirror }] = await Promise.all([
      admin.from("clients").select("id, name, kaizen_id").is("archived_at", null),
      admin.from("profiles").select("id, email, full_name").eq("is_active", true),
      admin.from("asana_tasks").select("gid, section, moves, request_id, counted_month, counted_at"),
    ]);
    const byKaizen = new Map((clients ?? []).filter((c) => c.kaizen_id != null).map((c) => [String(c.kaizen_id), c.id as string]));
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const before = new Map((mirror ?? []).map((m) => [m.gid as string, m]));
    const seen: string[] = [];
    let skipped = 0;

    for (const task of tasks) {
      const section = task.memberships.find((m) => m.project?.gid === project)?.section?.name ?? null;
      const fields = Object.fromEntries(task.custom_fields.filter((f) => f.display_value).map((f) => [f.name, f.display_value!]));
      const platform = (Object.entries(fields).find(([k]) => /platform/i.test(k))?.[1] ?? task.name.match(PLATFORM)?.[0] ?? null) as string | null;
      if (platform && /organic/i.test(platform)) {
        skipped++;
        t.tick(null);
        continue; // another team's work
      }
      // The client: the Client ID field (the form's first question), else the client's name in the task title
      const idField = Object.entries(fields).find(([k, v]) => /client\s*id|^id$|client #/i.test(k) || (/^\d{2,5}$/.test(String(v).trim()) && /client/i.test(k)))?.[1] ?? Object.values(fields).find((v) => /^\d{2,5}$/.test(String(v).trim()));
      let clientId = idField ? byKaizen.get(String(idField).trim()) : undefined;
      if (!clientId) {
        const title = norm(task.name);
        clientId = (clients ?? []).filter((c) => norm(c.name).length >= 4 && title.includes(norm(c.name))).sort((a, b) => b.name.length - a.name.length)[0]?.id;
      }
      const email = task.assignee?.email?.toLowerCase() ?? null;
      const profile = (people ?? []).find((p) => (email && p.email?.toLowerCase() === email) || (task.assignee?.name && p.full_name.toLowerCase().startsWith(task.assignee.name.toLowerCase())));
      const prev = before.get(task.gid);
      const moves = (prev?.moves ?? []) as { from: string | null; to: string | null; at: string }[];
      if (prev && prev.section !== section) moves.push({ from: prev.section as string | null, to: section, at: new Date().toISOString() });
      // The allotment month: set once, when it's first seen in production or delivered (a brief waiting in the Creative
      // Brief column hasn't drawn on anything yet). Delivered: the month it was completed. In production: the month it
      // last changed, which is now for a task that just moved, and its last real activity for one already there.
      const stage = stageForColumn(section);
      const inProduction = task.completed || stage !== "requested";
      const countedMonth = (prev?.counted_month as string | null) ?? (inProduction ? monthOf(task.completed ? (task.completed_at ?? task.modified_at) : task.modified_at) : null);
      // The moment it counted, so it falls in the client's billing cycle (not just the calendar month)
      const countedAt = (prev?.counted_at as string | null) ?? (inProduction ? (task.completed ? (task.completed_at ?? task.modified_at) : task.modified_at) : null);
      await admin.from("asana_tasks").upsert({
        gid: task.gid,
        name: task.name,
        notes: task.notes?.slice(0, 20000) ?? null,
        section,
        stage,
        counted_month: countedMonth,
        counted_at: countedAt,
        client_id: clientId ?? null,
        client_ref: idField ? String(idField) : null,
        platform,
        format: task.name.match(FORMAT)?.[1]?.toLowerCase().replace("static", "image").replace("reel", "video") ?? null,
        priority: Object.entries(fields).find(([k]) => /priority/i.test(k))?.[1] ?? (/urgent/i.test(task.name) ? "urgent" : null),
        assignee_name: task.assignee?.name ?? null,
        assignee_email: email,
        profile_id: profile?.id ?? null,
        due_on: task.due_on,
        url: task.permalink_url,
        fields,
        moves: moves.slice(-30),
        asana_created_at: task.created_at,
        asana_modified_at: task.modified_at,
        open: !task.completed,
        completed_at: task.completed ? (task.completed_at ?? task.modified_at) : null,
        synced_at: new Date().toISOString(),
      });
      seen.push(task.gid);
      t.tick(task.name.slice(0, 60));
    }
    // Completed or gone from the board in Asana: off the mirror (migrated ones keep their link)
    const gone = (mirror ?? []).filter((m) => !seen.includes(m.gid as string)).map((m) => m.gid as string);
    for (let i = 0; i < gone.length; i += 200) await admin.from("asana_tasks").update({ open: false, synced_at: new Date().toISOString() }).in("gid", gone.slice(i, i + 200));
    t.on("Counting new images and videos for the allotments");
    const counted = await countUnits(admin).catch(() => 0);
    t.on("Reading each task's history (moves and reassignments)");
    const histories = await readHistory(admin).catch(() => 0);
    await admin.from("sync_state").upsert({ source: "asana", cursor_at: new Date().toISOString(), last_run_at: new Date().toISOString(), last_result: { ok: true, project, tasks: seen.length, skipped, closed: gone.length, counted, histories } });
    await t.finish({ summary: `${seen.length} open tasks mirrored${skipped ? `, ${skipped} organic left out` : ""}${gone.length ? `, ${gone.length} closed in Asana` : ""}` });
    return { project, mirrored: seen.length, skipped, closed: gone.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("sync_state").upsert({ source: "asana", last_run_at: new Date().toISOString(), last_result: { ok: false, error } });
    await t.finish({ error });
    throw e;
  }
}

export type ShadowTicket = {
  gid: string;
  name: string;
  stage: Stage;
  section: string | null;
  clientId: string | null;
  clientName: string | null;
  clientSlug: string | null;
  clientRef: string | null;
  platform: string | null;
  format: string | null;
  priority: string | null;
  assignee: string | null;
  profileId: string | null;
  dueOn: string | null;
  url: string;
  notes: string | null;
  fields: Record<string, string>;
  moves: { from: string | null; to: string | null; at: string }[];
  createdAt: string | null;
};

/** The open Asana tasks not yet migrated, for the board. */
export async function loadShadows(db: SupabaseClient): Promise<ShadowTicket[]> {
  const { data } = await db
    .from("asana_tasks")
    .select("gid, name, stage, section, client_id, client_ref, platform, format, priority, assignee_name, profile_id, due_on, url, notes, fields, moves, asana_created_at, clients(name, slug)")
    .eq("open", true)
    .is("request_id", null)
    .not("stage", "is", null)
    .order("asana_created_at", { ascending: false })
    .limit(500);
  return (data ?? []).map((r) => {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    return {
      gid: r.gid,
      name: r.name,
      stage: r.stage as Stage,
      section: r.section,
      clientId: r.client_id,
      clientName: c?.name ?? null,
      clientSlug: c?.slug ?? null,
      clientRef: r.client_ref,
      platform: r.platform,
      format: r.format,
      priority: r.priority,
      assignee: r.assignee_name,
      profileId: r.profile_id,
      dueOn: r.due_on,
      url: r.url,
      notes: r.notes,
      fields: (r.fields ?? {}) as Record<string, string>,
      moves: (r.moves ?? []) as ShadowTicket["moves"],
      createdAt: r.asana_created_at,
    };
  });
}
