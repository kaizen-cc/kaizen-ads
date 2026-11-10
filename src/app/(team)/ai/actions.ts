"use server";

import { requireStaff } from "@/lib/auth";
import { isChatAgent } from "@/lib/kaizen-ai/agents";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { kindOf, MAX_BYTES, MAX_FILES, type AiModel, type ChatMessage, type Thread } from "@/lib/kaizen-ai/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Kaizen AI's threads, files and saved prompts. Reads go through the person's own session (row-level security: their
// threads, and threads a teammate shared with them, read only); writes check it's their own thread first.

type Ok<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const THREAD_COLS = "id, title, client_id, client_confirmed, agent_key, model, pinned, shared_with, last_message_at, profile_id, source, import_id, created_at, clients(name, slug)";

export async function listThreads(): Promise<Thread[]> {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("ai_threads").select(THREAD_COLS).is("archived_at", null).eq("source_complete", true).order("last_message_at", { ascending: false }).limit(1500);
  return (data ?? []) as unknown as Thread[];
}

/** The most messages shown when a thread opens (the newest; a long imported chat says how many came before) */
const SHOWN_MESSAGES = 400;

export async function loadThread(id: string): Promise<{ thread: Thread; messages: ChatMessage[]; owner: string | null; urls: Record<string, string>; earlier: number; notes: { name: string; chars: number }[] } | null> {
  const me = await requireStaff();
  const db = await createClient();
  const [{ data: t }, { data: m }, { count }] = await Promise.all([
    db.from("ai_threads").select(`${THREAD_COLS}, notes`).eq("id", id).maybeSingle(),
    db.from("ai_messages").select("id, role, content, attachments, tools, cards, agent_key, model, error, stopped, created_at").eq("thread_id", id).order("created_at", { ascending: false }).limit(SHOWN_MESSAGES),
    db.from("ai_messages").select("id", { count: "exact", head: true }).eq("thread_id", id),
  ]);
  if (!t) return null;
  const messages = ((m ?? []) as unknown as ChatMessage[]).reverse();
  const earlier = Math.max(0, (count ?? messages.length) - messages.length);
  const notes = (Array.isArray((t as { notes?: unknown }).notes) ? ((t as { notes: { name?: string; text?: string }[] }).notes) : []).map((n) => ({ name: String(n?.name ?? "Document"), chars: String(n?.text ?? "").length }));
  // Pictures in the thread, shown from short-lived links
  const paths = messages.flatMap((x) => (x.attachments ?? []).flatMap((a) => (a.kind === "image" ? [a.path] : a.kind === "video" && a.frames?.[0] ? [a.frames[0].path] : [])));
  const urls: Record<string, string> = {};
  if (paths.length) {
    const { data: signed } = await createAdminClient().storage.from(AI_BUCKET).createSignedUrls(paths.slice(0, 200), 3600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
  }
  let owner: string | null = null;
  if ((t as unknown as Thread).profile_id !== me.id) {
    const { data: p } = await createAdminClient().from("profiles").select("full_name").eq("id", (t as unknown as Thread).profile_id).maybeSingle();
    owner = (p?.full_name as string | undefined) ?? "A teammate";
  }
  const { notes: _notes, ...thread } = t as unknown as Thread & { notes?: unknown };
  void _notes;
  return { thread, messages, owner, urls, earlier, notes };
}

async function mine(id: string) {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("ai_threads").select("id").eq("id", id).eq("profile_id", me.id).maybeSingle();
  return data ? { me, db } : null;
}

export async function updateThread(id: string, patch: { title?: string; pinned?: boolean; model?: AiModel; agent?: string | null; clientId?: string | null; confirmClient?: boolean; archived?: boolean }): Promise<Ok> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not your thread." };
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.title === "string" && patch.title.trim()) row.title = patch.title.trim().slice(0, 120);
  if (typeof patch.pinned === "boolean") row.pinned = patch.pinned;
  if (patch.model === "opus" || patch.model === "sonnet") row.model = patch.model;
  if (patch.agent !== undefined) row.agent_key = isChatAgent(patch.agent) ? patch.agent : null;
  if (patch.clientId !== undefined) {
    if (patch.clientId) {
      const { data: c } = await ok.db.from("clients").select("id").eq("id", patch.clientId).maybeSingle();
      if (!c) return { ok: false, error: "You can't see that client." };
    }
    row.client_id = patch.clientId;
    row.client_confirmed = Boolean(patch.clientId);
  }
  if (patch.confirmClient) row.client_confirmed = true;
  if (patch.archived) row.archived_at = new Date().toISOString();
  const { error } = await ok.db.from("ai_threads").update(row).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Share a thread read only with teammates (replaces the list) */
