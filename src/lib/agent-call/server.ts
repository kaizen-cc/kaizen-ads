import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import { AiUnavailable, MODEL_IDS, aiBusy, getAgent, type Effort, type ModelKey, aiEnabled, anthropicClient, askJson, cachedBlock, usageFor } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { loadRolePlaybook, type RolePlaybook } from "@/lib/role-playbook";
import { TOOLS_RULE, agentTools } from "./agent-tools";
import { BACKGROUND_CHATTER_RULE, CALL_LIMIT_SECONDS, DISTRESS_RULE, END_CALL_RULE, LEARNINGS_SCHEMA, endMarkerFilter, endReasonFor, stripEndMarker, firstNameOf, parseLearnings, parseTopic, pendingItems, pendingOf, type CallEvent, type EndReason, type LearnedItem, type Learning, type ResumeMode } from "./core";
import { agentModality, keptLine, modeSince, parseModeLog, stillOpen, streamShaping, talkModeOf, type ModeStep, type TalkMode } from "./modality";
import { callHistory, longTurnText } from "./history";
import { wellFormed } from "./well-formed";
import { focusFor } from "./role-focus";
import { callConnectors, noConnectors, type CallConnectors } from "./call-connectors";
import type { CallContext } from "./call-context";
import { contextBlock, lookHint, lookTool, loadFrame, withFrame } from "./call-extras";
import { FILLER_DELAY_MS, checkInDue, checkInLine, fillerFor, progressPct, runToolLoop, soundsUnfinished, stepLabel, type LoopMessage, type LoopTool } from "./tool-loop";
import { turnTimes } from "./transcript";
import { callTimer, type CallTimer } from "./timing";
import { nextCapFor, createLengthGuard } from "./spoken-length";
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
  /** How the conversation is going now (a call or a chat) and when it moved between them */
  mode?: TalkMode | null;
  mode_log?: ModeStep[] | null;
};

const CALL_COLUMNS = "id, role_key, profile_id, voice_id, stt, started_at, ended_at, learned, resumed_from, resume_mode";
const ASSISTANT_COLUMNS = `${CALL_COLUMNS}, guest_role, uploads, thread_id`;
const TEAM_COLUMNS = `${ASSISTANT_COLUMNS}, guest_roles, job`;
const CHAT_COLUMNS = `${TEAM_COLUMNS}, mode, mode_log, last_turn_at`;

/** The call when it's this person's, still open and inside its time (a minute's grace for the last answer) */
export async function openCall(admin: SupabaseClient, me: Staff, callId: unknown): Promise<CallRow | null> {
  if (typeof callId !== "string" || !/^[0-9a-f-]{36}$/.test(callId)) return null;
  // Before the chat migration: every conversation is a call
  let first: { data: unknown; error: unknown } = await admin.from("ai_role_calls").select(CHAT_COLUMNS).eq("id", callId).maybeSingle();
  if (first.error) first = await admin.from("ai_role_calls").select(TEAM_COLUMNS).eq("id", callId).maybeSingle();
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
  // A call within its thirty minutes (from when it became a call), a chat while it's in use
  const mode = talkModeOf(data.mode);
  const log = parseModeLog(data.mode_log);
  if (!stillOpen({ mode, startedAt: data.started_at as string, lastTurnAt: (data.last_turn_at as string | null) ?? null, log, callLimitSeconds: CALL_LIMIT_SECONDS })) return null;
  return { ...(data as unknown as CallRow), mode, mode_log: log };
}

