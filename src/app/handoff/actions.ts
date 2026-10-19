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
