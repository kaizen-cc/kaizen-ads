"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

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
  // A message marked done (handled another way) or set aside as not needing a reply stops being chased (only the
  // person it's on can do that)
  if ((next === "dismissed" || next === "done") && /^owed2?:/.test(key)) await closeOwed(key.split(":")[1], me.id, next === "done" ? "done" : "not_needed");
  if (next === "dismissed" && /^said2?:/.test(key)) await closeSaid(key.split(":")[1], me.id, "done");
  revalidatePath("/pipeline");
  return next;
}

/** "Doesn't need a reply" from the Overview: the message stops being watched, and nobody above them is told. */
export async function dismissOwed(id: string) {
  const me = await requireStaff();
  await closeOwed(id, me.id, "not_needed");
}

/** "Done" from the Overview: handled another way (a call, in person); anyone it went up to hears it's taken care of. */
export async function doneOwed(id: string) {
  const me = await requireStaff();
  await closeOwed(id, me.id, "done");
}

/** The reply drafted for a message waiting on you (from the thread as it is now; `fresh` writes a new one). */
export async function draftReply(id: string, fresh = false): Promise<{ ok: true; draft: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not available here." };
  const admin = createAdminClient();
  const { data: o } = await admin.from("owed_replies").select("target_id").eq("id", id).maybeSingle();
  if (!o || o.target_id !== me.id) return { ok: false, error: "Only the person it's waiting on can draft the reply." };
  const { draftOwedReply } = await import("@/lib/reply-drafts");
  return draftOwedReply(admin, id, { force: fresh });
}

/** Sends your reply in the Slack thread, as you, and closes it (anyone it went up to hears it's answered). */
export async function sendReply(id: string, text: string): Promise<{ ok: true } | { ok: false; error: string; needsConnect?: boolean }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not available here." };
  const body = text.trim();
  if (!body) return { ok: false, error: "Write the reply first." };
  const admin = createAdminClient();
  const { data: o } = await admin.from("owed_replies").select("target_id, source, channel_id, thread_ts, message_ts, status").eq("id", id).maybeSingle();
  if (!o || o.target_id !== me.id) return { ok: false, error: "Only the person it's waiting on can answer it from here." };
  if (o.source !== "slack" || !o.channel_id) return { ok: false, error: "Emails are answered in Gmail: copy the draft and open the email." };
  const { postAsUser } = await import("@/lib/slack-user");
  const sent = await postAsUser(me.id, { channel: o.channel_id as string, text: body.slice(0, 3900), thread: ((o.thread_ts as string | null) ?? (o.message_ts as string)) || undefined });
  if (!sent.ok) return sent;
  const { markReplied } = await import("@/lib/owed-replies");
  await markReplied(admin, id, me.id);
  await admin.from("owed_replies").update({ draft: body.slice(0, 4000) }).eq("id", id);
  revalidatePath("/pipeline");
  return { ok: true };
}

async function closeOwed(id: string, meId: string, how: "done" | "not_needed") {
  if (!adminConfigured()) return;
  const { closeByHand } = await import("@/lib/owed-replies");
  await closeByHand(createAdminClient(), id, meId, how);
  revalidatePath("/pipeline");
}

/** A promise from Slack or email closed by the person who made it: done, or not happening after all. */
export async function closeSaidPromise(id: string, how: "done" | "dropped") {
  const me = await requireStaff();
  await closeSaid(id, me.id, how);
}

async function closeSaid(id: string, meId: string, how: "done" | "dropped") {
  if (!adminConfigured()) return;
  const now = new Date().toISOString();
  const admin = createAdminClient();
  await admin
    .from("message_promises")
    .update(how === "done" ? { status: "done", evidence: "Marked done by them", closed_at: now } : { status: "dismissed", dismissed_by: meId, dismiss_reason: "Not needed any more", closed_at: now })
    .eq("id", id)
    .eq("owner_id", meId)
    .in("status", ["open", "overdue", "escalated"]);
  await admin.from("notifications").update({ cleared_at: now }).in("key", [`said:${id}`, `said2:${id}`]).eq("profile_id", meId).is("cleared_at", null);
  revalidatePath("/pipeline");
}

/** A "taken care of" card has been read: it doesn't come back. */
export async function acknowledge(key: string) {
  const me = await requireStaff();
  const db = await createClient();
  await db.from("daily_items").update({ status: "done", done_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("profile_id", me.id).eq("key", key);
}
