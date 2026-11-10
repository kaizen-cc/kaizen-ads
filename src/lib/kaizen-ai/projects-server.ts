import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { officeText } from "@/lib/client-docs";
import { MAX_INSTRUCTIONS_CHARS, MAX_NOTES_CHARS, type ImportItem } from "./claude-import";
import { AI_BUCKET } from "./files";
import { fitKnowledge, isVisibility, projectBlock, type MemberRole, type ProjectVisibility } from "./projects";

// Kaizen AI projects on the server: what a chat in a project reads (its instructions and knowledge, read through the
// person's own session so row-level security decides whether they may), the text read from a knowledge file, and a
// Claude project brought over by the import.

/** The most text kept from one knowledge file */
export const MAX_DOC_CHARS = 400_000;

/** Whether the projects tables exist yet (the migration may not be applied): checked once per server */
let ready: boolean | null = null;
export async function projectsReady(db: SupabaseClient) {
  if (ready) return true;
  const { error } = await db.from("ai_projects").select("id", { head: true, count: "exact" }).limit(1);
  ready = !error;
  return ready;
}

/** A thread's project, when it has one (null before the migration, or when the person can no longer see it) */
export async function threadProjectId(db: SupabaseClient, threadId: string): Promise<string | null> {
  const { data, error } = await db.from("ai_threads").select("project_id").eq("id", threadId).maybeSingle();
  if (error) return null;
  return (data?.project_id as string | null | undefined) ?? null;
}

export type ProjectForChat = { id: string; name: string; client_id: string | null };

/** The project as the person can see it (row-level security: null when they can't) */
export async function visibleProject(db: SupabaseClient, id: string): Promise<ProjectForChat | null> {
  const { data, error } = await db.from("ai_projects").select("id, name, client_id").eq("id", id).is("archived_at", null).maybeSingle();
  if (error || !data) return null;
  return data as ProjectForChat;
}

/** The project's description, instructions and knowledge fitted to this message, as the block the chat reads */
export async function projectContext(db: SupabaseClient, id: string, query: string): Promise<{ block: string; name: string } | null> {
  const [{ data: p }, { data: docs }] = await Promise.all([
    db.from("ai_projects").select("name, description, instructions").eq("id", id).maybeSingle(),
    db.from("ai_project_docs").select("name, text").eq("project_id", id).order("created_at").limit(500),
  ]);
  if (!p) return null;
  const fit = fitKnowledge((docs ?? []) as { name: string; text: string | null }[], query);
  const block = projectBlock({ name: String(p.name), description: String(p.description ?? ""), instructions: String(p.instructions ?? "") }, fit);
  return { block, name: String(p.name) };
}

// ─── Reading a knowledge file ──────────────────────────────────────────────

/** The text in an uploaded knowledge file: PDFs, Word, PowerPoint, Excel, CSV, Markdown, JSON and text */
export async function readKnowledgeFile(admin: SupabaseClient, f: { path: string; name: string; mime: string }): Promise<{ text: string | null; note: string | null }> {
  const { data } = await admin.storage.from(AI_BUCKET).download(f.path);
  if (!data) return { text: null, note: "The file didn't arrive. Add it again." };
  const buf = Buffer.from(await data.arrayBuffer());
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  let text: string | null = null;
  if (f.mime === "application/pdf" || ext === "pdf") {
    const { pdfPages } = await import("@/lib/knowledge");
    const pages = await pdfPages(buf);
    text = pages ? pages.map((t, i) => (t ? `[page ${i + 1}]\n${t}` : "")).filter(Boolean).join("\n\n") : null;
    if (!text?.trim()) return { text: null, note: "No text could be read from this PDF (it may be a scan). Add a version with text, or paste what matters as a text doc." };
  } else if (ext === "docx" || ext === "pptx" || ext === "xlsx") text = officeText(buf, ext);
  else if (f.mime.startsWith("text/") || ["txt", "md", "csv", "tsv", "json", "html", "htm"].includes(ext)) {
    const raw = buf.toString("utf8");
    text = ext.startsWith("htm") ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ") : raw;
  } else return { text: null, note: "Only PDFs, Word, PowerPoint, Excel, CSV and text files are read as knowledge." };
  if (!text?.trim()) return { text: null, note: "No text could be read from it." };
  return text.length > MAX_DOC_CHARS ? { text: text.slice(0, MAX_DOC_CHARS), note: `Only the first ${MAX_DOC_CHARS / 1000}k characters are kept.` } : { text, note: null };
}

// ─── A Claude project, brought over by the import ──────────────────────────

const clean = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

/**
 * A project item from the import: the person's Claude project made into a Kaizen AI project (once: the same Claude
 * project is never made twice for the same person), shared the way the export says (people matched by their Kaizen
 * email; anyone not found is left out, and "specific people" with nobody found stays private), with its docs as
 * knowledge. Then every chat it held is put inside it: the person's own (imported now or before), and teammates'
 * imported chats from the same Claude project when they can see it.
 */
