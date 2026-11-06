import { requireStaff } from "@/lib/auth";
import { foreignItems, IMPORT_SOURCE, MAX_FILE_CHARS, MAX_MESSAGE_CHARS, MAX_NOTES_CHARS, type ImportItem } from "@/lib/kaizen-ai/claude-import";
import type { Attachment } from "@/lib/kaizen-ai/types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Kaizen AI's import from Claude, one batch of conversations at a time (the browser read the export and sends what
// the person picked, in requests well under the host's size limit). Each conversation becomes the person's own
// private thread, its messages at their original times; one already imported is skipped. A long conversation comes
// in parts: the first creates the thread, the rest add to it, the last marks it complete (an interrupted one is redone).
export const maxDuration = 120;

type Result = { uuid: string; status: "created" | "appended" | "skipped" | "failed"; threadId?: string; error?: string };

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
  const existing = new Map((existingRows ?? []).map((r) => [r.source_id as string, r as { id: string; source_complete: boolean; import_id: string | null }]));

  const results: Result[] = [];
  let created = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const it of items) {
    const sid = sourceId(it);
    if (!sid) continue;
    try {
      const had = existing.get(sid);
      let threadId: string;
      if ((Number(it.part) || 0) === 0) {
        if (had?.source_complete) {
          skipped++;
          results.push({ uuid: it.uuid, status: "skipped", threadId: had.id });
          continue;
        }
        // Started before and cut off: redone from the start
        if (had) await admin.from("ai_threads").delete().eq("id", had.id).eq("profile_id", me.id);
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
            last_message_at: updatedAt,
            created_at: createdAt,
            updated_at: now,
          })
          .select("id")
          .single();
        if (error || !t) throw new Error(error?.message ?? "Couldn't create the thread");
        threadId = t.id as string;
        existing.set(sid, { id: threadId, source_complete: false, import_id: imp.id as string });
        created++;
      } else {
        if (!had || had.source_complete || had.import_id !== imp.id) {
          results.push({ uuid: it.uuid, status: "skipped" });
          continue;
        }
        threadId = had.id;
      }
      const rows = (Array.isArray(it.messages) ? it.messages : []).slice(0, 5000).flatMap((m) => {
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
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await admin.from("ai_messages").insert(rows.slice(i, i + 200));
        if (error) throw new Error(error.message);
      }
      if (it.last) await admin.from("ai_threads").update({ source_complete: true }).eq("id", threadId);
      results.push({ uuid: it.uuid, status: Number(it.part) > 0 ? "appended" : "created", threadId });
    } catch (e) {
      console.error("[kaizen ai import]", e instanceof Error ? e.message : e);
      results.push({ uuid: it.uuid, status: "failed", error: "Couldn't import this one." });
    }
  }
  if (created || skipped) await admin.from("ai_imports").update({ created: (Number(imp.created) || 0) + created, skipped: (Number(imp.skipped) || 0) + skipped }).eq("id", imp.id);
  return Response.json({ results });
}

function sourceId(it: ImportItem) {
  const id = clean(it?.uuid, 100);
  if (!id) return "";
  return it.kind === "project" ? (id.startsWith("project:") ? id : `project:${id}`) : id;
}
