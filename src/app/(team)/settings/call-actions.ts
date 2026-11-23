"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import { CALL_LIMIT_SECONDS, assistantVoiceFor, decide, firstNameOf, greetingFor, handoverLine, keepsHandoverLine, isEndReason, isVoiceId, leftUnfinished, localDayIn, localHourIn, pendingOf, resumeModeFor, seedOf, statusOf, voiceFor, type Decision, type EndTrigger, type LearnedItem, type ResumeMode } from "@/lib/agent-call/core";
import { CHAT_LIMIT_SECONDS, modeSince, parseModeLog, stillOpen, talkModeOf, type TalkMode } from "@/lib/agent-call/modality";
import { currentTopic, endReasonOf, saveEndReason, summarizeCall, sweepOpenCalls } from "@/lib/agent-call/server";
import { reviewCallSafety } from "@/lib/agent-call/safety";
import { ASSISTANT_KEY, ASSISTANT_LABEL, assistantGreeting } from "@/lib/assistant/core";
import { assistantNameOf } from "@/lib/assistant/name";
import { formatTranscript, transcriptFileName } from "@/lib/agent-call/transcript";
import { learnFromCall, loadMemory, markFollowedUp } from "@/lib/assistant/memory";
import { writeCallNotes } from "@/lib/assistant/notes";
import { logTraining, snapshot } from "@/lib/agent-training";
import { aiEnabled } from "@/lib/ai";
import { requireStaff, type Staff } from "@/lib/auth";
import { viewAsMessage } from "@/lib/view-as-core";
import { elevenlabsConfigured, listVoices, realtimeSttToken } from "@/lib/elevenlabs";
import { createAdminClient } from "@/lib/supabase/admin";
import { chatWithAgent } from "./actions";

// Calling an agent by voice (Settings › AI agents › the agent): everyone on the team can call every agent and ask it
// things. Starting a call closes any call of theirs left open, works out how it follows the last one (a cut-off, a
// quick call back, later the same day, or a fresh start) for the greeting and the context, and hands the browser a
// single-use token for ElevenLabs' realtime speech to text. Hanging up closes it and logs what it cost. What a trainer
// (an exec, or the head of the agent's line) taught it waits as pending: at hang-up (or later, from their Overview or
// the agent's page) they keep or toss each item, and only kept ones are written. The turns themselves stream through
// /api/agent-call/turn and /api/agent-call/speak.

type Fail = { ok: false; error: string; needsNotice?: boolean };
const NOT_YOURS: Fail = { ok: false, error: "Only an executive or the head of this agent's line can change what it knows." };

export type StartedCall = { ok: true; callId: string; greeting: string; sttToken: string | null; limitSeconds: number; startedAt: string; mode: ResumeMode; canTeach: boolean; talk: TalkMode };

/** The last conversation with an agent, as the greeting reads it (how it ended, whether something was left open) */
async function lastConversation(admin: ReturnType<typeof createAdminClient>, profileId: string, roleKey: string) {
  const pick = (cols: string) => admin.from("ai_role_calls").select(cols).eq("profile_id", profileId).eq("role_key", roleKey).order("started_at", { ascending: false }).limit(1).maybeSingle();
  let res = (await pick("id, started_at, ended_at, last_turn_at, turns, topic, end_reason, job")) as unknown as { data: Record<string, unknown> | null; error: unknown };
  // Before the chat migration: no end reason (a drop, as before)
  if (res.error) res = (await pick("id, started_at, ended_at, last_turn_at, turns, topic")) as unknown as { data: Record<string, unknown> | null; error: unknown };
  return res.data;
}

/**
 * Pick up: the conversation's row, the greeting (kept as the agent's first line) and, for a call, a speech to text
 * token. `talk`: a voice call (the default) or a typed chat with the assistant; both are the same conversation and
 * turn pipeline, and either can move to the other (switchCallMode).
 */
