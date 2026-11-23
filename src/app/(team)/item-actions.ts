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

// ─── Items are living tasks (owner, Nov 23 2026): one owner, a due date, transfers (src/lib/item-owners.ts) ───

type TaskSnap = QuickSnap & { href?: string | null; story?: string | null; clientSlug?: string | null };

const snapOf = (s: TaskSnap) => ({ topic: s.topic as import("@/lib/today").TopicKey, client: s.client || null, clientId: s.clientId, clientSlug: s.clientSlug ?? null, title: s.title, story: s.story ?? "", href: s.href ?? null });

/** Transfer owner: the item moves to the teammate, leaves this person's day, shows on theirs, and it's logged */
export async function transferQuickItem(input: { key: string; snap: TaskSnap; to: string; note?: string }): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (input.to === me.id) return { ok: false, error: "It's already yours." };
  const { transferItem } = await import("@/lib/item-owners");
  const r = await transferItem(createAdminClient(), { id: me.id, name: me.fullName }, { key: input.key, to: input.to, snapshot: snapOf(input.snap), note: input.note ?? null });
  if (r.ok) revalidateDay();
  return r;
}

/** Change due date: kept on the item, and the ladder's clock counts from it */
export async function dueQuickItem(input: { key: string; snap: TaskSnap; due: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) return { ok: false, error: "Pick a date." };
  const { setItemDue } = await import("@/lib/item-owners");
  const r = await setItemDue(createAdminClient(), { id: me.id }, { key: input.key, due: input.due, snapshot: snapOf(input.snap) });
  if (r.ok) revalidateDay();
  return r;
}

/** A lead takes over a teammate's stuck item (from their linked "lead:<item>"): the original is transferred to them */
export async function takeOverQuickItem(leadKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  const itemKey = leadKey.replace(/^lead:/, "");
  const admin = createAdminClient();
  const { data: n } = await admin.from("ladder_nudges").select("item_key, client_id, client_name, what, href, lead_id, client:clients(slug)").eq("item_key", itemKey).eq("lead_id", me.id).in("status", ["open", "sent"]).maybeSingle();
  if (!n) return { ok: false, error: "That isn't stuck with your team any more." };
  const c = n.client as unknown as { slug: string | null } | null;
  const { transferItem } = await import("@/lib/item-owners");
  const r = await transferItem(admin, { id: me.id, name: me.fullName }, { key: itemKey, to: me.id, snapshot: { topic: "mine", client: (n.client_name as string | null) ?? null, clientId: (n.client_id as string | null) ?? null, clientSlug: c?.slug ?? null, title: String(n.what).replace(/^./, (x) => x.toUpperCase()), story: "You took it over from your team", href: (n.href as string | null) ?? null } });
  if (!r.ok) return r;
  revalidateDay();
  return { ok: true };
}