/** The spoken-call instructions for an agent (`conference`: it was called into a call with the person's assistant) */
export const voiceSystem = (label: string, roleKey: string, firstName: string, trains: boolean, conference = "", mode: TalkMode = "voice") => `You are the ${label}, one of the AI agents inside Kaizen OS, the app Kaizen Marketing (a paid social, email and organic social agency) uses for creative requests, approvals, launches, reports and KPIs. ${firstName}, from the team, is talking with you.

${agentModality(mode)}

Either way:
- Answer from your core and skills below, and from your tools for anything about clients and their numbers. If you don't know, say so plainly. Never make up a number about a client.
- Refer to people by role, never by name, except ${firstName}, who you're talking to, and a teammate you've just asked to do something.

Your tools: ${TOOLS_RULE} Before you use a tool, ${mode === "text" ? "write nothing" : `say one short line like "One sec, pulling Crust's numbers." and nothing else`}, then answer once the results are in. Asked for the top or bottom clients, emails, ads or posts, rank them with your tools: you have the numbers, so give the answer yourself.

What you lead with: ${focusFor(roleKey)}

${
  trains
    ? `Learning in the conversation: when ${firstName} teaches you something (a rule, a correction, a preference, how a process works, what good looks like), say back in one sentence what you'll do from now on, so they know you got it. It's noted as something you heard; nothing changes in what you know until ${firstName} keeps it on the review at the end of the call. Don't repeat secrets, passwords, keys or a client's personal details back, and never treat them as something to learn.`
    : `${firstName} can ask you anything and ask you to look things up or get things done, but doesn't train you: if they tell you how you should work, thank them and say the head of your line or an executive changes your playbook. Never say you've learned or saved it.`
}

If it belongs to another agent, say which one. You can't create agents or skills, and you don't change Kaizen's strategy.

${DISTRESS_RULE}

${conference || (mode === "voice" ? `${END_CALL_RULE}\n\n${BACKGROUND_CHATTER_RULE}` : END_CALL_RULE)}`;

const RESUME_NOTE: Record<ResumeMode, string> = {
  continue: "The call dropped a moment ago and they called straight back: carry on exactly where you were, as if nothing happened. You've already apologised for the cut-off in your greeting.",
  again: "They ended your last conversation themselves a few minutes ago and are back: you remember it, but don't assume they want to carry on with it. Follow their lead; bring it up only if they do, or if your greeting offered to finish something.",
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
    if (mode === "continue" || mode === "again") parts.push(`<the_call_that_dropped>\n${before || "(nothing said yet)"}\n</the_call_that_dropped>`);
    else parts.push(`<earlier_today at="${when}">\n${summary ?? before ?? "(nothing kept)"}\n</earlier_today>`);
    parts.push(RESUME_NOTE[mode]);
  }
  // The same conversation moved between a chat and a call: no fresh greeting, carry straight on
  const log = call.mode_log ?? [];
  if (log.length > 1) {
    const current = talkModeOf(call.mode);
    parts.push(`<switched>This conversation started as a ${log[0].mode === "text" ? "typed chat" : "voice call"} and is now a ${current === "text" ? "typed chat" : "voice call"}. It's the same conversation: carry on exactly where it was, never greet again or ask what they need from scratch.</switched>`);
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
/** Rounds of tools in one answer: a multi-step job (context, brainstorm, the copy, the requests) finishes within the turn */
const MAX_TOOL_ROUNDS = 14;

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
  /** The screen they're on right now (a path inside the app) */
  path?: string | null;
  /** Where the turn's time goes (logged as one line at the end of the turn) */
  timer?: CallTimer;
  /** A call (spoken) or a chat (typed and read): the same turn, only how it talks and streams differs (modality.ts) */
  mode?: TalkMode;
};

/**
 * An agent's playbook, kept a couple of minutes per server instance: every turn of a call (and every agent brought
 * onto it) used to read it fresh, two round trips to the database before the model could start. A playbook changes
 * only when a lead edits it or keeps what was learned on a review, and the next call reads the new one.
 */
const PLAYBOOKS = new Map<string, { at: number; book: Promise<RolePlaybook | null> }>();
const PLAYBOOK_TTL_MS = 120_000;

export function playbookFor(admin: SupabaseClient, roleKey: string): Promise<RolePlaybook | null> {
  const hit = PLAYBOOKS.get(roleKey);
  if (hit && Date.now() - hit.at < PLAYBOOK_TTL_MS) return hit.book;
  const book = loadRolePlaybook(admin, roleKey).catch((e) => {
    PLAYBOOKS.delete(roleKey);
    throw e;
  });
  PLAYBOOKS.set(roleKey, { at: Date.now(), book });
  book.then((b) => !b && PLAYBOOKS.delete(roleKey)).catch(() => undefined);
  return book;
}