export async function startCall(roleKey: string, opts: { talk?: TalkMode; headsUp?: string | null; tz?: string | null } = {}): Promise<StartedCall | Fail> {
  const me = await requireStaff();
  const talk = talkModeOf(opts.talk);
  // The owner viewing as a teammate: their assistant and agents stay theirs (a conversation would be kept as theirs)
  if (me.viewAs) return { ok: false, error: `${viewAsMessage(me.fullName)} The assistant is read only while you view as someone; ask your own assistant what a role sees.` };
  if (!canTalkToAgent(me, roleKey)) return { ok: false, error: "That isn't one of the agents." };
  if (!aiEnabled()) return { ok: false, error: "AI isn't connected yet." };
  if (talk === "voice" && !elevenlabsConfigured()) return { ok: false, error: "Calls need ElevenLabs: an exec adds ELEVENLABS_API_KEY in Vercel." };
  const admin = createAdminClient();
  // The one-time notice that conversations with Kaizen's AI are recorded and may be reviewed, before the first of any kind
  if (!(await noticeAcked(admin, me.id))) return { ok: false, error: "Calls and chats with Kaizen's AI are recorded and may be reviewed for safety and compliance.", needsNotice: true };
  const { data: role } = await admin.from("ai_roles").select("*").eq("key", roleKey).maybeSingle();
  if (!role) return { ok: false, error: "Unknown agent." };
  // A conversation of theirs never ended (a closed tab, a dropped line) is closed first, with how it ended (a drop,
  // unless its last words were a goodbye); what it heard stays for review
  const swept = await sweepOpenCalls(admin, { profileId: me.id }).catch(() => ({ closed: [] as string[] }));
  for (const id of swept.closed) after(() => summarizeCall(admin, id));
  // How this one follows their last one with this agent: a cut-off, a quick "hey again" after they ended it, a few
  // hours later, later the same day, or a fresh start
  const prev = await lastConversation(admin, me.id, roleKey);
  const endReason = isEndReason(prev?.end_reason) ? prev.end_reason : null;
  const mode = prev ? resumeModeFor({ startedAt: prev.started_at as string, endedAt: (prev.ended_at as string | null) ?? null, lastTurnAt: (prev.last_turn_at as string | null) ?? null, turns: Number(prev.turns ?? 0), endReason }) : "fresh";
  // ElevenLabs' realtime speech to text when it hands out a token (a call); the browser's own listening otherwise
  const sttToken =
    talk === "voice"
      ? await realtimeSttToken(CALL_LIMIT_SECONDS + 60).catch((e) => {
          console.error("[agent call] speech token", e instanceof Error ? e.message : e);
          return null;
        })
      : null;
  const roleVoice = (role as { voice_id?: string | null }).voice_id;
  // The assistant speaks in the voice its person picked (theirs alone), else the assistant's voice for everyone
  const personal = roleKey === ASSISTANT_KEY ? await personalVoice(admin, me.id) : null;
  const row = { role_key: roleKey, profile_id: me.id, voice_id: roleKey === ASSISTANT_KEY ? assistantVoiceFor(personal, roleVoice) : voiceFor(roleKey, roleVoice), stt: talk === "text" ? null : sttToken ? "scribe" : "browser" };
  const resumed = { resumed_from: mode === "fresh" ? null : ((prev?.id as string | undefined) ?? null) };
  let { data: call, error } = await admin
    .from("ai_role_calls")
    .insert({ ...row, ...resumed, resume_mode: mode, mode: talk, mode_log: [{ mode: talk, at: new Date().toISOString() }] })
    .select("id, started_at")
    .single();
  // Before the chat migration: no mode, and "again" reads as a quick call back
  if (error) ({ data: call, error } = await admin.from("ai_role_calls").insert({ ...row, ...resumed, resume_mode: mode === "again" ? "soon" : mode }).select("id, started_at").single());
  // Before the review migration: a plain call
  if (error) ({ data: call, error } = await admin.from("ai_role_calls").insert(row).select("id, started_at").single());
  if (error || !call) return { ok: false, error: error?.message ?? "Couldn't start the call." };
  // Back a moment after ending it themselves: the topic only when something was left open (a job running, a question)
  let topic = (prev?.topic as string | null) ?? null;
  if (mode === "again" && prev) {
    const { data: lastAgent } = await admin.from("ai_role_chats").select("content").eq("call_id", prev.id as string).neq("role", "user").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const job = prev.job as { status?: string } | null | undefined;
    if (!leftUnfinished({ jobOpen: job?.status === "open", lastAgent: (lastAgent?.content as string | null) ?? null })) topic = null;
  }
  // The hour where they are (their browser's time zone; New York when it isn't known): "good evening" at 8pm their time
  const hour = localHourIn(opts.tz);
  let greeting = greetingFor(me.fullName, role.label as string, mode, topic, seedOf(call.id as string), hour);
  // The assistant: a hello that remembers them (a birthday, how the trip went), unless the line just dropped
  if (roleKey === ASSISTANT_KEY && mode !== "continue") {
    const [memory, { data: tips }] = await Promise.all([loadMemory(admin, me.id), admin.from("assistant_tips").select("tip, seen_at, used_at, tipped_at").eq("profile_id", me.id)]);
    // A broken personal connection (their Slack connected for posting only, or expired): said once, instead of a tip
    let connLine: string | null = null;
    if (!me.viewAs) {
      const [{ slackConnection }, { helloConnectionLine }] = await Promise.all([import("@/lib/personal-connections"), import("@/lib/personal-connections-core")]);
      const slack = await slackConnection(me.id).catch(() => null);
      const line = slack ? helloConnectionLine("slack", slack.state) : null;
      if (line && slack) {
        const { error: told } = await admin.from("connection_notices").insert({ profile_id: me.id, service: "slack", state: slack.state });
        if (!told) connLine = line;
      }
    }
    const hello = assistantGreeting({ name: firstNameOf(me.fullName), memory, today: localDayIn(opts.tz), seed: seedOf(call.id as string), mode, timed: greeting, hour, tips: me.viewAs || connLine ? null : tips });
    greeting = connLine ? `${hello.text} ${connLine}` : hello.text;
    if (hello.followed) await markFollowedUp(admin, me.id, hello.followed);
    // Told once, then not again for a while
    if (hello.tipped) await admin.from("assistant_tips").update({ tipped_at: new Date().toISOString() }).eq("profile_id", me.id).eq("tip", hello.tipped);
  }
  // Answering the assistant's ring: the call opens with the heads-up itself ("Hey Santi! Heads up, I just put...")
  if (roleKey === ASSISTANT_KEY && opts.headsUp && /^[0-9a-f-]{36}$/i.test(opts.headsUp)) {
    const { headsUpFor } = await import("@/lib/assistant/heads-up-server");
    const h = await headsUpFor(admin, me.id, opts.headsUp).catch(() => null);
    if (h) {
      greeting = h.line;
      (await import("@/lib/assistant/context")).forgetContext(me.id);
    }
  }
  await admin.from("ai_role_chats").insert({ role_key: roleKey, role: "agent", content: greeting, attachments: [], changes: [], created_by: me.id, call_id: call.id });
  return { ok: true, callId: call.id as string, greeting, sttToken, limitSeconds: talk === "text" ? CHAT_LIMIT_SECONDS : CALL_LIMIT_SECONDS, startedAt: call.started_at as string, mode, canTeach: canTrainAgent(me, roleKey), talk };
}

