"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Someone on the creative team read a client's Brand Bible: this version is reviewed for them (it leaves their list).
 * The Head of Creative's review also marks the Bible itself reviewed, as the button on the Bible does.
 */
export async function markBibleReviewed(clientId: string, version: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("brand_bible_reviews").upsert({ client_id: clientId, version, profile_id: me.id }, { onConflict: "client_id,version,profile_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: "Couldn't mark it reviewed. Try again." };
  if (me.role === "head_of_creative")
    await db.from("client_brand_bibles").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId).eq("version", version).neq("status", "building");
  // Its notice is done with too
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).eq("key", `bible-review:${clientId}:${version}`).is("read_at", null);
  revalidatePath("/pipeline");
  return { ok: true };
}

/** A reminder or task asked of an agent is done: it leaves the person's list (their own session: only their own) */
export async function markAskDone(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("agent_asks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", id).eq("owner_id", me.id);
  if (error) return { ok: false, error: "Couldn't mark it done. Try again." };
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).eq("key", `agent-ask:${id}`).is("read_at", null);
  revalidatePath("/pipeline");
  return { ok: true };
}

/** One item of a checklist reminder ticked or unticked (their own session: only their own); all ticked marks it done */
export async function tickAskItem(id: string, index: number, done: boolean): Promise<{ ok: true; allDone: boolean } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { data, error } = await db.from("agent_asks").select("checklist").eq("id", id).eq("owner_id", me.id).maybeSingle();
  if (error || !data) return { ok: false, error: "That reminder isn't there any more." };
  const { cleanItems, tickItem } = await import("@/lib/agent-call/ask-rules");
  const items = tickItem(cleanItems(data.checklist), index, done);
  const allDone = items.length > 0 && items.every((i) => i.done);
  const { error: e } = await db
    .from("agent_asks")
    .update({ checklist: items, ...(allDone ? { status: "done", done_at: new Date().toISOString() } : {}) })
    .eq("id", id)
    .eq("owner_id", me.id);
  if (e) return { ok: false, error: "Couldn't save that. Try again." };
  if (allDone) revalidatePath("/pipeline");
  return { ok: true, allDone };
}

/** One line of a follow-ups card ticked or unticked: a checklist item, or a plain reminder or task as its own line */
export async function tickAskGroupItem(id: string, index: number | null, done: boolean): Promise<{ ok: true; allDone: boolean } | { ok: false; error: string }> {
  if (index !== null) return tickAskItem(id, index, done);
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db
    .from("agent_asks")
    .update(done ? { status: "done", done_at: new Date().toISOString() } : { status: "open", done_at: null })
    .eq("id", id)
    .eq("owner_id", me.id);
  if (error) return { ok: false, error: "Couldn't save that. Try again." };
  return { ok: true, allDone: false };
}

/** Every follow-up on a card done at once (their own session: only their own) */
export async function markAsksDone(ids: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const list = ids.map(String).slice(0, 60);
  if (!list.length) return { ok: true };
  const { error } = await db.from("agent_asks").update({ status: "done", done_at: new Date().toISOString() }).in("id", list).eq("owner_id", me.id);
  if (error) return { ok: false, error: "Couldn't mark them done. Try again." };
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).in("key", list.map((i) => `agent-ask:${i}`)).is("read_at", null);
  revalidatePath("/pipeline");
  return { ok: true };
}

/**
 * Reminders or tasks no longer needed: removed from the person's list (their own session: only their own). They're set
 * aside (dismissed), not done, so nobody hears it was handled; the agents and the recap stop counting them.
 */
export async function removeAsks(ids: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const list = ids.map(String).slice(0, 60);
  if (!list.length) return { ok: true };
  const { error } = await db.from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString() }).in("id", list).eq("owner_id", me.id).eq("status", "open");
  if (error) return { ok: false, error: "Couldn't remove it. Try again." };
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).in("key", list.map((i) => `agent-ask:${i}`)).is("read_at", null);
  revalidatePath("/pipeline");
  return { ok: true };
}

/**
 * One line of a follow-ups card removed: a plain reminder or task goes as a whole; a checklist item comes off its list
 * (the last one off removes the reminder, and if everything left is ticked, it's done).
 */
export async function removeAskGroupItem(id: string, text: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (text === null) return removeAsks([id]);
  const me = await requireStaff();
  const db = await createClient();
  const { data, error } = await db.from("agent_asks").select("checklist").eq("id", id).eq("owner_id", me.id).maybeSingle();
  if (error || !data) return { ok: false, error: "That reminder isn't there any more." };
  const { cleanItems, removeItem } = await import("@/lib/agent-call/ask-rules");
  const items = removeItem(cleanItems(data.checklist), text);
  if (!items.length) return removeAsks([id]);
  const allDone = items.every((i) => i.done);
  const { error: e } = await db
    .from("agent_asks")
    .update({ checklist: items, ...(allDone ? { status: "done", done_at: new Date().toISOString() } : {}) })
    .eq("id", id)
    .eq("owner_id", me.id);
  if (e) return { ok: false, error: "Couldn't remove it. Try again." };
  revalidatePath("/pipeline");
  return { ok: true };
}
