import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import { AiUnavailable, MODEL_IDS, aiBusy, aiEnabled, anthropicClient, askJson, cachedBlock, usageFor } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { loadRolePlaybook, type RolePlaybook } from "@/lib/role-playbook";
import { TOOLS_RULE, agentTools } from "./agent-tools";
import { CALL_LIMIT_SECONDS, CONCISE_RULE, DISTRESS_RULE, SPOKEN_RULE, END_CALL_RULE, LEARNINGS_SCHEMA, endMarkerFilter, stripEndMarker, firstNameOf, parseLearnings, parseTopic, pendingItems, pendingOf, type CallEvent, type LearnedItem, type Learning, type ResumeMode } from "./core";
import { callHistory } from "./history";
import { focusFor } from "./role-focus";
import { callConnectors, noConnectors, type CallConnectors } from "./call-connectors";
import type { CallContext } from "./call-context";
import { contextBlock, lookHint, lookTool, loadFrame, withFrame } from "./call-extras";
import { fillerFor, runToolLoop, type LoopMessage, type LoopTool } from "./tool-loop";
import { routeTeam } from "@/lib/assistant/team";
import type { TurnMode } from "@/lib/assistant/team-server";

// A voice call with one of the AI agents, on the server: the call's row (who, which agent, how long, what it cost and
// what it heard), each turn (the agent's answer streamed from Claude as it's written, from the same playbook its chat
// reads, in a speaking style, looking up live data with the person's own tools when asked), what the person taught it
// (held as pending until a person keeps or tosses it on the review; only for those who may train it), the call's
// short summary at the end, and closing calls that were never hung up (a closed tab, a dropped phone).

export type CallRow = {
  id: string;
  role_key: string;
  profile_id: string;
  voice_id: string | null;
  stt: string | null;
  started_at: string;
  ended_at: string | null;
  learned: LearnedItem[];
  resumed_from?: string | null;
  resume_mode?: ResumeMode | null;
  /** The specialists on the line (guest_roles; guest_role is the first, kept from when only one could be on), files
   *  uploaded on the call, the Kaizen AI thread its cards live in, and the job the agents are working on */
  guest_role?: string | null;
  guest_roles?: string[] | null;
  job?: unknown;
  uploads?: unknown[];
  thread_id?: string | null;
};

const CALL_COLUMNS = "id, role_key, profile_id, voice_id, stt, started_at, ended_at, learned, resumed_from, resume_mode";
const ASSISTANT_COLUMNS = `${CALL_COLUMNS}, guest_role, uploads, thread_id`;
const TEAM_COLUMNS = `${ASSISTANT_COLUMNS}, guest_roles, job`;

/** The call when it's this person's, still open and inside its time (a minute's grace for the last answer) */
export async function openCall(admin: SupabaseClient, me: Staff, callId: unknown): Promise<CallRow | null> {
  if (typeof callId !== "string" || !/^[0-9a-f-]{36}$/.test(callId)) return null;
  let first: { data: unknown; error: unknown } = await admin.from("ai_role_calls").select(TEAM_COLUMNS).eq("id", callId).maybeSingle();
  // Before the team migration: one specialist at a time, no job
  if (first.error) first = await admin.from("ai_role_calls").select(ASSISTANT_COLUMNS).eq("id", callId).maybeSingle();
  let data = first.data as Record<string, unknown> | null;
  // Before the assistant migration (or the review one): the columns they add aren't there yet
  if (first.error) {
    const second = await admin.from("ai_role_calls").select(CALL_COLUMNS).eq("id", callId).maybeSingle();
    data = second.data as Record<string, unknown> | null;
    if (second.error) data = (await admin.from("ai_role_calls").select("id, role_key, profile_id, voice_id, stt, started_at, ended_at, learned").eq("id", callId).maybeSingle()).data as Record<string, unknown> | null;
  }
  if (!data || data.profile_id !== me.id || data.ended_at) return null;
  if (!canTalkToAgent(me, data.role_key as string)) return null;
  if (Date.now() - new Date(data.started_at as string).getTime() > (CALL_LIMIT_SECONDS + 60) * 1000) return null;
  return data as unknown as CallRow;
}