// ─── One conversation, a call or a chat ─────────────────────────────────────

/** A line of the conversation as the chat window shows it */
export type ThreadLine = { who: "you" | "agent"; text: string; at: string; speaker: { role: string; label: string; icon: string } | null };

/** The conversation's lines, oldest first (the newest `limit`), with who said each */
async function threadLines(admin: ReturnType<typeof createAdminClient>, callId: string, limit = 120): Promise<ThreadLine[]> {
  const [{ data: rows }, { data: roles }] = await Promise.all([
    admin.from("ai_role_chats").select("role, content, role_key, created_at").eq("call_id", callId).order("created_at", { ascending: false }).limit(limit),
    admin.from("ai_roles").select("key, label, icon"),
  ]);
  const of = new Map((roles ?? []).map((r) => [r.key as string, { label: r.label as string, icon: ((r.icon as string | null) ?? "spark") as string }]));
  return ((rows ?? []) as { role: string; content: string; role_key: string | null; created_at: string }[])
    .slice()
    .reverse()
    .map((r) => {
      const key = r.role_key ?? ASSISTANT_KEY;
      const who = r.role === "user" ? ("you" as const) : ("agent" as const);
      const speaker = who === "agent" ? { role: key, label: key === ASSISTANT_KEY ? ASSISTANT_LABEL : (of.get(key)?.label ?? "Agent"), icon: key === ASSISTANT_KEY ? "spark" : (of.get(key)?.icon ?? "spark") } : null;
      return { who, text: String(r.content ?? ""), at: r.created_at, speaker };
    });
}

export type OpenedChat = { ok: true; callId: string; startedAt: string; lines: ThreadLine[]; earlier: ThreadLine[]; resumed: boolean; canTeach: boolean; headsUps: ChatHeadsUp[] };

/** An urgent heads-up waiting in the chat: its words are a line of the conversation; its link is a card to open it */
export type ChatHeadsUp = { id: string; href: string | null; title: string };

/**
 * The urgent heads-ups waiting for them (a missed or declined ring, or while they were away): written into the
 * conversation as the assistant's lines, so the agent knows what it said, and marked read.
 */
