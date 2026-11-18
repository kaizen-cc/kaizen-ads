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
