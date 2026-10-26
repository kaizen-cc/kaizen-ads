"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildSnapshot, readSnapshot } from "@/lib/today-snapshot";

/**
 * The Overview, while it's open: rebuild the daily review in the background and say whether anything changed since
 * the version on screen (`shown` is when that one was built). Rebuilt at most every 90 seconds, whoever asks.
 */
export async function refreshToday(shown: string): Promise<{ changed: boolean }> {
  const me = await requireStaff();
  const db = await createClient();
  const prev = await readSnapshot(db, me);
  if (prev && Date.now() - new Date(prev.computedAt).getTime() < 90_000) return { changed: prev.computedAt !== shown };
  const r = await buildSnapshot(db, me, prev);
  return { changed: r.changed };
}
