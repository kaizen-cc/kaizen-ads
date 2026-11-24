import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { execOnMeeting, meetingRef, ownerFor, peopleMatter, type Teammate } from "./meeting-actions-core";

// An internal meeting with an executive on it: its action items, each a task for the teammate who owns it (on their
// Overview, closed from evidence like any other). Read once per meeting (marked on the call's summary), deduped
// against work already done or in motion, and never a task for someone the notes don't clearly name.

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          owner: { type: "string", description: "The teammate who owns it, exactly as named in the team list" },
          task: { type: "string", description: "What they'll do, as a short task title" },
          detail: { type: "string", description: "The context from the meeting they need to do it (what, for whom, how), a few lines" },
          client: { type: "string", description: "The client it's for, exactly as in the client list, or empty" },
          due_days: { type: "integer", description: "Business days from the meeting it's due (as said, else 2)" },
          personnel: { type: "boolean", description: "True when the item touches a teammate's performance, conduct, discipline, firing or hiring, pay, health or personal life" },
          about: { type: "array", items: { type: "string" }, description: "Teammates (team-list names) the item is ABOUT, other than its owner; empty if none" },
        },
        required: ["owner", "task", "detail", "client", "due_days", "personnel", "about"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM = `You read the notes of an internal meeting at Kaizen, a marketing agency, and list its action items: what someone in the meeting said they (or a named teammate) will do. Only real commitments with a clear owner from the team list; not ideas floated, not things already done in the meeting, not the client's own to-dos. One item per piece of work; keep the specifics that were said (the client, the scope, the audit's focus, the deadline). Refer to people by the name in the team list. If nothing was committed, return no items.
People matters stay with leadership: anything about a teammate's performance, conduct, discipline, firing or hiring, pay, health or personal life is marked personnel (it is never filed as a task), and every teammate an item is about is listed in "about". Never phrase a task so it reveals what was said about someone.`;

type Call = { id: string; title: string; notes: string | null; host: string | null; attendees: string[] | null; occurred_at: string; summary: Record<string, unknown> | null };

/** Files the action items of one internal meeting (when an exec was on it), once. Returns how many tasks were made. */
export async function meetingActionItems(admin: SupabaseClient, callId: string): Promise<number> {
  const { data: call } = await admin.from("client_calls").select("id, title, notes, host, attendees, occurred_at, summary").eq("id", callId).maybeSingle();
  const c = call as Call | null;
  if (!c?.notes || (c.summary as { actions_read?: boolean } | null)?.actions_read) return 0;
  const { data: people } = await admin.from("profiles").select("id, full_name, email, is_exec").eq("is_active", true);
  const team = (people ?? []) as Teammate[];
  const mark = () => admin.from("client_calls").update({ summary: { ...(c.summary ?? {}), actions_read: true } }).eq("id", callId);
  if (!execOnMeeting(c.host, c.attendees, team)) {
    await mark();
    return 0;
  }
  const { data: clients } = await admin.from("clients").select("id, name").is("archived_at", null).limit(800);
  const known = (clients ?? []) as { id: string; name: string }[];
  const out = await askJson<{ items: { owner: string; task: string; detail: string; client: string; due_days: number; personnel?: boolean; about?: string[] }[] }>({
    agent: "calls",
    label: "meeting action items",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 3000,
    prompt: `Team:\n${team.map((t) => t.full_name).filter(Boolean).join("\n")}\n\nClients:\n${known.map((k) => k.name).join("\n")}\n\nMeeting: "${c.title}" on ${c.occurred_at.slice(0, 10)}\n\n<notes>\n${c.notes.slice(0, 60_000)}\n</notes>`,
  });
  const host = team.find((t) => t.email && t.email.toLowerCase() === String(c.host ?? "").toLowerCase()) ?? null;
  const items = (out.items ?? []).slice(0, 20).map((it, i) => ({ ...it, i, who: ownerFor(it.owner, team), client: known.find((k) => k.name.toLowerCase() === String(it.client ?? "").trim().toLowerCase()) ?? null }));
  // Deduped against reality: work already done or in motion isn't filed again
  const { loadReality } = await import("@/lib/reality-check");
  const { decide } = await import("@/lib/reality-check-core");
  const found = await loadReality(admin, { clientIds: items.map((it) => it.client?.id ?? null), ownerIds: items.map((it) => it.who?.id ?? null) }).catch(() => []);
  let made = 0;
  for (const it of items) {
    if (!it.who || !it.task.trim()) continue;
    // People matters never become tasks, and nobody is given a task drawn from a conversation about them
    if (peopleMatter(it, team)) continue;
    if (decide({ title: it.task, clientId: it.client?.id ?? null, ownerId: it.who.id }, found).state !== "new") continue;
    const ref = meetingRef(callId, it.i);
    const { data: had } = await admin.from("agent_asks").select("id").eq("source_ref", ref).maybeSingle();
    if (had) continue;
    const { data: due } = await admin.rpc("add_business_days", { p_ts: c.occurred_at, p_days: Math.max(1, Math.min(20, Number(it.due_days) || 2)) });
    const { error } = await admin.from("agent_asks").insert({
      kind: "task",
      owner_id: it.who.id,
      asked_by: host?.id ?? it.who.id,
      client_id: it.client?.id ?? null,
      title: it.task.slice(0, 200),
      detail: `${it.detail.slice(0, 1500)}\n\nFrom "${c.title}" (${c.occurred_at.slice(0, 10)}).`,
      due_on: due ? String(due).slice(0, 10) : null,
      source_ref: ref,
    });
    if (!error) made++;
  }
  await mark();
  return made;
}

/** Internal meetings of the last two days not read for action items yet (a few per run) */
export async function sweepMeetingActions(admin: SupabaseClient, max = 4): Promise<number> {
  const { data } = await admin
    .from("client_calls")
    .select("id, summary")
    .eq("status", "internal")
    .gte("occurred_at", new Date(Date.now() - 2 * 86_400_000).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(40);
  let made = 0;
  let ran = 0;
  for (const r of (data ?? []) as { id: string; summary: Record<string, unknown> | null }[]) {
    if (ran >= max) break;
    if (r.summary?.actions_read) continue;
    ran++;
    made += await meetingActionItems(admin, r.id).catch(() => 0);
  }
  return made;
}
