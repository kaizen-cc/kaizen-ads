"use server";

import { requireStaff, type Staff } from "@/lib/auth";
import { kindOf, type Thread } from "@/lib/kaizen-ai/types";
import {
  canDeleteProject,
  canEditProject,
  canUseProject,
  cleanConnectors,
  isVisibility,
  projectRole,
  type MemberRole,
  type ProjectAccess,
  type ProjectDetail,
  type ProjectDoc,
  type ProjectRole,
  type ProjectSummary,
  type ProjectVisibility,
} from "@/lib/kaizen-ai/projects";
import { MAX_DOC_CHARS, readKnowledgeFile } from "@/lib/kaizen-ai/projects-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Kaizen AI projects, like Claude's. Reads go through the person's own session, so row-level security decides what
// they see (private.ai_project_role); every change also checks their role here first (projectRole, the same rules),
// so a viewer is turned away with a plain message rather than a silent no-op. Until the projects migration is
// applied every read comes back empty and every change says projects aren't ready.

type Ok<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/;
const NOT_READY = "Projects aren't switched on yet.";

type Row = {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  client_id: string | null;
  connectors?: string[];
  visibility: ProjectVisibility;
  everyone_can_edit: boolean;
  created_by: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  clients: { name: string; slug: string } | null;
  ai_project_members: { profile_id: string; role: MemberRole }[];
};

const access = (r: Row): ProjectAccess => ({ created_by: r.created_by, visibility: r.visibility, everyone_can_edit: r.everyone_can_edit, members: r.ai_project_members ?? [] });
const roleOf = (r: Row, me: Staff) => projectRole(access(r), me);

/** The project and the person's role on it (null when they can't see it, or projects aren't set up yet) */
async function withRole(id: string) {
  const me = await requireStaff();
  if (!UUID.test(id)) return null;
  const db = await createClient();
  const { data, error } = await db.from("ai_projects").select("id, name, created_by, visibility, everyone_can_edit, client_id, ai_project_members(profile_id, role)").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const role = roleOf(data as unknown as Row, me);
  return role ? { me, db, role, row: data as unknown as Row } : null;
}

async function names(ids: string[]) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map<string, string>();
  const { data } = await createAdminClient().from("profiles").select("id, full_name").in("id", list);
  return new Map((data ?? []).map((p) => [String(p.id), String(p.full_name ?? "A teammate")]));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const me = await requireStaff();
  const db = await createClient();
  const { data, error } = await db
    .from("ai_projects")
    .select("id, name, description, client_id, visibility, everyone_can_edit, created_by, source, created_at, updated_at, clients(name, slug), ai_project_members(profile_id, role), ai_project_docs(count)")
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error || !data) return [];
  // The chats the person sees in each (theirs, and ones shared with them)
  const { data: threads } = await db.from("ai_threads").select("project_id").not("project_id", "is", null).is("archived_at", null).limit(5000);
  const chats = new Map<string, number>();
  for (const t of threads ?? []) chats.set(String(t.project_id), (chats.get(String(t.project_id)) ?? 0) + 1);
  return (data as unknown as (Row & { ai_project_docs: { count: number }[] })[]).flatMap((r) => {
    const role = roleOf(r, me);
    if (!role) return [];
    return [
      {
        id: r.id,
        name: r.name,
        description: r.description ?? "",
        client: r.client_id && r.clients ? { id: r.client_id, name: r.clients.name, slug: r.clients.slug } : null,
        visibility: r.visibility,
        role,
        createdBy: r.created_by,
        chats: chats.get(r.id) ?? 0,
        docs: r.ai_project_docs?.[0]?.count ?? 0,
        updatedAt: r.updated_at,
        imported: r.source === "claude",
      },
    ];
  });
}

const THREAD_COLS = "id, title, client_id, client_confirmed, agent_key, model, pinned, shared_with, last_message_at, profile_id, source, import_id, created_at, clients(name, slug)";

