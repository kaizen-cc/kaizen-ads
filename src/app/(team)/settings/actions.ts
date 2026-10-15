"use server";

import { revalidatePath } from "next/cache";
import { AiUnavailable, askJson, forgetAgent, type AgentKey } from "@/lib/ai";
import { requireExec } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };
type Kind = "knowledge" | "skill" | "example";

const KINDS: Kind[] = ["knowledge", "skill", "example"];
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high"];

function done(error?: { message: string } | null): ActionResult {
  forgetAgent();
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Model, effort and instructions. The next call of this agent uses them (within a minute on every server). */
export async function saveAgentSetup(key: AgentKey, v: { model: string; effort: string; instructions: string }): Promise<ActionResult> {
  const me = await requireExec();
  if (!MODELS.includes(v.model)) return { ok: false, error: "Pick a model." };
  if (!EFFORTS.includes(v.effort)) return { ok: false, error: "Pick an effort." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_agents")
    .update({ model: v.model, effort: v.effort, instructions: v.instructions.trim().slice(0, 20000), updated_by: me.id, updated_at: new Date().toISOString() })
    .eq("key", key);
  return done(error);
}

/** agentKey null = shared: every agent reads it. */
export async function addItem(v: { agentKey: string | null; kind: Kind; title: string; body: string; fileName?: string | null }): Promise<ActionResult> {
  const me = await requireExec();
  if (!v.title.trim() || !v.body.trim()) return { ok: false, error: "Give it a title and some content." };
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").insert({
    agent_key: v.agentKey,
    kind: KINDS.includes(v.kind) ? v.kind : "knowledge",
    title: v.title.trim().slice(0, 200),
    body: v.body.trim().slice(0, 60000),
    file_name: v.fileName ?? null,
    created_by: me.id,
  });
  return done(error);
}

export async function updateItem(id: string, v: { kind: Kind; title: string; body: string }): Promise<ActionResult> {
  await requireExec();
  if (!v.title.trim() || !v.body.trim()) return { ok: false, error: "Give it a title and some content." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_knowledge")
    .update({ kind: KINDS.includes(v.kind) ? v.kind : "knowledge", title: v.title.trim().slice(0, 200), body: v.body.trim().slice(0, 60000), updated_at: new Date().toISOString() })
    .eq("id", id);
  return done(error);
}

export async function setItemActive(id: string, active: boolean): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
  return done(error);
}

export async function deleteItem(id: string): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").delete().eq("id", id);
  return done(error);
}

// ─── Coach: chat with an agent's playbook ──────────────────────────────────

export type Change = {
  op: "set_instructions" | "update_item" | "add_item" | "turn_off_item" | "set_model";
  item_id: string;
  kind: "" | Kind;
  scope: "" | "agent" | "shared";
  title: string;
  body: string;
  model: "" | "opus" | "sonnet" | "haiku";
  effort: "" | "low" | "medium" | "high";
  reason: string;
  applied?: boolean;
};
export type ChatMessage = { id: number; role: "user" | "coach"; content: string; changes: Change[]; at: string };

const s = { type: "string" };
const COACH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "changes"],
  properties: {
    reply: s,
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "item_id", "kind", "scope", "title", "body", "model", "effort", "reason"],
        properties: {
          op: { type: "string", enum: ["set_instructions", "update_item", "add_item", "turn_off_item", "set_model"] },
          item_id: s,
          kind: { type: "string", enum: ["", "knowledge", "skill", "example"] },
          scope: { type: "string", enum: ["", "agent", "shared"] },
          title: s,
          body: s,
          model: { type: "string", enum: ["", "opus", "sonnet", "haiku"] },
          effort: { type: "string", enum: ["", "low", "medium", "high"] },
          reason: s,
        },
      },
    },
  },
};

const COACH_SYSTEM = `You coach the AI agents inside Kaizen Ads, the app Kaizen Marketing (a paid social agency) uses for creative requests, approvals, launches and KPIs.
An executive is chatting with you about ONE agent. They give feedback ("the briefs are too generic", "never mention competitors", "here's how we want headlines"). Your job is to turn that feedback into precise edits to the agent's playbook, so the agent does better next time.

The playbook has:
- instructions: the agent's main guidance (one text). Edit it for rules about how the agent thinks, priorities, tone and hard rules.
- skills: named methods to follow (frameworks, checklists, step-by-step procedures).
- knowledge: reference facts (brand rules, policies, offers, how Kaizen works).
- examples: what good output looks like.
- shared items are read by every agent; agent items only by this one.
- model (opus = deepest and slowest, sonnet = strong and quick, haiku = fastest and cheapest) and effort (low, medium, high).

How to propose changes:
- Find where the feedback belongs. Prefer editing the existing skill or instruction that covers it over adding a new item. Don't duplicate rules that already exist.
- set_instructions: body is the COMPLETE new instructions text (keep everything that still applies, change only what the feedback touches).
- update_item: item_id of the item, title, kind, and body as the COMPLETE new text.
- add_item: scope "agent" (default) or "shared" only if the rule clearly applies to every agent; kind, title, body.
- turn_off_item: item_id only, when something is wrong or outdated.
- set_model: model and effort, only when the feedback is about speed, cost or depth.
- Leave unused fields as empty strings. reason: one short sentence on why.
- Write every edit as a Kaizen standard, in roles (the Head of Creative, the copywriter, media buyers, customer success), never people's names. "Camille wants shorter headlines" becomes "Keep headlines under 30 characters." Client names belong only in client memory, not in a playbook.
- If the feedback is vague, ask one clarifying question in reply and propose no changes. If it's a question about the agent, answer it from the playbook.
reply: 1 to 3 sentences, plain and direct, saying what you'd change (the exec applies each change with a click).`;

