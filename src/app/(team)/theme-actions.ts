"use server";

import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type Theme = "system" | "dark" | "light";

/** Saves the person's light/dark choice on their profile, so it follows them to their other devices. */
export async function saveTheme(theme: Theme) {
  const me = await requireStaff();
  if (!["system", "dark", "light"].includes(theme)) return;
  await createAdminClient().from("profiles").update({ theme }).eq("id", me.id);
}
