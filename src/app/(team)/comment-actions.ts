"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addComment, loadThread, type ItemThread } from "@/lib/item-comments";

// Comments on any Overview or Today item (src/lib/item-comments.ts): read with the person's own session, written as
// them once they're shown to see the client.

export async function itemThread(key: string): Promise<ItemThread> {
  await requireStaff();
  return loadThread(await createClient(), key);
}

export async function commentOnItem(input: { key: string; clientId: string | null; title?: string | null; body?: string; waiting?: boolean | null; dueAt?: string | null; href?: string | null }): Promise<{ ok: true; thread: ItemThread } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  if (input.clientId) {
    const { data } = await db.from("clients").select("id").eq("id", input.clientId).maybeSingle();
    if (!data) return { ok: false, error: "You can't see that client." };
  }
  const r = await addComment(createAdminClient(), { id: me.id, fullName: me.fullName }, input);
  if (!r.ok) return r;
  return { ok: true, thread: await loadThread(db, input.key) };
}
