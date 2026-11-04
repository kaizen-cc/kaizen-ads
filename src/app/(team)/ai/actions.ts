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

const THREAD_COLS = "id, title, client_id, client_confirmed, agent_key, model, pinned, shared_with, last_message_at, profile_id, clients(name, slug)";

export async function listThreads(): Promise<Thread[]> {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("ai_threads").select(THREAD_COLS).is("archived_at", null).order("last_message_at", { ascending: false }).limit(300);
  return (data ?? []) as unknown as Thread[];
}

export async function loadThread(id: string): Promise<{ thread: Thread; messages: ChatMessage[]; owner: string | null; urls: Record<string, string> } | null> {
  const me = await requireStaff();
  const db = await createClient();
  const [{ data: t }, { data: m }] = await Promise.all([
    db.from("ai_threads").select(THREAD_COLS).eq("id", id).maybeSingle(),
    db.from("ai_messages").select("id, role, content, attachments, tools, cards, agent_key, model, error, stopped, created_at").eq("thread_id", id).order("created_at").limit(400),
  ]);
  if (!t) return null;
  const messages = (m ?? []) as unknown as ChatMessage[];
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
  return { thread: t as unknown as Thread, messages, owner, urls };
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