export async function importProject(
  admin: SupabaseClient,
  me: { id: string },
  importId: string,
  it: ImportItem,
  clientId: string | null,
): Promise<{ status: "created" | "skipped" | "failed"; projectId?: string; error?: string }> {
  const sid = clean(it.uuid, 120).replace(/^project:/, "");
  const p = it.project;
  if (!sid || !p) return { status: "failed", error: "Not a project." };
  const { data: had, error: readErr } = await admin.from("ai_projects").select("id, visibility, created_by").eq("created_by", me.id).eq("source", "claude").eq("source_id", sid).maybeSingle();
  if (readErr) return { status: "skipped", error: "Projects aren't set up yet." };
  let projectId = had?.id as string | undefined;
  let visibility: ProjectVisibility = isVisibility(had?.visibility) ? had.visibility : "private";
  let people: string[] = [];
  let created = false;
  if (!projectId) {
    const sharing = p.sharing ?? { visibility: "private", everyoneCanEdit: false, people: [] };
    const emails = [...new Set((Array.isArray(sharing.people) ? sharing.people : []).map((x) => (typeof x?.email === "string" ? x.email.trim().toLowerCase() : "")).filter(Boolean))].slice(0, 200);
    const { data: found } = emails.length ? await admin.from("profiles").select("id, email").in("email", emails).eq("is_active", true) : { data: [] };
    const byEmail = new Map((found ?? []).map((r) => [String(r.email), String(r.id)]));
    const members = new Map<string, MemberRole>();
    for (const x of sharing.people ?? []) {
      const id = x?.email ? byEmail.get(x.email.trim().toLowerCase()) : undefined;
      if (id && id !== me.id) members.set(id, x.role === "editor" || members.get(id) === "editor" ? "editor" : "viewer");
    }
    visibility = isVisibility(sharing.visibility) ? sharing.visibility : "private";
    if (visibility === "people" && !members.size) visibility = "private";
    const { data: row, error } = await admin
      .from("ai_projects")
      .insert({
        created_by: me.id,
        name: clean(p.name, 120).trim() || "Claude project",
        description: clean(p.description, 4000),
        instructions: clean(p.instructions, MAX_INSTRUCTIONS_CHARS + 100),
        client_id: clientId,
        visibility,
        everyone_can_edit: visibility === "everyone" && Boolean(sharing.everyoneCanEdit),
        source: "claude",
        source_id: sid,
        import_id: importId,
      })
      .select("id")
      .single();
    if (error || !row) return { status: "failed", error: "Couldn't create the project." };
    projectId = row.id as string;
    created = true;
    if (members.size) await admin.from("ai_project_members").insert([...members].map(([profile_id, role]) => ({ project_id: projectId, profile_id, role, added_by: me.id })));
    people = [...members.keys()];
    let room = MAX_NOTES_CHARS;
    const docs = (Array.isArray(p.docs) ? p.docs : []).slice(0, 200).flatMap((d) => {
      const text = clean(d?.text, Math.min(room, MAX_DOC_CHARS));
      room -= text.length;
      return text ? [{ project_id: projectId, kind: "text", name: clean(d?.name, 200) || "Document", text, chars: text.length, added_by: me.id, source_id: "claude" }] : [];
    });
    for (let i = 0; i < docs.length; i += 50) await admin.from("ai_project_docs").insert(docs.slice(i, i + 50));
  } else {
    const { data: m } = await admin.from("ai_project_members").select("profile_id").eq("project_id", projectId);
    people = (m ?? []).map((r) => String(r.profile_id));
  }
  // The person's chats from this Claude project, imported now or before
  const chats = [...new Set((Array.isArray(p.chatUuids) ? p.chatUuids : []).map((u) => clean(u, 100)).filter(Boolean))];
  for (let i = 0; i < chats.length; i += 200)
    await admin.from("ai_threads").update({ project_id: projectId, source_project: sid }).eq("profile_id", me.id).eq("source", "claude").in("source_id", chats.slice(i, i + 200)).is("project_id", null);
  // Teammates' chats from the same Claude project, imported before it came over, when they can see it now
  let others = admin.from("ai_threads").update({ project_id: projectId }).eq("source_project", sid).is("project_id", null).neq("profile_id", me.id);
  if (visibility !== "everyone") others = others.in("profile_id", visibility === "people" ? people : []);
  if (visibility === "everyone" || (visibility === "people" && people.length)) await others;
  return { status: created ? "created" : "skipped", projectId };
}

/** The Kaizen AI projects for the Claude projects these chats were in: the person's own first, else one they can see */
export async function projectsForChats(db: SupabaseClient, meId: string, claudeProjects: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!claudeProjects.length) return out;
  const { data } = await db.from("ai_projects").select("id, source_id, created_by").eq("source", "claude").in("source_id", claudeProjects.slice(0, 200));
  for (const r of (data ?? []).sort((a, b) => Number(b.created_by === meId) - Number(a.created_by === meId))) if (!out.has(String(r.source_id))) out.set(String(r.source_id), String(r.id));
  return out;
}