async function headsUpsIntoChat(admin: ReturnType<typeof createAdminClient>, profileId: string, callId: string): Promise<ChatHeadsUp[]> {
  const { unreadHeadsUps, markHeadsUpsRead } = await import("@/lib/assistant/heads-up-server");
  const list = await unreadHeadsUps(admin, profileId).catch(() => []);
  if (!list.length) return [];
  await admin.from("ai_role_chats").insert(list.map((h) => ({ role_key: ASSISTANT_KEY, role: "agent", content: h.chat, attachments: [], changes: [], created_by: profileId, call_id: callId })));
  await markHeadsUpsRead(admin, profileId, list.map((h) => h.id));
  return list.map((h) => ({ id: h.id, href: h.href, title: h.items.length > 1 ? `${h.items.length} urgent items` : (h.items[0]?.title ?? "Something urgent") }));
}

/** New heads-ups while the chat is open: into this conversation, as above (the chat window shows them straight away) */
export async function takeChatHeadsUps(callId: string): Promise<{ ok: true; lines: ThreadLine[]; headsUps: ChatHeadsUp[] } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That isn't your conversation." };
  const headsUps = await headsUpsIntoChat(admin, me.id, callId);
  if (!headsUps.length) return { ok: true, lines: [], headsUps };
  const lines = await threadLines(admin, callId, headsUps.length);
  return { ok: true, lines, headsUps };
}

/**
 * Chat with the assistant: their chat still open (a reload, another tab) picks up with its lines; otherwise a new
 * conversation starts (its greeting follows the same rules as a call's), with the last few lines of the one before
 * shown above it.
 */
export async function openAssistantChat(opts: { tz?: string | null } = {}): Promise<OpenedChat | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: open, error } = await admin.from("ai_role_calls").select("id, started_at, last_turn_at, mode, mode_log").eq("profile_id", me.id).eq("role_key", ASSISTANT_KEY).is("ended_at", null).eq("mode", "text").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!error && open && stillOpen({ mode: "text", startedAt: open.started_at as string, lastTurnAt: (open.last_turn_at as string | null) ?? null, log: parseModeLog(open.mode_log), callLimitSeconds: CALL_LIMIT_SECONDS })) {
    const headsUps = await headsUpsIntoChat(admin, me.id, open.id as string);
    return { ok: true, callId: open.id as string, startedAt: open.started_at as string, lines: await threadLines(admin, open.id as string), earlier: [], resumed: true, canTeach: canTrainAgent(me, ASSISTANT_KEY), headsUps };
  }
  const r = await startCall(ASSISTANT_KEY, { talk: "text", tz: opts.tz });
  if (!r.ok) return r;
  const { data: row } = await admin.from("ai_role_calls").select("resumed_from").eq("id", r.callId).maybeSingle();
  const before = (row?.resumed_from as string | null) ?? null;
  const headsUps = await headsUpsIntoChat(admin, me.id, r.callId);
  const [lines, earlier] = await Promise.all([threadLines(admin, r.callId), before ? threadLines(admin, before, 12) : Promise.resolve([] as ThreadLine[])]);
  return { ok: true, callId: r.callId, startedAt: r.startedAt, lines, earlier, resumed: false, canTeach: r.canTeach, headsUps };
}

export type SwitchedCall = { ok: true; line: string; sttToken: string | null; limitSeconds: number; since: string; lines: ThreadLine[] };

/**
 * The same conversation carries on in the other mode ("Call" in the chat, "Switch to chat" on a call, or the
 * assistant's switch_mode): the mode and when it moved are kept on the conversation, and the agent picks up with one
 * line ("Picking up where we left off: the Crust report."), never a fresh greeting. A call gets its speech to text
 * token, and its thirty minutes count from now.
 */
