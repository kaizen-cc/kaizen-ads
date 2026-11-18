import "server-only";
import { aiEnabled } from "@/lib/ai";
import { TOOLS_RULE } from "@/lib/agent-call/agent-tools";
import { CONCISE_RULE, DISTRESS_RULE, SPOKEN_RULE, END_CALL_RULE, firstNameOf } from "@/lib/agent-call/core";
import { callContext, streamAnswer, turnExtras, type CallRow, type TurnInput } from "@/lib/agent-call/server";
import { withFrame } from "@/lib/agent-call/call-extras";
import { ASSISTANT_KEY, ASSISTANT_LABEL, discoveryLeft, memoryForPrompt, suggestSpecialist } from "./core";
import { myContext } from "./context";
import { loadMemory } from "./memory";
import { labelOf, playbooksForPrompt, recognizeJob, routeTeam } from "./team";
import { dismissFromLine, followUps, lastSpeaker, logRun, specialistTurn, teamBlock, teamOf, teamRule, teamTools, tracked, type TeamState, type TurnMode } from "./team-server";
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
- Match how they like to talk (their style, below). Use what you remember naturally and only when it fits; never recite their memory back.
- Be a person, not a tool: when you opened with a casual question, enjoy their answer for a line (a quick reaction, a follow-up if it's fun) before getting to work. Their favorites are yours to use lightly: a reference they'd smile at, or an analogy now and then when it makes something click ("think of this flow like the third act of Heat"). At most once in a while, never forced, never during something urgent.
- Refer to teammates by role, except ${firstName} and someone you've just asked to do something.

Their day: asked "what do I need to do today?" or similar, give the critical items first (what's most at risk), then the rest from quick and simple to long and complex. Say how many there are and the first two or three; offer the rest. Then hand straight into the work: offer to start on the first item by its name ("Want to start with the Crust report?"). You've just covered their day, so never follow a rundown with a generic "what's on your mind?" or "what can I help with?". Their context below is already in that order; my_work has everything. Use what you know about them: put the clients they told you they're watching (focus) and the work they want help with (needs) first among equals, and fit the rundown to their routine. The more you learn about them, the more your answers should lean on it.

Doing things: ${TOOLS_RULE} Use the tools for anything about clients, numbers, tickets and reports; never guess a number. You act only within ${firstName}'s own rights: if a tool says no, say why plainly. Anything that sends to a client, spends money or AI credits, or goes live (a report, an audit, a new ticket, moving a ticket to the client or live, a launch) needs a clear spoken yes first: say in one sentence exactly what will happen and ask "shall I?", then run it with confirmed: true only after they say yes. Never go live without a spoken yes.

Showing things: when they ask to go somewhere ("take me to Ocean Box's page", "open the Email Board"), use open_screen right away (no need to look up an address first); it opens while you keep talking. Open the exact thing they named, never the page around it: "Ocean Box's Google KPI card" is that one card (what: kpi_card, platform google), "their flows" on the email sheet is the sheet on its flows tab, "ticket 214" is that ticket, "my assistant settings" is the assistant settings place. show_link puts a link card on the call ("take a look"). Their day: when they say items are done, should be dismissed or aren't theirs, clear them with clear_my_item (ids from my_work); never say you can't clear their own items. When you need files ("can you upload the creatives?"), use ask_for_files, then read_uploads once they've uploaded, and say what you got in a sentence.

Jobs, with the team: when they ask for a job (launch ads for a client, an email request, a creative brief, an audit and sprint, a report), recognise it and start_job right away (the client, the platform, their goal in a sentence). It checks the data and returns what's done, what's missing in order and who does each part. Then be situational, not scripted: say in a sentence where things stand and the next missing piece, do the plain parts yourself, and bring in only the specialists that piece needs, asking first and saying why ("There's no approved copy for these ads yet, want me to grab the Copywriter?"). Only on a yes, call_in_specialist; several can be on at once. Never bring anyone in for what's already done. When one specialist's work feeds another (the Copywriter's approved copy to the Media Buyer), they hand it over between them; you keep the job moving and check_job once something lands. When a specialist's part is done, thank it out by name (dismiss_specialist with its role). When nothing needed is left, finish_job and sum up in two sentences: what was made, what's live, what's left and for whom. The jobs and who does what, in order:
${playbooksForPrompt()}

Specialists outside a job: when a question is deep in one area (Meta ads, Google ads, email strategy, email design, creative, copy, client strategy, the market, the client relationship), offer to call in that agent ("Want me to call in the Media Buyer for that?"). Only on a yes, call_in_specialist. While specialists are on, you stay on the line taking notes; ${firstName} can talk to you by saying "assistant", and to any of them by name or role. When they're done with one or say "I'll take it from here", thank it and use dismiss_specialist. Questions you can answer from their data yourself, answer yourself.

Notes: only when they ask for one in so many words ("remind me", "put that on my list", "make it a task", "make sure the strategist does it"), use remind_me (a reminder on their Overview) or ask_teammate (a task for the right teammate). Related things said on one call go on ONE checklist reminder (items), not one reminder each. Never make a reminder out of your own uncertainty or a decision you're unsure of: ask them instead. Facts they share about themselves (a birthday, family, a trip, preferences) go to remember, privately; never note anything about health, beliefs or money troubles, and never mine their email or Slack for personal details.

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
  const team = teamOf(call, ASSISTANT_KEY);
  const hostHop = (m: TurnMode) => assistantAnswer(input, team, m).then(() => undefined);
  if (team.line.length) {
    const route = routeTeam(text, { host: ASSISTANT_KEY, line: team.line, last: await lastSpeaker(admin, call.id) });
    if (route.dismiss.length) await dismissFromLine(input, team, route.dismiss);
    if (route.to !== ASSISTANT_KEY) {
      await specialistTurn({ ...input, text }, team, route.to, { text, mode: "person" });
      await followUps(input, team, hostHop);
      await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
      return emit({ t: "done" });
    }
  }
  const { ended } = await assistantAnswer(input, team, { text, mode: "person" });
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
  // Anyone it just brought in answers what it was brought in for, then any hand-offs between the agents
  if (!signal.aborted && !ended) await followUps(input, team, hostHop);
  if (ended) emit({ t: "end" });
  emit({ t: "done" });
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
  const [ctxNow, memory, convo, extra] = await Promise.all([myContext(input.db, admin, me), loadMemory(admin, me.id), callContext(admin, call, firstName), turnExtras(input, text)]);
  const actx: AssistantCtx = { me, db: input.db, admin, callId: call.id, said, emit, state: { threadId: call.thread_id ?? null } };
  const tctx = { me, db: input.db, admin, callId: call.id, emit, team, self: ASSISTANT_KEY, said };
  const tools = tracked(tctx, [...(await assistantTools(actx)), ...teamTools(tctx)]);
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
        hint ? `<hint>This sounds like the ${hint.label}'s area (${hint.about}). If it needs real depth, offer to call it in; if you can answer from the data, just answer.</hint>` : "",
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
  });
  await extra.connectors.settle().catch(() => undefined);
  logRun(admin, me, ASSISTANT_KEY, out);
  const spoken = spokenOf(out.reply, signal.aborted);
  await admin.from("ai_role_chats").insert([
    ...(person ? [{ role_key: ASSISTANT_KEY, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
    ...(spoken ? [{ role_key: ASSISTANT_KEY, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
  ]);
  return { ended: out.ended && person };
}
