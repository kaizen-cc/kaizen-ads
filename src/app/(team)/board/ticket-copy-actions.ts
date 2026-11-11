"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { AiUnavailable, type Script } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CreativeCopy } from "@/lib/ticket-copy";
import { chatTicketCopy, readDraft, undoTicketCopy, writeTicketCopy, type DraftMessage } from "@/lib/ticket-copy-writer";

// The ticket's own copy in production (the creative's headlines, slide lines or script): written the moment production
// starts, fine-tuned in a chat with the copywriter, each change shown and undoable. See src/lib/ticket-copy-writer.ts.

export type CopyDraftState = {
  status: "none" | "writing" | "ready" | "failed";
  progress: string | null;
  content: CreativeCopy | null;
  /** What the last change changed, line by line */
  changes: string[];
  canUndo: boolean;
  messages: DraftMessage[];
  error: string | null;
  /** The database update for drafts is applied (before it: a video's script only, no chat) */
  setup: boolean;
  updatedAt: string | null;
};

type Result = { ok: true; state: CopyDraftState } | { ok: false; error: string };

const fail = (e: unknown) => ({ ok: false as const, error: e instanceof AiUnavailable ? e.message : e instanceof Error ? e.message : "Something went wrong." });

/** Where the ticket's copy stands, read as the person (their own clients only) */
export async function copyDraft(requestId: string): Promise<CopyDraftState> {
  await requireStaff();
  const db = await createClient();
  const { row, setup } = await readDraft(db, requestId);
  // A write with no progress for this long: the function running it is gone
  const stuck = row?.status === "writing" && Date.now() - Date.parse(row.updated_at) > 6 * 60_000;
  if (row)
    return {
      status: stuck ? "failed" : row.status,
      progress: row.progress,
      content: row.content,
      changes: row.changes ?? [],
      canUndo: (row.history ?? []).length > 0,
      messages: row.messages ?? [],
      error: stuck ? "The copywriter stopped before it finished. Write it again." : row.error,
      setup,
      updatedAt: row.updated_at,
    };
  // Before the update (or before anything was written): a video's script, if the script writer saved one
  const { data: s } = await db.from("request_scripts").select("content, generated_at").eq("request_id", requestId).maybeSingle();
  if (s) return { status: "ready", progress: null, content: { kind: "script", script: s.content as Script }, changes: [], canUndo: false, messages: [], error: null, setup, updatedAt: s.generated_at };
  return { status: "none", progress: null, content: null, changes: [], canUndo: false, messages: [], error: null, setup, updatedAt: null };
}

/** Write (or rewrite) the copy in the background; the ticket polls copyDraft for its progress */
export async function startCopyDraft(requestId: string): Promise<Result> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const db = await createClient();
  const { data: r } = await db.from("requests").select("id, format").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  const { setup } = await readDraft(db, requestId);
  if (!setup && r.format !== "video") return { ok: false, error: "The copy draft turns on once the database update for it is applied." };
  after(() => writeTicketCopy(createAdminClient(), requestId, me.id).catch((e) => console.error("ticket copy", requestId, e)));
  return { ok: true, state: { ...(await copyDraft(requestId)), status: "writing", progress: "Starting", error: null } };
}

/**
 * Start production: the ticket moves to In production and, the same moment, the AI copywriter starts writing the
 * creative's copy in the background.
 */
export async function startProduction(requestId: string): Promise<{ ok: true; copy: boolean } | { ok: false; error: string }> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_request", { p_request: requestId, p_stage: "in_production", p_note: null });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/board");
  // The move stands even when the copy can't start (it can be started from the ticket)
  const started = await startCopyDraft(requestId);
  return { ok: true, copy: started.ok };
}

export async function chatCopyDraft(requestId: string, text: string): Promise<Result> {
  const me = await requireStaff();
  const t = text.trim().slice(0, 2000);
  if (!t) return { ok: false, error: "Say what to change." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  // Only someone who can see the client (their own read of the ticket)
  const { data: r } = await (await createClient()).from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  try {
    await chatTicketCopy(createAdminClient(), requestId, t, { id: me.id, name: me.fullName });
    return { ok: true, state: await copyDraft(requestId) };
  } catch (e) {
    return fail(e);
  }
}

export async function undoCopyDraft(requestId: string): Promise<Result> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { data: r } = await (await createClient()).from("requests").select("id").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  try {
    await undoTicketCopy(createAdminClient(), requestId, { id: me.id, name: me.fullName });
    return { ok: true, state: await copyDraft(requestId) };
  } catch (e) {
    return fail(e);
  }
}
