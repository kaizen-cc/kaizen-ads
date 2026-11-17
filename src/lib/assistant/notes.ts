import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { parseTopic } from "@/lib/agent-call/core";
import { said } from "@/lib/agent-call/server";

// The assistant's notes from a call, written once it ends with a cheap model: a short summary, what was decided and
// what's to follow up. Follow-ups become reminders on the person's Overview (Next for me), credited to the assistant.
// Shown on the wrap-up after the call and on the assistant's page.

export type CallNotes = { summary: string; decisions: string[]; followUps: { what: string; due: string | null }[] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topic", "decisions", "follow_ups"],
  properties: {
    summary: { type: "string", description: "Two to four plain sentences: what was talked about and done" },
    topic: { type: "string", description: "The main thing talked about, a short phrase (up to eight words)" },
    decisions: { type: "array", items: { type: "string" }, description: "What was decided or done, one short line each (none is fine)" },
    follow_ups: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["what", "due"], properties: { what: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD if a day was said, else empty" } } },
      description: "What the person still has to do or check after the call (not what was already done, not reminders already set on the call)",
    },
  },
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Writes the notes of an ended assistant call (never throws) */
export async function writeCallNotes(admin: SupabaseClient, callId: string): Promise<CallNotes | null> {
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, notes").eq("id", callId).maybeSingle();
  if (!call || call.role_key !== "assistant" || call.notes) return (call?.notes as CallNotes | null) ?? null;
  const { data: rows } = await admin.from("ai_role_chats").select("role, content, role_key").eq("call_id", callId).order("created_at").limit(160);
  const turns = (rows ?? []) as { role: string; content: string; role_key: string }[];
  if (!turns.some((t) => t.role === "user")) {
    await admin.from("ai_role_calls").update({ notes: { summary: "", decisions: [], followUps: [] } }).eq("id", callId);
    return null;
  }
  // Reminders already set on the call aren't follow-ups again
  const { data: asks } = await admin.from("agent_asks").select("title").eq("call_id", callId);
  try {
    const out = await askJson<{ summary: string; topic: string; decisions: string[]; follow_ups: { what: string; due: string }[] }>({
      agent: "coach",
      label: "assistant call notes",
      bare: true,
      noSample: true,
      override: { model: "haiku", effort: "low" },
      system: "You take the notes of a voice call between a member of a marketing agency's team and their AI assistant (sometimes with a specialist agent called in). Plain, short, practical. Roles not names for anyone but 'you' (the person). Leave out anything personal they shared (family, trips, health); notes are about the work.",
      schema: SCHEMA,
      maxTokens: 2000,
      prompt: `<reminders_already_set>\n${(asks ?? []).map((a) => a.title).join("\n") || "(none)"}\n</reminders_already_set>\n\n<call>\n${said(turns, "You", "assistant")}\n</call>`,
    });
    const notes: CallNotes = {
      summary: clip(out.summary, 1200),
      decisions: (out.decisions ?? []).map((d) => clip(d, 200)).filter(Boolean).slice(0, 8),
      followUps: (out.follow_ups ?? []).map((f) => ({ what: clip(f.what, 160), due: /^\d{4}-\d{2}-\d{2}$/.test(String(f.due)) ? f.due : null })).filter((f) => f.what).slice(0, 6),
    };
    const topic = parseTopic(out);
    await admin.from("ai_role_calls").update({ notes, summary: notes.summary || null, ...(topic ? { topic } : {}) }).eq("id", callId);
    if (notes.followUps.length)
      await admin.from("agent_asks").insert(
        notes.followUps.map((f) => ({ kind: "reminder", owner_id: call.profile_id, asked_by: call.profile_id, role_key: "assistant", call_id: callId, title: f.what, detail: "A follow-up from your call with your assistant", due_on: f.due })),
      );
    return notes;
  } catch (e) {
    console.error("[assistant notes]", e instanceof Error ? e.message : e);
    return null;
  }
}
