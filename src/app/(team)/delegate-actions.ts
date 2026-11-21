"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { delegateItem, loadDelegates } from "@/lib/delegate";

/** The people the picker offers for an item's client (by the person's own role) */
export async function delegateOptions(clientId: string | null): Promise<{ id: string; name: string; role: string; onClient: boolean }[]> {
  const me = await requireStaff();
  return loadDelegates(createAdminClient(), { id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec }, clientId);
}

/** Delegates a Next for me item ("promise:<id>") to a teammate, with an optional note and due date */
export async function delegateNextItem(input: { ref: string; clientId: string | null; title: string; to: string; note?: string; due?: string }): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  // Only an item the person can see (their own session reads it)
  if (input.clientId) {
    const db = await createClient();
    const { data } = await db.from("clients").select("id").eq("id", input.clientId).maybeSingle();
    if (!data) return { ok: false, error: "You can't see that client." };
  }
  const r = await delegateItem(createAdminClient(), { id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec }, { ...input, why: null });
  if (!r.ok) return r;
  revalidatePath("/pipeline");
  return { ok: true, to: r.to };
}

/**
 * One line of a follow-ups card (a checklist line, "ask:<id>#<n>", or a plain reminder, "ask:<id>") delegated to a
 * teammate: only that line goes, the rest stay, so each line can go to someone different (issue #99)
 */
export async function delegateAskLine(input: { askId: string; line: number | null; title: string; to: string; note?: string; due?: string }): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { handedItem } = await import("@/lib/handover");
  const h = await handedItem(db, me.id, input.line === null ? `ask:${input.askId}` : `ask:${input.askId}#${input.line}`);
  if (!h) return { ok: false, error: "That reminder isn't there any more." };
  const admin = createAdminClient();
  const r = await delegateItem(admin, { id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec }, { ref: h.ref, clientId: h.clientId ?? null, title: h.title ?? input.title, to: input.to, note: input.note ?? null, due: input.due ?? null, why: null });
  if (!r.ok) return r;
  await h.clear(admin, r.to);
  revalidatePath("/pipeline");
  return { ok: true, to: r.to };
}
