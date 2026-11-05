"use server";

import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SAVED_COLS, toSaved, type SaveInput, type SavedRef, type SavedSource } from "@/lib/saved-references";

// Saved for later (client_saved_references), read and written with the person's own access: staff who can see the
// client. Starring is instant on screen; these only confirm it.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/i;
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

/** A reference saved for the client (starring again after it was used brings it back) */
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
      },
      { onConflict: "client_id,source,ref_id" },
    )
    .select(SAVED_COLS)
    .single();
  if (error || !data) return { ok: false, error: "Couldn't save it. Try again." };
  return { ok: true, ref: toSaved(data as Record<string, unknown>) };
}

/** Unstar: gone from Saved (one already used stays on record) */
export async function unsaveReference(clientId: string, source: SavedSource, refId: string): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const db = await createClient();
  const { error } = await db.from("client_saved_references").delete().eq("client_id", clientId).eq("source", source).eq("ref_id", refId).is("used_at", null);
  return error ? { ok: false, error: "Couldn't remove it. Try again." } : { ok: true };
}

/** The client's saved references not used yet, newest first */
export async function savedFor(clientId: string): Promise<SavedRef[]> {
  const me = await requireStaff();
  const { fitsFormat, formatsFor } = await import("@/lib/creative-formats");
  const allowed = formatsFor(me);
  if (!UUID.test(clientId)) return [];
  const db = await createClient();
  const { data } = await db.from("client_saved_references").select(SAVED_COLS).eq("client_id", clientId).is("used_at", null).order("created_at", { ascending: false }).limit(40);
  // Only references in the formats this person works in (a designer never sees video examples)
  return (data ?? []).map((r) => toSaved(r as Record<string, unknown>)).filter((r) => fitsFormat(allowed, r.format));
}

/** A brief (or a ticket's references) was made from these: they leave Saved, and the row keeps where they went */
export async function markSavedUsed(ids: string[], requestId?: string | null): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const list = ids.filter((x) => UUID.test(x)).slice(0, 40);
  if (!list.length) return { ok: true };
  const db = await createClient();
  const { error } = await db
    .from("client_saved_references")
    .update({ used_at: new Date().toISOString(), used_request_id: requestId && UUID.test(requestId) ? requestId : null })
    .in("id", list)
    .is("used_at", null);
  return error ? { ok: false, error: "Couldn't mark it used." } : { ok: true };
}
