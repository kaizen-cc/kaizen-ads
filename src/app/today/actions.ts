"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ItemSnapshot = { topic: string; client: string; title: string; clientId: string | null };
type Status = "seen" | "saved" | "done" | "dismissed";

/**
 * What this person did with an item in their recap. Seen never overwrites saved, done or dismissed (a card coming
 * back into view doesn't undo a choice); the other three always win.
 */
export async function setItem(key: string, status: Status, snap: ItemSnapshot) {
  const me = await requireStaff();
  const db = await createClient();
  const now = new Date().toISOString();
  const { data: cur } = await db.from("daily_items").select("status").eq("profile_id", me.id).eq("key", key).maybeSingle();
  if (cur && status === "seen") return;
  // Unsaving puts it back to plain seen
  const next: Status = status === "saved" && cur?.status === "saved" ? "seen" : status;
  await db.from("daily_items").upsert(
    {
      profile_id: me.id,
      key,
      topic: snap.topic,
      client_id: snap.clientId,
      snapshot: { client: snap.client, title: snap.title, topic: snap.topic },
      status: next,
      ...(next === "saved" ? { saved_at: now } : {}),
      ...(next === "done" ? { done_at: now } : {}),
      updated_at: now,
    },
    { onConflict: "profile_id,key" },
  );
  revalidatePath("/pipeline");
  return next;
}

/** A "taken care of" card has been read: it doesn't come back. */
export async function acknowledge(key: string) {
  const me = await requireStaff();
  const db = await createClient();
  await db.from("daily_items").update({ status: "done", done_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("profile_id", me.id).eq("key", key);
}
