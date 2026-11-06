import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { hideKeyOf, recapKeysOf } from "@/lib/today-counts";
import { reviewDay } from "@/lib/today-snapshot";

// What a person did with one item, in one place, whichever screen they did it on (the daily recap or the Overview's
// theme breakdowns): both read the same two marks. daily_items is the recap's (seen, saved, done, set aside), kept
// under every key the item can have there; hidden_items is the Overview's "cleared off my board", kept for the items
// the Overview has its own Done and Dismiss for. Anything that closes the item for everyone (a reply sent, a brief
// decided) is done by the caller; this records the person's side and has every open review re-checked.

export type MarkStatus = "seen" | "saved" | "done" | "dismissed";
export type MarkSnapshot = { topic?: string; client?: string; title?: string; clientId?: string | null };

/**
 * Marks an item for this person, from either side's key. Seen never overwrites another choice; saving twice unsaves.
 * Done and set aside (dismissed) are kept under all of its recap keys and, where the Overview shows it, as cleared
 * off their board too (how: done or dismissed), so it leaves both at once.
 */
export async function markItem(db: SupabaseClient, meId: string, key: string, status: MarkStatus, snap: MarkSnapshot = {}, overview?: { label?: string; href?: string | null; skip?: boolean }): Promise<MarkStatus> {
  const now = new Date().toISOString();
  const keys = recapKeysOf(key);
  const recapKey = keys.includes(key) ? key : keys[0];
  const { data: cur } = await db.from("daily_items").select("key, status, snapshot, topic, client_id").eq("profile_id", meId).in("key", keys);
  const curOf = new Map((cur ?? []).map((c) => [c.key as string, c]));
  if (status === "seen" && curOf.has(recapKey)) return (curOf.get(recapKey)!.status as MarkStatus) ?? "seen";
  // Unsaving puts it back to plain seen
  const next: MarkStatus = status === "saved" && curOf.get(recapKey)?.status === "saved" ? "seen" : status;
  const row = (k: string) => {
    const c = curOf.get(k);
    const topic = snap.topic ?? (c?.topic as string | undefined) ?? (k.startsWith("attention:") ? "work" : k.startsWith("fatigue:") ? "ads" : k.startsWith("brief:") ? "briefs" : "promises");
    return {
      profile_id: meId,
      key: k,
      topic,
      client_id: snap.clientId ?? (c?.client_id as string | null | undefined) ?? null,
      snapshot: snap.title || snap.client ? { client: snap.client ?? "", title: snap.title ?? "", topic } : ((c?.snapshot as object | null) ?? { topic }),
      status: next,
      ...(next === "saved" ? { saved_at: now } : {}),
      ...(next === "done" ? { done_at: now } : {}),
      updated_at: now,
    };
  };
  // Saved and seen are about the item as the recap shows it; done and set aside close every form of it
  const closing = next === "done" || next === "dismissed";
  await db.from("daily_items").upsert((closing ? keys : [recapKey]).map(row), { onConflict: "profile_id,key" });
  const hide = key.includes(":") && !keys.includes(key) ? key : hideKeyOf(recapKey);
  // skip: the item is closed for everyone already (your own reply or promise), so there's nothing to clear off a board
  if (closing && hide && !overview?.skip) {
    await db.from("hidden_items").upsert(
      { profile_id: meId, key: hide.slice(0, 200), how: next, label: (overview?.label ?? [snap.client, snap.title].filter(Boolean).join(": ")).slice(0, 300) || null, href: overview?.href ?? null, hidden_at: now },
      { onConflict: "profile_id,key" },
    );
  }
  // Seen changes nothing either screen shows; the rest redraw both
  if (next !== "seen" || status !== "seen") revalidateDay();
  return next;
}

/** Puts an item back for this person in both places: off the "cleared" list, and open again in their recap. */
export async function unmarkItem(db: SupabaseClient, meId: string, key: string) {
  const hide = hideKeyOf(recapKeysOf(key)[0]) ?? key;
  await db.from("hidden_items").delete().eq("profile_id", meId).eq("key", hide);
  await db.from("daily_items").update({ status: "seen", updated_at: new Date().toISOString() }).eq("profile_id", meId).in("key", recapKeysOf(key)).in("status", ["done", "dismissed"]);
  revalidateDay();
}

/**
 * Something closed for everyone (a reply sent, a promise done, a brief decided, an ad set aside): every review saved
 * today is due a re-check, so the next look at anyone's Overview or recap rebuilds it rather than waiting its turn.
 */
export async function reviewsChanged() {
  if (adminConfigured()) await createAdminClient().from("today_snapshots").update({ computed_at: new Date(0).toISOString() }).eq("day", reviewDay());
  revalidateDay();
}

export function revalidateDay() {
  revalidatePath("/pipeline");
  revalidatePath("/today");
}
