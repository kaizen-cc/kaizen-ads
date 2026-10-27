"use server";

import { revalidatePath } from "next/cache";
import { AGENT_MOMENTS } from "@/lib/agent-moments";
import { AiUnavailable, askJson, forgetAgent, type AgentKey } from "@/lib/ai";
import { requireExec } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readShared, SHARED_RULES, type AgentFile, type Attachment } from "@/lib/agent-docs";

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
  op: "set_instructions" | "update_item" | "add_item" | "turn_off_item" | "set_model" | "set_core";
  item_id: string;
  kind: "" | Kind;
  scope: "" | "agent" | "shared";
  title: string;
  body: string;
  model: "" | "opus" | "sonnet" | "haiku";
  effort: "" | "low" | "medium" | "high";
  reason: string;
  /** In the agent chat: the skill key it touches, or "core" for the agent's core */
  skill?: string;
  applied?: boolean;
};
export type ChatMessage = { id: number; role: "user" | "coach"; content: string; changes: Change[]; at: string; attachments?: Attachment[] };

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
An executive is chatting with you about ONE skill of one of Kaizen's six agents (Strategist, Creative Director, Copywriter, Media Buyer, Market Analyst, Account Manager). They give feedback ("the briefs are too generic", "never mention competitors", "here's how we want headlines"). Your job is to turn that feedback into precise edits to the agent's playbook, so the agent does better next time.

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
- You only improve this skill. Never propose a new agent or a new skill; if the feedback belongs to another skill or agent, say which one in reply.
- Kaizen's strategy spine and the agent's core are not yours to edit. If feedback contradicts the spine, say so and propose no change.
- If the feedback is vague, ask one clarifying question in reply and propose no changes. If it's a question about the agent, answer it from the playbook.
reply: 1 to 3 sentences, plain and direct, saying what you'd change (the exec applies each change with a click).`;