export async function shareThread(id: string, profileIds: string[]): Promise<Ok> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not your thread." };
  // Chats imported from Claude stay private to the person who imported them
  const { data: src } = await ok.db.from("ai_threads").select("source").eq("id", id).maybeSingle();
  if (src?.source) return { ok: false, error: "Chats imported from Claude stay private to you." };
  const ids = [...new Set(profileIds.filter((p) => /^[0-9a-f-]{36}$/.test(p) && p !== ok.me.id))].slice(0, 30);
  const { error } = await ok.db.from("ai_threads").update({ shared_with: ids, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (ids.length) {
    const { data: t } = await ok.db.from("ai_threads").select("title").eq("id", id).single();
    await createAdminClient()
      .from("notifications")
      .upsert(
        ids.map((p) => ({ profile_id: p, kind: "ai", title: `${ok.me.fullName.split(" ")[0]} shared a Kaizen AI thread with you`, body: String(t?.title ?? ""), href: `/ai?t=${id}`, key: `ai-share:${id}`, priority: "normal" })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      )
      .then(({ error: e }) => e && console.error("[kaizen ai] share notice", e.message));
  }
  return { ok: true };
}

export async function teammates(): Promise<{ id: string; name: string; role: string }[]> {
  const me = await requireStaff();
  const { data } = await createAdminClient().from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name");
  return (data ?? []).filter((p) => p.id !== me.id).map((p) => ({ id: p.id as string, name: p.full_name as string, role: p.role as string }));
}

export async function pickableClients(): Promise<{ id: string; name: string; slug: string }[]> {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).order("name").limit(1000);
  return (data ?? []) as { id: string; name: string; slug: string }[];
}

/**
 * Which client each imported Claude chat is about, for the ones no client name in the title or opening settled: the AI
 * reads each one's title and how it starts and picks the client from the list, or none (personal, internal, not about
 * one client). Up to 120 chats a call; only the person's own chats are sent, and nothing is kept.
 */
export async function matchImportClients(chats: { id: string; title: string; opening: string }[]): Promise<Record<string, string>> {
  await requireStaff();
  const { aiEnabled, askJson } = await import("@/lib/ai");
  if (!aiEnabled() || !chats.length) return {};
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name, industry, website").is("archived_at", null).order("name").limit(1000);
  const clients = (data ?? []) as { id: string; name: string; industry: string | null; website: string | null }[];
  if (!clients.length) return {};
  const list = clients.map((c, i) => `C${i + 1} · ${c.name}${c.industry ? ` · ${c.industry}` : ""}${c.website ? ` · ${c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")}` : ""}`).join("\n");
  const batch = chats.slice(0, 120);
  try {
    const out = await askJson<{ matches: { chat: number; client: string }[] }>({
      agent: "review",
      label: "claude import client match",
      bare: true,
      override: { model: "haiku", effort: "low" },
      maxTokens: 4000,
      schema: { type: "object", properties: { matches: { type: "array", items: { type: "object", properties: { chat: { type: "number" }, client: { type: "string" } }, required: ["chat", "client"], additionalProperties: false } } }, required: ["matches"], additionalProperties: false },
      system:
        "You sort a marketing agency team member's past AI chats by the agency client each one is about. For each chat, pick the client from the list when the chat is clearly about that client's business (their ads, brand, products, reports, creative, website, offer), even when the client is named differently (spacing, abbreviation, a product or location of theirs). Answer the client's code (C12). Use \"\" when it's about no single client: personal matters, the agency itself, tools and code, general questions, or when you're unsure. Never guess.",
      prompt: `<clients>\n${list}\n</clients>\n\n<chats>\n${batch.map((c, i) => `${i + 1}. ${c.title.slice(0, 160)}${c.opening ? ` :: ${c.opening.replace(/\s+/g, " ").slice(0, 280)}` : ""}`).join("\n")}\n</chats>\n\nmatches: one entry per chat you can place (chat: its number, client: the code).`,
    });
    const res: Record<string, string> = {};
    for (const m of out.matches ?? []) {
      const chat = batch[Math.round(m.chat) - 1];
      const n = Number(String(m.client).replace(/\D/g, ""));
      const c = n >= 1 ? clients[n - 1] : null;
      if (chat && c) res[chat.id] = c.id;
    }
    return res;
  } catch {
    return {};
  }
}

/** Upload links for files the browser sends straight to storage (in the person's own folder) */
export async function uploadSlots(files: { name: string; mime: string; bytes: number; role?: "file" | "frame" | "audio" }[]): Promise<Ok<{ slots: { path: string; token: string }[] }>> {
  const me = await requireStaff();
  if (!files.length) return { ok: true, slots: [] };
  if (files.filter((f) => (f.role ?? "file") === "file").length > MAX_FILES) return { ok: false, error: `Up to ${MAX_FILES} files at a time.` };
  if (files.length > 420) return { ok: false, error: "Too many pieces." };
  const admin = createAdminClient();
  const batch = crypto.randomUUID();
  const slots: { path: string; token: string }[] = [];
  for (const [i, f] of files.entries()) {
    const role = f.role ?? "file";
    if (role === "file") {
      const kind = kindOf(f.mime, f.name);
      if (!kind) return { ok: false, error: `${f.name}: pictures, PDFs, Word, Excel, PowerPoint, CSV, text and video only.` };
      if (f.bytes > MAX_BYTES[kind]) return { ok: false, error: `${f.name} is too big (up to ${Math.round(MAX_BYTES[kind] / 1_000_000)} MB for this kind).` };
    }
    const safe = f.name.replace(/[^\w.-]+/g, "-").slice(-80) || "file";
    const path = `${me.id}/${batch}/${role === "file" ? "" : `${role}-`}${String(i).padStart(3, "0")}-${safe}`;
    const { data, error } = await admin.storage.from(AI_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Couldn't get the upload ready. Try again." };
    slots.push({ path: data.path, token: data.token });
  }
  return { ok: true, slots };
}

// ─── Imported from Claude ────────────────────────────────────────────────────

export type ClaudeImport = { id: string; fileName: string | null; created: number; skipped: number; threads: number; status: string; createdAt: string };

/** What the person already imported (Claude conversation ids, so they're skipped) and their imports */
export async function claudeImportState(): Promise<{ imported: string[]; projects: string[]; imports: ClaudeImport[] }> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: imps } = await db.from("ai_imports").select("id, file_name, created, skipped, status, created_at").eq("profile_id", me.id).order("created_at", { ascending: false }).limit(20);
  // Page by page (a read returns at most 1,000 rows)
  const rows: { source_id: string; import_id: string | null }[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data } = await db.from("ai_threads").select("source_id, import_id").eq("profile_id", me.id).eq("source", "claude").eq("source_complete", true).order("id").range(from, from + 999);
    rows.push(...((data ?? []) as typeof rows));
    if ((data?.length ?? 0) < 1000) break;
  }
  const per = new Map<string, number>();
  for (const r of rows) if (r.import_id) per.set(r.import_id as string, (per.get(r.import_id as string) ?? 0) + 1);
  // Claude projects already made into Kaizen AI projects (none before the projects migration is applied)
  const { data: projs } = await db.from("ai_projects").select("source_id").eq("created_by", me.id).eq("source", "claude").limit(2000);
  return {
    imported: rows.map((r) => String(r.source_id)),
    projects: (projs ?? []).map((p) => String(p.source_id)),
    imports: (imps ?? []).filter((i) => i.file_name !== NO_IMPORT).map((i) => ({ id: i.id as string, fileName: (i.file_name as string | null) ?? null, created: Number(i.created) || 0, skipped: Number(i.skipped) || 0, threads: per.get(i.id as string) ?? 0, status: String(i.status), createdAt: String(i.created_at) })),
  };
}

/** The marker an "I don't have Claude chats" leaves (an empty, finished import), so Kaizen AI stops asking */
const NO_IMPORT = "__no_claude_chats__";

/** Whether the person still has to bring their Claude chats over (or say they have none) before their first chat */
export async function needsClaudeImport(): Promise<boolean> {
  const me = await requireStaff();
  const db = await createClient();
  const { count } = await db.from("ai_imports").select("id", { count: "exact", head: true }).eq("profile_id", me.id);
  return !count;
}

/** "I don't have Claude chats to bring": recorded once, so the import step doesn't come back */
export async function skipClaudeImport(): Promise<Ok> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("ai_imports").insert({ profile_id: me.id, file_name: NO_IMPORT, conversations: 0, status: "done", finished_at: new Date().toISOString() });
  return error ? { ok: false, error: "Couldn't save that. Try again." } : { ok: true };
}

