import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTrainAgent } from "@/lib/agent-access";
import { logTraining } from "@/lib/agent-training";
import { AiUnavailable, MODEL_IDS, aiBusy, aiEnabled, anthropicClient, askJson, cachedBlock, usageFor } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { loadRolePlaybook, type RolePlaybook } from "@/lib/role-playbook";
import { CALL_LIMIT_SECONDS, LEARNINGS_SCHEMA, firstNameOf, parseLearnings, type CallEvent, type LearnedItem, type Learning } from "./core";

// A voice call with one of the AI agents, on the server: the call's row (who, which agent, how long, what it cost and
// learned), each turn (the agent's answer streamed from Claude as it's written, from the same playbook its chat reads,
// in a speaking style), and what the person taught it (saved to its skills straight away, or sent to its chat as a
// proposed edit when it would rewrite its core or a skill's instructions).

export type CallRow = { id: string; role_key: string; profile_id: string; voice_id: string | null; stt: string | null; started_at: string; ended_at: string | null; learned: LearnedItem[] };

/** The call when it's this person's, still open and inside its time (a minute's grace for the last answer) */
export async function openCall(admin: SupabaseClient, me: Staff, callId: unknown): Promise<CallRow | null> {
  if (typeof callId !== "string" || !/^[0-9a-f-]{36}$/.test(callId)) return null;
  const { data } = await admin.from("ai_role_calls").select("id, role_key, profile_id, voice_id, stt, started_at, ended_at, learned").eq("id", callId).maybeSingle();
  if (!data || data.profile_id !== me.id || data.ended_at) return null;
  if (!canTrainAgent(me, data.role_key as string)) return null;
  if (Date.now() - new Date(data.started_at as string).getTime() > (CALL_LIMIT_SECONDS + 60) * 1000) return null;
  return data as CallRow;
}

const voiceSystem = (label: string, firstName: string) => `You are the ${label}, one of the AI agents inside Kaizen Ads, the app Kaizen Marketing (a paid social agency) uses for creative requests, approvals, launches, reports and KPIs. ${firstName}, who trains you, has called you. You're on a live voice call: everything you write is spoken aloud by a text to speech voice as you write it.

Speak like a sharp colleague on the phone, in the first person ("I check…", "In my briefs I…"):
- Short spoken sentences. Usually one to three; more only when asked to explain how you work, and even then in a few short sentences, not a lecture.
- No markdown, no lists, no bullets, no headings, no asterisks, no emojis, no links, no code. If there are several points, say them in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them: "about twelve hundred dollars", "a two point four ROAS", "three to five days", "March fourth". Round when exact digits don't matter. Say "percent", not the symbol.
- Never say anything that sounds like reading a document ("as stated in my core"). Just say what you do.
- If you didn't catch something or it's vague, ask one short question.
- Answer from your core and skills below. If you don't know, say so plainly. Never make up a number about a client.
- Refer to people by role, never by name, except ${firstName}, who you're talking to.

Learning on the call: when ${firstName} teaches you something (a rule, a correction, a preference, how a process works, what good looks like), say back in one sentence what you'll do from now on, so they know you got it. It's saved to your knowledge automatically after you reply; a change to your core or a skill's instructions goes to your chat as an edit a person applies. Don't repeat secrets, passwords, keys or a client's personal details back, and never treat them as something to learn.

If it belongs to another agent, say which one. You can't create agents or skills, and you don't change Kaizen's strategy.`;

const EXTRACT_SYSTEM = `You read one moment of a voice call between a member of Kaizen Marketing's team (a paid social agency) and one of its AI agents, and pick out anything the person TAUGHT the agent that it should remember: a rule, a correction, a preference, a step in a process, a definition, what good looks like. Questions, small talk, thanks and things the agent already knows (in its playbook) are not learnings. Most moments teach nothing: then return an empty list.

For each learning:
- type "note" when it's a fact, a method or an example that fits as its own item in ONE of the agent's skills; type "rewrite" only when it changes the agent's core (skill "core": a rule for everything it does, its tone, its priorities) or rewrites a skill's existing instructions.
- skill: the key of the skill it belongs to (from the list), or "core" for a rewrite of the core.
- kind: knowledge (a fact), skill (a method, rule or procedure for that job) or example (what good looks like).
- title: a short name, up to eight words.
- body: the learning written as a Kaizen standard, plain and complete, one to four sentences. Written in roles (the Head of Creative, the copywriter, media buyers, customer success), never people's names. A specific client's details belong in that client's memory, not here: leave them out.
- Never include passwords, keys, tokens, logins, email addresses, phone numbers, payment details or anyone's personal details. If the lesson can't be written without them, leave it out.
- Don't repeat an item the playbook already has. At most three learnings.`;