/** The spoken-call instructions for an agent (`conference`: it was called into a call with the person's assistant) */
export const voiceSystem = (label: string, roleKey: string, firstName: string, trains: boolean, conference = "") => `You are the ${label}, one of the AI agents inside Kaizen OS, the app Kaizen Marketing (a paid social, email and organic social agency) uses for creative requests, approvals, launches, reports and KPIs. ${firstName}, from the team, has called you. You're on a live voice call: everything you write is spoken aloud by a text to speech voice as you write it.

${CONCISE_RULE}

${SPOKEN_RULE}

Speak like a sharp colleague on the phone, in the first person ("I check…", "In my briefs I…"):
- Short spoken sentences, one to three by default.
- No markdown, no lists, no bullets, no headings, no asterisks, no emojis, no links, no code. If there are several points, say them in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them: "about twelve hundred dollars", "a two point four ROAS", "three to five days", "March fourth". Round when exact digits don't matter. Say "percent", not the symbol. Never read a table out: give the one or two numbers that answer the question and offer more.
- Never say anything that sounds like reading a document ("as stated in my core"). Just say what you do.
- Write names as they're spelled (Klaviyo, Cloudbeds): the voice already says them right. Never spell a name out phonetically or explain how it's said.
- If you didn't catch something or it's vague, ask one short question.
- Answer from your core and skills below, and from your tools for anything about clients and their numbers. If you don't know, say so plainly. Never make up a number about a client.
- Refer to people by role, never by name, except ${firstName}, who you're talking to, and a teammate you've just asked to do something.

Your tools: ${TOOLS_RULE} Before you use a tool, say one short line like "One sec, pulling Crust's numbers." and nothing else, then answer once the results are in. Asked for the top or bottom clients, emails, ads or posts, rank them with your tools: you have the numbers, so give the answer yourself.

What you lead with: ${focusFor(roleKey)}

${
  trains
    ? `Learning on the call: when ${firstName} teaches you something (a rule, a correction, a preference, how a process works, what good looks like), say back in one sentence what you'll do from now on, so they know you got it. It's noted as something you heard; nothing changes in what you know until ${firstName} keeps it on the review at the end of the call. Don't repeat secrets, passwords, keys or a client's personal details back, and never treat them as something to learn.`
    : `${firstName} can ask you anything and ask you to look things up or get things done, but doesn't train you: if they tell you how you should work, thank them and say the head of your line or an executive changes your playbook. Never say you've learned or saved it.`
}

If it belongs to another agent, say which one. You can't create agents or skills, and you don't change Kaizen's strategy.

${DISTRESS_RULE}

${conference || END_CALL_RULE}`;

const RESUME_NOTE: Record<ResumeMode, string> = {
  continue: "The call dropped a moment ago and they called straight back: carry on exactly where you were, as if nothing happened. You've already apologised for the cut-off in your greeting.",
  soon: "You talked a few hours ago today: you remember it. Refer back to it naturally when it helps.",
  later_today: "You talked earlier today: you remember it, and you've asked whether to pick up from there or start something new.",
  fresh: "",
};

