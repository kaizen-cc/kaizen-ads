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

export async function researchAction(input: { name?: string; website?: string; location?: string; question?: string; prospectId?: string; mode?: string }): Promise<Result<{ id: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { researchProspect } = await import("@/lib/sales-agent");
    const r = await researchProspect(await createClient(), createAdminClient(), g.me, { name: input.name ?? null, website: input.website ?? null, location: input.location ?? null, question: input.question ?? null, prospectId: input.prospectId ?? null, ...modeOf(input.mode) });
    if (!r.ok) return r;
    refresh(r.prospect.id);
    return { ok: true, id: r.prospect.id };
  } catch (e) {
    return failed(e);
  }
}

/** The research form's "Direct or white label" ("" = detect it; "direct"; "p:<partner key>") */
function modeOf(mode: string | undefined): { relationship?: "direct" | "white_label"; partnerKey?: string | null } {
  if (mode === "direct") return { relationship: "direct", partnerKey: null };
  if (mode?.startsWith("p:")) return { relationship: "white_label", partnerKey: mode.slice(2) };
  return {};
}

/**
 * Research again from the prospect page: one background job does the research and then the go-to-market strategy (one
 * progress bar, one notification when the PDF is ready). When direct-or-white-label isn't known yet, the research runs
 * here and the strategy builds as soon as that's set.
 */
export async function researchAgainAction(prospectId: string): Promise<Result<{ background: boolean }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { autoGtm } = await import("@/lib/sales-gtm");
    const q = await autoGtm(createAdminClient(), { prospectId, profileId: g.me.id, refresh: true });
    if (q.queued) {
      refresh(prospectId);
      return { ok: true, background: true };
    }
    const { researchProspect, getProspect } = await import("@/lib/sales-agent");
    const p = await getProspect(await createClient(), prospectId);
    if (!p) return { ok: false, error: "That prospect isn't there anymore." };
    const r = await researchProspect(await createClient(), createAdminClient(), g.me, { prospectId, name: p.name, website: p.website, location: p.location });
    if (!r.ok) return r;
    refresh(prospectId);
    return { ok: true, background: false };
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

/** Starts a go-to-market strategy for a prospect in the background (Kaizen's branding, or a white-label partner's) */
export async function startGtmAction(prospectId: string, ask: string): Promise<Result<{ id: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  try {
    // The branding follows the relationship stored on the prospect (set first on the page, or detected)
    const { queueGtm, relationshipOf, partnerOf } = await import("@/lib/sales-gtm");
    const { getProspect } = await import("@/lib/sales-agent");
    const admin = createAdminClient();
    const p = await getProspect(await createClient(), prospectId);
    if (!p) return { ok: false, error: "That prospect isn't there anymore." };
    const rel = await relationshipOf(admin, p);
    if (!rel) return { ok: false, error: "Is this a direct Kaizen deal or a white-label pitch for a partner agency? Set it first." };
    if (rel.detected) await (await createClient()).from("prospects").update({ relationship: rel.relationship, partner_key: rel.partner?.key ?? null }).eq("id", prospectId);
    const partner = rel.partner ? await partnerOf(admin, rel.partner.key) : null;
    if (partner && !partner.kit_confirmed_at) return { ok: false, error: `${partner.name}'s brand kit isn't confirmed yet: ask your assistant to set it up (partner_kit), then build.` };
    const q = await queueGtm(admin, { prospectId, profileId: g.me.id, partnerKey: partner?.key ?? null, ask: ask.trim() || null });
    refresh(prospectId);
    return { ok: true, id: q.id };
  } catch (e) {
    return failed(e);
  }
}

/** A go-to-market strategy's state (the page polls it while it's built) */
export async function gtmStatusAction(id: string): Promise<Result<{ status: string; stage: string | null }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { data } = await (await createClient()).from("prospect_gtms").select("status, stage").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "It isn't there." };
  return { ok: true, status: data.status as string, stage: (data.stage as string | null) ?? null };
}

/** A short-lived link to download the GTM PDF */
export async function gtmPdfAction(documentId: string): Promise<Result<{ url: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  // Execs only (the gate): any GTM PDF, whoever made it
  const { data: d } = await createAdminClient().from("kaizen_documents").select("bucket, path, file_name").eq("id", documentId).eq("kind", "gtm").maybeSingle();
  if (!d?.path) return { ok: false, error: "That PDF isn't there." };
  const { data, error } = await createAdminClient().storage.from(d.bucket as string).createSignedUrl(d.path as string, 600, { download: (d.file_name as string) || true });
  if (error || !data) return { ok: false, error: error?.message ?? "The link couldn't be made." };
  return { ok: true, url: data.signedUrl };
}

/** Direct Kaizen deal or white-label pitch (with its partner), stored on the prospect */
export async function setRelationshipAction(prospectId: string, relationship: "direct" | "white_label", partnerKey: string | null): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  if (relationship === "white_label" && !partnerKey) return { ok: false, error: "Which partner agency?" };
  const { updateProspect } = await import("@/lib/sales-agent");
  const r = await updateProspect(await createClient(), prospectId, { relationship, partner_key: relationship === "white_label" ? partnerKey : null });
  if (!r.ok) return r;
  // Researched already: the strategy builds now in the branding just set (a new version when the branding changed)
  const admin = createAdminClient();
  const { data: p } = await admin.from("prospects").select("researched_at").eq("id", prospectId).maybeSingle();
  const { data: last } = await admin.from("prospect_gtms").select("partner_key, status").eq("prospect_id", prospectId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const same = last && last.status !== "failed" && last.status !== "cancelled" && (last.partner_key ?? null) === (relationship === "white_label" ? partnerKey : null);
  if (p?.researched_at && !same) {
    const { autoGtm } = await import("@/lib/sales-gtm");
    await autoGtm(admin, { prospectId, profileId: g.me.id });
  }
  refresh(prospectId);
  return { ok: true };
}
