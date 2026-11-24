"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff, type Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesSalesPages } from "@/lib/sales-core";

// Sales › Prospects: research a business, build a list, draft a pitch, review a call, and change a prospect's stage,
// owner or notes. Execs and leads only (checked here, and by row-level security). The same work runs from the
// assistant and Kaizen AI through src/lib/ai-tools/sales.ts.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function gate(): Promise<{ me: Staff } | { error: string }> {
  const me = await requireStaff();
  if (!seesSalesPages(me)) return { error: "Sales is for the executives for now." };
  if (me.viewAs) return { error: "While viewing as someone, nothing is saved for them." };
  return { me };
}

const failed = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "That didn't work. Try again." });

function refresh(id?: string) {
  revalidatePath("/sales");
  if (id) revalidatePath(`/sales/${id}`);
}

export async function researchAction(input: { name?: string; website?: string; location?: string; question?: string; prospectId?: string }): Promise<Result<{ id: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { researchProspect } = await import("@/lib/sales-agent");
    const r = await researchProspect(await createClient(), createAdminClient(), g.me, { name: input.name ?? null, website: input.website ?? null, location: input.location ?? null, question: input.question ?? null, prospectId: input.prospectId ?? null });
    if (!r.ok) return r;
    refresh(r.prospect.id);
    return { ok: true, id: r.prospect.id };
  } catch (e) {
    return failed(e);
  }
}

/** Starts a prospect search in the background (it keeps going if they leave the page); returns its id to follow */
export async function findAction(input: { profile: string; count?: number }): Promise<Result<{ id: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const profile = input.profile.trim();
  if (!profile) return { ok: false, error: "What kind of business, and where? (e.g. med spas in Tampa running no ads)" };
  try {
    const { queueProspectSearch, runProspectSearch } = await import("@/lib/prospect-search");
    const q = await queueProspectSearch(createAdminClient(), { profileId: g.me.id, profile, want: input.count ?? null, via: "page" });
    if (!q.existing) after(() => runProspectSearch(createAdminClient(), q.id).then(() => undefined));
    return { ok: true, id: q.id };
  } catch (e) {
    return failed(e);
  }
}

/** A search's live state (the page polls it while it runs) */
export async function searchStatusAction(id: string): Promise<Result<{ search: import("@/lib/prospect-search").SearchView }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { SEARCH_COLS, searchView } = await import("@/lib/prospect-search");
  const { data } = await (await createClient()).from("prospect_searches").select(SEARCH_COLS).eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "That search isn't there." };
  return { ok: true, search: searchView(data as Record<string, unknown>) };
}

export async function cancelSearchAction(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { error } = await (await createClient()).from("prospect_searches").update({ cancel: true }).eq("id", id).in("status", ["queued", "running"]);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** They opened the results: the Overview item to review them is cleared (and its notice read) */
export async function reviewedSearchAction(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const db = await createClient();
  await db.from("prospect_searches").update({ reviewed_at: new Date().toISOString() }).eq("id", id).eq("status", "done").is("reviewed_at", null);
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("key", `prospect-search:${id}`).is("read_at", null);
  revalidatePath("/sales");
  return { ok: true };
}

export async function addAction(input: { name: string; website?: string; location?: string }): Promise<Result<{ id: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const name = input.name.trim().slice(0, 160);
  if (!name) return { ok: false, error: "A prospect needs a name." };
  const { cleanSite } = await import("@/lib/sales-core");
  const { data, error } = await (await createClient())
    .from("prospects")
    .insert({ name, website: cleanSite(input.website), location: input.location?.trim() || null, status: "new", owner_id: g.me.id, created_by: g.me.id, source: "added" })
    .select("id")
    .single();
  if (error) return { ok: false, error: /prospects_site/.test(error.message) ? "A prospect with that website is already in the pipeline." : error.message };
  refresh();
  return { ok: true, id: data.id as string };
}

export async function updateAction(id: string, patch: { status?: string; owner_id?: string | null; notes?: string; lost_reason?: string }): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { updateProspect } = await import("@/lib/sales-agent");
  const r = await updateProspect(await createClient(), id, patch);
  if (!r.ok) return r;
  refresh(id);
  return { ok: true };
}

export async function pitchAction(id: string, focus: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const db = await createClient();
    const { getProspect, draftPitch } = await import("@/lib/sales-agent");
    const p = await getProspect(db, id);
    if (!p) return { ok: false, error: "That prospect isn't there anymore." };
    await draftPitch(db, createAdminClient(), g.me, p, { focus: focus.trim() || null });
    refresh(id);
    return { ok: true };
  } catch (e) {
    return failed(e);
  }
}

export async function reviewAction(id: string, input: { transcript?: string; doc?: string }): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    let text = input.transcript?.trim() ?? "";
    let source: string | null = null;
    if (!text && input.doc?.trim()) {
      const { readGoogleFile } = await import("@/lib/assistant/read-file");
      const f = await readGoogleFile(g.me.email, input.doc.trim());
      if (!f.ok) return { ok: false, error: f.say };
      text = f.text;
      source = f.title;
    }
    const db = await createClient();
    const { getProspect, reviewSalesCall } = await import("@/lib/sales-agent");
    const p = await getProspect(db, id);
    if (!p) return { ok: false, error: "That prospect isn't there anymore." };
    const r = await reviewSalesCall(db, createAdminClient(), g.me, { transcript: text, prospect: p, source });
    if (!r.ok) return r;
    refresh(id);
    return { ok: true };
  } catch (e) {
    return failed(e);
  }
}

export async function wonAction(id: string, client?: string): Promise<Result<{ client: { name: string; slug: string } | null; documents: number }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const db = await createClient();
  const { getProspect, updateProspect, linkWonProspect } = await import("@/lib/sales-agent");
  const p = await getProspect(db, id);
  if (!p) return { ok: false, error: "That prospect isn't there anymore." };
  if (p.status !== "won") {
    const u = await updateProspect(db, id, { status: "won" });
    if (!u.ok) return u;
  }
  const r = await linkWonProspect(db, createAdminClient(), { ...p, status: "won" }, client ?? null);
  refresh(id);
  return { ok: true, client: r.client ? { name: r.client.name, slug: r.client.slug } : null, documents: r.documents.length };
}

export async function deleteNoteAction(prospectId: string, noteId: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { error } = await (await createClient()).from("prospect_notes").delete().eq("id", noteId).eq("prospect_id", prospectId);
  if (error) return { ok: false, error: error.message };
  refresh(prospectId);
  return { ok: true };
}

export async function archiveAction(id: string, reason: string, note: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { archiveProspect } = await import("@/lib/sales-agent");
  const r = await archiveProspect(await createClient(), createAdminClient(), g.me, id, reason, note);
  if (!r.ok) return r;
  refresh(id);
  return { ok: true };
}

export async function unarchiveAction(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { unarchiveProspect } = await import("@/lib/sales-agent");
  const r = await unarchiveProspect(await createClient(), createAdminClient(), g.me, id);
  if (!r.ok) return r;
  refresh(id);
  return { ok: true };
}