/** What every turn reads besides the agent's own playbook: where they called from, their connectors, a screenshot */
export async function turnExtras(input: TurnInput, text: string, tag = "") {
  const t = input.timer ?? callTimer();
  const [where0, team, connectors, frame] = await Promise.all([
    t.time(`${tag}screen`, contextBlock(input.db, input.context, input.me).catch(() => "")),
    // The client in play: the lines it buys, who sits in each seat (so hand-offs only go to roles it has) and how it
    // makes money (so every idea fits the business)
    t.time(
      `${tag}client`,
      import("@/lib/assistant/routing-server").then(({ clientTeamBlock }) => clientTeamBlock(input.db, input.admin, input.context?.clientId ?? null, text, { viewer: input.me.id, me: input.me })).catch(() => ""),
    ),
    t.time(
      `${tag}connectors`,
      callConnectors({ me: input.me, admin: input.admin, callId: input.call.id, text, turnStart: input.startedAt ?? Date.now() }).catch((e) => {
        console.error("[agent call] connectors", e instanceof Error ? e.message : e);
        return noConnectors();
      }),
    ),
    input.frame ? t.time(`${tag}frame`, loadFrame(input.admin, input.me, input.call.id, input.frame).catch(() => null)) : null,
  ]);
  const where = [where0, team].filter(Boolean).join("\n\n");
  return { where, connectors, frame, look: lookTool(input.emit), hint: lookHint(text, Boolean(frame)) };
}

