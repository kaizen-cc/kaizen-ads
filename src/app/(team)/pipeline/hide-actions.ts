"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** Clears something off this person's Overview: done or dismissed, for them only. It stays for everyone else. */
export async function hideForMe(key: string, how: "done" | "dismissed", label?: string, href?: string | null) {
  const me = await requireStaff();
  const db = await createClient();
  await db.from("hidden_items").upsert({ profile_id: me.id, key: key.slice(0, 200), how, label: label?.slice(0, 300) ?? null, href: href ?? null, hidden_at: new Date().toISOString() }, { onConflict: "profile_id,key" });
  revalidatePath("/pipeline");
}

/** Puts it back */
export async function unhideForMe(key: string) {
  const me = await requireStaff();
  const db = await createClient();
  await db.from("hidden_items").delete().eq("profile_id", me.id).eq("key", key);
  revalidatePath("/pipeline");
}
