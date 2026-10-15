"use server";

import { revalidatePath } from "next/cache";
import { AiUnavailable } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { problems, type Ad } from "@/lib/copy";
import { draftCopy } from "@/lib/copy-draft";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type CopySet = {
  id: string;
  status: "drafting" | "review" | "approved" | "failed";
  ads: Ad[];
  aiAds: Ad[];
  notes: string | null;
  error: string | null;
  version: number;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
  reusedFrom: string | null;
};
export type CopyState = { set: CopySet | null; reusable: { id: string; title: string; approvedAt: string | null; ads: Ad[] } | null };

const toSet = (s: Record<string, unknown>): CopySet => ({
  id: s.id as string,
  status: s.status as CopySet["status"],
  ads: (s.ads ?? []) as Ad[],
  aiAds: (s.ai_ads ?? []) as Ad[],
  notes: (s.notes as string | null) ?? null,
  error: (s.error as string | null) ?? null,
  version: s.version as number,
  approvedBy: (s.profiles as { full_name: string } | null)?.full_name ?? null,
  approvedAt: (s.approved_at as string | null) ?? null,
  updatedAt: s.updated_at as string,
  reusedFrom: (s.reused_from as string | null) ?? null,
});

/** The ticket's copy set, and an approved set for the same angle that could be reused instead of re-asking. */
export async function ticketCopy(requestId: string): Promise<CopyState> {
  await requireStaff();
  const supabase = await createClient();
  const [{ data: set }, { data: r }] = await Promise.all([
    supabase.from("copy_sets").select("*, profiles!copy_sets_approved_by_fkey(full_name)").eq("request_id", requestId).maybeSingle(),
    supabase.from("requests").select("client_id, angle_id").eq("id", requestId).maybeSingle(),
  ]);
  let reusable: CopyState["reusable"] = null;
  if (r?.angle_id && set?.status !== "approved") {
    const { data: other } = await supabase
      .from("copy_sets")
      .select("id, ads, approved_at, requests(title)")
      .eq("client_id", r.client_id)
      .eq("angle_id", r.angle_id)
      .eq("status", "approved")
      .neq("request_id", requestId)
      .order("approved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (other) reusable = { id: other.id, title: (other.requests as unknown as { title: string } | null)?.title ?? "Another ticket", approvedAt: other.approved_at, ads: other.ads as Ad[] };
  }
  return { set: set ? toSet(set) : null, reusable };
}

/** Write (or rewrite with a note from copy review) the copy set. */
export async function redraftCopy(requestId: string, note?: string): Promise<{ ok: true; state: CopyState } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: visible } = await supabase.from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!visible) return { ok: false, error: "Ticket not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    await draftCopy(createAdminClient(), requestId, me.id, note);
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't write the copy." };
  }
  revalidatePath("/board");
  return { ok: true, state: await ticketCopy(requestId) };
}

/** Copy review's edits, saved as they type. */
export async function saveCopy(setId: string, ads: Ad[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("copy_sets").update({ ads: ads.slice(0, 5), updated_by: me.id, updated_at: new Date().toISOString() }).eq("id", setId).neq("status", "approved");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Approve: saves the final edits, checks every hard limit, and moves the ticket to Ready for client. */
export async function approveCopy(setId: string, ads: Ad[]): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const issues = problems(ads);
  if (issues.length) return { ok: false, error: issues[0] };
  const saved = await saveCopy(setId, ads);
  if (!saved.ok) return saved;
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_copy", { p_set: setId });
  revalidatePath("/board");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Copy was already approved for this angle on another ticket: reuse it instead of asking again. */
export async function reuseCopy(requestId: string, fromSetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: from }, { data: r }] = await Promise.all([
    supabase.from("copy_sets").select("ads, client_id, angle_id, status").eq("id", fromSetId).maybeSingle(),
    supabase.from("requests").select("id, client_id, angle_id").eq("id", requestId).maybeSingle(),
  ]);
  if (!from || !r || from.status !== "approved" || from.client_id !== r.client_id) return { ok: false, error: "That copy can't be reused here." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { data: set, error } = await createAdminClient()
    .from("copy_sets")
    .upsert(
      { request_id: requestId, client_id: r.client_id, angle_id: r.angle_id, status: "review", ads: from.ads, ai_ads: from.ads, reused_from: fromSetId, notes: "Reused the copy already approved for this angle.", updated_by: me.id, updated_at: new Date().toISOString() },
      { onConflict: "request_id" },
    )
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  const { error: approveError } = await supabase.rpc("approve_copy", { p_set: set.id });
  revalidatePath("/board");
  return approveError ? { ok: false, error: approveError.message } : { ok: true };
}
