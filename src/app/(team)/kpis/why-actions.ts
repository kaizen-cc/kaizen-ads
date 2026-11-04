"use server";

import { requireStaff } from "@/lib/auth";
import { askWhy, whyItem, whyThread, type WhyKind, type WhyMessage } from "@/lib/audit-why";
import { canRebut, saveRebuttal } from "@/lib/audit-rebuttals";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The "Why?" chat on audit items and sprint moves (team only). Every read checks the item with the viewer's own
// access first, so only someone who can see the audit can ask about it.

const KINDS: WhyKind[] = ["account", "business", "sprint"];
const KEY = /^(verdict|budget|(action|cause|watchout|test|creative):\d{1,3}|channel:[a-z]{2,20}|task)$/;

function valid(kind: string, auditId: string, itemKey: string) {
  return KINDS.includes(kind as WhyKind) && /^[0-9a-f-]{36}$/.test(auditId) && KEY.test(itemKey);
}

/** The item's thread, and whether this person may teach the agent */
export async function loadWhy(kind: WhyKind, auditId: string, itemKey: string): Promise<{ ok: true; messages: WhyMessage[]; canTeach: boolean } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!valid(kind, auditId, itemKey)) return { ok: false, error: "Not found." };
  const db = await createClient();
  if (!(await whyItem(db, kind, auditId, itemKey))) return { ok: false, error: "Not found." };
  const [messages, teach] = await Promise.all([whyThread(db, auditId, itemKey), adminConfigured() ? canRebut(createAdminClient(), me.id) : Promise.resolve(false)]);
  return { ok: true, messages, canTeach: teach };
}

/** Ask the agent that wrote the item */
export async function askWhyAction(kind: WhyKind, auditId: string, itemKey: string, question: string): Promise<{ ok: true; answer: WhyMessage } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!valid(kind, auditId, itemKey)) return { ok: false, error: "Not found." };
  if (!question.trim()) return { ok: false, error: "Ask a question first." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const item = await whyItem(await createClient(), kind, auditId, itemKey);
  if (!item) return { ok: false, error: "Not found." };
  try {
    const r = await askWhy(createAdminClient(), { kind, auditId, itemKey, item, question, by: me.id });
    return { ok: true, answer: { id: r.answerId ?? `local-${Date.now()}`, role: "agent", body: r.answer, by: null, at: r.at, lesson: r.lesson, taught: false } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The agent couldn't answer. Try again." };
  }
}

/**
 * "Teach the agent this": the lesson the agent drew from someone's pushback, saved through the audit pushback loop
 * (kept on the audit, in client memory, and as a conditional learning the next audits read). Only people given the
 * pushback permission can teach.
 */
export async function teachWhy(messageId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  if (!(await canRebut(admin, me.id))) return { ok: false, error: "Only the people given the audit pushback permission can teach the agent." };
  const db = await createClient();
  const { data: m } = await db.from("audit_item_messages").select("id, audit_kind, audit_id, item_key, role, lesson, taught_at, created_at").eq("id", messageId).maybeSingle();
  if (!m || m.role !== "agent" || !m.lesson) return { ok: false, error: "Nothing to teach on this answer." };
  if (m.taught_at) return { ok: true };
  const item = await whyItem(db, m.audit_kind as WhyKind, m.audit_id as string, m.item_key as string);
  if (!item?.teach) return { ok: false, error: "This move didn't come from an audit, so there's no audit to teach." };
  // The person's own words, the last thing they said before this answer
  const { data: said } = await db.from("audit_item_messages").select("body").eq("audit_id", m.audit_id).eq("item_key", m.item_key).eq("role", "person").lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(1).maybeSingle();
  try {
    await saveRebuttal(admin, {
      clientId: item.clientId,
      kind: item.teach.kind,
      auditId: item.teach.auditId,
      itemKey: item.teach.itemKey,
      finding: item.teach.finding,
      reason: `${m.lesson}${said?.body ? ` (from the Why chat: "${String(said.body).slice(0, 600)}")` : ""}`,
      by: me.id,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
  await admin.from("audit_item_messages").update({ taught_at: new Date().toISOString(), taught_by: me.id }).eq("id", m.id);
  return { ok: true };
}