/** A project as its page shows it: details, knowledge (names and sizes), people, and the chats in it the person sees */
export async function loadProject(id: string): Promise<{ project: ProjectDetail; chats: (Thread & { owner: string | null })[] } | null> {
  const me = await requireStaff();
  if (!UUID.test(id)) return null;
  const db = await createClient();
  const [{ data, error }, { data: docs }, { data: threads }] = await Promise.all([
    db.from("ai_projects").select("id, name, description, instructions, client_id, connectors, visibility, everyone_can_edit, created_by, source, created_at, updated_at, clients(name, slug), ai_project_members(profile_id, role)").eq("id", id).maybeSingle(),
    db.from("ai_project_docs").select("id, kind, name, chars, bytes, note, added_by, created_at").eq("project_id", id).order("created_at").limit(500),
    db.from("ai_threads").select(THREAD_COLS).eq("project_id", id).is("archived_at", null).eq("source_complete", true).order("last_message_at", { ascending: false }).limit(300),
  ]);
  if (error || !data) return null;
  const r = data as unknown as Row;
  const role = roleOf(r, me);
  if (!role) return null;
  const members = r.ai_project_members ?? [];
  const chatList = (threads ?? []) as unknown as Thread[];
  const who = await names([r.created_by, ...members.map((m) => m.profile_id), ...chatList.map((t) => t.profile_id)]);
  const editors =
    r.visibility === "everyone" && r.everyone_can_edit
      ? [who.get(r.created_by) ?? "The creator", "Everyone at Kaizen"]
      : [who.get(r.created_by) ?? "The creator", ...(r.visibility === "private" ? [] : members.filter((m) => m.role === "editor").map((m) => who.get(m.profile_id) ?? "A teammate"))];
  const docList: ProjectDoc[] = (docs ?? []).map((d) => ({ id: String(d.id), kind: d.kind === "file" ? "file" : "text", name: String(d.name), chars: Number(d.chars) || 0, bytes: d.bytes == null ? null : Number(d.bytes), note: (d.note as string | null) ?? null, addedBy: (d.added_by as string | null) ?? null, createdAt: String(d.created_at) }));
  return {
    project: {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      instructions: r.instructions ?? "",
      client: r.client_id && r.clients ? { id: r.client_id, name: r.clients.name, slug: r.clients.slug } : null,
      connectors: r.connectors ?? [],
      visibility: r.visibility,
      everyoneCanEdit: r.everyone_can_edit,
      role,
      creator: { id: r.created_by, name: who.get(r.created_by) ?? "A teammate" },
      members: members.map((m) => ({ id: m.profile_id, name: who.get(m.profile_id) ?? "A teammate", role: m.role })).sort((a, b) => a.name.localeCompare(b.name)),
      editors,
      docs: docList,
      knowledgeChars: docList.reduce((n, d) => n + d.chars, 0),
      imported: r.source === "claude",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
    chats: chatList.map((t) => ({ ...t, owner: t.profile_id === me.id ? null : (who.get(t.profile_id) ?? "A teammate") })),
  };
}

export async function createProject(p: { name: string; description?: string; instructions?: string; clientId?: string | null }): Promise<Ok<{ id: string }>> {
  const me = await requireStaff();
  const name = p.name.trim().slice(0, 120);
  if (!name) return { ok: false, error: "Give the project a name." };
  const db = await createClient();
  let clientId: string | null = null;
  if (p.clientId && UUID.test(p.clientId)) {
    const { data: c } = await db.from("clients").select("id").eq("id", p.clientId).maybeSingle();
    if (!c) return { ok: false, error: "You can't see that client." };
    clientId = p.clientId;
  }
  const { data, error } = await db
    .from("ai_projects")
    .insert({ created_by: me.id, name, description: (p.description ?? "").trim().slice(0, 4000), instructions: (p.instructions ?? "").slice(0, 40_000), client_id: clientId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.code === "42P01" ? NOT_READY : "Couldn't create the project." };
  return { ok: true, id: data.id as string };
}

const touch = (db: Awaited<ReturnType<typeof createClient>>, id: string) => db.from("ai_projects").update({ updated_at: new Date().toISOString() }).eq("id", id);

/** Name, description, instructions, client and expected connectors: editors only */
export async function updateProject(id: string, patch: { name?: string; description?: string; instructions?: string; clientId?: string | null; connectors?: string[] }): Promise<Ok> {
  const ok = await withRole(id);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canEditProject(ok.role)) return { ok: false, error: "Only the project's editors can change it." };
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.name === "string") {
    const name = patch.name.trim().slice(0, 120);
    if (!name) return { ok: false, error: "Give the project a name." };
    row.name = name;
  }
  if (typeof patch.description === "string") row.description = patch.description.trim().slice(0, 4000);
  if (typeof patch.instructions === "string") row.instructions = patch.instructions.slice(0, 40_000);
  if (patch.connectors !== undefined) row.connectors = cleanConnectors(patch.connectors);
  if (patch.clientId !== undefined) {
    if (patch.clientId) {
      const { data: c } = await ok.db.from("clients").select("id").eq("id", patch.clientId).maybeSingle();
      if (!c) return { ok: false, error: "You can't see that client." };
    }
    row.client_id = patch.clientId || null;
  }
  const { error } = await ok.db.from("ai_projects").update(row).eq("id", id);
  return error ? { ok: false, error: "Couldn't save that. Try again." } : { ok: true };
}