/** The conversation so far for the prompt: the agent's chat (typed and spoken), oldest first */
async function recentChat(admin: SupabaseClient, roleKey: string, firstName: string) {
  const { data } = await admin.from("ai_role_chats").select("role, content").eq("role_key", roleKey).order("created_at", { ascending: false }).limit(24);
  return (data ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.role === "user" ? firstName : "You"}: ${m.content}`)
    .join("\n");
}

/** What the person taught in this moment, checked and ready to save (never throws: a failed read learns nothing) */
async function extractLearnings(book: RolePlaybook, said: string, reply: string): Promise<Learning[]> {
  if (said.trim().split(/\s+/).length < 5) return [];
  try {
    const out = await askJson<unknown>({
      agent: "coach",
      label: `agent call learnings ${book.role.key}`,
      bare: true,
      noSample: true,
      override: { model: "sonnet", effort: "low" },
      system: EXTRACT_SYSTEM,
      schema: LEARNINGS_SCHEMA,
      maxTokens: 4000,
      prompt: `<agent>${book.role.label}</agent>\n<skills>\n${book.skills.map((s) => `${s.key}: ${s.label}. ${s.description}`).join("\n")}\n</skills>\n\n<playbook>\n${book.text}\n</playbook>\n\n<person_said>\n${said}\n</person_said>\n\n<agent_replied>\n${reply}\n</agent_replied>`,
    });
    return parseLearnings(out, book.skills.map((s) => s.key));
  } catch (e) {
    console.error("[agent call] learnings", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Save what was learned: each note becomes an item in its skill straight away (kept in the agent's history like any
 * applied edit, so an exec can revert it); each rewrite is kept on the call and sent to the chat at hang-up.
 */
async function saveLearnings(admin: SupabaseClient, me: Staff, call: CallRow, learnings: Learning[]): Promise<LearnedItem[]> {
  const out: LearnedItem[] = [];
  for (const l of learnings) {
    if (l.type === "rewrite") {
      out.push({ id: null, type: "rewrite", skill: l.skill, title: l.title, body: l.body });
      continue;
    }
    if (!canTrainAgent(me, l.skill)) continue;
    const { data, error } = await admin
      .from("ai_knowledge")
      .insert({ agent_key: l.skill, kind: l.kind, title: l.title, body: l.body, created_by: me.id })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[agent call] save learning", error?.message);
      continue;
    }
    await logTraining(admin, { me, agentKey: l.skill, target: "item:new", record: `item:${data.id}`, before: null });
    out.push({ id: data.id as string, type: "note", skill: l.skill, title: l.title, body: l.body });
  }
  return out;
}

/**
 * One turn of the call: the agent answers what the person said, streamed as it's written; meanwhile what they taught
 * is read and saved. Both sides are kept in the agent's chat, tagged with the call. Logged in ai_runs like any run.
 */
export async function runCallTurn(input: { me: Staff; admin: SupabaseClient; call: CallRow; text: string; signal: AbortSignal; emit: (e: CallEvent) => void }) {
  const { me, admin, call, signal, emit } = input;
  const said = input.text.trim().slice(0, 4000);
  if (!said) return emit({ t: "done" });
  if (!aiEnabled()) return emit({ t: "error", message: "AI isn't connected yet." });
  const firstName = firstNameOf(me.fullName);
  const [book, convo] = await Promise.all([loadRolePlaybook(admin, call.role_key), recentChat(admin, call.role_key, firstName)]);
  if (!book) return emit({ t: "error", message: "Unknown agent." });

  const model = "sonnet" as const;
  const effort = "low" as const;
  const started = Date.now();
  let reply = "";
  let error: string | null = null;
  const used = { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
  try {
    const stream = anthropicClient().messages.stream(
      {
        model: MODEL_IDS[model],
        max_tokens: 4000,
        // The agent's whole playbook is the same every turn: cached, so later turns read it at a tenth of the price
        system: [cachedBlock(`${voiceSystem(book.role.label, firstName)}\n\n${book.text}`)] as Anthropic.TextBlockParam[],
        thinking: { type: "adaptive" },
        output_config: { effort },
        messages: [{ role: "user", content: `<conversation_so_far>\n${convo || "(the call just started)"}\n</conversation_so_far>\n\n<${firstName}_says>\n${said}\n</${firstName}_says>` }],
      },
      { signal },
    );
    stream.on("text", (d) => {
      reply += d;
      emit({ t: "text", d });
    });
    const res = await stream.finalMessage();
    Object.assign(used, usageFor(res.usage));
    if (res.stop_reason === "refusal") error = "refusal";
  } catch (e) {
    if (!signal.aborted) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error("[agent call] turn", error);
      emit({ t: "error", message: aiBusy(e) ? "I'm a bit busy right now. Try me again in a moment." : e instanceof AiUnavailable ? e.message : "Sorry, I lost my train of thought. Say that again?" });
    }
  }
  void admin
    .from("ai_runs")
    .insert({ agent_key: "coach", label: `agent call ${call.role_key}`, model, effort, ms: Date.now() - started, ...used, ok: !error, error, profile_id: me.id, actor: "person" })
    .then(({ error: e }) => e && console.error("[agent call] log run", e.message));

  // Kept in the agent's chat (what was cut short by talking over it ends with an ellipsis)
  const spoken = reply.trim() ? `${reply.trim()}${signal.aborted ? "…" : ""}` : "";
  await admin.from("ai_role_chats").insert([
    { role_key: call.role_key, role: "user", content: said, attachments: [], changes: [], created_by: me.id, call_id: call.id },
    ...(spoken ? [{ role_key: call.role_key, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
  ]);

  // What they taught, read after the answer (so it never slows the voice down), saved and shown on the call
  const learned = await saveLearnings(admin, me, call, await extractLearnings(book, said, reply));
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: learned });
  if (learned.length) emit({ t: "learned", items: learned });
  emit({ t: "done" });
}