export async function runCallTurn(input: TurnInput) {
  const { me, admin, call, signal, emit } = input;
  // A long paste is taken whole (up to TURN_CHARS; only a truly huge one keeps its start and end)
  const text = longTurnText(input.text);
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
  const timer = input.timer ?? callTimer();
  const mode = talkModeOf(input.mode);
  const [book, convo, extra] = await timer.time("context", Promise.all([timer.time("playbook", playbookFor(admin, call.role_key)), timer.time("history", callContext(admin, call, firstName)), turnExtras(input, text)]));
  if (!book) return emit({ t: "error", message: "Unknown agent." });
  const tctx = { me, db: input.db, admin, callId: call.id, emit, team: state, self: call.role_key, said: text };
  const tools = team.tracked(tctx, [...(await timer.time("tools_build", agentTools({ me, db: input.db, admin, roleKey: call.role_key, label: book.role.label, callId: call.id, emit, said: text, path: input.path ?? null, screen: input.context?.screen ?? null, clientId: input.context?.clientId ?? null }))), ...team.teamTools(tctx)]);
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  // With others on the line, the captions say who's speaking
  if (state.line.length) {
    const { data: role } = await admin.from("ai_roles").select("icon").eq("key", call.role_key).maybeSingle();
    emit({ t: "speaker", role: call.role_key, label: book.role.label, icon: (role?.icon as string) ?? "spark" });
  }

  const out = await streamAnswer({
    system: `${voiceSystem(book.role.label, call.role_key, firstName, trains, "", mode)}\n\n${team.hostRule(firstName)}\n\n${book.text}`,
    tools: [...tools, extra.look, ...extra.connectors.tools],
    mode,
    content: withFrame([`Today is ${today} (New York).`, extra.where, team.teamBlock(state, call.role_key, firstName), convo, extra.hint, `<${firstName}_says>\n${text}\n</${firstName}_says>`].filter(Boolean).join("\n\n"), extra.frame),
    signal,
    emit,
    connectors: extra.connectors,
    filler: { callId: call.id, turn: input.startedAt ?? 0, said: text },
    timer,
  });
  await extra.connectors.settle().catch(() => undefined);
  const { reply, error, used, model, effort, started } = out;
  void admin
    .from("ai_runs")
    .insert({ agent_key: "coach", label: `agent call ${call.role_key}`, model, effort, ms: Date.now() - started, ...used, ok: !error, error, profile_id: me.id, actor: "person" })
    .then(({ error: e }) => e && console.error("[agent call] log run", e.message));

  // Kept in the agent's chat (what was cut short by talking over it ends with an ellipsis)
  const spoken = keptLine(reply, signal.aborted, mode);
  // The person's line at when they said it, the answer after it (the transcript reads them in that order)
  const at = turnTimes(input.startedAt, Date.now());
  await admin.from("ai_role_chats").insert([
    { role_key: call.role_key, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.said },
    ...(spoken ? [{ role_key: call.role_key, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.answered }] : []),
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
export type Answer = { reply: string; ended: boolean; error: string | null; used: { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number }; model: ModelKey; effort: Effort; started: number };

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
/**
 * The last filler said on each call (in this server's memory, best effort): never the same line twice in a row, and at
 * most one filler per turn, however many agents answer in it
 */
const FILLERS = new Map<string, { line: string; turn: number }>();
/** Whether the last answer on each call was cut by the length guard (the next one never is: never twice in a row) */
const CUTS = new Map<string, boolean>();
/** The last check-in said on each call, so the next is never the same line */
const CHECK_INS = new Map<string, string>();
/** Past the cap, how much more a round may write silently before it's stopped (a preamble to a tool call is short) */
const SILENT_OVERFLOW_CHARS = 600;

export async function streamAnswer(input: {
  system: string;
  tools: readonly LoopTool[];
  content: string | unknown[];
  signal: AbortSignal;
  emit: (e: CallEvent) => void;
  maxRounds?: number;
  connectors?: Conn | null;
  /** For the filler: the call, when the turn arrived, and what the person said this turn ("" for a hand-over) */
  filler?: { callId: string; turn: number; said: string };
  /** Where the time goes (the model's first word, each round, each tool); `tag` names whose answer it is */
  timer?: CallTimer;
  tag?: string;
  /** A chat: no spoken fillers and no length guard (it's read, see modality.ts) */
  mode?: TalkMode;
}): Promise<Answer> {
  const { signal, emit } = input;
  const shaping = streamShaping(talkModeOf(input.mode));
  const timer = input.timer ?? callTimer();
  const tag = input.tag ?? "";
  // Each tool's time, by name
  // One tool per name: the API refuses the whole turn on a repeated name ("Tool names must be unique"), which the person
  // hears as "I lost my train of thought". The first registration wins; a repeat is logged so it gets fixed at the source.
  const seenNames = new Set<string>();
  const unique = input.tools.filter((t) => {
    if (!seenNames.has(t.name)) return seenNames.add(t.name), true;
    console.error(`[agent call] duplicate tool dropped: ${t.name}`);
    return false;
  });
  const tools: LoopTool[] = unique.map((t) => ({ ...t, run: (x: Record<string, unknown>) => timer.time(`${tag}tool:${t.name}`, () => Promise.resolve(t.run(x))) }));
  const fk = shaping.filler ? (input.filler ?? null) : null;
  const fillerSaid = () => Boolean(fk && FILLERS.get(fk.callId)?.turn === fk.turn);
  const noteFiller = (line: string) => {
    if (!fk) return;
    if (FILLERS.size > 500) FILLERS.clear();
    FILLERS.set(fk.callId, { line, turn: fk.turn });
  };
  let fillerTimer: ReturnType<typeof setTimeout> | null = null;
  const conn = input.connectors ?? null;
  const defs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema: input_schema as Anthropic.Tool.InputSchema }));
  if (defs.length) (defs[defs.length - 1] as Anthropic.Tool).cache_control = { type: "ephemeral" };
  // The model and effort an exec sets in Settings > AI agents > Assistant (Sonnet at medium until then), read each answer
  const { model, effort } = await getAgent("assistant_talk").catch(() => ({ model: "sonnet" as const, effort: "medium" as const }));
  const started = Date.now();
  let reply = "";
  let error: string | null = null;
  let fillers = 0;
  const used = { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
  const messages: LoopMessage[] = [{ role: "user", content: input.content }];
  const marker = endMarkerFilter();
  // The length guard: past its cap a round's answer stops at the end of the sentence and offers the rest. A fresh guard
  // each round (what was said before a lookup doesn't count against the answer), never twice in a row on a call
  const capOf = () => (shaping.lengthGuard ? nextCapFor(fk ? fk.said : "", Boolean(fk && CUTS.get(fk.callId))) : Number.MAX_SAFE_INTEGER);
  let guard = createLengthGuard(capOf());
  let wasCut = false;
  let firstWord = false;
  let lastSpoke = Date.now();
  const say = (d: string) => {
    if (!d) return;
    if (!firstWord && d.trim()) {
      firstWord = true;
      timer.mark(`${tag}first_word`);
    }
    reply += d;
    lastSpoke = Date.now();
    emit({ t: "text", d });
  };
  /** The stream being read now, so the guard can stop a monologue once it has said enough */
  let current: { abort: () => void } | null = null;
  let cut = false;
  let overflow = 0;
  const sayModel = (d: string) => {
    if (cut) {
      // Past the cap: nothing more is said, but the round reads on (it may be heading for a lookup); a monologue is stopped
      overflow += d.length;
      if (overflow > SILENT_OVERFLOW_CHARS) current?.abort();
      return;
    }
    say(guard.feed(marker.feed(d)));
    if (guard.capped && !cut) cut = true;
  };

  // Long work: the step bar (the call's and the chat's), and on a call a short check-in when it's been quiet a while
  const done: string[] = [];
  let step: string | null = null;
  const showProgress = (next: string | null) => {
    step = next;
    emit({ t: "progress", progress: next ? { step: next, done: done.slice(-6), pct: progressPct(done.length), who: tag ? tag.replace(/:$/, "") : null } : null });
  };
  let checkIns = 0;
  const lastCheckIn = () => (fk ? (CHECK_INS.get(fk.callId) ?? null) : null);
  const ticker = shaping.filler
    ? setInterval(() => {
        if (signal.aborted || !step || !checkInDue(Date.now() - lastSpoke, checkIns)) return;
        const line = checkInLine(lastCheckIn(), Date.now() / 1000 + checkIns);
        if (fk) CHECK_INS.set(fk.callId, line);
        checkIns++;
        lastSpoke = Date.now();
        // Its own sentence, said by whoever is working; not kept as part of the answer
        emit({ t: "text", d: `${reply && !/[\n.!?]\s*$/.test(reply) ? "\n" : ""}${line}\n` });
      }, 400)
    : null;
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
      // Half an emoji left by a cut anywhere in the context makes the API refuse the request: made whole first
      system: wellFormed(system()),
      thinking: { type: "adaptive" as const },
      output_config: { effort },
      messages: wellFormed(msgs) as Anthropic.MessageParam[],
    };
    // Cut at the length guard: the round ends with what was said
    const ended = (stream: { currentMessage?: unknown }): Reply => ({
      content: roundText.trim() ? [{ type: "text", text: roundText }] : [],
      stop_reason: "end_turn",
      usage: ((stream.currentMessage as { usage?: Anthropic.Usage } | undefined)?.usage ?? { input_tokens: 0, output_tokens: 0 }) as Anthropic.Usage,
    });
    if (!withConn || !conn) {
      const stream = anthropicClient().messages.stream({ ...base, ...(last || !defs.length ? {} : { tools: defs }) } as Anthropic.MessageCreateParamsStreaming, { signal });
      current = stream;
      stream.on("text", (d) => {
        roundText += d;
        sayModel(d);
      });
      try {
        return (await stream.finalMessage()) as unknown as Reply;
      } catch (e) {
        if (cut && !signal.aborted) return ended(stream);
        throw e;
      }
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
    current = stream;
    stream.on("text", (d) => {
      roundText += d;
      sayModel(d);
    });
    // Their service is being read (on Anthropic's side): a line so the call doesn't go quiet
    stream.on("contentBlock", (b) => {
      const block = b as unknown as { type: string; server_name?: string };
      if (!shaping.filler || block.type !== "mcp_tool_use" || roundText.trim() || fillers > 0 || fillerSaid()) return;
      const line = `One sec, checking your ${conn.nameOf(String(block.server_name ?? ""))}.`;
      say(`${line}\n`);
      noteFiller(line);
      fillers++;
    });
    try {
      return (await stream.finalMessage()) as unknown as Reply;
    } catch (e) {
      if (cut && !signal.aborted) return ended(stream);
      throw e;
    }
  };

  try {
    await runToolLoop({
      tools,
      messages,
      maxRounds: input.maxRounds ?? MAX_TOOL_ROUNDS,
      signal,
      step: async (msgs, last) => {
        roundText = "";
        guard = createLengthGuard(capOf());
        cut = false;
        overflow = 0;
        let res: Reply | null = null;
        // A connector the API couldn't reach or sign in to: the round again without it (once). A long run of connector
        // calls pauses (pause_turn): sent back as it is to carry on, a few times at most
        let retried = false;
        for (let pause = 0; ; ) {
          try {
            res = await timer.time(`${tag}model`, ask(msgs, last));
          } catch (e) {
            if (!signal.aborted && !retried && conn?.servers.length && !roundText && conn.drop(e)) {
              retried = true;
              continue;
            }
            throw e;
          }
          if (!cut) say(guard.feed(marker.flush()));
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
        const stop = marker.ended ? "end_turn" : res.stop_reason;
        // Cut and the round is the answer: offer the rest. Cut ahead of a lookup: the work goes on, nothing is offered
        if (cut && stop !== "tool_use") {
          wasCut = true;
          say(guard.tail);
        }
        return { content: res.content as { type: string }[], stop };
      },
      // Said it's working on it and stopped: the work carries on in this turn instead of waiting for them to speak
      unfinished: (content) => !marker.ended && !signal.aborted && soundsUnfinished(content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ")),
      // While lookups run: the line the agent said, or (only when the tools are slow, about a second and a half) one
      // said for it, so the call never goes quiet. Once per turn, never the same line twice in a row, naming the
      // client only when this turn is about it. A line break ends it, so the answer that follows is its own sentence
      onTools: (calls) => {
        if (step) done.push(step);
        showProgress(stepLabel(tools.find((t) => t.name === calls[0]?.name), calls[0]?.input ?? {}, null));
        if (roundText.trim()) say("\n");
        if (!shaping.filler || roundText.trim() || fillers > 0 || fillerSaid()) return;
        const line = fillerFor(calls, { said: fk ? fk.said : undefined, last: fk ? (FILLERS.get(fk.callId)?.line ?? null) : null, seed: Date.now() });
        if (!line) return;
        fillerTimer = setTimeout(() => {
          fillerTimer = null;
          if (signal.aborted || fillers > 0 || fillerSaid()) return;
          say(`${line}\n`);
          noteFiller(line);
          fillers++;
        }, FILLER_DELAY_MS);
      },
      afterTools: () => {
        if (fillerTimer) clearTimeout(fillerTimer);
        fillerTimer = null;
      },
    });
  } catch (e) {
    if (fillerTimer) clearTimeout(fillerTimer);
    if (!signal.aborted) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error("[agent call] turn", error);
      emit({ t: "error", message: aiBusy(e) ? "I'm a bit busy right now. Try me again in a moment." : e instanceof AiUnavailable ? e.message : "Sorry, I lost my train of thought. Say that again?" });
    }
  }
  if (ticker) clearInterval(ticker);
  if (step) showProgress(null);
  if (fk && shaping.lengthGuard) {
    if (CUTS.size > 500) CUTS.clear();
    CUTS.set(fk.callId, wasCut);
  }
  // Hung up after background chatter with no clear yes to "are you still there?": logged for review
  if (marker.forPrivacy) console.warn("[agent call] hung up: background chatter, no clear yes", input.filler?.callId ?? "");
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

/**
 * What the conversation is about right now, as a short phrase ("the Crust report"), for the line that picks it up in
 * the other mode. A cheap model with a short wait: on a slow answer it's left out ("Picking up where we left off.").
 */
export async function currentTopic(admin: SupabaseClient, callId: string, waitMs = 2500): Promise<string | null> {
  const { data: rows } = await admin.from("ai_role_chats").select("role, content").eq("call_id", callId).order("created_at", { ascending: false }).limit(8);
  const turns = ((rows ?? []) as Turn[]).slice().reverse();
  if (!turns.some((t) => t.role === "user")) return null;
  const ask = askJson<{ summary: string; topic: string }>({
    agent: "coach",
    label: "agent call topic",
    bare: true,
    noSample: true,
    override: { model: "haiku", effort: "low" },
    system: "You read the latest lines of a conversation between a member of a marketing agency's team and one of its AI agents, and name what it's about right now. Plain words, no names of people, no secrets or personal details.",
    schema: SUMMARY_SCHEMA,
    maxTokens: 400,
    prompt: `<conversation>\n${said(turns, "They")}\n</conversation>`,
  })
    .then((out) => parseTopic(out))
    .catch(() => null);
  return Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
}

// ─── Calls never hung up ────────────────────────────────────────────────────

/**
 * Closes calls nobody hung up (a closed tab, a dropped phone, a call past its time): ended when last talked in, what
 * they heard left pending for review (it shows in the person's Overview), a call that heard nothing marked reviewed.
 * `profileId`: every open call of that person (they're starting another); else every call past its time.
 */
export async function sweepOpenCalls(admin: SupabaseClient, opts: { profileId?: string; keep?: string | null } = {}): Promise<{ closed: string[] }> {
  const query = (cols: string) => {
    let q = admin.from("ai_role_calls").select(cols).is("ended_at", null).limit(200);
    if (opts.profileId) q = q.eq("profile_id", opts.profileId);
    else q = q.lt("started_at", new Date(Date.now() - (CALL_LIMIT_SECONDS + 120) * 1000).toISOString());
    return q;
  };
  // Before the chat migration: no mode (every one a call)
  let res = (await query("id, started_at, last_turn_at, learned, mode, mode_log")) as unknown as { data: Record<string, unknown>[] | null; error: unknown };
  if (res.error) res = (await query("id, started_at, last_turn_at, learned")) as unknown as { data: Record<string, unknown>[] | null; error: unknown };
  if (res.error) return { closed: [] };
  const closed: string[] = [];
  for (const c of res.data ?? []) {
    if (opts.keep && c.id === opts.keep) continue;
    const mode = talkModeOf(c.mode);
    // A chat still in use, or a call carried on into a new hour, isn't swept by the clock (only when its person starts something else)
    if (!opts.profileId && stillOpen({ mode, startedAt: c.started_at as string, lastTurnAt: (c.last_turn_at as string | null) ?? null, log: parseModeLog(c.mode_log), callLimitSeconds: CALL_LIMIT_SECONDS })) continue;
    const start = Date.parse(c.started_at as string);
    const last = c.last_turn_at ? Date.parse(c.last_turn_at as string) : start;
    const cap = mode === "text" ? Number.MAX_SAFE_INTEGER : modeSince({ mode, startedAt: c.started_at as string, log: parseModeLog(c.mode_log) }) + CALL_LIMIT_SECONDS * 1000;
    const end = new Date(Math.min(Math.max(last, start), cap, Date.now())).toISOString();
    const pending = pendingOf((c.learned ?? []) as LearnedItem[]).length;
    const { error: e } = await admin
      .from("ai_role_calls")
      .update({ ended_at: end, ...(pending ? {} : { reviewed_at: new Date().toISOString() }) })
      .eq("id", c.id)
      .is("ended_at", null);
    if (e) continue;
    closed.push(c.id as string);
    // Nobody ended it: a drop, unless the last words were a goodbye (they said bye, then closed the tab)
    await saveEndReason(admin, c.id as string, await endReasonOf(admin, c.id as string, "sweep").catch((): EndReason => "dropped"));
  }
  return { closed };
}

/** How a conversation ended, from what closed it and its last lines (core.ts endReasonFor) */
export async function endReasonOf(admin: SupabaseClient, callId: string, trigger: Parameters<typeof endReasonFor>[0]["trigger"]): Promise<EndReason> {
  if (trigger === "button" || trigger === "agent_end" || trigger === "chat_close") return endReasonFor({ trigger });
  const { data } = await admin.from("ai_role_chats").select("role, content").eq("call_id", callId).order("created_at", { ascending: false }).limit(4);
  const rows = (data ?? []) as { role: string; content: string }[];
  return endReasonFor({ trigger, lastUser: rows.find((r) => r.role === "user")?.content ?? null, lastAgent: rows.find((r) => r.role !== "user")?.content ?? null });
}

/** Kept on the conversation (before the chat migration there's nowhere to keep it: the greeting treats it as a drop) */
export async function saveEndReason(admin: SupabaseClient, callId: string, reason: EndReason): Promise<void> {
  const { error } = await admin.from("ai_role_calls").update({ end_reason: reason }).eq("id", callId);
  if (error && !/end_reason/.test(error.message)) console.error("[agent call] end reason", error.message);
}