const EXTRACT_SYSTEM = `You read one moment of a voice call between a member of Kaizen Marketing's team (a paid social, email and organic social agency) and one of its AI agents. Give the topic of the moment (what the person is asking or talking about, as a short phrase), and pick out anything the person TAUGHT the agent that it should remember: a rule, a correction, a preference, a step in a process, a definition, what good looks like. Questions, asks for numbers or actions, small talk, thanks and things the agent already knows (in its playbook) are not learnings. Most moments teach nothing: then return an empty list.

For each learning:
- type "note" when it's a fact, a method or an example that fits as its own item in ONE of the agent's skills; type "rewrite" only when it changes the agent's core (skill "core": a rule for everything it does, its tone, its priorities) or rewrites a skill's existing instructions.
- skill: the key of the skill it belongs to (from the list), or "core" for a rewrite of the core.
- kind: knowledge (a fact), skill (a method, rule or procedure for that job) or example (what good looks like).
- title: a short name, up to eight words.
- body: the learning written as a Kaizen standard, plain and complete, one to four sentences. Written in roles (the Head of Creative, the copywriter, media buyers, customer success), never people's names. A specific client's details belong in that client's memory, not here: leave them out.
- Never include passwords, keys, tokens, logins, email addresses, phone numbers, payment details or anyone's personal details. If the lesson can't be written without them, leave it out.
- Don't repeat an item the playbook already has. At most three learnings.`;

type Turn = { role: string; content: string; role_key?: string | null };
/** The lines as the agent reads them: the person by first name, itself as "You", another agent on the call by its role */
export const said = (rows: Turn[], firstName: string, self?: string) =>
  rows.map((m) => `${m.role === "user" ? firstName : !self || !m.role_key || m.role_key === self ? "You" : `The ${m.role_key.replace(/_/g, " ")}`}: ${m.content}`).join("\n");

/** This call's turns so far, and how it follows the last call (its turns or its summary), for the prompt */
export async function callContext(admin: SupabaseClient, call: CallRow, firstName: string): Promise<string> {
  // The latest lines (it used to take the first sixty, so a long call lost its recent turns while the prompt kept
  // growing): the newest whole, older ones as a short digest, so each answer is as quick at minute thirty as at one
  const { data: latest } = await admin.from("ai_role_chats").select("role, content, role_key").eq("call_id", call.id).order("created_at", { ascending: false }).limit(200);
  const history = callHistory(((latest ?? []) as Turn[]).slice().reverse());
  const now = history.recent;
  const parts: string[] = [];
  const mode = call.resume_mode ?? "fresh";
  if (call.resumed_from && mode !== "fresh") {
    const [{ data: prev }, { data: turns }] = await Promise.all([
      admin.from("ai_role_calls").select("summary, started_at").eq("id", call.resumed_from).maybeSingle(),
      admin
        .from("ai_role_chats")
        .select("role, content, role_key")
        .eq("call_id", call.resumed_from)
        .order("created_at", { ascending: false })
        .limit(mode === "continue" ? 16 : 8),
    ]);
    const before = said(((turns ?? []) as Turn[]).slice().reverse(), firstName, call.role_key);
    const summary = (prev?.summary as string | null) ?? null;
    const when = prev?.started_at ? new Date(prev.started_at as string).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "earlier";
    if (mode === "continue") parts.push(`<the_call_that_dropped>\n${before || "(nothing said yet)"}\n</the_call_that_dropped>`);
    else parts.push(`<earlier_today at="${when}">\n${summary ?? before ?? "(nothing kept)"}\n</earlier_today>`);
    parts.push(RESUME_NOTE[mode]);
  }
  parts.push(`<this_call>\n${history.digest ? `${history.digest}\n\n` : ""}${said(now, firstName, call.role_key) || "(the call just started)"}\n</this_call>`);
  return parts.join("\n\n");
}

/** The topic of a moment and what the person taught in it, checked (never throws: a failed read learns nothing) */
export async function readMoment(book: RolePlaybook, text: string, reply: string): Promise<{ topic: string | null; learnings: Learning[] }> {
  if (text.trim().split(/\s+/).length < 5) return { topic: null, learnings: [] };
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
      prompt: `<agent>${book.role.label}</agent>\n<skills>\n${book.skills.map((s) => `${s.key}: ${s.label}. ${s.description}`).join("\n")}\n</skills>\n\n<playbook>\n${book.text}\n</playbook>\n\n<person_said>\n${text}\n</person_said>\n\n<agent_replied>\n${reply}\n</agent_replied>`,
    });
    return { topic: parseTopic(out), learnings: parseLearnings(out, book.skills.map((s) => s.key)) };
  } catch (e) {
    console.error("[agent call] learnings", e instanceof Error ? e.message : e);
    return { topic: null, learnings: [] };
  }
}

