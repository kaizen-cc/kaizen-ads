import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { cache } from "react";
import { loadToday, type Today } from "@/lib/today";
import { applyMarks, withLooks } from "@/lib/today-counts";

// The daily review, kept per person per day. Built once (the first visit of the day, with its loading moment), then
// shown instantly on every visit after (a refresh, signing in again) while it's rebuilt in the background; what changed
// since the last build (handled, new) is noted so the Overview can say so.

export type Delta = { handled: number; added: number; at: string };
export type Snapshot = { today: Today; delta: Delta | null; computedAt: string };

/** Today in New York, as a date (the review's day) */
export const reviewDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Items no longer on anyone's day ("ask for fresh footage" was retired) dropped from a review saved before, counts redone */
const RETIRED = ["assets:"];
const current = (t: Today): Today => {
  const items = (t.items ?? []).filter((i) => !RETIRED.some((k) => i.key.startsWith(k)));
  return items.length === (t.items ?? []).length ? t : { ...t, items, looks: undefined as unknown as Today["looks"] };
};

export async function readSnapshot(db: SupabaseClient, me: Staff): Promise<Snapshot | null> {
  // The saved review, and what this person has done since in either place (the recap's marks and what they cleared off
  // the Overview), so a Done in one shows in the other at once rather than at the next rebuild
  const [{ data }, { data: marks }, { data: hidden }] = await Promise.all([
    db.from("today_snapshots").select("data, delta, computed_at").eq("profile_id", me.id).eq("day", reviewDay()).maybeSingle(),
    db.from("daily_items").select("key, status").eq("profile_id", me.id).in("status", ["saved", "done", "dismissed"]),
    db.from("hidden_items").select("key").eq("profile_id", me.id),
  ]);
  const markOf = new Map((marks ?? []).map((m) => [m.key as string, m.status as string]));
  const hiddenKeys = new Set((hidden ?? []).map((h) => h.key as string));
  // A review saved before the counts were kept on it gets them worked out from its items
  return data ? { today: applyMarks(withLooks(current(data.data as Today)), markOf, hiddenKeys), delta: (data.delta as Delta | null) ?? null, computedAt: data.computed_at as string } : null;
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

/**
 * Today's review for this request: the saved one, else built now. Shared by everything on the page that shows its
 * numbers (the "Your day" card and the theme cards), so they read one review and agree, and it's built at most once.
 */
export const todaySnapshot = cache(async (db: SupabaseClient, me: Staff): Promise<Snapshot> => (await readSnapshot(db, me)) ?? (await buildSnapshot(db, me, null)));
