import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Briefs in progress, kept in the database as they're typed (brief_drafts), so a sign-out, a crash or another device
// never loses one: the request form saves the whole form as it stands (src/app/(team)/requests/new/request-form.tsx),
// the person picks it up from the "Unfinished brief" card on the request screen or their Overview, and it's gone once
// sent. Read and written with the person's own access: only they ever see their drafts.

export type BriefDraftRow = { id: string; context: string | null; clientId: string | null; client: string | null; title: string | null; step: number; updatedAt: string };

/** Their drafts, newest first */
export async function listBriefDrafts(db: SupabaseClient, profileId: string, limit = 12): Promise<BriefDraftRow[]> {
  const { data } = await db.from("brief_drafts").select("id, context, client_id, title, step, updated_at, clients(name)").eq("profile_id", profileId).order("updated_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => ({ id: r.id as string, context: (r.context as string | null) ?? null, clientId: (r.client_id as string | null) ?? null, client: (r.clients as unknown as { name: string } | null)?.name ?? null, title: (r.title as string | null) ?? null, step: Number(r.step) || 0, updatedAt: r.updated_at as string }));
}

/** One draft's saved form (theirs only), or null */
export async function getBriefDraft(db: SupabaseClient, id: string): Promise<{ id: string; context: string | null; payload: Record<string, unknown>; updatedAt: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("brief_drafts").select("id, context, payload, updated_at").eq("id", id).maybeSingle();
  return data ? { id: data.id as string, context: (data.context as string | null) ?? null, payload: data.payload as Record<string, unknown>, updatedAt: data.updated_at as string } : null;
}

/** Keeps the form as it stands (by its id; a brief tied to something, by that) and returns the draft's id */
export async function saveBriefDraft(db: SupabaseClient, profileId: string, d: { id: string | null; context: string | null; clientId: string | null; title: string | null; step: number; payload: Record<string, unknown> }): Promise<string | null> {
  const { fitPayload } = await import("@/lib/brief-drafts-core");
  const payload = fitPayload(d.payload);
  if (!payload) return null;
  const row = { profile_id: profileId, context: d.context, client_id: d.clientId, title: d.title?.slice(0, 200) || null, step: Math.max(0, Math.min(20, d.step)), payload, updated_at: new Date().toISOString() };
  if (d.id && /^[0-9a-f-]{36}$/i.test(d.id)) {
    const { data } = await db.from("brief_drafts").upsert({ id: d.id, ...row }, { onConflict: "id" }).select("id").maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }
  if (d.context) {
    const { data } = await db.from("brief_drafts").upsert(row, { onConflict: "profile_id,context" }).select("id").maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }
  const { data } = await db.from("brief_drafts").insert(row).select("id").single();
  return (data?.id as string | undefined) ?? null;
}

/** Gone: sent, started over, or deleted by its owner */
export async function deleteBriefDraft(db: SupabaseClient, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await db.from("brief_drafts").delete().eq("id", id);
}
