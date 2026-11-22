"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { cleanSafetyText, isCallId, safetyAlertKey, SAFETY_RESOLUTION_MAX } from "@/lib/agent-call/safety-alert";
import { createAdminClient } from "@/lib/supabase/admin";

// A flagged call's alert, for the executives together: dismissing it resolves it for every exec (their bell items
// for it are read and cleared, and any heads-up still waiting is dropped), and comments every exec sees.

type Result = { ok: true } | { ok: false; error: string };
const NOT_READY = "This needs a quick database update before it works. Try again shortly.";

async function execOnly(callId: string) {
  const me = await requireStaff();
  if (!me.isExec || !isCallId(callId)) return null;
  return me;
}

/** Dismisses the alert for all the execs, with an optional note on how it was resolved */
export async function dismissSafetyAlert(callId: string, note?: string): Promise<Result> {
  const me = await execOnly(callId);
  if (!me) return { ok: false, error: "Only executives can do this." };
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await admin
    .from("call_safety_reviews")
    .update({ resolved_at: now, resolved_by: me.id, resolution: cleanSafetyText(note, SAFETY_RESOLUTION_MAX) || null })
    .eq("call_id", callId)
    .eq("flagged", true);
  if (error) return { ok: false, error: /resolved|resolution/.test(error.message) ? NOT_READY : error.message };
  const key = safetyAlertKey(callId);
  await admin.from("notifications").update({ read_at: now }).eq("key", key).is("read_at", null);
  await admin.from("notifications").update({ cleared_at: now }).eq("key", key).is("cleared_at", null);
  await admin.from("assistant_heads_up_items").delete().eq("key", `n:${key}`).is("heads_up_id", null);
  revalidatePath(`/safety/${callId}`);
  return { ok: true };
}

/** Opens a dismissed alert again (the bell items stay cleared; the page shows it as open) */
export async function reopenSafetyAlert(callId: string): Promise<Result> {
  const me = await execOnly(callId);
  if (!me) return { ok: false, error: "Only executives can do this." };
  const { error } = await createAdminClient().from("call_safety_reviews").update({ resolved_at: null, resolved_by: null, resolution: null }).eq("call_id", callId);
  if (error) return { ok: false, error: /resolved|resolution/.test(error.message) ? NOT_READY : error.message };
  revalidatePath(`/safety/${callId}`);
  return { ok: true };
}

/** Adds a comment to the alert, for every exec to see */
export async function commentOnSafetyAlert(callId: string, text: string): Promise<Result> {
  const me = await execOnly(callId);
  if (!me) return { ok: false, error: "Only executives can do this." };
  const body = cleanSafetyText(text);
  if (!body) return { ok: false, error: "Write a comment first." };
  const { error } = await createAdminClient().from("call_safety_comments").insert({ call_id: callId, author_id: me.id, body });
  if (error) return { ok: false, error: /call_safety_comments/.test(error.message) ? NOT_READY : error.message };
  revalidatePath(`/safety/${callId}`);
  return { ok: true };
}
