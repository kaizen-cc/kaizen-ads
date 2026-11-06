"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { LIVE } from "@/lib/live";
import { SAVED_COLS, saveState, toSaved, type LinkPreview, type SaveInput, type SavedRef, type SavedSource } from "@/lib/saved-references";

// Ideas saved for later (client_saved_references), per person per client, read and written with the person's own
// access. Starring is instant on screen; these only confirm it.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/i;
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

/** Saved by this person for the client (starring again after it was used brings it back for them) */
export async function saveReference(clientId: string, input: SaveInput): Promise<{ ok: true; ref: SavedRef } | Fail> {
  const me = await requireStaff();
  if (!UUID.test(clientId) || !input.refId) return { ok: false, error: "That can't be saved." };
  const db = await createClient();
  const { data, error } = await db
    .from("client_saved_references")
    .upsert(
      {
        client_id: clientId,
        source: input.source,
        ref_id: input.refId.slice(0, 200),
        url: clip(input.url, 1000),
        thumbnail: clip(input.thumbnail, 2000),
        title: clip(input.title, 300),
        subtitle: clip(input.subtitle, 300),
        format: input.format,
        data: input.data ?? {},
        saved_by: me.id,
        created_at: new Date().toISOString(),
        used_at: null,
        used_request_id: null,
        used_by: null,
        used_href: null,
        dismissed_at: null,
      },
      { onConflict: "client_id,source,ref_id,saved_by" },
    )
    .select(SAVED_COLS)
    .single();
  if (error || !data) return { ok: false, error: "Couldn't save it. Try again." };
  return { ok: true, ref: toSaved(data as Record<string, unknown>) };
}

/** Preview cards for pasted reference links (title and picture, read on the server); a link that can't be read still shows */
export async function linkPreviews(urls: string[]): Promise<LinkPreview[]> {
  await requireStaff();
  const list = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)))].slice(0, 10);
  if (!list.length) return [];
  const { previewLink } = await import("@/lib/link-preview");
  const admin = adminConfigured() ? createAdminClient() : null;
  return Promise.all(list.map((u) => previewLink(u, admin)));
}

/** Unstar: gone from this person's saved list (one already used stays on record) */
export async function unsaveReference(clientId: string, source: SavedSource, refId: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("client_saved_references").delete().eq("client_id", clientId).eq("source", source).eq("ref_id", refId).eq("saved_by", me.id).is("used_at", null);
  return error ? { ok: false, error: "Couldn't remove it. Try again." } : { ok: true };
}

/** Close the "already in motion" notice on a saved idea someone else briefed */
export async function dismissSaved(id: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  if (!UUID.test(id)) return { ok: false, error: "That isn't there." };
  const db = await createClient();
  const { error } = await db.from("client_saved_references").update({ dismissed_at: new Date().toISOString() }).eq("id", id).eq("saved_by", me.id);
  return error ? { ok: false, error: "Couldn't dismiss it. Try again." } : { ok: true };
}

/** Every idea this person saved, across clients: open ones and ones someone else put in motion (not dismissed) */
export async function mySaves(): Promise<SavedRef[]> {
  const me = await requireStaff();
  const { fitsFormat, formatsFor } = await import("@/lib/creative-formats");
  const allowed = formatsFor(me);
  const db = await createClient();
  const { data } = await db
    .from("client_saved_references")
    .select(SAVED_COLS)
    .eq("saved_by", me.id)
    .is("dismissed_at", null)
    .or(`used_at.is.null,used_by.neq.${me.id}`)
    .order("created_at", { ascending: false })
    .limit(400);
  return (data ?? [])
    .filter((r) => saveState({ id: r.id as string, savedBy: r.saved_by as string | null, usedAt: r.used_at as string | null, usedBy: r.used_by as string | null, dismissedAt: r.dismissed_at as string | null }, me.id) !== "hidden")
    .map((r) => toSaved(r as Record<string, unknown>))
    .filter((r) => fitsFormat(allowed, r.format));
}

/** This person's saved ideas for the client not used yet, newest first (to add to a brief or a ticket) */
export async function savedFor(clientId: string): Promise<SavedRef[]> {
  const me = await requireStaff();
  const { fitsFormat, formatsFor } = await import("@/lib/creative-formats");
  const allowed = formatsFor(me);
  if (!UUID.test(clientId)) return [];
  const db = await createClient();
  const { data } = await db.from("client_saved_references").select(SAVED_COLS).eq("client_id", clientId).eq("saved_by", me.id).is("used_at", null).order("created_at", { ascending: false }).limit(40);
  // Only references in the formats this person works in (a designer never sees video examples)
  return (data ?? []).map((r) => toSaved(r as Record<string, unknown>)).filter((r) => fitsFormat(allowed, r.format));
}

/** The clients a star can save for, outside a client's own page: the live ones this person can see */
export async function saveClients(): Promise<{ id: string; name: string }[]> {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name").is("archived_at", null).in("status", LIVE).order("name").limit(500);
  return (data ?? []).map((c) => ({ id: c.id as string, name: c.name as string }));
}

/** A brief (or a ticket's references) was made from these saved ideas: everyone's save of them is used now */
export async function markSavedUsed(ids: string[], requestId?: string | null): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const list = ids.filter((x) => UUID.test(x)).slice(0, 40);
  if (!list.length) return { ok: true };
  const db = adminConfigured() ? createAdminClient() : await createClient();
  let href: string | null = null;
  if (requestId && UUID.test(requestId)) {
    const { data: r } = await db.from("requests").select("number").eq("id", requestId).maybeSingle();
    if (r?.number) href = `/board?t=${r.number}`;
  }
  try {
    const { markIdeasUsed } = await import("@/lib/saved-used");
    await markIdeasUsed(db, { savedIds: list, requestId, href, by: { id: me.id, name: me.fullName } });
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't mark it used." };
  }
}