/** The most rounds of lookups in one turn before the agent answers with what it has */
const MAX_TOOL_ROUNDS = 5;

/**
 * One turn of the call: the agent answers what the person said, streamed as it's written, looking things up with the
 * person's tools on the way (a short spoken line covers the wait); meanwhile what they taught is noted as pending (for
 * those who train it). Both sides are kept in the agent's chat, tagged with the call. Logged in ai_runs like any run.
 */
export type TurnInput = {
  me: Staff;
  admin: SupabaseClient;
  db: SupabaseClient;
  call: CallRow;
  text: string;
  signal: AbortSignal;
  emit: (e: CallEvent) => void;
  /** Where they called from (a client, a report, a Kaizen AI thread), from the screen's Call button */
  context?: CallContext | null;
  /** A screenshot of their screen that comes with this turn (a look), in the call's uploads */
  frame?: string | null;
  /** When the turn arrived (an ask for a yes must be older than this) */
  startedAt?: number;
};

/** What every turn reads besides the agent's own playbook: where they called from, their connectors, a screenshot */
export async function turnExtras(input: TurnInput, text: string) {
  const [where, connectors, frame] = await Promise.all([
    contextBlock(input.db, input.context).catch(() => ""),
    callConnectors({ me: input.me, admin: input.admin, callId: input.call.id, text, turnStart: input.startedAt ?? Date.now() }).catch((e) => {
      console.error("[agent call] connectors", e instanceof Error ? e.message : e);
      return noConnectors();
    }),
    input.frame ? loadFrame(input.admin, input.me, input.call.id, input.frame).catch(() => null) : null,
  ]);
  return { where, connectors, frame, look: lookTool(input.emit), hint: lookHint(text, Boolean(frame)) };
}