export async function startClaudeImport(fileName: string, conversations: number): Promise<Ok<{ id: string }>> {
  const me = await requireStaff();
  const db = await createClient();
  const { data, error } = await db.from("ai_imports").insert({ profile_id: me.id, file_name: fileName.slice(0, 200), conversations: Math.max(0, Math.round(conversations) || 0) }).select("id").single();
  return error || !data ? { ok: false, error: "Couldn't start the import." } : { ok: true, id: data.id as string };
}

export async function finishClaudeImport(id: string): Promise<Ok> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("ai_imports").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", id).eq("profile_id", me.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Delete a chat imported from Claude for good (its messages go with it) */
export async function deleteImportedThread(id: string): Promise<Ok> {
  const me = await requireStaff();
  const db = await createClient();
  const { data, error } = await db.from("ai_threads").delete().eq("id", id).eq("profile_id", me.id).not("source", "is", null).select("id");
  if (error) return { ok: false, error: error.message };
  return data?.length ? { ok: true } : { ok: false, error: "Only chats you imported can be deleted." };
}

/** Delete a whole import: every chat it brought in */
export async function deleteClaudeImport(id: string): Promise<Ok<{ threads: number }>> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: gone } = await db.from("ai_threads").delete().eq("import_id", id).eq("profile_id", me.id).select("id");
  const { error } = await db.from("ai_imports").delete().eq("id", id).eq("profile_id", me.id);
  return error ? { ok: false, error: error.message } : { ok: true, threads: gone?.length ?? 0 };
}