export async function switchCallMode(callId: string, to: TalkMode): Promise<SwitchedCall | Fail> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId)) return { ok: false, error: "That conversation isn't there." };
  const talk = talkModeOf(to);
  if (talk === "voice" && !elevenlabsConfigured()) return { ok: false, error: "Calls need ElevenLabs: an exec adds ELEVENLABS_API_KEY in Vercel." };
  const admin = createAdminClient();
  const { data: call, error } = await admin.from("ai_role_calls").select("id, profile_id, role_key, ended_at, mode, mode_log").eq("id", callId).maybeSingle();
  if (error) return { ok: false, error: "Switching needs the latest update. Try again in a moment." };
  if (!call || call.profile_id !== me.id || call.ended_at || !canTalkToAgent(me, call.role_key as string)) return { ok: false, error: "This conversation has ended." };
  const since = new Date().toISOString();
  const log = [...parseModeLog(call.mode_log), { mode: talk, at: since }].slice(-200);
  const [sttToken, topic] = await Promise.all([
    talk === "voice"
      ? realtimeSttToken(CALL_LIMIT_SECONDS + 60).catch((e) => {
          console.error("[agent call] speech token", e instanceof Error ? e.message : e);
          return null;
        })
      : Promise.resolve(null),
    currentTopic(admin, callId).catch(() => null),
  ]);
  const { error: e } = await admin
    .from("ai_role_calls")
    .update({ mode: talk, mode_log: log, ...(talk === "voice" ? { stt: sttToken ? "scribe" : "browser" } : {}) })
    .eq("id", callId);
  if (e) return { ok: false, error: "Couldn't switch. Try again." };
  const line = handoverLine(topic);
  // Kept in the conversation only after a real pause: mid-conversation the switch carries straight on (no repeated line)
  const { data: lastRow } = await admin.from("ai_role_chats").select("role, content, created_at").eq("call_id", callId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const last = lastRow ? { at: Date.parse(lastRow.created_at as string), role: lastRow.role as string, content: String(lastRow.content ?? "") } : null;
  if (keepsHandoverLine(last, Date.now())) await admin.from("ai_role_chats").insert({ role_key: call.role_key, role: "agent", content: line, attachments: [], changes: [], created_by: me.id, call_id: callId });
  return { ok: true, line, sttToken, limitSeconds: talk === "voice" ? CALL_LIMIT_SECONDS : CHAT_LIMIT_SECONDS, since, lines: talk === "text" ? await threadLines(admin, callId) : [] };
}

/** The voice a person picked for their own assistant (null before the migration, or when they haven't) */
async function personalVoice(admin: ReturnType<typeof createAdminClient>, profileId: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("assistant_voice").eq("id", profileId).maybeSingle();
  if (error) return null;
  return (data?.assistant_voice as string | null) ?? null;
}

/**
 * The call carries on past the hour (never cut mid-sentence): the same conversation gets a fresh hour from now, logged
 * on it like a switch to voice, and a new listening token. No line is added: it simply goes on.
 */
export async function extendCall(callId: string): Promise<{ ok: true; since: string; sttToken: string | null } | Fail> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId)) return { ok: false, error: "That conversation isn't there." };
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id, role_key, ended_at, mode, mode_log").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id || call.ended_at || !canTalkToAgent(me, call.role_key as string)) return { ok: false, error: "This call has ended." };
  const since = new Date().toISOString();
  const log = [...parseModeLog(call.mode_log), { mode: "voice" as const, at: since }].slice(-200);
  const { error } = await admin.from("ai_role_calls").update({ mode: "voice", mode_log: log }).eq("id", callId);
  if (error) return { ok: false, error: "Couldn't carry the call on." };
  const sttToken = await realtimeSttToken(CALL_LIMIT_SECONDS + 60).catch(() => null);
  return { ok: true, since, sttToken };
}

/** A new speech to text token mid-call (the first one is single use: a dropped connection needs another) */
export async function renewSttToken(callId: string): Promise<{ ok: true; token: string } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id, role_key, started_at, ended_at, mode_log").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id || call.ended_at || !canTalkToAgent(me, call.role_key as string)) return { ok: false, error: "This call has ended." };
  const since = modeSince({ mode: "voice", startedAt: call.started_at as string, log: parseModeLog(call.mode_log) });
  const left = CALL_LIMIT_SECONDS - (Date.now() - since) / 1000;
  if (left <= 0) return { ok: false, error: "This call has ended." };
  try {
    return { ok: true, token: await realtimeSttToken(left + 30) };
  } catch {
    return { ok: false, error: "Couldn't reconnect the listening." };
  }
}

/** A short speech to text token for dictating into the chat (the mic in the chat's input; replies stay text) */
export async function dictationToken(callId: string): Promise<{ ok: true; token: string } | Fail> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId)) return { ok: false, error: "That conversation isn't there." };
  if (!elevenlabsConfigured()) return { ok: false, error: "Dictation needs ElevenLabs." };
  const { data: call } = await createAdminClient().from("ai_role_calls").select("profile_id, role_key, ended_at").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id || call.ended_at || !canTalkToAgent(me, call.role_key as string)) return { ok: false, error: "This conversation has ended." };
  try {
    return { ok: true, token: await realtimeSttToken(10 * 60) };
  } catch {
    return { ok: false, error: "Couldn't start dictation." };
  }
}

