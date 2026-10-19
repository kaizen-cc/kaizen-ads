import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Stage } from "@/lib/stages";

// Asana's Creative board, mirrored while the team moves over to Kaizen Ads. Every few minutes the open tasks are read
// (column, assignee, due date, Client ID, priority, description) and kept as "shadow" tickets in the matching stage.
// Moves and edits in Asana show up here; tasks completed or removed in Asana drop off. Organic social requests are
// left out (this app is paid ads and creative). Read-only: nothing is written back to Asana.

export const asanaConfigured = () => Boolean(process.env.ASANA_TOKEN);
const API = "https://app.asana.com/api/1.0";

async function asana<T>(path: string, params: Record<string, string> = {}): Promise<{ data: T; next_page?: { offset: string } | null }> {
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

/** Asana's columns → our stages. "Launched" isn't mirrored: it's done. */
export const COLUMN_STAGE: [RegExp, Stage | null][] = [
  [/^creative brief/i, "requested"],
  [/^in progress/i, "in_production"],
  [/^creative for review/i, "internal_review"],
  [/^ready for copy/i, "copy"],
  [/^copy for review/i, "copy_review"],
  [/^copy/i, "copy"],
  [/^ready for client/i, "ready_for_client"],
  [/^sent to client/i, "client_review"],
  [/^client revision/i, "client_revision"],
  [/^ready for launch/i, "ready_for_launch"],
  [/^launched/i, null],
];
export const stageForColumn = (name: string | null) => (name ? (COLUMN_STAGE.find(([re]) => re.test(name.trim()))?.[1] ?? null) : null);

/** The Creative project: ASANA_PROJECT_GID, or the project named "Creative" in the token's workspaces. */
async function projectGid(admin: SupabaseClient) {
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

/** Reads the Asana board and updates the mirror. */
export async function syncAsana(admin: SupabaseClient) {
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "asana", "tasks");
  try {
    const project = await projectGid(admin);
    t.on("Reading the Creative board in Asana");
    const tasks = await all<AsanaTask>(`/projects/${project}/tasks`, {
      completed_since: "now", // open tasks only
      opt_fields: "name,notes,completed,assignee.name,assignee.email,due_on,permalink_url,created_at,modified_at,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value",
    });
    t.total(tasks.length);
    const [{ data: clients }, { data: people }, { data: mirror }] = await Promise.all([
      admin.from("clients").select("id, name, kaizen_id").is("archived_at", null),
      admin.from("profiles").select("id, email, full_name").eq("is_active", true),
      admin.from("asana_tasks").select("gid, section, moves, request_id"),
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
      await admin.from("asana_tasks").upsert({
        gid: task.gid,
        name: task.name,
        notes: task.notes?.slice(0, 20000) ?? null,
        section,
        stage: stageForColumn(section),
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
        open: true,
        synced_at: new Date().toISOString(),
      });
      seen.push(task.gid);
      t.tick(task.name.slice(0, 60));
    }
    // Completed or gone from the board in Asana: off the mirror (migrated ones keep their link)
    const gone = (mirror ?? []).filter((m) => !seen.includes(m.gid as string)).map((m) => m.gid as string);
    for (let i = 0; i < gone.length; i += 200) await admin.from("asana_tasks").update({ open: false, synced_at: new Date().toISOString() }).in("gid", gone.slice(i, i + 200));
    await admin.from("sync_state").upsert({ source: "asana", cursor_at: new Date().toISOString(), last_run_at: new Date().toISOString(), last_result: { ok: true, project, tasks: seen.length, skipped, closed: gone.length } });
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
