import { requireStaff } from "@/lib/auth";
import { foreignItems, IMPORT_SOURCE, MAX_FILE_CHARS, MAX_MESSAGE_CHARS, MAX_NOTES_CHARS, type ImportItem } from "@/lib/kaizen-ai/claude-import";
import { importProject, projectsForChats, projectsReady } from "@/lib/kaizen-ai/projects-server";
import type { Attachment } from "@/lib/kaizen-ai/types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Kaizen AI's import from Claude, one batch of conversations at a time (the browser read the export and sends what
// the person picked, in requests well under the host's size limit). Each conversation becomes the person's own
// private thread, its messages at their original times; one already imported is skipped. A long conversation comes
// in parts: the first creates the thread, the rest add to it, the last marks it complete (an interrupted one is redone).
export const maxDuration = 120;

type Result = { uuid: string; status: "created" | "appended" | "filled" | "skipped" | "failed"; threadId?: string; error?: string; added?: number };

const UUID = /^[0-9a-f-]{36}$/;
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");
const isoOr = (s: unknown, fallback: string) => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : fallback);

export async function POST(request: Request) {
  const me = await requireStaff();
  if (!adminConfigured()) return Response.json({ error: "Not set up" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { importId?: string; items?: ImportItem[]; sourceAccount?: unknown } | null;
  if (!body || typeof body.importId !== "string" || !UUID.test(body.importId) || !Array.isArray(body.items)) return Response.json({ error: "Nothing to import." }, { status: 400 });
  // The Claude account these are from: when declared, every item that names its account must be that one (the browser
  // only sends the person's own chats from an organization's export; this turns away anything else)
  if (body.sourceAccount != null) {
    if (typeof body.sourceAccount !== "string" || !body.sourceAccount.trim()) return Response.json({ error: "Nothing to import." }, { status: 400 });
    if (foreignItems(body.items, body.sourceAccount)) return Response.json({ error: "Some of these chats are from someone else's Claude account. Only your own can be imported." }, { status: 400 });
  }
  const db = await createClient();
  const admin = createAdminClient();
  // The import is theirs
  const { data: imp } = await db.from("ai_imports").select("id, created, skipped").eq("id", body.importId).eq("profile_id", me.id).maybeSingle();
  if (!imp) return Response.json({ error: "That import isn't yours." }, { status: 403 });

  const items = body.items.slice(0, 60);
  // Clients they picked, among the clients they can see
  const asked = [...new Set(items.map((i) => i.clientId).filter((c): c is string => typeof c === "string" && UUID.test(c)))];
  const visible = new Set<string>();
  if (asked.length) {
    const { data } = await db.from("clients").select("id").in("id", asked);
    for (const c of data ?? []) visible.add(c.id as string);
  }
  const sourceIds = [...new Set(items.map((i) => sourceId(i)).filter(Boolean))];
  const { data: existingRows } = sourceIds.length
    ? await admin.from("ai_threads").select("id, source_id, source_complete, import_id").eq("profile_id", me.id).eq("source", IMPORT_SOURCE).in("source_id", sourceIds)
    : { data: [] };
  type Had = { id: string; source_complete: boolean; import_id: string | null; source_project?: string | null; project_id?: string | null };
  const existing = new Map((existingRows ?? []).map((r) => [r.source_id as string, r as Had]));
  // The projects columns, when the migration is in (read apart so an older database still imports)
  if (existingRows?.length) {
    const { data: links, error: linkErr } = await admin.from("ai_threads").select("id, source_project, project_id").in("id", existingRows.map((r) => r.id as string));
    if (!linkErr) for (const l of links ?? []) for (const h of existing.values()) if (h.id === l.id) Object.assign(h, { source_project: l.source_project ?? null, project_id: l.project_id ?? null });
  }

  const results: Result[] = [];
  let created = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  // Projects (once the projects migration is in): a project item makes the Kaizen AI project; a chat from a Claude
  // project goes inside the Kaizen AI project made from it, when there is one the person can see
  const withProjects = await projectsReady(db);
  for (const it of items) {
    if (it?.kind !== "project" || !withProjects) continue;
    try {
      const r = await importProject(admin, me, imp.id as string, it, it.clientId && visible.has(it.clientId) ? it.clientId : null);
      if (r.status === "created") created++;
      else if (r.status === "skipped") skipped++;
      results.push({ uuid: it.uuid, status: r.status, ...(r.error ? { error: r.error } : {}) });
    } catch (e) {
      console.error("[kaizen ai import] project", e instanceof Error ? e.message : e);
      results.push({ uuid: it.uuid, status: "failed", error: "Couldn't import this project." });
    }
  }
  const inProject = withProjects ? await projectsForChats(db, me.id, [...new Set(items.flatMap((i) => (i?.kind !== "project" && typeof i?.projectUuid === "string" && i.projectUuid ? [i.projectUuid.slice(0, 100)] : [])))]) : new Map<string, string>();
  for (const it of items) {
    const sid = sourceId(it);
    if (!sid) continue;
    if (it.kind === "project") {
      // Before the projects migration: nothing to make yet (offered again next time)
      if (!withProjects) results.push({ uuid: it.uuid, status: "skipped" });
      continue;
    }
    try {
      const had = existing.get(sid);
      const claudeProject = withProjects && typeof it.projectUuid === "string" && it.projectUuid ? it.projectUuid.slice(0, 100) : null;
      let threadId: string;
      // Already here (imported before, or an earlier part of this one): only what's missing is added, never a copy
      let have: Set<number> | null = null;
      if (had) {
        threadId = had.id;
        have = await messageTimes(admin, threadId);
        // A chat imported before its project came over: put inside it now
        if (claudeProject && (!had.source_project || !had.project_id)) {
          const link = { source_project: claudeProject, ...(!had.project_id && inProject.get(claudeProject) ? { project_id: inProject.get(claudeProject) } : {}) };
          await admin.from("ai_threads").update(link).eq("id", threadId);
          Object.assign(had, link);
        }
      } else {
        const createdAt = isoOr(it.createdAt, now);
        const updatedAt = isoOr(it.updatedAt, createdAt);
        let room = MAX_NOTES_CHARS;
        const notes = (Array.isArray(it.notes) ? it.notes : []).slice(0, 60).flatMap((d) => {
          const text = clean(d?.text, room);
          room -= text.length;
          return text ? [{ name: clean(d?.name, 200) || "Document", text }] : [];
        });
        const clientId = it.clientId && visible.has(it.clientId) ? it.clientId : null;
        const { data: t, error } = await admin
          .from("ai_threads")
          .insert({
            profile_id: me.id,
            title: clean(it.title, 120).trim() || "Imported chat",
            client_id: clientId,
            client_confirmed: Boolean(clientId),
            model: "opus",
            source: IMPORT_SOURCE,
            source_id: sid,
            import_id: imp.id,
            source_complete: false,
            notes,
            ...(claudeProject ? { source_project: claudeProject, project_id: inProject.get(claudeProject) ?? null } : {}),
            last_message_at: updatedAt,
            created_at: createdAt,
            updated_at: now,
          })
          .select("id")
          .single();
        if (error || !t) throw new Error(error?.message ?? "Couldn't create the thread");
        threadId = t.id as string;
        existing.set(sid, { id: threadId, source_complete: false, import_id: imp.id as string, source_project: claudeProject, project_id: claudeProject ? (inProject.get(claudeProject) ?? null) : null });
        created++;
      }
      const all = (Array.isArray(it.messages) ? it.messages : []).slice(0, 5000).flatMap((m) => {
        const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
        if (!role) return [];
        const attachments: Attachment[] = (Array.isArray(m.files) ? m.files : []).slice(0, 20).map((f) => {
          const name = clean(f?.name, 200) || "attachment";
          const text = typeof f?.text === "string" ? f.text.slice(0, MAX_FILE_CHARS + 100) : null;
          return { path: "", name, mime: "text/plain", bytes: text?.length ?? 0, kind: "text", text, imported: true, note: text ? null : "Only the file's name came with the Claude export" };
        });
        const content = clean(m.text, MAX_MESSAGE_CHARS + 100);
        if (!content && !attachments.length) return [];
        return [{ thread_id: threadId, role, content, attachments, created_at: isoOr(m.at, now), ...(role === "assistant" ? { model: "claude" } : {}) }];
      });
      // Each message is known by its original time (kept unique and in order by the reader)
      const rows = have ? all.filter((r) => !have.has(Date.parse(r.created_at))) : all;
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await admin.from("ai_messages").insert(rows.slice(i, i + 200));
        if (error) throw new Error(error.message);
      }
      if (it.last && !had?.source_complete) {
        await admin.from("ai_threads").update({ source_complete: true }).eq("id", threadId);
        if (had) had.source_complete = true;
      }
      if (had && rows.length) {
        const newest = rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), "");
        await admin.from("ai_threads").update({ last_message_at: newest }).eq("id", threadId).lt("last_message_at", newest);
      }
      if (had && Number(it.part) === 0 && !rows.length) skipped++;
      const status: Result["status"] = !had ? "created" : rows.length ? (Number(it.part) > 0 ? "appended" : "filled") : "skipped";
      results.push({ uuid: it.uuid, status, threadId, ...(rows.length ? { added: rows.length } : {}) });
    } catch (e) {
      console.error("[kaizen ai import]", e instanceof Error ? e.message : e);
      results.push({ uuid: it.uuid, status: "failed", error: "Couldn't import this one." });
    }
  }
  if (created || skipped) await admin.from("ai_imports").update({ created: (Number(imp.created) || 0) + created, skipped: (Number(imp.skipped) || 0) + skipped }).eq("id", imp.id);
  return Response.json({ results });
}

/** The original times of a thread's messages (page by page: a read returns at most 1,000 rows) */
async function messageTimes(admin: ReturnType<typeof createAdminClient>, threadId: string) {
  const out = new Set<number>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await admin.from("ai_messages").select("created_at").eq("thread_id", threadId).order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.add(Date.parse(String(r.created_at)));
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

function sourceId(it: ImportItem) {
  const id = clean(it?.uuid, 100);
  if (!id) return "";
  return it.kind === "project" ? (id.startsWith("project:") ? id : `project:${id}`) : id;
}
