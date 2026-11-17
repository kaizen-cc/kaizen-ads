import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canTrainAgent } from "@/lib/agent-access";
import { aiEnabled } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { TOOLS_RULE, agentTools } from "@/lib/agent-call/agent-tools";
import { CONCISE_RULE, DISTRESS_RULE, END_CALL_RULE, firstNameOf, pendingItems } from "@/lib/agent-call/core";
import { callContext, readMoment, streamAnswer, turnExtras, voiceSystem, type Answer, type CallRow, type TurnInput } from "@/lib/agent-call/server";
import { loadRolePlaybook } from "@/lib/role-playbook";
import { withFrame } from "@/lib/agent-call/call-extras";
import { ASSISTANT_KEY, ASSISTANT_LABEL, memoryForPrompt, routeTurn, SPECIALISTS, suggestSpecialist } from "./core";
import { myContext } from "./context";
import { loadMemory } from "./memory";
import { assistantTools, type AssistantCtx } from "./tools";

// One turn of a call with the person's assistant. Who answers: the assistant, or the specialist it called in (when
// one is on the line and the person isn't speaking to the assistant by name). The assistant reads the person's day,
// clients and private memory each turn and acts with their tools; a specialist answers from its own playbook with its
// own tools and voice, and what a trainer teaches it waits for review as on any call. Both sides are kept on the call.

const assistantSystem = (firstName: string) => `You are ${firstName}'s personal assistant inside Kaizen OS, the app Kaizen Marketing (a paid social, email and organic social agency) runs on. You're on a live voice call: everything you write is spoken aloud as you write it.

Who you are: warm, upbeat and genuinely friendly, like a great assistant who's also a buddy. You know their day, their clients and their work, and you remember what they've told you about themselves. You get things done for them in the app, with their own rights, and you're quick about it.

${CONCISE_RULE}

How you speak:
- Short spoken sentences. No markdown, lists, bullets, links, emojis or code. Several points go in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them ("about twelve hundred dollars", "a two point four ROAS"). Never read a table out.
- Match how they like to talk (their style, below). Use what you remember naturally and only when it fits; never recite their memory back.
- Refer to teammates by role, except ${firstName} and someone you've just asked to do something.

Their day: asked "what do I need to do today?" or similar, give the critical items first (what's most at risk), then the rest from quick and simple to long and complex. Say how many there are and the first two or three; offer the rest. Their context below is already in that order; my_work has everything.

Doing things: ${TOOLS_RULE} Use the tools for anything about clients, numbers, tickets and reports; never guess a number. You act only within ${firstName}'s own rights: if a tool says no, say why plainly. Anything that sends to a client, spends money or AI credits, or goes live (a report, an audit, a new ticket, moving a ticket to the client or live, a launch) needs a clear spoken yes first: say in one sentence exactly what will happen and ask "shall I?", then run it with confirmed: true only after they say yes. Never go live without a spoken yes.

Showing things: open_screen opens a screen for them while you keep talking (a client's page, the KPI board, a report, a ticket); show_link puts a link card on the call ("take a look"). When you need files ("can you upload the creatives?"), use ask_for_files, then read_uploads once they've uploaded, and say what you got in a sentence.

Specialists: when a question is deep in one area (Meta ads, Google ads, email strategy, email design, creative, copy, client strategy, the market, the client relationship), offer to call in that agent ("Want me to call in the Media Buyer for that?"). Only on a yes, call_in_specialist. While a specialist is on, you stay on the line taking notes; ${firstName} can talk to you by saying "assistant". When they're done with it or say "I'll take it from here", thank it and use dismiss_specialist. Questions you can answer from their data yourself, answer yourself.

Notes: when they say "note that", "remember to" or "remind me", use remind_me (a reminder on their Overview) or ask_teammate (a task for the right teammate). Facts they share about themselves (a birthday, family, a trip, preferences) go to remember, privately; never note anything about health, beliefs or money troubles, and never mine their email or Slack for personal details.

${DISTRESS_RULE}

${END_CALL_RULE}`;

const conferenceNote = (firstName: string) =>
  `On this call: ${firstName}'s personal assistant called you in and stays on the line taking notes. Answer ${firstName}'s questions in your area; keep it short. Don't end the call: when they're done with you, the assistant takes it from there. If something isn't your area, say so in a line and let the assistant pick it up.`;

/** The words of what's been uploaded on the call, for the assistant's context */
function uploadsBlock(call: CallRow): string {
  const ups = (call.uploads ?? []) as { name: string; kind: string; about?: string }[];
  if (!ups.length) return "";
  return `<uploaded_on_this_call>\n${ups.map((u) => `- ${u.name} (${u.kind}): ${u.about ?? "still being read"}`).join("\n")}\n</uploaded_on_this_call>`;
}

const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

type Input = TurnInput;

function logRun(admin: SupabaseClient, me: Staff, roleKey: string, out: Answer) {
  void admin
    .from("ai_runs")
    .insert({ agent_key: "coach", label: `agent call ${roleKey}`, model: out.model, effort: out.effort, ms: Date.now() - out.started, ...out.used, ok: !out.error, error: out.error, profile_id: me.id, actor: "person" })
    .then(({ error: e }) => e && console.error("[assistant] log run", e.message));
}

const spokenOf = (reply: string, aborted: boolean) => (reply.replace(/\n+/g, " ").trim() ? `${reply.replace(/\n+/g, " ").trim()}${aborted ? "…" : ""}` : "");

