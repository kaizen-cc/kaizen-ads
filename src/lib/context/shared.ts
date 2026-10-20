import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ContextItem = {
  client_id: string;
  source: "slack_internal" | "slack_external" | "gmail" | "drive" | "call";
  external_id: string;
  thread_id: string | null;
  occurred_at: string;
  author: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  meta: Record<string, unknown>;
};

export type CollectResult = { items: ContextItem[]; notes?: Record<string, unknown> };

/** "Crust Pizza Co." → "crustpizzaco", for matching channels and folders to clients. */
export const compact = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

/** Keep enough of a message to be useful without storing whole email chains. */
export const trimBody = (s: string | null | undefined, max = 3000) => {
  if (!s) return null;
  const clean = s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

export async function saveItems(admin: SupabaseClient, items: ContextItem[]) {
  // The same message can arrive twice in one read (a thread reply also sent to the channel); keep the last
  const unique = [...new Map(items.map((i) => [`${i.source}|${i.external_id}`, i])).values()];
  for (let i = 0; i < unique.length; i += 500) {
    const { error } = await admin.from("context_items").upsert(unique.slice(i, i + 500), { onConflict: "source,external_id" });
    if (error) throw new Error(`Saving context: ${error.message}`);
  }
}

export async function getCursor(admin: SupabaseClient, source: string, fallbackDays = 30) {
  const { data } = await admin.from("sync_state").select("cursor_at").eq("source", source).maybeSingle();
  return data?.cursor_at ? new Date(data.cursor_at) : new Date(Date.now() - fallbackDays * 86_400_000);
}

export async function setCursor(admin: SupabaseClient, source: string, cursor: Date, result: Record<string, unknown>) {
  await admin.from("sync_state").upsert({ source, cursor_at: cursor.toISOString(), last_run_at: new Date().toISOString(), last_result: result });
}

/** Something to remember about a client: prefer (do this), avoid (don't) or note (a fact to know). */
/** dated: true as of the source's date (a period's results, an event, a promotion), kept as background, not a rule */
export type Lesson = { kind: "prefer" | "avoid" | "note"; body: string; dated?: boolean };

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
/** Mostly the same words as something already remembered: the same lesson again (a re-read, a client repeating themselves). */
function known(body: string, memory: string[]) {
  const a = words(body);
  return memory.some((m) => {
    const b = words(m);
    const both = [...a].filter((w) => b.has(w)).length;
    return both / Math.max(1, Math.min(a.size, b.size)) > 0.7;
  });
}

/** Lessons from a call or a document into the client's memory, skipping ones it already holds. */
export async function rememberLessons(admin: SupabaseClient, clientId: string, lessons: Lesson[], source: "call" | "drive", at: string) {
  const fresh = lessons.map((l) => ({ ...l, body: l.body.trim().slice(0, 1000) })).filter((l) => l.body);
  if (!fresh.length) return 0;
  const { data: memory } = await admin.from("client_memory").select("body").eq("client_id", clientId).eq("status", "active").limit(200);
  const held = (memory ?? []).map((m) => m.body as string);
  const add: Lesson[] = [];
  for (const l of fresh.slice(0, 6)) if (!known(l.body, [...held, ...add.map((x) => x.body)])) add.push(l);
  if (add.length) await admin.from("client_memory").insert(add.map((l) => ({ client_id: clientId, kind: l.kind, body: l.body, source, created_at: at, dated: l.dated ? at.slice(0, 10) : null })));
  return add.length;
}
