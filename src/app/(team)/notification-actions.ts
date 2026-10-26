"use server";

import { requireStaff } from "@/lib/auth";
import { loadNotifications, withDefaults, type NoticePrefs } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";

/**
 * The bell: the latest notifications, how many are unread, and whether critical ones should pop up. It checks every
 * minute, so it never redirects: signed out (an expired session, the design preview) it just comes back empty, and
 * the access rules keep each person to their own rows.
 */
export async function myNotifications() {
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  if (!claims?.claims) return { items: [], unread: 0, popups: false };
  const [list, { data: prefs }] = await Promise.all([loadNotifications(db), db.from("notification_prefs").select("settings").maybeSingle()]);
  return { ...list, popups: withDefaults(prefs?.settings).popups };
}

/** Read one, or all of them. */
export async function markRead(id?: string) {
  const me = await requireStaff();
  const db = await createClient();
  let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).is("read_at", null);
  if (id) q = q.eq("id", id);
  await q;
}

/** Clears notifications off the bell: the ones given, or all of them. They stay on record (cleared_at), so "Undo"
 *  brings them back. Clearing also counts as reading. */
export async function clearNotices(ids?: string[]) {
  const me = await requireStaff();
  const db = await createClient();
  const now = new Date().toISOString();
  let q = db.from("notifications").update({ cleared_at: now }).eq("profile_id", me.id).is("cleared_at", null);
  if (ids) q = q.in("id", ids);
  const { data } = await q.select("id, read_at");
  const fresh = (data ?? []).filter((n) => !n.read_at).map((n) => n.id as string);
  if (fresh.length) await db.from("notifications").update({ read_at: now }).in("id", fresh);
  return (data ?? []).map((n) => n.id as string);
}

/** Puts cleared notifications back on the bell (the Undo after clearing). */
export async function restoreNotices(ids: string[]) {
  const me = await requireStaff();
  if (!ids.length) return;
  await (await createClient()).from("notifications").update({ cleared_at: null }).eq("profile_id", me.id).in("id", ids);
}

/** Saves this person's notification settings (each change saves as it's made). */
export async function saveNoticePrefs(settings: NoticePrefs): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const clean = withDefaults(settings);
  const { error } = await (await createClient()).from("notification_prefs").upsert({ profile_id: me.id, settings: clean, updated_at: new Date().toISOString() }, { onConflict: "profile_id" });
  return error ? { ok: false, error: error.message } : { ok: true };
}
