"use server";

import { requireStaff } from "@/lib/auth";
import { browseState, chatMenu, type BrowseState, type MenuItem } from "@/lib/connectors/shared";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { Card } from "@/lib/kaizen-ai/types";

// The composer's plug menu: the connectors enabled for the person's role, whether each is connected, and which are on
// in this thread (remembered per thread); Browse connectors (the whole Directory, featured first) with Connect,
// Requested or Request to enable; and Cancel on a connector confirm card.

export type ChatConnector = MenuItem;

export async function chatConnectors(threadId: string | null): Promise<{ items: ChatConnector[]; on: string[] | null; isExec: boolean }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { items: [], on: null, isExec: me.isExec };
  const admin = createAdminClient();
  const { listConnectors, myConnections, threadConnectorKeys } = await import("@/lib/connectors/server");
  const [catalog, mine] = await Promise.all([listConnectors(admin), myConnections(admin, me.id)]);
  const items = chatMenu(catalog, mine, me);
  let on: string[] | null = null;
  if (threadId && /^[0-9a-f-]{36}$/.test(threadId)) {
    const db = await createClient();
    const { data: t } = await db.from("ai_threads").select("id").eq("id", threadId).eq("profile_id", me.id).maybeSingle();
    if (t) on = await threadConnectorKeys(admin, threadId);
  }
  return { items, on, isExec: me.isExec };
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

export type BrowseItem = {
  /** The Directory entry (what a request is for) */
  ref: string;
  title: string;
  description: string | null;
  icon_url: string | null;
  featured: boolean;
  state: BrowseState;
  /** The connector's key once it's enabled (Connect) */
  key: string | null;
  auth: string | null;
};

/**
 * Browse connectors: the whole Directory, featured first, searched by name, vendor and description. Each says where it
 * stands for this person: connected, enabled (Connect), requested, or Request to enable (execs: Enable).
 */
export async function browseConnectors(q: string, limit = 60): Promise<{ items: BrowseItem[]; total: number; ready: boolean; isExec: boolean }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { items: [], total: 0, ready: false, isExec: me.isExec };
  const admin = createAdminClient();
  const { myConnections, offerFor, searchDirectory } = await import("@/lib/connectors/server");
  const { myPendingRefs } = await import("@/lib/connectors/requests");
  const [found, mine, asked] = await Promise.all([searchDirectory(admin, q, limit), myConnections(admin, me.id), myPendingRefs(admin, me.id)]);
  const menu = chatMenu(found.offers.map((o) => ({ ...o, icon_url: null, note: null })), mine, me);
  const items = found.rows.map((x): BrowseItem => {
    const o = offerFor(found.offers, x);
    const m = o ? menu.find((i) => i.key === o.key) : null;
    // Enabled, but not for this person's role: they ask for it by the connector the team has
    const ref = o && !m && o.enabled ? `connector:${o.id}` : x.name;
    return {
      ref,
      title: x.title || x.name,
      description: x.description,
      icon_url: x.icon_url,
      featured: Boolean(x.featured),
      state: browseState({ enabledForMe: Boolean(m), connected: m?.state === "connected", requested: asked.has(ref), isExec: me.isExec }),
      key: m ? o!.key : null,
      auth: m ? o!.auth : null,
    };
  });
  return { items, total: found.total, ready: found.ready, isExec: me.isExec };
}

/** Request to enable (with an optional note): every exec hears, with Enable one click away */
export async function requestConnector(ref: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { askToEnable } = await import("@/lib/connectors/requests");
  const r = await askToEnable(createAdminClient(), me, String(ref ?? ""), note);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
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