export async function chatWithCoach(key: AgentKey, message: string, files: AgentFile[] = []): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; error: string }> {
  const me = await requireExec();
  const text = message.trim();
  if (!text && !files.length) return { ok: false, error: "Write something first." };
  const supabase = await createClient();
  const [{ data: agent }, { data: items }, { data: history }] = await Promise.all([
    supabase.from("ai_agents").select("key, label, description, model, effort, instructions, live, ai_roles(label, core)").eq("key", key).maybeSingle(),
    supabase.from("ai_knowledge").select("id, agent_key, kind, title, body, active").or(`agent_key.eq.${key},agent_key.is.null`).order("created_at"),
    supabase.from("ai_agent_chats").select("role, content, changes").eq("agent_key", key).order("created_at", { ascending: false }).limit(16),
  ]);
  if (!agent) return { ok: false, error: "Unknown agent." };
  const { data: spine } = await supabase.from("ai_spine").select("body").eq("id", 1).maybeSingle();
  const role = agent.ai_roles as unknown as { label: string; core: string } | null;

  const playbook = [
    `<kaizen_strategy read_only="true">
${spine?.body ?? ""}
</kaizen_strategy>`,
    role ? `<agent_core agent="${role.label}" read_only="true">
${role.core}
</agent_core>` : "",
    `<skill key="${agent.key}" name="${agent.label}" of="${role?.label ?? "no agent"}" model="${agent.model}" effort="${agent.effort}" ${agent.live ? "in use" : "not wired into the app yet"}>`,
    `<description>${agent.description}</description>`,
    `<instructions>\n${agent.instructions || "(empty)"}\n</instructions>`,
    ...(items ?? []).map(
      (k) => `<item id="${k.id}" kind="${k.kind}" scope="${k.agent_key ? "agent" : "shared"}" ${k.active ? "" : 'off="true" '}title="${k.title.replace(/"/g, "'")}">\n${k.body}\n</item>`,
    ),
    "</skill>",
  ]
    .filter(Boolean)
    .join("\n");
  const convo = (history ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.role === "user" ? "Exec" : "You"}: ${m.content}${m.role === "coach" && (m.changes as Change[]).length ? ` [proposed ${(m.changes as Change[]).map((c) => `${c.op}${c.title ? ` "${c.title}"` : ""}${c.applied ? " (applied)" : ""}`).join(", ")}]` : ""}`)
    .join("\n");

  try {
    const shared = await readShared(createAdminClient(), key, files, text);
    const out = await askJson<{ reply: string; changes: Change[] }>({
      agent: "coach",
      label: `coach ${key}`,
      system: `${COACH_SYSTEM}\n${SHARED_RULES}`,
      schema: COACH_SCHEMA,
      images: shared.images,
      pdfs: shared.pdfs,
      prompt: `${playbook}\n\n<conversation_so_far>\n${convo || "(new conversation)"}\n</conversation_so_far>\n\n${shared.block}\n\n<exec_says>\n${text || "(shared the material above)"}\n</exec_says>`,
    });
    const known = new Set((items ?? []).map((k) => k.id));
    const changes = out.changes
      .filter((c) => (c.op === "update_item" || c.op === "turn_off_item" ? known.has(c.item_id) : true))
      .map((c) => ({ ...c, applied: false }));
    await supabase.from("ai_agent_chats").insert([
      { agent_key: key, role: "user", content: text.slice(0, 8000), attachments: shared.attachments, created_by: me.id },
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
  const { data } = await supabase.from("ai_agent_chats").select("id, role, content, changes, attachments, created_at").eq("agent_key", key).order("created_at").limit(200);
  return (data ?? []).map((m) => ({ id: m.id, role: m.role as "user" | "coach", content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at, attachments: (m.attachments ?? []) as Attachment[] }));
}

type Db = Awaited<ReturnType<typeof createClient>>;

/** Write one proposed edit to a skill's playbook. set_core edits the agent's core (only the agent chat proposes it). */
async function writeChange(supabase: Db, me: { id: string }, key: string, c: Change, roleKey?: string): Promise<{ message: string } | null> {
  const now = new Date().toISOString();
  if (c.op === "set_core") {
    if (!roleKey) return { message: "Change the core from the agent's page." };
    return (await supabase.from("ai_roles").update({ core: c.body.trim().slice(0, 20000), updated_by: me.id, updated_at: now }).eq("key", roleKey)).error;
  }
  if (c.op === "set_instructions") return (await supabase.from("ai_agents").update({ instructions: c.body.trim().slice(0, 20000), updated_by: me.id, updated_at: now }).eq("key", key)).error;
  if (c.op === "set_model") {
    const patch: Record<string, string> = { updated_by: me.id, updated_at: now };
    if (MODELS.includes(c.model)) patch.model = c.model;
    if (EFFORTS.includes(c.effort)) patch.effort = c.effort;
    return (await supabase.from("ai_agents").update(patch).eq("key", key)).error;
  }
  if (c.op === "update_item")
    return (
      await supabase
        .from("ai_knowledge")
        .update({ title: c.title.trim() || undefined, body: c.body.trim(), ...(c.kind ? { kind: c.kind } : {}), active: true, updated_at: now })
        .eq("id", c.item_id)
    ).error;
  if (c.op === "add_item")
    return (
      await supabase.from("ai_knowledge").insert({
        // The agent chat only ever writes to its own skills; the skill coach may add a shared item
        agent_key: c.scope === "shared" && !roleKey ? null : key,
        kind: c.kind || "skill",
        title: c.title.trim() || "From the coach",
        body: c.body.trim(),
        created_by: me.id,
      })
    ).error;
  if (c.op === "turn_off_item") return (await supabase.from("ai_knowledge").update({ active: false, updated_at: now }).eq("id", c.item_id)).error;
  return null;
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
  const error = await writeChange(supabase, me, key, c);
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

// ─── Talk to the whole agent ───────────────────────────────────────────────
// An exec talks to the Media Buyer (not one of its skills) like an employee. It knows its core and every skill's
// playbook, answers how it works, and turns feedback into edits wherever they belong: the core when it's about
// everything it does, the one skill whose work it's about, or each skill it touches. Applied on click, like the coach.

export type RoleChatMessage = { id: number; role: "user" | "agent"; content: string; changes: Change[]; at: string; attachments?: Attachment[] };

const ROLE_SCHEMA = {
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
        required: ["op", "skill", "item_id", "kind", "title", "body", "model", "effort", "reason"],
        properties: {
          op: { type: "string", enum: ["set_core", "set_instructions", "update_item", "add_item", "turn_off_item", "set_model"] },
          skill: s,
          item_id: s,
          kind: { type: "string", enum: ["", "knowledge", "skill", "example"] },
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

const roleSystem = (label: string) => `You are the ${label}, one of the six AI agents inside Kaizen Ads, the app Kaizen Marketing (a paid social agency) uses for creative requests, approvals, launches and KPIs.
An executive is talking to you the way they'd talk to an employee in that role: asking how you work, why you do something, or giving you feedback ("you're too wordy in briefs", "always check frequency before calling fatigue"). Speak as yourself, in the first person ("I check…", "In my briefs I…").

You work through your core (what you always do, read before any of your skills) and your skills (each one a job you do somewhere in the app, with its own instructions and playbook items: skills are methods, knowledge is facts, examples are what good looks like). Kaizen's strategy sits above all of it.

When they give feedback, change yourself so you do better next time:
- Decide where it belongs. If it's about everything you do (tone, priorities, a hard rule for all your work), it goes in your core with set_core. If it's about one job, it goes in that skill: edit the instruction or item that already covers it. If it touches two or three jobs but not all, propose one change per skill. Never duplicate a rule that already lives in your core or a skill.
- Prefer editing what exists over adding. Use add_item only when nothing covers it.
- set_core: body is the COMPLETE new core (keep everything that still applies, change only what the feedback touches). skill "core".
- set_instructions: skill = that skill's key; body is the COMPLETE new instructions for that skill.
- update_item: item_id of the item, title, kind, and body as the COMPLETE new text. Never update an item marked truncated; add a short item next to it instead. skill = the item's skill key.
- add_item: skill = the skill key it belongs to; kind, title, body.
- turn_off_item: item_id only (and its skill), when something is wrong or outdated.
- set_model: skill, model and effort, only when the feedback is about speed, cost or depth for that job.
- Leave unused fields as empty strings. reason: one short sentence on why, naming the job it changes.
- Write every edit as a Kaizen standard, in roles (the Head of Creative, the copywriter, media buyers, customer success), never people's names. Client names belong only in client memory, not in your playbook.
- You can't create new agents or new skills, and you don't edit shared knowledge or Kaizen's strategy. If feedback contradicts the strategy, say so and propose no change. If it belongs to another agent, say which one.
- If the feedback is vague, ask one clarifying question and propose no changes. If it's a question, answer it from your core and skills, plainly and specifically.

reply: plain text, conversational, like a sharp colleague. No markdown, no asterisks, no bullet symbols, no headings, no emojis. Usually 1 to 4 sentences; longer only when they ask you to explain how you work. When you propose changes, say in a sentence what you'd change and where (the exec applies each change with a click). Refer to people by role, never by name.`;

// Keep the agent's whole playbook within a sensible prompt: long items show their start and are marked truncated
const ITEM_CAP = 6000;
const PLAYBOOK_CAP = 90000;

export async function chatWithAgent(roleKey: string, message: string, files: AgentFile[] = []): Promise<{ ok: true; messages: RoleChatMessage[] } | { ok: false; error: string }> {
  const me = await requireExec();
  const text = message.trim();
  if (!text && !files.length) return { ok: false, error: "Write something first." };
  const supabase = await createClient();
  const [{ data: role }, { data: skills }, { data: spine }, { data: history }] = await Promise.all([
    supabase.from("ai_roles").select("key, label, description, core").eq("key", roleKey).maybeSingle(),
    supabase.from("ai_agents").select("key, label, description, model, effort, instructions, live").eq("role_key", roleKey).order("sort_order"),
    supabase.from("ai_spine").select("body").eq("id", 1).maybeSingle(),
    supabase.from("ai_role_chats").select("role, content, changes").eq("role_key", roleKey).order("created_at", { ascending: false }).limit(16),
  ]);
  if (!role) return { ok: false, error: "Unknown agent." };
  const keys = (skills ?? []).map((k) => k.key as string);
  const [{ data: items }, { data: shared }] = await Promise.all([
    keys.length ? supabase.from("ai_knowledge").select("id, agent_key, kind, title, body, active").in("agent_key", keys).order("created_at") : Promise.resolve({ data: [] as never[] }),
    supabase.from("ai_knowledge").select("title").is("agent_key", null).eq("active", true).order("created_at"),
  ]);

  let budget = PLAYBOOK_CAP;
  const truncated = new Set<string>();
  const itemXml = (k: { id: string; kind: string; title: string; body: string; active: boolean }) => {
    const room = Math.max(400, Math.min(ITEM_CAP, budget));
    const cut = k.body.length > room;
    if (cut) truncated.add(k.id);
    budget -= Math.min(k.body.length, room);
    return `<item id="${k.id}" kind="${k.kind}" ${k.active ? "" : 'off="true" '}${cut ? 'truncated="true" ' : ""}title="${k.title.replace(/"/g, "'")}">\n${cut ? `${k.body.slice(0, room)}…` : k.body}\n</item>`;
  };
  const playbook = [
    `<kaizen_strategy read_only="true">\n${spine?.body ?? ""}\n</kaizen_strategy>`,
    `<me agent="${role.label}">\n<description>${role.description}</description>\n<core>\n${role.core || "(empty)"}\n</core>\n</me>`,
    ...(skills ?? []).map((sk) =>
      [
        `<skill key="${sk.key}" name="${sk.label}" model="${sk.model}" effort="${sk.effort}" ${sk.live ? "in use" : "not wired into the app yet"}>`,
        `<description>${sk.description}</description>`,
        (AGENT_MOMENTS[sk.key] ?? []).length ? `<where_it_runs>\n${AGENT_MOMENTS[sk.key].map((m) => `${m.title} (${m.where}; ${m.when})`).join("\n")}\n</where_it_runs>` : "",
        `<instructions>\n${sk.instructions || "(empty)"}\n</instructions>`,
        ...(items ?? []).filter((k) => k.agent_key === sk.key).map(itemXml),
        "</skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    shared?.length ? `<shared_knowledge read_only="true">\n${shared.map((k) => k.title).join("\n")}\n</shared_knowledge>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const convo = (history ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.role === "user" ? "Exec" : "You"}: ${m.content}${m.role === "agent" && (m.changes as Change[]).length ? ` [proposed ${(m.changes as Change[]).map((c) => `${c.op} on ${c.skill}${c.title ? ` "${c.title}"` : ""}${c.applied ? " (applied)" : ""}`).join(", ")}]` : ""}`)
    .join("\n");

  try {
    const shared = await readShared(createAdminClient(), roleKey, files, text);
    const out = await askJson<{ reply: string; changes: Change[] }>({
      agent: "coach",
      label: `agent chat ${roleKey}`,
      system: `${roleSystem(role.label)}\n${SHARED_RULES}`,
      schema: ROLE_SCHEMA,
      images: shared.images,
      pdfs: shared.pdfs,
      prompt: `${playbook}\n\n<conversation_so_far>\n${convo || "(new conversation)"}\n</conversation_so_far>\n\n${shared.block}\n\n<exec_says>\n${text || "(shared the material above)"}\n</exec_says>`,
    });
    // Only edits to this agent's own core, skills and items survive; an item edit is filed under the item's real skill
    const owner = new Map((items ?? []).map((k) => [k.id as string, k.agent_key as string]));
    const changes = out.changes
      .map((c): Change | null => {
        if (c.op === "set_core") return { ...c, skill: "core", item_id: "" };
        if (c.op === "update_item" || c.op === "turn_off_item") {
          const k = owner.get(c.item_id);
          if (!k || (c.op === "update_item" && truncated.has(c.item_id))) return null;
          return { ...c, skill: k };
        }
        return keys.includes(c.skill ?? "") ? c : null;
      })
      .filter((c): c is Change => Boolean(c))
      .map((c) => ({ ...c, scope: "agent" as const, applied: false }));
    // Plain words: no markdown emphasis or emojis, whatever the model does
    const reply = out.reply.replace(/\*\*|__|(^|\s)[*#]+\s/gm, "$1").replace(/\p{Extended_Pictographic}️?/gu, "").trim();
    const { error } = await supabase.from("ai_role_chats").insert([
      { role_key: roleKey, role: "user", content: text.slice(0, 8000), attachments: shared.attachments, created_by: me.id },
      { role_key: roleKey, role: "agent", content: reply, changes, created_by: me.id },
    ]);
    if (error) return { ok: false, error: error.message };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : `The ${role.label} couldn't answer. Try again.` };
  }
  return { ok: true, messages: await loadRoleChat(roleKey) };
}

export async function loadRoleChat(roleKey: string): Promise<RoleChatMessage[]> {
  await requireExec();
  const supabase = await createClient();
  const { data } = await supabase.from("ai_role_chats").select("id, role, content, changes, attachments, created_at").eq("role_key", roleKey).order("created_at").limit(200);
  return (data ?? []).map((m) => ({ id: m.id, role: m.role as "user" | "agent", content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at, attachments: (m.attachments ?? []) as Attachment[] }));
}

/** Apply one edit the agent proposed, checking it still lands on this agent's own core, skills or items. */
export async function applyRoleChange(roleKey: string, chatId: number, index: number): Promise<ActionResult> {
  const me = await requireExec();
  const supabase = await createClient();
  const { data: msg } = await supabase.from("ai_role_chats").select("changes").eq("id", chatId).eq("role_key", roleKey).maybeSingle();
  const changes = (msg?.changes ?? []) as Change[];
  const c = changes[index];
  if (!c) return { ok: false, error: "That change isn't there any more." };
  if (c.applied) return { ok: true };

  let key = c.skill ?? "";
  if (c.op === "update_item" || c.op === "turn_off_item") {
    const { data: item } = await supabase.from("ai_knowledge").select("agent_key").eq("id", c.item_id).maybeSingle();
    if (!item?.agent_key) return { ok: false, error: "That item isn't there any more." };
    key = item.agent_key;
  }
  if (c.op !== "set_core") {
    const { data: skill } = await supabase.from("ai_agents").select("key").eq("key", key).eq("role_key", roleKey).maybeSingle();
    if (!skill) return { ok: false, error: "That isn't one of this agent's skills." };
  }
  const error = await writeChange(supabase, me, key, { ...c, scope: "agent" }, roleKey);
  if (error) return { ok: false, error: error.message };
  changes[index] = { ...c, applied: true };
  await supabase.from("ai_role_chats").update({ changes }).eq("id", chatId);
  return done();
}

export async function clearRoleChat(roleKey: string): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_role_chats").delete().eq("role_key", roleKey);
  return done(error);
}

/** An agent's core: what every one of its skills reads before its own playbook. */
export async function saveRoleCore(key: string, core: string): Promise<ActionResult> {
  const me = await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_roles").update({ core: core.trim().slice(0, 20000), updated_by: me.id, updated_at: new Date().toISOString() }).eq("key", key);
  return done(error);
}

/** Kaizen's strategy spine: every agent reads it first. Execs only; the Coach never edits it. */
export async function saveSpine(body: string): Promise<ActionResult> {
  const me = await requireExec();
  const text = body.trim();
  if (text.length < 40) return { ok: false, error: "The spine can't be empty." };
  const supabase = await createClient();
  const { error } = await supabase.from("ai_spine").update({ body: text.slice(0, 20000), updated_by: me.id, updated_at: new Date().toISOString() }).eq("id", 1);
  return done(error);
}
