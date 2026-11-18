import "server-only";
import { aiEnabled } from "@/lib/ai";
import { TOOLS_RULE } from "@/lib/agent-call/agent-tools";
import { firstNameOf } from "@/lib/agent-call/core";
import { keptLine, talkModeOf } from "@/lib/agent-call/modality";
import { callContext, streamAnswer, turnExtras, type CallRow, type TurnInput } from "@/lib/agent-call/server";
import { withFrame } from "@/lib/agent-call/call-extras";
import { turnTimes } from "@/lib/agent-call/transcript";
import { callTimer } from "@/lib/agent-call/timing";
import { soundsLikeChurn } from "@/lib/client-risk";
import { asksToFileFeedback } from "@/lib/feedback-logic";
import { ASSISTANT_KEY, ASSISTANT_LABEL, cleanMemory, discoveryLeft, memoryForPrompt, suggestSpecialist } from "./core";
import { planAssistantTurn } from "./prompt";
import { assistantNameOf } from "./name";
import { myContext } from "./context";
import { loadMemory, saveNotes } from "./memory";
import { directSpecialist, labelOf, playbooksForPrompt, recognizeJob, routeTeam, wantsShorter } from "./team";
import { dismissFromLine, followUps, joinSpecialist, lastSpeaker, logRun, specialistTurn, teamBlock, teamOf, teamRule, teamTools, tracked, type TeamState, type TurnMode } from "./team-server";
import { assistantTools, type AssistantCtx } from "./tools";

// One turn of a call with the person's assistant. Who answers: the assistant, or whichever specialist on the line the
// person is talking to (by name or role, else whoever the conversation is with). The assistant reads the person's day,
// clients and private memory each turn and acts with their tools; it runs jobs (launching ads, an email request…) by
// checking what's missing and bringing in only the specialists that part needs, after asking. Each specialist answers
// from its own playbook with its own tools and voice, hands work to the others on the line, and what a trainer
// teaches it waits for review as on any call. Everyone's lines are kept on the call.

/** The words of what's been uploaded on the call, for the assistant's context */
function uploadsBlock(call: CallRow): string {
  const ups = (call.uploads ?? []) as { name: string; kind: string; about?: string }[];
  if (!ups.length) return "";
  return `<uploaded_on_this_call>\n${ups.map((u) => `- ${u.name} (${u.kind}): ${u.about ?? "still being read"}`).join("\n")}\n</uploaded_on_this_call>`;
}

const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

type Input = TurnInput;

/** A turn of an assistant call: routed to the assistant or to whichever specialist on the line it's for */
export async function runAssistantTurn(input: Input) {
  const { admin, call, emit, signal } = input;
  const text = input.text.trim().slice(0, 4000);
  if (!text) return emit({ t: "done" });
  if (!aiEnabled()) return emit({ t: "error", message: "AI isn't connected yet." });
  const timer = input.timer ?? callTimer();
  const team = teamOf(call, ASSISTANT_KEY);
  const hostHop = (m: TurnMode) => assistantAnswer(input, team, m).then(() => undefined);
  // A specialist they asked for, or the one whose line a strategy question is about: it joins and answers now, with
  // no "shall I?" and without the assistant's model in between (that was a whole extra round before anyone spoke)
  const direct = directSpecialist(text, { screen: input.context?.screen ?? null });
  if (team.line.length) {
    const route = routeTeam(text, { host: ASSISTANT_KEY, line: team.line, last: await timer.time("last_speaker", lastSpeaker(admin, call.id)) });
    if (route.dismiss.length) await dismissFromLine(input, team, route.dismiss);
    if (route.to === ASSISTANT_KEY && direct && !route.dismiss.length && (await bringIn(input, team, direct.key, text))) return;
    if (route.to !== ASSISTANT_KEY) {
      await specialistTurn({ ...input, text }, team, route.to, { text, mode: "person" });
      await followUps(input, team, hostHop);
      await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
      return emit({ t: "done" });
    }
  } else if (direct && (await bringIn(input, team, direct.key, text))) return;
  const { ended } = await assistantAnswer(input, team, { text, mode: "person" });
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
  // Anyone it just brought in answers what it was brought in for, then any hand-offs between the agents
  if (!signal.aborted && !ended) await followUps(input, team, hostHop);
  if (ended) emit({ t: "end" });
  emit({ t: "done" });
}

