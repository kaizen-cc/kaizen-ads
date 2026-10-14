import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ContextItem = {
  client_id: string;
  source: "slack_internal" | "slack_external" | "gmail" | "drive";
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
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await admin.from("context_items").upsert(items.slice(i, i + 500), { onConflict: "source,external_id" });
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
