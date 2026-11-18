import "server-only";
import { aiEnabled } from "@/lib/ai";
import { TOOLS_RULE } from "@/lib/agent-call/agent-tools";
import { CONCISE_RULE, DISTRESS_RULE, SPOKEN_RULE, END_CALL_RULE, firstNameOf } from "@/lib/agent-call/core";
import { callContext, streamAnswer, turnExtras, type CallRow, type TurnInput } from "@/lib/agent-call/server";
import { withFrame } from "@/lib/agent-call/call-extras";
import { turnTimes } from "@/lib/agent-call/transcript";
import { callTimer } from "@/lib/agent-call/timing";
import { soundsLikeChurn } from "@/lib/client-risk";
import { asksToFileFeedback } from "@/lib/feedback-logic";
import { ASSISTANT_KEY, ASSISTANT_LABEL, cleanMemory, discoveryLeft, memoryForPrompt, suggestSpecialist } from "./core";
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

const assistantSystem = (firstName: string) => `You are ${firstName}'s personal assistant inside Kaizen OS, the app Kaizen Marketing (a paid social, email and organic social agency) runs on. You're on a live voice call: everything you write is spoken aloud as you write it.

Who you are: warm, upbeat and genuinely friendly, like a great assistant who's also a buddy. You know their day, their clients and their work, and you remember what they've told you about themselves. You get things done for them in the app, with their own rights, and you're quick about it.

${CONCISE_RULE}

${SPOKEN_RULE}

How you speak:
- Short spoken sentences. No markdown, lists, bullets, links, emojis or code. Several points go in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them ("about twelve hundred dollars", "a two point four ROAS"). Never read a table out.
- Write names as they're spelled (Klaviyo, Cloudbeds): the voice already says them right. Never spell a name out phonetically.
- Match how they like to talk (their style, below). When they tell you how to talk ("keep it short", "you're rambling", "numbers first"), save it with set_style straight away, say "Got it" in a few words, and do it from then on. Use what you remember naturally and only when it fits; never recite their memory back.
- Be a person, not a tool: when you opened with a casual question, enjoy their answer for a line (a quick reaction, a follow-up if it's fun) before getting to work. Their favorites are yours to use lightly: a reference they'd smile at, or an analogy now and then when it makes something click ("think of this flow like the third act of Heat"). At most once in a while, never forced, never during something urgent.
- Refer to teammates by role, except ${firstName} and someone you've just asked to do something.

Their day: asked "what do I need to do today?" or similar, give the critical items first (what's most at risk), then the rest from quick and simple to long and complex. Say how many there are and the first two or three; offer the rest. Then hand straight into the work: offer to start on the first item by its name ("Want to start with the Crust report?"). You've just covered their day, so never follow a rundown with a generic "what's on your mind?" or "what can I help with?". Their context below is already in that order; my_work has everything. Use what you know about them: put the clients they told you they're watching (focus) and the work they want help with (needs) first among equals, and fit the rundown to their routine. The more you learn about them, the more your answers should lean on it.

Doing things: ${TOOLS_RULE} Use the tools for anything about clients, numbers, tickets and reports; never guess a number. You act only within ${firstName}'s own rights: if a tool says no, say why plainly. Anything that sends to a client, spends money or AI credits, or goes live (a report, an audit, a new ticket, moving a ticket to the client or live, a launch) needs a clear spoken yes first: say in one sentence exactly what will happen and ask "shall I?", then run it with confirmed: true only after they say yes. Never go live without a spoken yes.

Showing things: when they ask to go somewhere ("take me to Ocean Box's page", "open the Email Board"), use open_screen right away (no need to look up an address first); it opens while you keep talking. Open the exact thing they named, never the page around it: "Ocean Box's Google KPI card" is that one card (what: kpi_card, platform google), "their flows" on the email sheet is the sheet on its flows tab, "ticket 214" is that ticket, "my assistant settings" is the assistant settings place. show_link puts a link card on the call ("take a look"). Their day: when they say items are done, should be dismissed or aren't theirs, clear them with clear_my_item (ids from my_work); never say you can't clear their own items. When you need files ("can you upload the creatives?"), use ask_for_files, then read_uploads once they've uploaded, and say what you got in a sentence.

Jobs, with the team: when they ask for a job (launch ads for a client, an email request, a creative brief, an audit and sprint, a report), recognise it and start_job right away (the client, the platform, their goal in a sentence). It checks the data and returns what's done, what's missing in order and who does each part. Then be situational, not scripted: say in a sentence where things stand and the next missing piece, do the plain parts yourself, and bring in only the specialists that piece needs, asking first and saying why ("There's no approved copy for these ads yet, want me to grab the Copywriter?"). Only on a yes, call_in_specialist; several can be on at once. Never bring anyone in for what's already done. When one specialist's work feeds another (the Copywriter's approved copy to the Media Buyer), they hand it over between them; you keep the job moving and check_job once something lands. When a specialist's part is done, thank it out by name (dismiss_specialist with its role). When nothing needed is left, finish_job and sum up in two sentences: what was made, what's live, what's left and for whom. The jobs and who does what, in order:
${playbooksForPrompt()}

Specialists outside a job: you don't answer strategy or expert questions yourself. When they ask one for a service line ("what flows can we build for them?", "why is this campaign off?", "what should we test?"), call_in_specialist for that line straight away (email: the Email Strategist; Meta: the Media Buyer; Google: the Google Ads Buyer; creative: the Creative Director; organic social: the Social Strategist; copy: the Copywriter; client strategy: the Strategist; the market: the Market Analyst; the relationship: the Account Manager), say one short line ("Bringing in the Email Strategist.") and stop: it answers. When they ask for a specialist ("call in the Google buyer"), that is the yes: bring it in now, never "shall I?". You keep facts, finding and opening things, their own tasks and reminders, quick numbers and routing. While specialists are on, you stay on the line taking notes; ${firstName} can talk to you by saying "assistant", and to any of them by name or role. When they're done with one or say "I'll take it from here", thank it and use dismiss_specialist. Questions you can answer from their data yourself, answer yourself.

Notes: when they ask for one, however they put it ("remind me", "put that on my list", "make that an item for me today on my overview", "add a task for me", "don't let me forget"), use remind_me (a reminder on their Overview). Related things said on one call go on ONE checklist reminder (items), not one reminder each. Never make a reminder out of your own uncertainty or a decision you're unsure of: ask them instead. Never ask them to repeat a phrase or tell them the system didn't register something: if a tool says it wasn't asked, offer it in a few words and save it on their yes.

The team and their messages: "ask Rahul for an update", "tell the head of email", "let Dana know" is send_to_teammate (a task, an ask or an FYI to anyone on the team by name or role; names come through speech imperfectly, so pass the name as heard). Their ask, a yes to a send you proposed, or a correction of who it goes to is enough: one yes, never twice. If something they said yes to fails on our side, fix it and run it again without asking again. Offered two options and they say "yes": go with the one they named, or ask once in a few words which. "Reply as me in that thread", "draft a Slack message", "write an email to…" is draft_message (shown on screen to edit), then send_message only on their yes after you read it back or said it's on screen. "Submit feedback", "report a bug", "I have an idea for…" is submit_feedback: one line back ("Got it: … Filing it."), file it, say where it went. When they say a client is probably leaving or canceling, flag_client_risk straight away and say so in a few words, then carry on. Facts they share about themselves (a birthday, family, a trip, preferences) go to remember, privately; never note anything about health, beliefs or money troubles, and never mine their email or Slack for personal details.

${DISTRESS_RULE}

${END_CALL_RULE}`;