export async function runCallTurn(input: TurnInput) {
  const { me, admin, call, signal, emit } = input;
  const text = input.text.trim().slice(0, 4000);
  if (!text) return emit({ t: "done" });
  if (!aiEnabled()) return emit({ t: "error", message: "AI isn't connected yet." });
  const firstName = firstNameOf(me.fullName);
  const trains = canTrainAgent(me, call.role_key);
  // Other agents may be on the line (this agent brought them in): the turn goes to whoever it's for
  const team = await import("@/lib/assistant/team-server");
  const state = team.teamOf(call, call.role_key);
  const hostHop = (m: TurnMode) => team.specialistTurn(input, state, call.role_key, m);
  if (state.line.length) {
    const route = routeTeam(text, { host: call.role_key, line: state.line, last: await team.lastSpeaker(admin, call.id) });
    if (route.dismiss.length) await team.dismissFromLine(input, state, route.dismiss);
    if (route.to !== call.role_key) {
      await team.specialistTurn({ ...input, text }, state, route.to, { text, mode: "person" });
      await team.followUps(input, state, hostHop);
      await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
      return emit({ t: "done" });
    }
  }
  const [book, convo, extra] = await Promise.all([loadRolePlaybook(admin, call.role_key), callContext(admin, call, firstName), turnExtras(input, text)]);
  if (!book) return emit({ t: "error", message: "Unknown agent." });
  const tctx = { me, db: input.db, admin, callId: call.id, emit, team: state, self: call.role_key, said: text };
  const tools = team.tracked(tctx, [...(await agentTools({ me, db: input.db, admin, roleKey: call.role_key, label: book.role.label, callId: call.id, emit, said: text })), ...team.teamTools(tctx)]);
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  // With others on the line, the captions say who's speaking
  if (state.line.length) {
    const { data: role } = await admin.from("ai_roles").select("icon").eq("key", call.role_key).maybeSingle();
    emit({ t: "speaker", role: call.role_key, label: book.role.label, icon: (role?.icon as string) ?? "spark" });
  }

  const out = await streamAnswer({
    system: `${voiceSystem(book.role.label, call.role_key, firstName, trains)}\n\n${team.hostRule(firstName)}\n\n${book.text}`,
    tools: [...tools, extra.look, ...extra.connectors.tools],
    content: withFrame([`Today is ${today} (New York).`, extra.where, team.teamBlock(state, call.role_key, firstName), convo, extra.hint, `<${firstName}_says>\n${text}\n</${firstName}_says>`].filter(Boolean).join("\n\n"), extra.frame),
    signal,
    emit,
    connectors: extra.connectors,
  });
  await extra.connectors.settle().catch(() => undefined);
  const { reply, error, used, model, effort, started } = out;
  void admin
    .from("ai_runs")
    .insert({ agent_key: "coach", label: `agent call ${call.role_key}`, model, effort, ms: Date.now() - started, ...used, ok: !error, error, profile_id: me.id, actor: "person" })
    .then(({ error: e }) => e && console.error("[agent call] log run", e.message));

  // Kept in the agent's chat (what was cut short by talking over it ends with an ellipsis)
  const spoken = reply.replace(/\n+/g, " ").trim() ? `${reply.replace(/\n+/g, " ").trim()}${signal.aborted ? "…" : ""}` : "";
  await admin.from("ai_role_chats").insert([
    { role_key: call.role_key, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id },
    ...(spoken ? [{ role_key: call.role_key, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
  ]);
  // Anyone it just brought in answers now, then any hand-offs between the agents on the line
  if (!signal.aborted && !out.ended) await team.followUps(input, state, hostHop);

  // The topic and what they taught, read after the answer (so it never slows the voice down). Only someone who trains
  // this agent teaches it: for anyone else nothing is captured. Held as pending until kept or tossed on the review.
  const moment = await readMoment(book, text, reply);
  const heard = trains ? pendingItems(moment.learnings.filter((l) => canTrainAgent(me, l.type === "note" ? l.skill : call.role_key)), () => crypto.randomUUID()) : [];
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: heard });
  if (moment.topic) void admin.from("ai_role_calls").update({ topic: moment.topic }).eq("id", call.id).then(({ error: e }) => e && console.error("[agent call] topic", e.message));
  if (heard.length) emit({ t: "learned", items: heard });
  if (out.ended) emit({ t: "end" });
  emit({ t: "done" });
}

/** What one spoken answer came to: the words (without the end marker), whether it hung up, and its cost */
export type Answer = { reply: string; ended: boolean; error: string | null; used: { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number }; model: "sonnet"; effort: "low"; started: number };

/** The person's connected services for one answer (see call-connectors.ts) */
type Conn = Pick<CallConnectors, "servers" | "toolsets" | "betas" | "system" | "drop" | "nameOf">;

type Reply = { content: unknown[]; stop_reason: string | null; usage: Anthropic.Usage };

/**
 * One spoken answer: streamed from Claude as it's written (each piece sent on as a text event), looking things up with
 * the tools on the way (a short spoken line covers the wait), the end marker held back (a goodbye that hangs up sets
 * `ended`). Used by every agent's call turn and by the assistant and the specialist it calls in. `content` can carry a
 * screenshot (image blocks first). With the person's connectors, the request goes through the MCP connector (a beta):
 * their services' tools run on Anthropic's side within the answer.
 */
export async function streamAnswer(input: { system: string; tools: readonly LoopTool[]; content: string | unknown[]; signal: AbortSignal; emit: (e: CallEvent) => void; maxRounds?: number; connectors?: Conn | null }): Promise<Answer> {
  const { signal, emit, tools } = input;
  const conn = input.connectors ?? null;
  const defs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema: input_schema as Anthropic.Tool.InputSchema }));
  if (defs.length) (defs[defs.length - 1] as Anthropic.Tool).cache_control = { type: "ephemeral" };
  const model = "sonnet" as const;
  const effort = "low" as const;
  const started = Date.now();
  let reply = "";
  let error: string | null = null;
  let fillers = 0;
  const used = { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
  const messages: LoopMessage[] = [{ role: "user", content: input.content }];
  const marker = endMarkerFilter();
  const say = (d: string) => {
    if (!d) return;
    reply += d;
    emit({ t: "text", d });
  };
  let roundText = "";
  // The agent's whole playbook is the same every turn: cached, so later turns read it at a tenth of the price. What
  // their connectors are comes after it, uncached (it changes when they connect something)
  const system = (): Anthropic.TextBlockParam[] => [cachedBlock(input.system) as Anthropic.TextBlockParam, ...(conn?.system ? [{ type: "text" as const, text: conn.system }] : [])];

  /** One request to the model, streamed; with connectors, through the MCP connector */
  const ask = async (msgs: LoopMessage[], last: boolean): Promise<Reply> => {
    const withConn = Boolean(conn?.servers.length);
    const base = {
      model: MODEL_IDS[model],
      // Spoken answers are short: room for a little thinking and a few sentences, never a lecture
      max_tokens: 2500,
      system: system(),
      thinking: { type: "adaptive" as const },
      output_config: { effort },
      messages: msgs as Anthropic.MessageParam[],
    };
    if (!withConn || !conn) {
      const stream = anthropicClient().messages.stream({ ...base, ...(last || !defs.length ? {} : { tools: defs }) } as Anthropic.MessageCreateParamsStreaming, { signal });
      stream.on("text", (d) => {
        roundText += d;
        say(marker.feed(d));
      });
      return (await stream.finalMessage()) as unknown as Reply;
    }
    const stream = anthropicClient().beta.messages.stream(
      {
        ...base,
        tools: [...(last ? [] : defs), ...conn.toolsets],
        mcp_servers: conn.servers,
        betas: conn.betas,
      } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
      { signal },
    );
    stream.on("text", (d) => {
      roundText += d;
      say(marker.feed(d));
    });
    // Their service is being read (on Anthropic's side): a line so the call doesn't go quiet
    stream.on("contentBlock", (b) => {
      const block = b as unknown as { type: string; server_name?: string };
      if (block.type !== "mcp_tool_use" || roundText.trim() || fillers > 0) return;
      say(`One sec, checking your ${conn.nameOf(String(block.server_name ?? ""))}.\n`);
      fillers++;
    });
    return (await stream.finalMessage()) as unknown as Reply;
  };

  try {
    await runToolLoop({
      tools,
      messages,
      maxRounds: input.maxRounds ?? MAX_TOOL_ROUNDS,
      signal,
      step: async (msgs, last) => {
        roundText = "";
        let res: Reply | null = null;
        // A connector the API couldn't reach or sign in to: the round again without it (once). A long run of connector
        // calls pauses (pause_turn): sent back as it is to carry on, a few times at most
        let retried = false;
        for (let pause = 0; ; ) {
          try {
            res = await ask(msgs, last);
          } catch (e) {
            if (!signal.aborted && !retried && conn?.servers.length && !roundText && conn.drop(e)) {
              retried = true;
              continue;
            }
            throw e;
          }
          say(marker.flush());
          const u = usageFor(res.usage);
          used.input_tokens += u.input_tokens;
          used.output_tokens += u.output_tokens;
          used.cache_write_tokens += u.cache_write_tokens;
          used.cache_read_tokens += u.cache_read_tokens;
          if (res.stop_reason === "pause_turn" && pause < 3 && !signal.aborted && !marker.ended) {
            pause++;
            msgs.push({ role: "assistant", content: res.content });
            continue;
          }
          break;
        }
        if (res.stop_reason === "refusal") error = "refusal";
        return { content: res.content as { type: string }[], stop: marker.ended ? "end_turn" : res.stop_reason };
      },
      // While lookups run: the line the agent said, or one said for it, so the call never goes quiet. A line break
      // ends it, so the answer that follows is spoken as its own sentence
      onTools: (calls) => {
        if (!roundText.trim() && fillers === 0) {
          say(fillerFor(calls, Date.now()));
          fillers++;
        }
        say("\n");
      },
    });
  } catch (e) {
    if (!signal.aborted) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error("[agent call] turn", error);
      emit({ t: "error", message: aiBusy(e) ? "I'm a bit busy right now. Try me again in a moment." : e instanceof AiUnavailable ? e.message : "Sorry, I lost my train of thought. Say that again?" });
    }
  }
  return { reply: stripEndMarker(reply).text, ended: marker.ended, error, used, model, effort, started };
}

