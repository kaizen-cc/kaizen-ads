import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { parseTopic } from "@/lib/agent-call/core";
import { said } from "@/lib/agent-call/server";
import { cleanJob, jobForPrompt, playbookOf } from "./team";

// The notes from a call with the assistant (or any call where agents worked a job together), written once it ends with
// a cheap model: a short summary, what was decided, what each agent on the line did, what was made (from the job's
// record, not the model) and what's to follow up. Follow-ups become reminders on the person's Overview (Next for me),
// credited to the host. Shown on the wrap-up after the call and on the assistant's page.

export type CallNotes = {
  summary: string;
  decisions: string[];
  followUps: { what: string; due: string | null; client?: string | null }[];
  /** What each agent on the line did (only when more than one agent spoke) */
  agents?: { label: string; did: string[] }[];
  /** What the job made on the call (briefs, copy, tickets, launches, reports), from its record */
  made?: { label: string; href: string | null }[];
  job?: { label: string; client: string | null; status: string } | null;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topic", "decisions", "by_agent", "follow_ups"],
  properties: {
    summary: { type: "string", description: "Two to four plain sentences: what was talked about and done" },
    topic: { type: "string", description: "The main thing talked about, a short phrase (up to eight words)" },
    decisions: { type: "array", items: { type: "string" }, description: "What was decided or done, one short line each (none is fine)" },
    by_agent: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["agent", "did"], properties: { agent: { type: "string", description: "The agent's role as it appears in the call" }, did: { type: "array", items: { type: "string" } } } },
      description: "When more than one agent spoke: what each one did or decided, one short line each (empty when only one agent spoke)",
    },
    follow_ups: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["what", "due", "client"], properties: { what: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD if a day was said, else empty" }, client: { type: "string", description: "The client it is about, by name, or empty when it is about no client" } } },
      description: "What the person still has to do or check after the call (not what was already done, not reminders already set on the call)",
    },
  },
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Writes the notes of an ended assistant call, or of a call where agents worked together (never throws) */
export async function writeCallNotes(admin: SupabaseClient, callId: string): Promise<CallNotes | null> {
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, notes").eq("id", callId).maybeSingle();
  if (!call || call.notes) return (call?.notes as CallNotes | null) ?? null;
  // The job and who was on the line (before the team migration: none)
  const { data: teamRow } = await admin.from("ai_role_calls").select("job, guest_roles").eq("id", callId).maybeSingle();
  const job = cleanJob(teamRow?.job);
  if (call.role_key !== "assistant" && !job && !((teamRow?.guest_roles as string[] | null) ?? []).length) return null;
  const { data: rows } = await admin.from("ai_role_chats").select("role, content, role_key").eq("call_id", callId).order("created_at").limit(160);
  const turns = (rows ?? []) as { role: string; content: string; role_key: string }[];
  if (!turns.some((t) => t.role === "user")) {
    await admin.from("ai_role_calls").update({ notes: { summary: "", decisions: [], followUps: [] } }).eq("id", callId);
    return null;
  }
  // Reminders already set on the call aren't follow-ups again
  const { data: asks } = await admin.from("agent_asks").select("title").eq("call_id", callId);
  try {
    const out = await askJson<{ summary: string; topic: string; decisions: string[]; by_agent?: { agent: string; did: string[] }[]; follow_ups: { what: string; due: string; client?: string }[] }>({
      agent: "coach",
      label: "assistant call notes",
      bare: true,
      noSample: true,
      override: { model: "haiku", effort: "low" },
      system: "You take the notes of a voice call between a member of a marketing agency's team and their AI assistant or one of its AI agents (sometimes with other specialist agents on the line, working a job together). Plain, short, practical. Roles not names for anyone but 'you' (the person). Leave out anything personal they shared (family, trips, health); notes are about the work.",
      schema: SCHEMA,
      maxTokens: 2000,
      prompt: `<reminders_already_set>\n${(asks ?? []).map((a) => a.title).join("\n") || "(none)"}\n</reminders_already_set>${job ? `\n\n${jobForPrompt(job)}` : ""}\n\n<call>\n${said(turns, "You", call.role_key as string)}\n</call>`,
    });
    const speakers = new Set(turns.filter((t) => t.role === "agent").map((t) => t.role_key));
    const notes: CallNotes = {
      summary: clip(out.summary, 1200),
      decisions: (out.decisions ?? []).map((d) => clip(d, 200)).filter(Boolean).slice(0, 8),
      followUps: (out.follow_ups ?? []).map((f) => ({ what: clip(f.what, 160), due: /^\d{4}-\d{2}-\d{2}$/.test(String(f.due)) ? f.due : null, client: clip(f.client, 120) || null })).filter((f) => f.what).slice(0, 6),
      agents:
        speakers.size > 1
          ? (out.by_agent ?? [])
              .map((a) => ({ label: clip(a.agent, 40), did: (a.did ?? []).map((d) => clip(d, 200)).filter(Boolean).slice(0, 5) }))
              .filter((a) => a.label && a.did.length)
              .slice(0, 5)
          : [],
      made: job ? job.artifacts.map((a) => ({ label: a.label, href: a.href })) : [],
      job: job ? { label: playbookOf(job.kind)?.label ?? job.kind, client: job.client?.name ?? null, status: job.status } : null,
    };
    const topic = parseTopic(out);
    await admin.from("ai_role_calls").update({ notes, summary: notes.summary || null, ...(topic ? { topic } : {}) }).eq("id", callId);
    if (notes.followUps.length) await saveFollowUps(admin, { callId, profileId: call.profile_id as string, roleKey: call.role_key as string, followUps: notes.followUps });
    return notes;
  } catch (e) {
    console.error("[assistant notes]", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * The call's follow-ups as reminders on the person's Overview: ONE per client (a checklist, its items ticked off one
 * by one, with the call's transcript to open) and one for everything about no client, never a row for each
 */
async function saveFollowUps(admin: SupabaseClient, c: { callId: string; profileId: string; roleKey: string; followUps: CallNotes["followUps"] }) {
  const { data: clients } = await admin.from("clients").select("id, name").is("archived_at", null).limit(500);
  const known = (clients ?? []) as { id: string; name: string }[];
  const find = (name: string | null | undefined) => {
    const n = String(name ?? "").trim().toLowerCase();
    if (!n) return null;
    return known.find((k) => k.name.toLowerCase() === n) ?? known.find((k) => n.length > 2 && (k.name.toLowerCase().includes(n) || n.includes(k.name.toLowerCase()))) ?? null;
  };
  const { followUpReminders } = await import("@/lib/agent-call/ask-groups");
  const reminders = followUpReminders(
    c.followUps.map((f) => {
      const k = find(f.client);
      return { what: f.what, due: f.due, clientId: k?.id ?? null, client: k?.name ?? null };
    }),
  );
  for (const r of reminders) {
    const base = { kind: "reminder", owner_id: c.profileId, asked_by: c.profileId, role_key: c.roleKey, call_id: c.callId, client_id: r.clientId, title: r.title, detail: "", due_on: r.due };
    const { error } = await admin.from("agent_asks").insert({ ...base, checklist: r.checklist, with_transcript: true });
    // Before the checklist's migration: the items go in the detail instead
    if (error) await admin.from("agent_asks").insert({ ...base, detail: r.checklist.map((i) => `- ${i.text}`).join("\n").slice(0, 2000) });
  }
}