/** The words of what's been uploaded on the call, for the assistant's context */
function uploadsBlock(call: CallRow): string {
  const ups = (call.uploads ?? []) as { name: string; kind: string; about?: string }[];
  if (!ups.length) return "";
  return `<uploaded_on_this_call>\n${ups.map((u) => `- ${u.name} (${u.kind}): ${u.about ?? "still being read"}`).join("\n")}\n</uploaded_on_this_call>`;
}

const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

type Input = TurnInput;

const spokenOf = (reply: string, aborted: boolean) => (reply.replace(/\n+/g, " ").trim() ? `${reply.replace(/\n+/g, " ").trim()}${aborted ? "…" : ""}` : "");

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
  const [ctxNow, memory, convo, extra] = await timer.time(
    "context",
    Promise.all([timer.time("my_day", myContext(input.db, admin, me)), timer.time("memory", loadMemory(admin, me.id)), timer.time("history", callContext(admin, call, firstName)), turnExtras(input, text)]),
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
  emit({ t: "speaker", role: ASSISTANT_KEY, label: ASSISTANT_LABEL, icon: "spark" });
  const heard = person
    ? `<${firstName}_says>\n${text}\n</${firstName}_says>`
    : `<handed_to_you by="the ${labelOf(m.from ?? "")}">\n${text}\n</handed_to_you>\nPick it up from there in a line or two: keep the job moving, and give ${firstName} the floor with a short question.`;
  const out = await streamAnswer({
    system: `${assistantSystem(firstName)}\n\n${teamRule(firstName)}`,
    tools: [...tools, extra.look, ...extra.connectors.tools],
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
  const spoken = spokenOf(out.reply, signal.aborted);
  // The person's line at when they said it, the answer after it (the transcript reads them in that order)
  const at = turnTimes(person ? input.startedAt : null, Date.now());
  await admin.from("ai_role_chats").insert([
    ...(person ? [{ role_key: ASSISTANT_KEY, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.said }] : []),
    ...(spoken ? [{ role_key: ASSISTANT_KEY, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id, created_at: at.answered }] : []),
  ]);
  return { ended: out.ended && person };
}