// ─── The call's summary ─────────────────────────────────────────────────────

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topic"],
  properties: {
    summary: { type: "string", description: "Two to four plain sentences: what was asked and answered, numbers that came up, anything agreed or left open" },
    topic: { type: "string", description: "The main thing talked about, as a short phrase that fits after 'our conversation about' (up to eight words)" },
  },
};

/** A short summary of a call, written once it ends (a cheap model), so later calls the same day can refer back to it */
export async function summarizeCall(admin: SupabaseClient, callId: string): Promise<void> {
  const { data: rows } = await admin.from("ai_role_chats").select("role, content").eq("call_id", callId).order("created_at").limit(80);
  const turns = (rows ?? []) as Turn[];
  if (turns.filter((t) => t.role === "user").length === 0) return;
  try {
    const out = await askJson<{ summary: string; topic: string }>({
      agent: "coach",
      label: "agent call summary",
      bare: true,
      noSample: true,
      override: { model: "haiku", effort: "low" },
      system: "You summarise a voice call between a member of a marketing agency's team and one of its AI agents, for the agent to remember later today. Plain words, no names of people (say 'they'), no secrets or personal details.",
      schema: SUMMARY_SCHEMA,
      maxTokens: 1200,
      prompt: `<call>\n${said(turns, "They")}\n</call>`,
    });
    const topic = parseTopic(out);
    await admin
      .from("ai_role_calls")
      .update({ summary: String(out.summary ?? "").trim().slice(0, 1500) || null, ...(topic ? { topic } : {}) })
      .eq("id", callId);
  } catch (e) {
    console.error("[agent call] summary", e instanceof Error ? e.message : e);
  }
}

