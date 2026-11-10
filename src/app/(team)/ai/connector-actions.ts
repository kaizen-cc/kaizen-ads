"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { Card } from "@/lib/kaizen-ai/types";

// The composer's connections menu: the connectors offered to the person, whether each is connected, and which are on
// in this thread (remembered per thread). Plus Cancel on a connector confirm card.

export type ChatConnector = { key: string; name: string; icon_url: string | null; note: string | null; auth: string; state: "connected" | "reconnect" | "not_connected" };

export async function chatConnectors(threadId: string | null): Promise<{ items: ChatConnector[]; on: string[] | null }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { items: [], on: null };
  const admin = createAdminClient();
  const { offeredConnectors, myConnections, threadConnectorKeys } = await import("@/lib/connectors/server");
  const [offered, mine] = await Promise.all([offeredConnectors(admin, me), myConnections(admin, me.id)]);
  const items = offered.map((c): ChatConnector => {
    const m = mine.find((x) => x.connector_id === c.id);
    return { key: c.key, name: c.name, icon_url: c.icon_url, note: c.note, auth: c.auth, state: c.auth === "none" ? "connected" : !m ? "not_connected" : m.status === "active" ? "connected" : "reconnect" };
  });
  let on: string[] | null = null;
  if (threadId && /^[0-9a-f-]{36}$/.test(threadId)) {
    const db = await createClient();
    const { data: t } = await db.from("ai_threads").select("id").eq("id", threadId).eq("profile_id", me.id).maybeSingle();
    if (t) on = await threadConnectorKeys(admin, threadId);
  }
  return { items, on };
}

export async function setThreadConnectors(threadId: string, keys: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: t } = await db.from("ai_threads").select("id").eq("id", threadId).eq("profile_id", me.id).maybeSingle();
  if (!t) return { ok: false, error: "Not your thread." };
  const { setThreadConnectorKeys } = await import("@/lib/connectors/server");
  const { error } = await setThreadConnectorKeys(createAdminClient(), threadId, Array.isArray(keys) ? keys.map(String) : []);
  return error ? { ok: false, error: error.code === "42P01" ? "Connectors need the latest database update first." : error.message } : { ok: true };
}

/** Cancel on a confirm card: it stays in the thread as cancelled, and the tool stays off */
export async function cancelConnectorAction(cardId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(cardId)) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const { data: m } = await admin.from("ai_messages").select("id, cards, ai_threads!inner(profile_id)").contains("cards", [{ id: cardId }]).limit(1).maybeSingle();
  const owner = (m as { ai_threads?: { profile_id?: string } | null } | null)?.ai_threads?.profile_id;
  if (!m || owner !== me.id) return { ok: false, error: "Not your thread." };
  const cards = ((m.cards ?? []) as Card[]).map((c) => (c.type === "connector_confirm" && c.id === cardId && c.status === "pending" ? { ...c, status: "cancelled" as const } : c));
  const { error } = await admin.from("ai_messages").update({ cards }).eq("id", m.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