export type EndedCall ={ ok: true; seconds: number; learned: LearnedItem[]; canReview: boolean; skills: Record<string, string> };

/**
 * Hang up: the call is closed, its cost logged with the other AI runs (ElevenLabs characters and seconds listened),
 * a short summary written after it (for later calls today), and what it heard comes back for the review. Nothing
 * heard is written yet. Safe to call twice.
 */
export async function endCall(callId: string, how: EndTrigger = null): Promise<EndedCall | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, stt, started_at, ended_at, tts_characters, learned").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const endedAt = call.ended_at ? new Date(call.ended_at as string) : new Date();
  const seconds = Math.min(CALL_LIMIT_SECONDS + 60, Math.max(0, Math.round((endedAt.getTime() - new Date(call.started_at as string).getTime()) / 1000)));
  if (!call.ended_at) {
    const sttSeconds = call.stt === "scribe" ? seconds : 0;
    const pending = pendingOf(learned).length;
    const { error } = await admin
      .from("ai_role_calls")
      .update({ ended_at: endedAt.toISOString(), stt_seconds: sttSeconds, ...(pending ? {} : { reviewed_at: endedAt.toISOString() }) })
      .eq("id", callId);
    if (error) await admin.from("ai_role_calls").update({ ended_at: endedAt.toISOString(), stt_seconds: sttSeconds }).eq("id", callId);
    await admin.from("ai_runs").insert({
      agent_key: "coach",
      label: `agent call voice ${call.role_key}`,
      model: null,
      ms: seconds * 1000,
      input_tokens: 0,
      output_tokens: 0,
      characters: (call.tts_characters as number) ?? 0,
      audio_seconds: sttSeconds,
      ok: true,
      profile_id: me.id,
      actor: "person",
    });
    after(() => summarizeCall(admin, callId));
    // How it ended (hung up, a goodbye, the chat closed, or a drop), for how the next one greets them
    // (kept now, not after: a call back a moment later reads it)
    await saveEndReason(admin, callId, await endReasonOf(admin, callId, how).catch(() => "dropped" as const));
    // The assistant's notes and what it learned about the person (their private memory), then every call's safety review
    if (call.role_key === ASSISTANT_KEY) {
      after(() => writeCallNotes(admin, callId).then(() => undefined));
      after(() => learnFromCall(admin, callId).then(() => undefined));
      // A call with an agent where others joined or a job ran: its notes too (who did what, what was made)
    } else after(() => writeCallNotes(admin, callId).then(() => undefined));
    // A little later, so the last part of the recording has landed before the review decides whether to keep it
    after(async () => {
      await new Promise((r) => setTimeout(r, 20_000));
      await reviewCallSafety(admin, callId);
    });
    revalidatePath("/settings");
  }
  // On an assistant call, what was heard belongs to the specialists it called in
  // (and on a call with an agent, what the specialists it brought in heard is theirs)
  const taught = [...new Set(learned.map((l) => l.role).filter((r): r is string => Boolean(r)))];
  const roles = call.role_key === ASSISTANT_KEY ? taught : [...new Set([call.role_key as string, ...taught])];
  const { data: skillRows } = roles.length ? await admin.from("ai_agents").select("key, label").in("role_key", roles) : { data: [] };
  const skills = Object.fromEntries((skillRows ?? []).map((k) => [k.key as string, k.label as string]));
  return { ok: true, seconds, learned, canReview: roles.some((r) => canTrainAgent(me, r)), skills };
}

export type ReviewedCall = { ok: true; learned: LearnedItem[]; kept: number; tossed: number; proposals: number };

/**
 * The review: keep or toss each thing a call heard, with a kept note's text as edited. Kept notes are written to their
 * skill as knowledge items (in the agent's history, so an exec can revert one); kept rewrites of the core or a skill's
 * instructions go to the agent's chat as proposed edits a person applies; tossed ones are kept on the call as tossed.
 * The same people who apply edits in the agent's chat may review: an exec, or the head of the agent's line (their own
 * calls; an exec anyone's). Every pending item needs a decision. Safe against a second review (it's claimed first).
 */