export async function chatWithCoach(key: AgentKey, message: string): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; error: string }> {
  const me = await requireExec();
  const text = message.trim();
  if (!text) return { ok: false, error: "Write something first." };
  const supabase = await createClient();
  const [{ data: agent }, { data: items }, { data: history }] = await Promise.all([
    supabase.from("ai_agents").select("key, label, description, model, effort, instructions, live").eq("key", key).maybeSingle(),
    supabase.from("ai_knowledge").select("id, agent_key, kind, title, body, active").or(`agent_key.eq.${key},agent_key.is.null`).order("created_at"),
    supabase.from("ai_agent_chats").select("role, content, changes").eq("agent_key", key).order("created_at", { ascending: false }).limit(16),
  ]);
  if (!agent) return { ok: false, error: "Unknown agent." };

  const playbook = [
    `<agent key="${agent.key}" name="${agent.label}" model="${agent.model}" effort="${agent.effort}" ${agent.live ? "in use" : "not wired into the app yet"}>`,
    `<description>${agent.description}</description>`,
    `<instructions>\n${agent.instructions || "(empty)"}\n</instructions>`,
    ...(items ?? []).map(
      (k) => `<item id="${k.id}" kind="${k.kind}" scope="${k.agent_key ? "agent" : "shared"}" ${k.active ? "" : 'off="true" '}title="${k.title.replace(/"/g, "'")}">\n${k.body}\n</item>`,
    ),
    "</agent>",
  ].join("\n");
  const convo = (history ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.role === "user" ? "Exec" : "You"}: ${m.content}${m.role === "coach" && (m.changes as Change[]).length ? ` [proposed ${(m.changes as Change[]).map((c) => `${c.op}${c.title ? ` "${c.title}"` : ""}${c.applied ? " (applied)" : ""}`).join(", ")}]` : ""}`)
    .join("\n");

  try {
    const out = await askJson<{ reply: string; changes: Change[] }>({
      agent: "coach",
      label: `coach ${key}`,
      system: COACH_SYSTEM,
      schema: COACH_SCHEMA,
      prompt: `${playbook}\n\n<conversation_so_far>\n${convo || "(new conversation)"}\n</conversation_so_far>\n\n<exec_says>\n${text}\n</exec_says>`,
    });
    const known = new Set((items ?? []).map((k) => k.id));
    const changes = out.changes
      .filter((c) => (c.op === "update_item" || c.op === "turn_off_item" ? known.has(c.item_id) : true))
      .map((c) => ({ ...c, applied: false }));
    await supabase.from("ai_agent_chats").insert([
      { agent_key: key, role: "user", content: text.slice(0, 8000), created_by: me.id },
      { agent_key: key, role: "coach", content: out.reply, changes, created_by: me.id },
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The coach couldn't answer. Try again." };
  }
  return { ok: true, messages: await loadChat(key) };
}

export async function loadChat(key: AgentKey): Promise<ChatMessage[]> {
  await requireExec();
  const supabase = await createClient();
  const { data } = await supabase.from("ai_agent_chats").select("id, role, content, changes, created_at").eq("agent_key", key).order("created_at").limit(200);
  return (data ?? []).map((m) => ({ id: m.id, role: m.role as "user" | "coach", content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at }));
}

/** Apply one of the coach's proposed edits. */
export async function applyChange(key: AgentKey, chatId: number, index: number): Promise<ActionResult> {
  const me = await requireExec();
  const supabase = await createClient();
  const { data: msg } = await supabase.from("ai_agent_chats").select("changes").eq("id", chatId).eq("agent_key", key).maybeSingle();
  const changes = (msg?.changes ?? []) as Change[];
  const c = changes[index];
  if (!c) return { ok: false, error: "That change isn't there any more." };
  if (c.applied) return { ok: true };

  let error: { message: string } | null = null;
  if (c.op === "set_instructions") {
    ({ error } = await supabase.from("ai_agents").update({ instructions: c.body.trim(), updated_by: me.id, updated_at: new Date().toISOString() }).eq("key", key));
  } else if (c.op === "set_model") {
    const patch: Record<string, string> = { updated_by: me.id, updated_at: new Date().toISOString() };
    if (MODELS.includes(c.model)) patch.model = c.model;
    if (EFFORTS.includes(c.effort)) patch.effort = c.effort;
    ({ error } = await supabase.from("ai_agents").update(patch).eq("key", key));
  } else if (c.op === "update_item") {
    ({ error } = await supabase
      .from("ai_knowledge")
      .update({ title: c.title.trim() || undefined, body: c.body.trim(), ...(c.kind ? { kind: c.kind } : {}), active: true, updated_at: new Date().toISOString() })
      .eq("id", c.item_id));
  } else if (c.op === "add_item") {
    ({ error } = await supabase.from("ai_knowledge").insert({
      agent_key: c.scope === "shared" ? null : key,
      kind: c.kind || "skill",
      title: c.title.trim() || "From the coach",
      body: c.body.trim(),
      created_by: me.id,
    }));
  } else if (c.op === "turn_off_item") {
    ({ error } = await supabase.from("ai_knowledge").update({ active: false, updated_at: new Date().toISOString() }).eq("id", c.item_id));
  }
  if (error) return { ok: false, error: error.message };
  changes[index] = { ...c, applied: true };
  await supabase.from("ai_agent_chats").update({ changes }).eq("id", chatId);
  return done();
}

export async function clearChat(key: AgentKey): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_agent_chats").delete().eq("agent_key", key);
  return done(error);
}