/**
 * A specialist joins for what the person just said and answers it (or, already on, simply answers): the assistant says
 * one line ("Bringing in the Email Strategist."), the specialist answers from its own playbook, then any hand-offs.
 * False when it can't join (not theirs to talk to, offline, the line is full): the assistant answers instead.
 */
async function bringIn(input: Input, team: TeamState, key: string, text: string): Promise<boolean> {
  const { me, admin, call, emit, signal } = input;
  const timer = input.timer ?? callTimer();
  if (!team.line.includes(key)) {
    const j = await timer.time("join", joinSpecialist({ me, admin, callId: call.id, emit, team }, key));
    if (!j.joined) return false;
    const line = `Bringing in the ${j.label}.`;
    emit({ t: "speaker", role: ASSISTANT_KEY, label: ASSISTANT_LABEL, icon: "spark" });
    emit({ t: "text", d: `${line}\n` });
    timer.mark("first_word");
    const at = turnTimes(input.startedAt, Date.now());
    void admin
      .from("ai_role_chats")
      .insert({ role_key: ASSISTANT_KEY, role: "agent", content: line, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.answered })
      .then(({ error }) => error && console.error("[assistant call] join line", error.message));
  }
  await specialistTurn({ ...input, text }, team, key, { text, mode: "person", fresh: true });
  if (!signal.aborted) await followUps(input, team, (m) => assistantAnswer(input, team, m).then(() => undefined));
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
  emit({ t: "done" });
  return true;
}

/**
 * The assistant's own answer: to what the person said (`person`), or to what an agent on the line handed it
 * (`handoff`, where nothing gated runs: only the person's own yes does that). It reads their day, clients and private
 * memory, who's on the line and the job, and acts with their tools and the team tools.
 */
