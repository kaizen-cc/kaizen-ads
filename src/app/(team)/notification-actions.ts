"use server";

import { requireStaff } from "@/lib/auth";
import { loadNotifications } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";

/** The bell: the latest notifications and how many are unread (only the person's own, by the access rules). */
export async function myNotifications() {
  await requireStaff();
  return loadNotifications(await createClient());
}

/** Read one, or all of them. */
export async function markRead(id?: string) {
  const me = await requireStaff();
  const db = await createClient();
  let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).is("read_at", null);
  if (id) q = q.eq("id", id);
  await q;
}
