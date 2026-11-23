import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMemory } from "@/lib/assistant/memory";
import { memoryForPrompt } from "@/lib/assistant/core";
import { memoryPrompt, type PastCall, type PastThread } from "./memory-core";

// The memory block for one Kaizen AI turn (src/lib/kaizen-ai/memory-core.ts): this person's own memory, and with a
// client pinned, their own other chats and calls about that client. Every read is the person's own rows (profile_id),
// so one person's chats never reach another's.

export async function memoryBlock(admin: SupabaseClient, me: { id: string }, client: { id: string; name: string } | null, threadId: string | null): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [rows, threads, calls] = await Promise.all([
    loadMemory(admin, me.id).catch(() => []),
    client ? pastThreads(admin, me.id, client.id, threadId) : Promise.resolve([] as PastThread[]),
    client ? pastCalls(admin, me.id) : Promise.resolve([] as PastCall[]),
  ]);
  return memoryPrompt({ personal: memoryForPrompt(rows, today), client: client?.name ?? null, threads, calls });
}

/** Their other chats about this client: the title and the last answer's opening, newest first */
async function pastThreads(admin: SupabaseClient, profileId: string, clientId: string, current: string | null): Promise<PastThread[]> {
  let q = admin.from("ai_threads").select("id, title, last_message_at").eq("profile_id", profileId).eq("client_id", clientId).is("archived_at", null).order("last_message_at", { ascending: false }).limit(9);
  if (current) q = q.neq("id", current);
  const { data } = await q;
  const list = (data ?? []).slice(0, 8);
  if (!list.length) return [];
  const gists = await Promise.all(
    list.map(async (t) => {
      const { data: m } = await admin.from("ai_messages").select("content").eq("thread_id", t.id as string).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle();
      return String(m?.content ?? "").replace(/\s+/g, " ").trim();
    }),
  );
  return list.map((t, i) => ({ title: String(t.title ?? "Untitled chat"), at: String(t.last_message_at ?? ""), gist: gists[i] })).filter((t) => t.gist);
}

/** Their recent calls with a summary (only the parts about this client are kept, in memoryPrompt) */
async function pastCalls(admin: SupabaseClient, profileId: string): Promise<PastCall[]> {
  const { data } = await admin.from("ai_role_calls").select("started_at, summary").eq("profile_id", profileId).not("summary", "is", null).order("started_at", { ascending: false }).limit(30);
  return (data ?? []).map((c) => ({ at: String(c.started_at ?? ""), summary: String(c.summary ?? "") }));
}