// ─── Saved prompts ───────────────────────────────────────────────────────────

export type Template = { id: string; title: string; prompt: string; shared: boolean; mine: boolean; uses: number; by: string | null };

export async function listTemplates(): Promise<Template[]> {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("ai_templates").select("id, title, prompt, shared, uses, profile_id, profiles(full_name)").order("uses", { ascending: false }).limit(200);
  return (data ?? []).map((t) => ({ id: t.id as string, title: t.title as string, prompt: t.prompt as string, shared: Boolean(t.shared), uses: Number(t.uses) || 0, mine: t.profile_id === me.id, by: (t.profiles as unknown as { full_name: string } | null)?.full_name ?? null }));
}

export async function saveTemplate(t: { id?: string; title: string; prompt: string; shared: boolean }): Promise<Ok<{ id: string }>> {
  const me = await requireStaff();
  const title = t.title.trim().slice(0, 80);
  const prompt = t.prompt.trim().slice(0, 8000);
  if (!title || !prompt) return { ok: false, error: "Give it a name and the prompt." };
  const db = await createClient();
  const row = { title, prompt, shared: Boolean(t.shared), updated_at: new Date().toISOString() };
  const { data, error } = t.id ? await db.from("ai_templates").update(row).eq("id", t.id).eq("profile_id", me.id).select("id").single() : await db.from("ai_templates").insert({ ...row, profile_id: me.id }).select("id").single();
  return error || !data ? { ok: false, error: error?.message ?? "Couldn't save it." } : { ok: true, id: data.id as string };
}

export async function deleteTemplate(id: string): Promise<Ok> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("ai_templates").delete().eq("id", id).eq("profile_id", me.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function usedTemplate(id: string) {
  await requireStaff();
  const admin = createAdminClient();
  const { data } = await admin.from("ai_templates").select("uses").eq("id", id).maybeSingle();
  if (data) await admin.from("ai_templates").update({ uses: (Number(data.uses) || 0) + 1 }).eq("id", id);
}
