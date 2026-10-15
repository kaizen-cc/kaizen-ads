"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { draftCopy } from "@/lib/copy-draft";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type ReviewComment = {
  id: string;
  designId: string;
  version: number;
  fileId: string | null;
  x: number | null;
  y: number | null;
  tMs: number | null;
  body: string;
  round: "internal" | "client";
  author: string | null;
  remembered: boolean;
  resolved: boolean;
  at: string;
};

export async function ticketComments(requestId: string): Promise<ReviewComment[]> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase
    .from("review_comments")
    .select("id, design_id, version, file_id, x, y, t_ms, body, round, remembered, resolved_at, created_at, profiles!review_comments_author_id_fkey(full_name)")
    .eq("request_id", requestId)
    .order("created_at");
  return (data ?? []).map((c) => ({
    id: c.id,
    designId: c.design_id,
    version: c.version,
    fileId: c.file_id,
    x: c.x == null ? null : Number(c.x),
    y: c.y == null ? null : Number(c.y),
    tMs: c.t_ms,
    body: c.body,
    round: c.round as "internal" | "client",
    author: (c.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    remembered: c.remembered,
    resolved: Boolean(c.resolved_at),
    at: c.created_at,
  }));
}

/** A comment pinned to a spot on an image (x, y from 0 to 1) or a moment in a video (tMs). */
export async function addComment(v: {
  requestId: string;
  designId: string;
  version: number;
  fileId: string | null;
  x?: number | null;
  y?: number | null;
  tMs?: number | null;
  body: string;
}): Promise<{ ok: true; comments: ReviewComment[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!v.body.trim()) return { ok: false, error: "Write the comment first." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("client_id, stage").eq("id", v.requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  const clamp = (n: number | null | undefined) => (n == null ? null : Math.min(1, Math.max(0, n)));
  const { error } = await supabase.from("review_comments").insert({
    request_id: v.requestId,
    client_id: r.client_id,
    design_id: v.designId,
    version: v.version,
    file_id: v.fileId,
    x: clamp(v.x),
    y: clamp(v.y),
    t_ms: v.tMs == null ? null : Math.max(0, Math.round(v.tMs)),
    body: v.body.trim().slice(0, 2000),
    round: ["ready_for_client", "client_review", "client_revision"].includes(r.stage) ? "client" : "internal",
    author_id: me.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, comments: await ticketComments(v.requestId) };
}

export async function setCommentResolved(id: string, requestId: string, resolved: boolean): Promise<{ ok: true; comments: ReviewComment[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase
    .from("review_comments")
    .update({ resolved_at: resolved ? new Date().toISOString() : null, resolved_by: resolved ? me.id : null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, comments: await ticketComments(requestId) };
}

/** Save a review comment as an "avoid" rule in client memory, so every agent and future brief knows it. */
export async function rememberComment(id: string, requestId: string): Promise<{ ok: true; comments: ReviewComment[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: c } = await supabase.from("review_comments").select("client_id, body, remembered").eq("id", id).maybeSingle();
  if (!c) return { ok: false, error: "Comment not found." };
  if (!c.remembered) {
    const { error } = await supabase.from("client_memory").insert({ client_id: c.client_id, kind: "avoid", body: c.body, source: "team", created_by: me.id });
    if (error) return { ok: false, error: error.message };
    await supabase.from("review_comments").update({ remembered: true }).eq("id", id);
  }
  return { ok: true, comments: await ticketComments(requestId) };
}

/**
 * The Head of Creative (or an exec): approve the creative or send it back. Approving moves the ticket to Copy and has the
 * Copywriter draft the set straight away; it lands in Copy review a minute later.
 */
export async function reviewCreative(requestId: string, decision: "approve" | "changes", note?: string): Promise<ActionResult> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("review_creative", { p_request: requestId, p_decision: decision, p_note: note?.trim() || null });
  if (error) return { ok: false, error: error.message };
  if (decision === "approve" && adminConfigured()) {
    after(async () => {
      try {
        await draftCopy(createAdminClient(), requestId, me.id);
      } catch (e) {
        console.error("[copy] draft after approval failed:", e instanceof Error ? e.message : e);
      }
    });
  }
  revalidatePath("/board");
  return { ok: true };
}