export async function reviewCallLearnings(callId: string, decisions: Record<string, Decision>): Promise<ReviewedCall | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, learned, reviewed_at").eq("id", callId).maybeSingle();
  if (!call) return { ok: false, error: "That call isn't there any more." };
  const items = (call.learned ?? []) as LearnedItem[];
  // An assistant call's items were taught to the specialist it called in (each carries its agent)
  const roleKey = call.role_key === ASSISTANT_KEY ? (items.find((l) => l.role)?.role ?? "") : (call.role_key as string);
  if (!canTrainAgent(me, roleKey) || (call.profile_id !== me.id && !me.isExec)) return NOT_YOURS;
  const plan = decide(items, decisions);
  if (!plan.ok) return plan;
  // Claimed, so two tabs can't write the same notes twice
  const { data: claimed } = await admin.from("ai_role_calls").update({ reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("id", callId).is("reviewed_at", null).select("id");
  if (!claimed?.length) return { ok: false, error: "This call was already reviewed." };

  const next = plan.items.slice();
  const proposals: LearnedItem[] = [];
  for (const k of plan.keep) {
    const at = next.findIndex((x) => x.key === k.key);
    if (k.type === "rewrite") {
      proposals.push(k);
      continue;
    }
    if (!canTrainAgent(me, k.skill)) {
      next[at] = { ...k, status: "tossed" };
      continue;
    }
    const { data, error } = await admin.from("ai_knowledge").insert({ agent_key: k.skill, kind: k.kind ?? "knowledge", title: k.title, body: k.body, created_by: me.id }).select("id").single();
    if (error || !data) {
      console.error("[agent call] keep learning", error?.message);
      // Not written: back to pending, so it surfaces again
      next[at] = { ...k, status: "pending" };
      continue;
    }
    await logTraining(admin, { me, agentKey: k.skill, target: "item:new", record: `item:${data.id}`, before: null });
    next[at] = { ...k, id: data.id as string };
  }
  const stillPending = pendingOf(next).length > 0;
  await admin
    .from("ai_role_calls")
    .update({ learned: next, ...(stillPending ? { reviewed_at: null, reviewed_by: null } : {}) })
    .eq("id", callId);
  // Proposals go to each agent's own chat (an assistant call can have taught more than one)
  for (const [agent, list] of Object.entries(Object.groupBy(proposals, (p) => p.role ?? roleKey))) {
    if (!list?.length || !canTrainAgent(me, agent)) continue;
    const asked = `From our call, change how you work: ${list.map((p) => `${p.skill === "core" ? "in your core" : `in your ${p.skill} skill`}, ${p.body}`).join(" Also, ")}`;
    after(async () => {
      const r = await chatWithAgent(agent, asked);
      if (!r.ok) console.error("[agent call] proposals", r.error);
    });
  }
  revalidatePath("/settings");
  revalidatePath("/pipeline");
  return { ok: true, learned: next, kept: plan.keep.length, tossed: plan.tossed, proposals: proposals.length };
}

/** Undo one note a call saved (the item is turned off, as a revert does; Put back turns it on again) */
export async function undoLearning(callId: string, itemId: string, undo = true): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, learned").eq("id", callId).maybeSingle();
  if (!call || (call.profile_id !== me.id && !me.isExec)) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const at = learned.findIndex((l) => l.id === itemId && l.type === "note" && statusOf(l) === "kept");
  if (at < 0) return { ok: false, error: "That isn't something this call saved." };
  const { data: item } = await admin.from("ai_knowledge").select("agent_key").eq("id", itemId).maybeSingle();
  if (!item) return { ok: false, error: "That item isn't there any more." };
  if (!canTrainAgent(me, item.agent_key as string)) return NOT_YOURS;
  const before = await snapshot(admin, `item:${itemId}`);
  const { error } = await admin.from("ai_knowledge").update({ active: !undo, updated_at: new Date().toISOString() }).eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await logTraining(admin, { me, agentKey: item.agent_key as string, target: `item:${itemId}`, record: `item:${itemId}`, before });
  learned[at] = { ...learned[at], undone: undo };
  await admin.from("ai_role_calls").update({ learned }).eq("id", callId);
  revalidatePath("/settings");
  return { ok: true };
}

export type CallVoice = { id: string; name: string; about: string; preview: string | null };

async function trainerOf(roleKey: string): Promise<Staff | null> {
  const me = await requireStaff();
  return canTrainAgent(me, roleKey) ? me : null;
}

