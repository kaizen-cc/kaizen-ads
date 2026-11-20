"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { markItem, revalidateDay, snoozeItem } from "@/lib/item-state";
import { delegateItem } from "@/lib/delegate";
import { stableKeyOf } from "@/lib/today-counts";
import { setItem, type ItemSnapshot } from "@/app/today/actions";

// The quick actions every Overview and Today item has, wherever it's drawn (the list view, the cards, the recap):
// Done, Snooze to tomorrow, Delegate and Comment (src/components/item-quick-actions.tsx). Done goes through the recap's
// own setItem, so an item closes the same way from either place.

export type QuickSnap = ItemSnapshot;

/** Done: closed for this person (and for everyone, when it's their own message or promise) */
export async function doneQuickItem(key: string, snap: QuickSnap) {
  return setItem(key, "done", snap);
}

/** Snooze to tomorrow: gone from this person's day until tomorrow, then back on its own */
export async function snoozeQuickItem(key: string, snap: QuickSnap): Promise<{ ok: true; until: string }> {
  const me = await requireStaff();
  const until = await snoozeItem(await createClient(), me.id, key, snap);
  return { ok: true, until };
}

/**
 * Delegate: a task for the teammate (Next for me, a bell notice), tied back to the item by its stable key. It leaves the
 * delegator's day at once and stays with the new owner only.
 */
export async function delegateQuickItem(input: { key: string; snap: QuickSnap; to: string; note?: string; due?: string; href?: string | null }): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  if (input.snap.clientId) {
    const { data } = await db.from("clients").select("id").eq("id", input.snap.clientId).maybeSingle();
    if (!data) return { ok: false, error: "You can't see that client." };
  }
  const title = [input.snap.client, input.snap.title].filter(Boolean).join(": ") || "An item from my day";
  const r = await delegateItem(createAdminClient(), { id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec }, { ref: `item:${stableKeyOf(input.key)}`.slice(0, 200), clientId: input.snap.clientId, title, to: input.to, note: input.note ?? null, due: input.due ?? null, why: null });
  if (!r.ok) return r;
  await markItem(db, me.id, input.key, "dismissed", input.snap, { label: `Delegated to ${r.to}: ${title}`.slice(0, 300), href: input.href ?? null });
  return { ok: true, to: r.to };
}

/** The Overview's layout, kept on the person's profile so it follows them to every device */
export async function setOverviewLayout(layout: "cards" | "list") {
  const me = await requireStaff();
  if (layout !== "cards" && layout !== "list") return;
  await createAdminClient().from("profiles").update({ overview_layout: layout }).eq("id", me.id);
  revalidateDay();
}
