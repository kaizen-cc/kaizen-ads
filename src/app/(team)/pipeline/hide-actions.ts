"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { markItem, unmarkItem } from "@/lib/item-state";

/**
 * Clears something off this person's Overview: done or dismissed, for them only. It stays for everyone else. The same
 * mark as the recap's Done or "not for me" (src/lib/item-state.ts), so it leaves their day there too.
 */
export async function hideForMe(key: string, how: "done" | "dismissed", label?: string, href?: string | null) {
  const me = await requireStaff();
  const db = await createClient();
  await markItem(db, me.id, key.slice(0, 200), how, {}, { label, href: href ?? null });
}

/** Puts it back, on the Overview and in their recap */
export async function unhideForMe(key: string) {
  const me = await requireStaff();
  const db = await createClient();
  await unmarkItem(db, me.id, key);
}