async function assistantAnswer(input: Input, team: TeamState, m: TurnMode): Promise<{ ended: boolean }> {
  const { me, admin, call, emit, signal } = input;
  const text = m.text;
  const person = m.mode === "person";
  const said = person ? text : "";
  const firstName = firstNameOf(me.fullName);
  const timer = input.timer ?? callTimer();
  const [ctxNow, memory, convo, extra, assistantName] = await timer.time(
    "context",
    Promise.all([timer.time("my_day", myContext(input.db, admin, me)), timer.time("memory", loadMemory(admin, me.id)), timer.time("history", callContext(admin, call, firstName)), turnExtras(input, text), assistantNameOf(admin, me.id)]),
  );
  // "Keep it short", "you're rambling": kept in their style right away, so every later call starts that way
  if (person && wantsShorter(text)) {
    const notes = cleanMemory({ notes: [{ kind: "style", topic: "length", body: "Keep it short: lead with the answer in a sentence or two, at most three items, then offer more." }] }, memory);
    if (notes.length) void saveNotes(admin, me.id, notes, call.id).catch((e) => console.error("[assistant call] style", e instanceof Error ? e.message : e));
  }
  const actx: AssistantCtx = { me, db: input.db, admin, callId: call.id, said, emit, state: { threadId: call.thread_id ?? null }, path: input.path ?? null, screen: input.context?.screen ?? null, clientId: input.context?.clientId ?? null };
  const tctx = { me, db: input.db, admin, callId: call.id, emit, team, self: ASSISTANT_KEY, said };
  const tools = tracked(tctx, [...(await timer.time("tools_build", assistantTools(actx))), ...teamTools(tctx)]);
  // A job they're asking for (when none is open), or the specialist whose area this is
  const job = person && team.job?.status !== "open" ? recognizeJob(text) : null;
  const hint = person && !team.line.length && !job ? suggestSpecialist(text) : null;
  const mem = memoryForPrompt(memory, todayIso());
  // Getting to know them: the first call is mostly this; after that, one gentle question per call until each is known
  const left = discoveryLeft(memory);
  const first = !memory.length;
  const discovery =
    person && left.length
      ? first
        ? `<getting_to_know_them>This is your first call with ${firstName}. If they're happy to, get to know them before anything else: ask these one at a time, like a friendly new colleague, reacting briefly to each answer before the next: ${left.map((d) => d.ask).join("; ")}. If they'd rather get straight to work, help them and keep the questions for later calls. Thank them at the end and say how you'll use it.</getting_to_know_them>`
        : `<getting_to_know_them>Still to learn about ${firstName}: ${left.map((d) => d.ask).join("; ")}. Once, when the moment is natural (a lull, or at the end), ask one of these; never in the middle of a task.</getting_to_know_them>`
      : "";
  emit({ t: "speaker", role: ASSISTANT_KEY, label: assistantName || ASSISTANT_LABEL, icon: "spark" });
  const heard = person
    ? `<${firstName}_says>\n${text}\n</${firstName}_says>`
    : `<handed_to_you by="the ${labelOf(m.from ?? "")}">\n${text}\n</handed_to_you>\nPick it up from there in a line or two: keep the job moving, and give ${firstName} the floor with a short question.`;
  // The one place the mode (a call or a chat) enters the turn: how it talks and how the answer streams, nothing else
  const mode = talkModeOf(input.mode);
  const plan = planAssistantTurn({ firstName, assistantName, mode, toolsRule: TOOLS_RULE, playbooks: playbooksForPrompt(), teamRule: teamRule(firstName), tools: [...tools, extra.look, ...extra.connectors.tools] });
  const out = await streamAnswer({
    system: plan.system,
    tools: plan.tools,
    mode,
    connectors: extra.connectors,
    content: withFrame(
      [
        `Today is ${today()} (New York).`,
        ctxNow.text,
        extra.where,
        mem ? `<what_you_know_about_${firstName} private="true">\n${mem}\n</what_you_know_about_${firstName}>` : "",
        discovery,
        uploadsBlock(call),
        teamBlock(team, ASSISTANT_KEY, firstName),
        job ? `<hint>This sounds like the ${job.label.toLowerCase()} job (${job.about}). If they want it done now, start_job straight away, then say where things stand and what's missing; if they're only mentioning it, just answer.</hint>` : "",
        person && soundsLikeChurn(text) ? `<hint>This may say a client is leaving: if so, flag_client_risk now and say so in a few words.</hint>` : "",
        person && asksToFileFeedback(text) ? `<hint>They want to file feedback about the app: one line back, then submit_feedback.</hint>` : "",
        hint ? `<hint>This sounds like the ${hint.label}'s area (${hint.about}). A strategy or expert question goes to it: call_in_specialist now, no question first; a quick fact or number you can read from the data, just answer.</hint>` : "",
        convo,
        extra.hint,
        heard,
      ]
        .filter(Boolean)
        .join("\n\n"),
      extra.frame,
    ),
    signal,
    emit,
    filler: { callId: call.id, turn: input.startedAt ?? 0, said },
    timer,
  });
  await extra.connectors.settle().catch(() => undefined);
  logRun(admin, me, ASSISTANT_KEY, out);
  const spoken = keptLine(out.reply, signal.aborted, mode);
  // The person's line at when they said it, the answer after it (the transcript reads them in that order)
  const at = turnTimes(person ? input.startedAt : null, Date.now());
  await admin.from("ai_role_chats").insert([
    ...(person ? [{ role_key: ASSISTANT_KEY, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.said }] : []),
    ...(spoken ? [{ role_key: ASSISTANT_KEY, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.answered }] : []),
  ]);
  return { ended: out.ended && person };
}