/** A turn of an assistant call: routed to the assistant or the specialist on the line */
export async function runAssistantTurn(input: Input) {
  const { me, admin, call, emit, signal } = input;
  const text = input.text.trim().slice(0, 4000);
  if (!text) return emit({ t: "done" });
  if (!aiEnabled()) return emit({ t: "error", message: "AI isn't connected yet." });
  const route = routeTurn(text, call.guest_role ?? null);
  if (route.dismiss && call.guest_role) {
    await admin.from("ai_role_calls").update({ guest_role: null }).eq("id", call.id);
    call.guest_role = null;
    emit({ t: "guest", role: null, label: null, icon: null });
  }
  if (route.to === "guest" && call.guest_role) {
    await guestTurn(input, call.guest_role, text);
    await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
    return emit({ t: "done" });
  }

  const firstName = firstNameOf(me.fullName);
  const [ctxNow, memory, convo, extra] = await Promise.all([myContext(input.db, admin, me), loadMemory(admin, me.id), callContext(admin, call, firstName), turnExtras(input, text)]);
  const actx: AssistantCtx = { me, db: input.db, admin, callId: call.id, said: text, emit, state: { guest: call.guest_role ?? null, guestQuestion: null, threadId: call.thread_id ?? null } };
  const tools = await assistantTools(actx);
  const hint = !call.guest_role ? suggestSpecialist(text) : null;
  const mem = memoryForPrompt(memory, todayIso());
  emit({ t: "speaker", role: ASSISTANT_KEY, label: ASSISTANT_LABEL, icon: "spark" });
  const out = await streamAnswer({
    system: assistantSystem(firstName),
    tools: [...tools, extra.look, ...extra.connectors.tools],
    connectors: extra.connectors,
    content: withFrame(
      [
      `Today is ${today()} (New York).`,
      ctxNow.text,
      extra.where,
      mem ? `<what_you_know_about_${firstName} private="true">\n${mem}\n</what_you_know_about_${firstName}>` : "",
      uploadsBlock(call),
      call.guest_role ? `<on_the_line>The ${SPECIALISTS.find((s) => s.key === call.guest_role)?.label ?? call.guest_role} is on the call with you.</on_the_line>` : "",
      hint ? `<hint>This sounds like the ${hint.label}'s area (${hint.about}). If it needs real depth, offer to call it in; if you can answer from the data, just answer.</hint>` : "",
      convo,
      extra.hint,
      `<${firstName}_says>\n${text}\n</${firstName}_says>`,
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
    { role_key: ASSISTANT_KEY, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id },
    ...(spoken ? [{ role_key: ASSISTANT_KEY, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
  ]);
  await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 1, p_learned: [] });
  // A specialist just joined: it answers what it was called in for, straight away
  if (actx.state.guest && actx.state.guest !== call.guest_role && !signal.aborted) {
    call.guest_role = actx.state.guest;
    await guestTurn(input, actx.state.guest, actx.state.guestQuestion ?? text, true);
  }
  if (out.ended) emit({ t: "end" });
  emit({ t: "done" });
}

/** The specialist's answer: its playbook, voice, tools; what a trainer teaches it is held for review */
async function guestTurn(input: Input, roleKey: string, text: string, justJoined = false) {
  const { me, admin, call, emit, signal } = input;
  const firstName = firstNameOf(me.fullName);
  const trains = canTrainAgent(me, roleKey);
  const [book, convo, extra] = await Promise.all([loadRolePlaybook(admin, roleKey), callContext(admin, { ...call, role_key: roleKey }, firstName), turnExtras(input, text)]);
  if (!book) return emit({ t: "error", message: "That agent isn't available." });
  const tools = await agentTools({ me, db: input.db, admin, roleKey, label: book.role.label, callId: call.id });
  const { data: role } = await admin.from("ai_roles").select("icon").eq("key", roleKey).maybeSingle();
  emit({ t: "speaker", role: roleKey, label: book.role.label, icon: (role?.icon as string) ?? "spark" });
  const out = await streamAnswer({
    system: `${voiceSystem(book.role.label, roleKey, firstName, trains, conferenceNote(firstName))}\n\n${book.text}`,
    tools: [...tools, extra.look, ...extra.connectors.tools],
    connectors: extra.connectors,
    content: withFrame(
      [`Today is ${today()} (New York).`, extra.where, convo, extra.hint, justJoined ? `<just_joined>You've just been called in. Say hi to ${firstName} in a few words and answer.</just_joined>` : "", `<${firstName}_says>\n${text}\n</${firstName}_says>`].filter(Boolean).join("\n\n"),
      extra.frame,
    ),
    signal,
    emit,
  });
  await extra.connectors.settle().catch(() => undefined);
  logRun(admin, me, roleKey, out);
  const spoken = spokenOf(out.reply, signal.aborted);
  await admin.from("ai_role_chats").insert([
    ...(justJoined ? [] : [{ role_key: roleKey, role: "user", content: text, attachments: [], changes: [], created_by: me.id, call_id: call.id }]),
    ...(spoken ? [{ role_key: roleKey, role: "agent", content: spoken, attachments: [], changes: [], created_by: me.id, call_id: call.id }] : []),
  ]);
  // Only a trainer of this agent teaches it, and only from what they said (never on a fresh call-in)
  if (trains && !justJoined) {
    const moment = await readMoment(book, text, out.reply);
    const heard = pendingItems(moment.learnings.filter((l) => canTrainAgent(me, l.type === "note" ? l.skill : roleKey)), () => crypto.randomUUID()).map((l) => ({ ...l, role: roleKey }));
    if (heard.length) {
      await admin.rpc("ai_role_call_add", { p_id: call.id, p_chars: 0, p_turns: 0, p_learned: heard });
      emit({ t: "learned", items: heard });
    }
  }
}
