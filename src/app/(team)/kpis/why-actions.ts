"use server";

import { requireStaff } from "@/lib/auth";
import { askWhy, whyItem, whyThread, type WhyKind, type WhyMessage } from "@/lib/audit-why";
import { mayRebut, saveDeployLesson, saveRebuttal } from "@/lib/audit-rebuttals";
import { whoCanTeach } from "@/lib/rebut-permission";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The "Why?" chat on audit items, sprint moves and Google idea plans (team only). Every read checks the item with the
// viewer's own access first, so only someone who can see the audit can ask about it. Anyone who can see it can ask;
// teaching the agent is for the people allowed to push back on that item's platform (src/lib/rebut-permission.ts).

const KINDS: WhyKind[] = ["account", "business", "sprint", "deploy"];
const KEY = /^(verdict|budget|(action|cause|watchout|test|creative):\d{1,3}|channel:[a-z]{2,20}|task|plan)$/;

function valid(kind: string, auditId: string, itemKey: string) {
  return KINDS.includes(kind as WhyKind) && /^[0-9a-f-]{36}$/.test(auditId) && KEY.test(itemKey);
}

/** The item's thread, whether this person may teach the agent, and who can when they can't */
export async function loadWhy(kind: WhyKind, auditId: string, itemKey: string): Promise<{ ok: true; messages: WhyMessage[]; canTeach: boolean; whoTeaches: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!valid(kind, auditId, itemKey)) return { ok: false, error: "Not found." };
  const db = await createClient();
  const item = await whyItem(db, kind, auditId, itemKey);
  if (!item) return { ok: false, error: "Not found." };
  const [messages, teach] = await Promise.all([whyThread(db, auditId, itemKey), adminConfigured() ? mayRebut(createAdminClient(), me.id, item.platform) : Promise.resolve(false)]);
  return { ok: true, messages, canTeach: teach, whoTeaches: whoCanTeach(item.platform) };
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
 * (kept on the audit, in client memory, and as a conditional learning the next audits read; a Google item teaches the
 * Google auditor, a Google idea plan the Google launcher). Only the people allowed to push back on the item's platform
 * can teach: the permission, or the Head of Google on a Google item and the Head of Meta on a Meta one.
 */
export async function teachWhy(messageId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const db = await createClient();
  const { data: m } = await db.from("audit_item_messages").select("id, audit_kind, audit_id, item_key, role, lesson, taught_at, created_at").eq("id", messageId).maybeSingle();
  if (!m || m.role !== "agent" || !m.lesson) return { ok: false, error: "Nothing to teach on this answer." };
  const item = await whyItem(db, m.audit_kind as WhyKind, m.audit_id as string, m.item_key as string);
  if (!item) return { ok: false, error: "Not found." };
  if (!(await mayRebut(admin, me.id, item.platform))) return { ok: false, error: whoCanTeach(item.platform) };
  if (m.taught_at) return { ok: true };
  if (!item.teach) return { ok: false, error: "This move didn't come from an audit, so there's no audit to teach." };
  // The person's own words, the last thing they said before this answer
  const { data: said } = await db.from("audit_item_messages").select("body").eq("audit_id", m.audit_id).eq("item_key", m.item_key).eq("role", "person").lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const reason = `${m.lesson}${said?.body ? ` (from the Why chat: "${String(said.body).slice(0, 600)}")` : ""}`;
  try {
    if (item.teach.kind === "deploy") await saveDeployLesson(admin, { clientId: item.clientId, messageId: m.id as string, finding: item.teach.finding, reason, by: me.id });
    else
      await saveRebuttal(admin, {
        clientId: item.clientId,
        kind: item.teach.kind,
        auditId: item.teach.auditId,
        itemKey: item.teach.itemKey,
        finding: item.teach.finding,
        reason,
        by: me.id,
        platform: item.platform,
      });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
  await admin.from("audit_item_messages").update({ taught_at: new Date().toISOString(), taught_by: me.id }).eq("id", m.id);
  return { ok: true };
}