/** The voices an agent can speak in (Kaizen's own ElevenLabs voices first) */
export async function callVoices(roleKey: string): Promise<{ ok: true; voices: CallVoice[] } | Fail> {
  if (!(await trainerOf(roleKey))) return NOT_YOURS;
  if (!elevenlabsConfigured()) return { ok: false, error: "ElevenLabs isn't connected." };
  try {
    const voices = await listVoices();
    return {
      ok: true,
      voices: voices.map((v) => ({
        id: v.id,
        name: v.name,
        about: [v.labels.gender, v.labels.accent, v.labels.age, v.labels.description ?? v.labels.descriptive].filter(Boolean).join(", "),
        preview: v.previewUrl,
      })),
    };
  } catch {
    return { ok: false, error: "Couldn't load the voices." };
  }
}

/** The voice an agent speaks in on calls (null goes back to its role's default) */
export async function setAgentVoice(roleKey: string, voiceId: string | null): Promise<{ ok: true } | Fail> {
  const me = await trainerOf(roleKey);
  if (!me) return NOT_YOURS;
  if (voiceId !== null && !isVoiceId(voiceId)) return { ok: false, error: "Pick a voice." };
  const { error } = await createAdminClient().from("ai_roles").update({ voice_id: voiceId, updated_by: me.id }).eq("key", roleKey);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

// ─── The recording notice ───────────────────────────────────────────────────

async function noticeAcked(admin: ReturnType<typeof createAdminClient>, profileId: string): Promise<boolean> {
  const { data, error } = await admin.from("call_notice_acks").select("profile_id").eq("profile_id", profileId).maybeSingle();
  // Before the migration: no notice table yet, calls go on as before
  if (error) return true;
  return Boolean(data);
}

/** The person read the notice (calls are recorded and may be reviewed): kept with the time, asked once */
export async function ackCallNotice(): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const { error } = await createAdminClient().from("call_notice_acks").upsert({ profile_id: me.id, version: 1, acked_at: new Date().toISOString() }, { onConflict: "profile_id" });
  return error ? { ok: false, error: "Couldn't save that. Try again." } : { ok: true };
}

// ─── The transcript ─────────────────────────────────────────────────────────

/**
 * A call's transcript as a text file (the call screen's menu, the summary after it, the Assistant page and the agent's
 * page): the date, the agent, and every line with its time into the call. Only the caller's own calls; an exec can
 * read anyone's, as they already can in the agents' chats.
 */
export async function callTranscript(callId: string): Promise<{ ok: true; name: string; text: string } | Fail> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId)) return { ok: false, error: "That call isn't there." };
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, started_at, ended_at").eq("id", callId).maybeSingle();
  if (!call || (call.profile_id !== me.id && !me.isExec)) return { ok: false, error: "That call isn't yours." };
  const [{ data: rows }, { data: roles }, { data: who }, mineName] = await Promise.all([
    admin.from("ai_role_chats").select("role, content, role_key, created_at").eq("call_id", callId).order("created_at").limit(2000),
    admin.from("ai_roles").select("key, label"),
    call.profile_id === me.id ? Promise.resolve({ data: { full_name: me.fullName } }) : admin.from("profiles").select("full_name").eq("id", call.profile_id as string).maybeSingle(),
    assistantNameOf(admin, call.profile_id as string),
  ]);
  const labels = Object.fromEntries((roles ?? []).map((r) => [r.key as string, r.label as string]));
  const label = (key: string | null | undefined) => (key === ASSISTANT_KEY ? (mineName || ASSISTANT_LABEL) : (labels[key ?? ""] ?? "Agent"));
  const agentLabel = label(call.role_key as string);
  const personName = firstNameOf((who?.full_name as string | null) ?? null);
  const text = formatTranscript({
    startedAt: call.started_at as string,
    endedAt: (call.ended_at as string | null) ?? null,
    agentLabel,
    personName: personName === "there" ? "You" : personName,
    lines: (rows ?? []).map((r) => ({ at: r.created_at as string, who: r.role === "user" ? "user" : "agent", speaker: r.role === "user" ? null : label((r.role_key as string | null) ?? (call.role_key as string)), text: String(r.content ?? "") })),
  });
  return { ok: true, name: transcriptFileName(call.started_at as string, agentLabel), text };
}

/** A message drafted on the call, edited on its card before it's approved (only on the person's own call) */
export async function saveCallDraft(callId: string, draftId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId) || !text.trim()) return { ok: false, error: "That draft isn't there." };
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  const { editDraft } = await import("@/lib/assistant/handoff-server");
  return (await editDraft(admin, callId, draftId.slice(0, 40), text)) ? { ok: true } : { ok: false, error: "That draft was already sent or isn't there." };
}
