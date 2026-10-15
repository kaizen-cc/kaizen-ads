"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { stageInfo } from "@/lib/stages";
import { draftCopy } from "@/lib/copy-draft";
import { AiUnavailable, type CreativeNotes } from "@/lib/ai";
import { currentCreative, runCreativeReview, startRun, type ReviewProgress } from "@/lib/creative-review";
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
  w?: number | null; // a box: x, y is its top-left corner
  h?: number | null;
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
    .select("id, design_id, version, file_id, x, y, w, h, t_ms, body, round, remembered, resolved_at, created_at, author_name, profiles!review_comments_author_id_fkey(full_name)")
    .eq("request_id", requestId)
    .order("created_at");
  return (data ?? []).map((c) => ({
    id: c.id,
    designId: c.design_id,
    version: c.version,
    fileId: c.file_id,
    x: c.x == null ? null : Number(c.x),
    y: c.y == null ? null : Number(c.y),
    w: c.w == null ? null : Number(c.w),
    h: c.h == null ? null : Number(c.h),
    tMs: c.t_ms,
    body: c.body,
    round: c.round as "internal" | "client",
    author: c.author_name ?? (c.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
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

// ─── AI review (QA before creative review) ──────────────────────────────────

export type AiRun = {
  id: string;
  status: "running" | "done" | "failed";
  progress: ReviewProgress;
  notes: CreativeNotes | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  by: string | null;
  current: boolean; // it looked at the files on the ticket now (nothing replaced since)
};
/** Sent on without a clean AI review. Only leads and execs get this. */
export type Forced = { by: string | null; at: string; skipped: boolean; fixes: number; note: string | null };
export type AiReviewState = { latest: AiRun | null; runs: number; hasCreative: boolean; forced: Forced | null };

const STUCK_MS = 4 * 60_000; // no progress for this long: the function running it is gone
const MAKING = ["in_production", "client_revision"];
const FORCED = ["past_ai_fixes", "skipped_ai"];

/** The latest AI review on a ticket (with live progress while it runs) and whether it's still about the current files. */
export async function aiReview(requestId: string): Promise<AiReviewState> {
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: rows, count }, { signature, designs }, { data: r }] = await Promise.all([
    supabase
      .from("creative_ai_reviews")
      .select("id, status, progress, content, error, signature, started_at, updated_at, profiles(full_name)", { count: "exact" })
      .eq("request_id", requestId)
      .order("started_at", { ascending: false })
      .limit(1),
    currentCreative(supabase, requestId),
    supabase.from("requests").select("stage, stage_entered_at").eq("id", requestId).maybeSingle(),
  ]);
  const row = rows?.[0];
  let latest: AiRun | null = null;
  if (row) {
    const stuck = row.status === "running" && Date.now() - Date.parse(row.updated_at) > STUCK_MS;
    latest = {
      id: row.id,
      status: stuck ? "failed" : (row.status as AiRun["status"]),
      progress: row.progress as ReviewProgress,
      notes: (row.content as CreativeNotes | null) ?? null,
      error: stuck ? "The review stopped before it finished. Run it again." : row.error,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      by: (row.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      current: row.signature === signature,
    };
  }

  // Past production, leads see whether it was sent on past the AI's notes
  let forced: Forced | null = null;
  if (isExecOrLead(me) && r && !MAKING.includes(r.stage)) {
    const { data: ev } = await supabase
      .from("request_events")
      .select("created_at, body, data, profiles(full_name)")
      .eq("request_id", requestId)
      .eq("kind", "review")
      .in("data->>action", FORCED)
      .gte("created_at", new Date(Date.parse(r.stage_entered_at) - 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ev) {
      const d = ev.data as { action: string; fixes?: number };
      forced = { by: (ev.profiles as unknown as { full_name: string } | null)?.full_name ?? null, at: ev.created_at, skipped: d.action === "skipped_ai", fixes: d.fixes ?? 0, note: ev.body };
    }
  }
  return { latest, runs: count ?? 0, hasCreative: designs.some((d) => d.files.length), forced };
}

/** Start an AI review of the current files. It runs in the background; aiReview shows its progress. */
export async function startAiReview(requestId: string): Promise<{ ok: true; state: AiReviewState } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("stage").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const { data: busy } = await admin
    .from("creative_ai_reviews")
    .select("id")
    .eq("request_id", requestId)
    .eq("status", "running")
    .gt("updated_at", new Date(Date.now() - STUCK_MS).toISOString())
    .limit(1)
    .maybeSingle();
  if (!busy) {
    try {
      const id = await startRun(admin, requestId, me.id);
      after(() => runCreativeReview(admin, id));
    } catch (e) {
      return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't start the review." };
    }
  }
  return { ok: true, state: await aiReview(requestId) };
}

/**
 * Send the work on from production (to creative review) or from client changes (back to the client). It goes when the
 * latest AI review is about these files and found nothing to fix; otherwise only with force, which is logged for leads.
 */
export async function sendOn(requestId: string, opts: { force?: boolean; note?: string } = {}): Promise<ActionResult> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("stage").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (!MAKING.includes(r.stage)) return { ok: false, error: "This ticket isn't being made right now." };
  const next = stageInfo(r.stage).next!;
  const state = await aiReview(requestId);
  if (!state.hasCreative) return { ok: false, error: "Upload the creative first." };
  const run = state.latest;
  const clean = run?.status === "done" && run.current && run.notes?.verdict !== "fix";
  if (!clean && !opts.force) return { ok: false, error: run?.status === "running" ? "The AI review is still running." : "Run the AI review first, or send it anyway." };

  const { error } = await supabase.rpc("move_request", { p_request: requestId, p_stage: next, p_note: opts.note?.trim() || null });
  if (error) return { ok: false, error: error.message };
  if (!clean && adminConfigured()) {
    const reviewed = run?.status === "done" && run.current;
    await createAdminClient()
      .from("request_events")
      .insert({
        request_id: requestId,
        kind: "review",
        from_stage: r.stage,
        to_stage: next,
        actor_id: me.id,
        body: opts.note?.trim() || null,
        data: { action: reviewed ? "past_ai_fixes" : "skipped_ai", fixes: reviewed ? run!.notes!.notes.filter((n) => n.severity === "fix").length : 0, run_id: reviewed ? run!.id : null },
      });
  }
  revalidatePath("/board");
  return { ok: true };
}

/** The client's latest open request for changes on a ticket (their overall notes; the pins are comments). */
export async function clientRound(requestId: string): Promise<{ round: number; byName: string | null; at: string; targets: string[]; designNote: string | null; copyNotes: string | null } | null> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase
    .from("client_rounds")
    .select("round, by_name, created_at, targets, design_note, copy_notes")
    .eq("request_id", requestId)
    .eq("decision", "revise")
    .is("sent_back_at", null)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { round: data.round, byName: data.by_name, at: data.created_at, targets: data.targets, designNote: data.design_note, copyNotes: data.copy_notes } : null;
}