// ─── Calls never hung up ────────────────────────────────────────────────────

/**
 * Closes calls nobody hung up (a closed tab, a dropped phone, a call past its time): ended when last talked in, what
 * they heard left pending for review (it shows in the person's Overview), a call that heard nothing marked reviewed.
 * `profileId`: every open call of that person (they're starting another); else every call past its time.
 */
export async function sweepOpenCalls(admin: SupabaseClient, opts: { profileId?: string } = {}): Promise<{ closed: string[] }> {
  let q = admin.from("ai_role_calls").select("id, started_at, last_turn_at, learned").is("ended_at", null).limit(200);
  if (opts.profileId) q = q.eq("profile_id", opts.profileId);
  else q = q.lt("started_at", new Date(Date.now() - (CALL_LIMIT_SECONDS + 120) * 1000).toISOString());
  const { data, error } = await q;
  if (error) return { closed: [] };
  const closed: string[] = [];
  for (const c of data ?? []) {
    const start = Date.parse(c.started_at as string);
    const last = c.last_turn_at ? Date.parse(c.last_turn_at as string) : start;
    const end = new Date(Math.min(Math.max(last, start), start + CALL_LIMIT_SECONDS * 1000, Date.now())).toISOString();
    const pending = pendingOf((c.learned ?? []) as LearnedItem[]).length;
    const { error: e } = await admin
      .from("ai_role_calls")
      .update({ ended_at: end, ...(pending ? {} : { reviewed_at: new Date().toISOString() }) })
      .eq("id", c.id)
      .is("ended_at", null);
    if (!e) closed.push(c.id as string);
  }
  return { closed };
}
