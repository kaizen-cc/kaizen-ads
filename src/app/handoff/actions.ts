"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { askAboutAccount, writeHandoff, type ChatTurn } from "@/lib/handoff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Only someone who can see the client can use its handoff (the access rules decide). */
async function canSee(id: string) {
  const me = await requireStaff();
  const { data } = await (await createClient()).from("account_handoffs").select("id, to_id").eq("id", id).maybeSingle();
  return data ? { me, h: data } : null;
}

export async function askAccount(id: string, question: string): Promise<Result<{ chat: ChatTurn[] }>> {
  const ok = await canSee(id);
  if (!ok) return { ok: false, error: "Handoff not found." };
  if (!question.trim()) return { ok: false, error: "Ask something first." };
  try {
    return { ok: true, chat: await askAboutAccount(createAdminClient(), id, question, ok.me.fullName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't answer that just now." };
  }
}

export async function rewriteHandoff(id: string): Promise<Result> {
  const ok = await canSee(id);
  if (!ok) return { ok: false, error: "Handoff not found." };
  const admin = createAdminClient();
  await admin.from("account_handoffs").update({ status: "writing", error: null }).eq("id", id);
  after(() => writeHandoff(admin, id));
  revalidatePath(`/handoff/${id}`);
  return { ok: true };
}

/** The new buyer opened it: it comes off their home. */
export async function markHandoffSeen(id: string) {
  const ok = await canSee(id);
  if (!ok || ok.h.to_id !== ok.me.id) return;
  await createAdminClient().from("account_handoffs").update({ seen_at: new Date().toISOString() }).eq("id", id).is("seen_at", null);
}

/** The person handing over ticks off what they've passed on (they, an executive or a line head) */
export async function toggleHandOver(id: string, item: number): Promise<Result<{ done: number[] }>> {
  const ok = await canSee(id);
  if (!ok) return { ok: false, error: "Handoff not found." };
  const admin = createAdminClient();
  const { data } = await admin.from("account_handoffs").select("from_id, checklist").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "Handoff not found." };
  const me = ok.me;
  if (data.from_id !== me.id && !me.isExec && !me.isLead && !String(me.role).startsWith("head_of_")) return { ok: false, error: "Only the person handing over ticks these off." };
  const cur = new Set(((data.checklist ?? []) as unknown[]).map(Number).filter(Number.isInteger));
  if (cur.has(item)) cur.delete(item);
  else cur.add(item);
  const done = [...cur].sort((a, b) => a - b);
  await admin.from("account_handoffs").update({ checklist: done }).eq("id", id);
  revalidatePath(`/handoff/${id}`);
  return { ok: true, done };
}
