import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { loadToday, type Today } from "@/lib/today";

// The daily review, kept per person per day. Built once (the first visit of the day, with its loading moment), then
// shown instantly on every visit after (a refresh, signing in again) while it's rebuilt in the background; what changed
// since the last build (handled, new) is noted so the Overview can say so.

export type Delta = { handled: number; added: number; at: string };
export type Snapshot = { today: Today; delta: Delta | null; computedAt: string };

/** Today in New York, as a date (the review's day) */
export const reviewDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function readSnapshot(db: SupabaseClient, me: Staff): Promise<Snapshot | null> {
  const { data } = await db.from("today_snapshots").select("data, delta, computed_at").eq("profile_id", me.id).eq("day", reviewDay()).maybeSingle();
  return data ? { today: data.data as Today, delta: (data.delta as Delta | null) ?? null, computedAt: data.computed_at as string } : null;
}

/** Builds the review now and saves it; changed is true when what's on it differs from the last build today. */
export async function buildSnapshot(db: SupabaseClient, me: Staff, prev?: Snapshot | null): Promise<Snapshot & { changed: boolean }> {
  const before = prev === undefined ? await readSnapshot(db, me) : prev;
  const today = await loadToday(db, me);
  const was = new Set((before?.today.items ?? []).map((i) => i.key));
  const now = new Set(today.items.map((i) => i.key));
  const handled = [...was].filter((k) => !now.has(k)).length;
  const added = [...now].filter((k) => !was.has(k)).length;
  // Changed: items came or went, or one moved tier (a ticket got later, an account went further off target)
  const tierOf = new Map((before?.today.items ?? []).map((i) => [i.key, i.tier]));
  const changed = !before || handled > 0 || added > 0 || today.items.some((i) => tierOf.has(i.key) && tierOf.get(i.key) !== i.tier);
  const at = new Date().toISOString();
  // The note keeps the last real change; the first build of the day has none
  const delta: Delta | null = before && (handled || added) ? { handled, added, at } : (before?.delta ?? null);
  await db.from("today_snapshots").upsert({ profile_id: me.id, day: reviewDay(), data: today, delta, computed_at: at });
  return { today, delta, computedAt: at, changed };
}
