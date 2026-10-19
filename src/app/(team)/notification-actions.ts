"use server";

import { requireStaff } from "@/lib/auth";
import { loadNotifications, withDefaults, type NoticePrefs } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";

/** The bell: the latest notifications, how many are unread, and whether critical ones should pop up. */
export async function myNotifications() {
  const me = await requireStaff();
  const db = await createClient();
  const [list, { data: prefs }] = await Promise.all([loadNotifications(db), db.from("notification_prefs").select("settings").eq("profile_id", me.id).maybeSingle()]);
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

/** Saves this person's notification settings (each change saves as it's made). */
export async function saveNoticePrefs(settings: NoticePrefs): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const clean = withDefaults(settings);
  const { error } = await (await createClient()).from("notification_prefs").upsert({ profile_id: me.id, settings: clean, updated_at: new Date().toISOString() }, { onConflict: "profile_id" });
  return error ? { ok: false, error: error.message } : { ok: true };
}