/** Who can see and change it: editors only. Replaces the people list; new people get a notification. */
export async function shareProject(id: string, s: { visibility: ProjectVisibility; everyoneCanEdit: boolean; members: { id: string; role: MemberRole }[] }): Promise<Ok> {
  const ok = await withRole(id);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canEditProject(ok.role)) return { ok: false, error: "Only the project's editors can change who has access." };
  if (!isVisibility(s.visibility)) return { ok: false, error: "Pick who can see it." };
  const members = new Map<string, MemberRole>();
  if (s.visibility !== "private") for (const m of (s.members ?? []).slice(0, 100)) if (UUID.test(m.id) && m.id !== ok.row.created_by) members.set(m.id, m.role === "editor" ? "editor" : "viewer");
  const before = new Set((ok.row.ai_project_members ?? []).map((m) => m.profile_id));
  const { error } = await ok.db.from("ai_projects").update({ visibility: s.visibility, everyone_can_edit: s.visibility === "everyone" && Boolean(s.everyoneCanEdit), updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: "Couldn't save that. Try again." };
  // Editors may lose edit through this change (everyone_can_edit off): the people list is written with the admin
  // client, now that the role was checked above
  const admin = createAdminClient();
  await admin.from("ai_project_members").delete().eq("project_id", id);
  if (members.size) {
    const { error: e } = await admin.from("ai_project_members").insert([...members].map(([profile_id, role]) => ({ project_id: id, profile_id, role, added_by: ok.me.id })));
    if (e) return { ok: false, error: "Couldn't save the people. Try again." };
  }
  const added = [...members.keys()].filter((p) => !before.has(p) && p !== ok.me.id);
  if (added.length)
    await admin
      .from("notifications")
      .upsert(
        added.map((p) => ({ profile_id: p, kind: "ai", title: `${ok.me.fullName.split(" ")[0]} added you to a Kaizen AI project`, body: ok.row.name, href: `/ai?p=${id}`, key: `ai-project:${id}`, priority: "normal" })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      )
      .then(({ error: n }) => n && console.error("[kaizen ai] project notice", n.message));
  return { ok: true };
}

/** Delete the project (the owner only). Its chats stay with the people who had them, outside any project. */
export async function deleteProject(id: string): Promise<Ok> {
  const ok = await withRole(id);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canDeleteProject(ok.role)) return { ok: false, error: "Only the person who made the project can delete it." };
  const { error } = await ok.db.from("ai_projects").delete().eq("id", id);
  return error ? { ok: false, error: "Couldn't delete it. Try again." } : { ok: true };
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export async function addProjectText(id: string, d: { name: string; text: string }): Promise<Ok<{ doc: ProjectDoc }>> {
  const ok = await withRole(id);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canEditProject(ok.role)) return { ok: false, error: "Only the project's editors can add knowledge." };
  const text = d.text.slice(0, MAX_DOC_CHARS);
  if (!text.trim()) return { ok: false, error: "Paste or write something first." };
  const name = d.name.trim().slice(0, 200) || text.trim().split("\n")[0].slice(0, 60) || "Text";
  const { data, error } = await ok.db.from("ai_project_docs").insert({ project_id: id, kind: "text", name, text, chars: text.length, added_by: ok.me.id }).select("id, created_at").single();
  if (error || !data) return { ok: false, error: "Couldn't add it. Try again." };
  await touch(ok.db, id);
  return { ok: true, doc: { id: String(data.id), kind: "text", name, chars: text.length, bytes: null, note: null, addedBy: ok.me.id, createdAt: String(data.created_at) } };
}

/** Files already uploaded to the person's own folder: their text read now and kept as knowledge */
export async function addProjectFiles(id: string, files: { path: string; name: string; mime: string; bytes: number }[]): Promise<Ok<{ docs: ProjectDoc[] }>> {
  const ok = await withRole(id);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canEditProject(ok.role)) return { ok: false, error: "Only the project's editors can add knowledge." };
  const admin = createAdminClient();
  const docs: ProjectDoc[] = [];
  for (const f of files.slice(0, 10)) {
    if (typeof f.path !== "string" || !f.path.startsWith(`${ok.me.id}/`)) continue;
    const kind = kindOf(String(f.mime ?? ""), String(f.name ?? ""));
    if (kind !== "pdf" && kind !== "doc" && kind !== "text") continue;
    const name = String(f.name).slice(0, 200);
    const read = await readKnowledgeFile(admin, { path: f.path, name, mime: String(f.mime ?? "") }).catch(() => ({ text: null, note: "It couldn't be read." }));
    const { data, error } = await ok.db
      .from("ai_project_docs")
      .insert({ project_id: id, kind: "file", name, path: f.path, mime: f.mime || null, bytes: Number(f.bytes) || null, text: read.text, chars: read.text?.length ?? 0, note: read.note, added_by: ok.me.id })
      .select("id, created_at")
      .single();
    if (error || !data) continue;
    docs.push({ id: String(data.id), kind: "file", name, chars: read.text?.length ?? 0, bytes: Number(f.bytes) || null, note: read.note, addedBy: ok.me.id, createdAt: String(data.created_at) });
  }
  if (!docs.length) return { ok: false, error: "Those files couldn't be added. PDFs, Word, PowerPoint, Excel, CSV and text files work." };
  await touch(ok.db, id);
  return { ok: true, docs };
}

export async function removeProjectDoc(projectId: string, docId: string): Promise<Ok> {
  const ok = await withRole(projectId);
  if (!ok) return { ok: false, error: "That project isn't there any more." };
  if (!canEditProject(ok.role)) return { ok: false, error: "Only the project's editors can remove knowledge." };
  const { error } = await ok.db.from("ai_project_docs").delete().eq("id", docId).eq("project_id", projectId);
  if (error) return { ok: false, error: "Couldn't remove it. Try again." };
  await touch(ok.db, projectId);
  return { ok: true };
}

/** One knowledge doc's text, to read on the page (anyone who can see the project) */
export async function readProjectDoc(projectId: string, docId: string): Promise<{ name: string; text: string; note: string | null } | null> {
  const ok = await withRole(projectId);
  if (!ok || !canUseProject(ok.role) || !UUID.test(docId)) return null;
  const { data } = await ok.db.from("ai_project_docs").select("name, text, note").eq("id", docId).eq("project_id", projectId).maybeSingle();
  return data ? { name: String(data.name), text: String(data.text ?? ""), note: (data.note as string | null) ?? null } : null;
}

// ─── Chats and projects ──────────────────────────────────────────────────────

/** Put one of the person's own chats in a project they can see, or take it out (null) */
export async function moveThreadToProject(threadId: string, projectId: string | null): Promise<Ok> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: t } = await db.from("ai_threads").select("id").eq("id", threadId).eq("profile_id", me.id).maybeSingle();
  if (!t) return { ok: false, error: "Not your chat." };
  let role: ProjectRole | null = null;
  if (projectId) {
    const ok = await withRole(projectId);
    role = ok?.role ?? null;
    if (!canUseProject(role)) return { ok: false, error: "You can't see that project." };
  }
  const { error } = await db.from("ai_threads").update({ project_id: projectId, updated_at: new Date().toISOString() }).eq("id", threadId);
  return error ? { ok: false, error: "Couldn't move it. Try again." } : { ok: true };
}

/** The project each of these threads is in, with its name (empty before the migration) */
export async function threadProjects(): Promise<Record<string, { id: string; name: string }>> {
  await requireStaff();
  const db = await createClient();
  const { data, error } = await db.from("ai_threads").select("id, project_id, ai_projects(name)").not("project_id", "is", null).is("archived_at", null).limit(3000);
  if (error) return {};
  const out: Record<string, { id: string; name: string }> = {};
  for (const r of (data ?? []) as unknown as { id: string; project_id: string; ai_projects: { name: string } | null }[]) if (r.ai_projects) out[r.id] = { id: r.project_id, name: r.ai_projects.name };
  return out;
}

/**
 * The connectors the person has connected (keys like "shopify"), for the "Connect Shopify" hint. Personal connections
 * live in Settings › Connections (built separately); until their table is there this reads nothing, so every expected
 * connector shows the hint.
 */
export async function myConnectorKeys(): Promise<string[]> {
  const me = await requireStaff();
  const db = await createClient();
  for (const [table, col] of [
    ["mcp_connections", "connector_key"],
    ["ai_connections", "connector_key"],
  ] as const) {
    const { data, error } = await db.from(table).select(col).eq("profile_id", me.id);
    if (!error) return [...new Set((data ?? []).map((r) => String((r as Record<string, unknown>)[col] ?? "").toLowerCase()).filter(Boolean))];
  }
  return [];
}
