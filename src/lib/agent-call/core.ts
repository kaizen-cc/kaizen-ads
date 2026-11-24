// Calling an AI agent by voice: the plain helpers shared by the server and the call screen (no keys, no calls).
// Splitting the reply into sentences to speak as they arrive, cleaning text for speech, telling when the person has
// finished talking (or is talking over the agent), turning microphone audio into what speech to text takes, and
// checking what the agent learned before it's saved.

import type { JobView } from "@/lib/assistant/team";

/** The longest a call runs, in seconds; the screen shows the time left and hangs up at the end */
export const CALL_LIMIT_SECONDS = 60 * 60;
/** Five minutes before the hour: the agent says so once, and keeps notes; past the hour the call carries straight on */
export const CALL_WARN_SECONDS = CALL_LIMIT_SECONDS - 5 * 60;
export const CALL_WARN_LINE = "Just so you know, we've got about five minutes left on this call. I'm keeping notes, and if we go over I'll carry straight on in a fresh one, same conversation.";

// ─── Voices ─────────────────────────────────────────────────────────────────

/**
 * ElevenLabs' low-latency model, for speaking in a call (about 100ms to the first sound, half the characters' cost).
 * Turbo v2.5 is deprecated in its favour; the v4 realtime voice is only on the dialogue WebSocket; Multilingual v2 is
 * smoother but several times slower to start. Flash doesn't normalise numbers itself (unless asked, which costs
 * latency), so every sentence is put into spoken words first (speech-text.ts). ELEVENLABS_CALL_MODEL overrides it.
 */
export const CALL_TTS_MODEL = "eleven_flash_v2_5";

/** A starting voice for each agent (ElevenLabs' own premade voices, on every account), changed on the agent's page */
export const DEFAULT_VOICES: Record<string, { id: string; name: string }> = {
  strategist: { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  creative_director: { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte" },
  copywriter: { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
  media_buyer: { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
  google_buyer: { id: "cjVigY5qzO86Huf0OWal", name: "Eric" },
  tiktok_buyer: { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam" },
  market_analyst: { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
  account_manager: { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  email_strategist: { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura" },
  email_creative: { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily" },
  email_builder: { id: "iP95p4xoKVk53GoZ742B", name: "Chris" },
  social_strategist: { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice" },
  tracking_engineer: { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum" },
  // The personal assistant: a warm, friendly voice
  assistant: { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda" },
};
const FALLBACK_VOICE = { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger" };

export const isVoiceId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{8,40}$/.test(v);

/** The voice an agent speaks in: the one picked on its page, else its role's default */
export function voiceFor(roleKey: string, picked?: string | null): string {
  if (isVoiceId(picked)) return picked;
  return (DEFAULT_VOICES[roleKey] ?? FALLBACK_VOICE).id;
}

export const defaultVoiceName = (roleKey: string) => (DEFAULT_VOICES[roleKey] ?? FALLBACK_VOICE).name;

/** The assistant's voice for one person: the one they picked, else the one set for the assistant, else its default */
export function assistantVoiceFor(personal: string | null | undefined, roleVoice: string | null | undefined): string {
  return isVoiceId(personal) ? personal : voiceFor("assistant", roleVoice);
}

/**
 * The voice one sentence of a call is spoken in. The call's own agent (on an assistant call: the assistant, in the voice
 * its person picked) always speaks in the call's voice, set when the call started; a line with no speaker, or one from
 * a role that isn't a specialist on the call, is the call's own agent too (never a default or a random voice mid-call).
 * A specialist brought onto the call speaks in its own voice, which must sound like someone else: when it's the same as
 * the call's voice, it takes its role's default, or another default that differs.
 */
export function voiceForLine(o: { callRole: string; callVoice: string | null | undefined; lineRole?: string | null; specialist?: boolean; specialistVoice?: string | null }): string {
  const own = isVoiceId(o.callVoice) ? o.callVoice : voiceFor(o.callRole);
  const role = o.lineRole ?? o.callRole;
  if (role === o.callRole || !o.specialist) return own;
  const theirs = voiceFor(role, o.specialistVoice);
  if (theirs !== own) return theirs;
  const fallback = (DEFAULT_VOICES[role] ?? FALLBACK_VOICE).id;
  if (fallback !== own) return fallback;
  return [...Object.values(DEFAULT_VOICES), FALLBACK_VOICE].find((v) => v.id !== own)!.id;
}

// ─── Greeting ───────────────────────────────────────────────────────────────

/** The first name from a full name (or "there" when there's none) */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = String(fullName ?? "")
    .trim()
    .split(/\s+/)[0];
  return first && /\p{L}/u.test(first) ? first : "there";
}

// ─── Picking up where you left off ──────────────────────────────────────────

/** Back within this many minutes of a call that ended abnormally (a drop, a closed tab): the same conversation carries on (a cut-off) */
export const RESUME_CONTINUE_MINUTES = 15;
/** Back within this many minutes of a conversation they ended themselves (hung up, said bye, closed the chat): "hey again" */
export const RESUME_AGAIN_MINUTES = 10;
/** Called again within this many hours the same day: "Hey again", remembering what was said */
export const RESUME_SOON_HOURS = 4;
/** The day a call falls on is New York's (where the team works), so a late call isn't "tomorrow" in UTC */
export const CALL_TIME_ZONE = "America/New_York";

/**
 * How a new call relates to the last one with the same agent: "continue" (cut off a moment ago: carry on as if nothing
 * happened), "soon" (a few hours later the same day: hey again), "later_today" (the morning's call, now the end of the
 * day: pick up or something new) or "fresh" (another day, or nothing was said last time).
 */
export type ResumeMode = "continue" | "again" | "soon" | "later_today" | "fresh";

/**
 * How a conversation ended: the person hung up (the button), the agent ended it on a goodbye (or the person's last
 * words were a parting line), the person closed the chat, or abnormally (a dropped connection, a closed tab, a crash,
 * no end event at all). Only `dropped` is a cut-off worth apologising for.
 */
export type EndReason = "hangup" | "goodbye" | "chat_closed" | "dropped";
export const END_REASONS: readonly EndReason[] = ["hangup", "goodbye", "chat_closed", "dropped"];
export const isEndReason = (v: unknown): v is EndReason => typeof v === "string" && (END_REASONS as readonly string[]).includes(v);

/** What closed it: the red button, the agent's goodbye (its end marker), the chat's close, or nothing deliberate */
export type EndTrigger = "button" | "agent_end" | "chat_close" | "limit" | "unload" | "sweep" | "error" | null | undefined;

/** A parting line ("ok bye", "thanks, that's all", "talk later"): said last, the end was on purpose even with no button */
const PARTING = /\b(?:bye|goodbye|good night|see (?:you|ya)|talk (?:to you )?(?:later|soon|tomorrow)|catch you later|that'?s (?:all|it)(?: for (?:now|today))?|i'?m (?:done|all set)|have a good (?:one|day|night|evening|weekend))\b/i;
export const soundsLikeParting = (text: string | null | undefined) => PARTING.test(String(text ?? "").trim());

/**
 * Why a conversation ended, from what closed it and its last lines. A button or chat close is deliberate; the agent's
 * end marker is a goodbye; anything else (the tab closed, the line dropped, the sweep found it open) is a drop, unless
 * the last words either side said were a parting line (they said bye, then closed the tab).
 */
export function endReasonFor(input: { trigger: EndTrigger; lastUser?: string | null; lastAgent?: string | null }): EndReason {
  if (input.trigger === "button") return "hangup";
  if (input.trigger === "agent_end") return "goodbye";
  if (input.trigger === "chat_close") return "chat_closed";
  if (soundsLikeParting(input.lastUser) || soundsLikeParting(input.lastAgent)) return "goodbye";
  return "dropped";
}

/** Ended on purpose (no apology for a cut-off when they come back) */
export const deliberateEnd = (reason: EndReason | null | undefined) => reason === "hangup" || reason === "goodbye" || reason === "chat_closed";

/** The last call with the agent: when it was last talked in, how many turns it had and how it ended (null: unknown, as a drop) */
export type PreviousCall = { startedAt: string; endedAt: string | null; lastTurnAt: string | null; turns: number; endReason?: EndReason | null };

const dayIn = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: CALL_TIME_ZONE });

/** When the previous call was last alive: its last turn, else its end, else its start */
export function lastAliveAt(prev: PreviousCall): number {
  return Date.parse(prev.lastTurnAt ?? prev.endedAt ?? prev.startedAt);
}

export function resumeModeFor(prev: PreviousCall | null, now: Date = new Date()): ResumeMode {
  if (!prev || prev.turns <= 0) return "fresh";
  const at = lastAliveAt(prev);
  if (!Number.isFinite(at)) return "fresh";
  const gap = now.getTime() - at;
  // Ended on purpose a moment ago: hey again, no apology and no assuming the topic carries on
  if (deliberateEnd(prev.endReason)) {
    if (gap <= RESUME_AGAIN_MINUTES * 60_000) return "again";
  } else if (gap <= RESUME_CONTINUE_MINUTES * 60_000) return "continue";
  if (dayIn(new Date(at)) !== dayIn(now)) return "fresh";
  if (gap <= RESUME_SOON_HOURS * 3_600_000) return "soon";
  return "later_today";
}

/** A topic as it's said after "about": short, no full stop at the end */
function topicPhrase(topic: string | null | undefined): string | null {
  const t = String(topic ?? "")
    .replace(/\s+/g, " ")
    .replace(/[.!?\s]+$/, "")
    .replace(/^(about|asking about)\s+/i, "")
    .trim();
  if (!t) return null;
  const words = t.split(" ");
  return words.length > 14 ? words.slice(0, 14).join(" ") : t;
}

const GREETINGS: Record<ResumeMode, { withTopic: string[]; plain: string[] }> = {
  fresh: {
    withTopic: [],
    plain: ["Hey {name}, it's the {label}. What can I help you with?", "Hi {name}, {label} here. What's on your mind?", "Hey {name}! It's the {label}. What are we working on?"],
  },
  continue: {
    withTopic: ["Sorry {name}, we got cut off. You were asking about {topic}.", "Sorry about that, {name}, we got cut off. We were on {topic}.", "{name}, sorry, the line dropped. You were asking about {topic}."],
    plain: ["Sorry {name}, we got cut off. Where were we?", "Sorry about that, {name}, the line dropped. Go ahead."],
  },
  // Back a few minutes after ending it themselves: casual, and the topic only when something was left unfinished
  again: {
    withTopic: ["Hey again, {name}! What's up? We can finish {topic} if you like.", "{name}, hey again! Something new, or back to {topic}?", "Oh hey again, {name}. What's up? Still need {topic}?"],
    plain: ["Hey again, {name}! What's up?", "{name}! Back already. What's up?", "Oh hey again, {name}. What can I do?", "Hey again! What's up, {name}?"],
  },
  soon: {
    withTopic: ["Hey again, {name}! Good to hear from you so soon. More on {topic}, or something else?", "{name}, hey again! Back so soon. What's up?"],
    plain: ["Hey again, {name}! Good to hear from you so soon. What's up?", "{name}, hey again! Back so soon. What can I do?"],
  },
  later_today: {
    withTopic: ["Hey {name}! Want to pick up from our conversation earlier today about {topic}, or something new?", "Hi again, {name}. Do you want to carry on with {topic} from earlier, or something new?"],
    plain: ["Hey {name}! Want to pick up from our conversation earlier today, or something new?", "Hi again, {name}. Carry on from earlier today, or something new?"],
  },
};

// ─── Their local time ───────────────────────────────────────────────────────

/** A time zone the browser sent, if it's a real one (New York otherwise, where the team works) */
export function timeZoneOf(tz: string | null | undefined): string {
  const z = String(tz ?? "").trim();
  if (!z || z.length > 64) return CALL_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return CALL_TIME_ZONE;
  }
}

/** The hour (0 to 23) in their time zone */
export function localHourIn(tz: string | null | undefined, now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timeZoneOf(tz) }).format(now)) % 24;
}

/** Their day (YYYY-MM-DD) in their time zone */
export const localDayIn = (tz: string | null | undefined, now: Date = new Date()) => now.toLocaleDateString("en-CA", { timeZone: timeZoneOf(tz) });

/** Work hours start and end (8am to 6pm, as the team's business hours) */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;
export const isAfterHours = (hour: number) => hour < WORK_START_HOUR || hour >= WORK_END_HOUR;

/** The part of the day an hour falls in, for "good morning" or "good evening" */
export type DayPart = "morning" | "afternoon" | "evening" | "late";
export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 23) return "evening";
  return "late";
}

/**
 * After work hours: playful, human hellos, as if they caught the agent off the clock. Many of them, so it never sounds
 * canned. `{name}` is their first name; evening, late night and early morning each have their own.
 */
export const AFTER_HOURS_GREETINGS: Record<Exclude<DayPart, "afternoon">, string[]> = {
  evening: [
    "Good evening, {name}! Was just taking a little rest, didn't expect you here. What's up?",
    "Oh hey, {name}! I was just putting my feet up. Good evening! What can I do?",
    "Evening, {name}! Caught me winding down for the night, but I'm all yours. What's going on?",
    "Hey {name}, good evening! I was about to call it a day, but I've always got time for you. What's up?",
    "Well hello, {name}! Didn't think I'd see you this evening. What are we working on?",
    "Good evening, {name}! Still at it? Let's get it done so you can enjoy your night. What do you need?",
    "{name}! Hey, good evening. I was just making a cup of tea. What can I help with?",
    "Oh, hi {name}! Good evening. The office went quiet hours ago, so it's just us. What's up?",
  ],
  late: [
    "Hey {name}! Burning the midnight oil? I was just dozing off. What's up?",
    "Whoa, {name}, it's late! You caught me half asleep, but I'm here. What do you need?",
    "{name}! Hey, night owl. Didn't expect you at this hour. What can I do?",
    "Oh hey, {name}. Late one tonight, huh? I'm up. What's going on?",
    "Hi {name}! It's way past office hours, but I'm happy to help. What's up?",
    "Hey {name}, couldn't sleep either? What are we working on?",
  ],
  morning: [
    "Good morning, {name}! You're up early. I'm still on my first coffee. What's up?",
    "Morning, {name}! Early bird today, huh? What can I do for you?",
    "Oh, good morning, {name}! Didn't expect anyone this early. What's going on?",
    "Hey {name}, good morning! Beat everyone in today. What are we starting with?",
    "Rise and shine, {name}! I was just stretching. What do you need?",
  ],
};

/** A fresh start in work hours: "good morning" before noon, the usual hello after */
const MORNING_GREETINGS = ["Good morning, {name}! It's the {label}. What can I help you with?", "Morning, {name}! {label} here. What's on your mind?", "Good morning, {name}! It's the {label}. What are we working on?"];

/** Called back later the same day, after hours: the same "hey again", with a nod to the hour */
const AFTER_HOURS_AGAIN = ["Hey again, {name}! Still at it? What's up?", "{name}, hey again! Didn't expect you back this late. What can I do?", "Oh hey again, {name}. Working late, huh? What's up?"];

/** The plain lines that fit the hour, when it changes them (null: the usual ones) */
function linesForHour(mode: ResumeMode, hour: number | null | undefined): string[] | null {
  if (hour == null || !Number.isFinite(hour)) return null;
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const part = dayPartOf(h);
  if (isAfterHours(h)) {
    if (mode === "fresh") return AFTER_HOURS_GREETINGS[part === "afternoon" ? "evening" : part];
    if (mode === "soon" || mode === "later_today") return AFTER_HOURS_AGAIN;
    return null;
  }
  return mode === "fresh" && part === "morning" ? MORNING_GREETINGS : null;
}

/**
 * What the agent says when it picks up: the person's first name, in a line that fits how this call follows the last
 * one (a cut-off, a quick call back, later the same day, or a fresh start). `seed` picks among a few ways of saying it
 * so it never sounds canned (seedOf the call's id; 0 is the first way). `hour`, in their own time zone, makes a fresh
 * start a "good morning" and anything after work hours one of the playful after-hours lines.
 */
export function greetingFor(fullName: string | null | undefined, roleLabel: string, mode: ResumeMode = "fresh", topic: string | null = null, seed = 0, hour: number | null = null): string {
  const name = firstNameOf(fullName);
  const t = topicPhrase(topic);
  const set = GREETINGS[mode];
  const list = t && set.withTopic.length ? set.withTopic : (linesForHour(mode, hour) ?? set.plain);
  const line = list[Math.abs(Math.trunc(seed)) % list.length];
  const out = line.replace("{name}", name).replace("{label}", roleLabel).replace("{topic}", t ?? "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * The agent's first line after the conversation moves between chat and a call (the same conversation, no fresh
 * greeting): "Picking up where we left off: the Crust report."
 */
export function handoverLine(topic: string | null | undefined): string {
  const t = topicPhrase(topic);
  return t ? `Picking up where we left off: ${t}.` : "Picking up where we left off. Go ahead.";
}

/** How long a pause makes a mode switch a picking-up (shorter: the conversation is still going, no line) */
export const HANDOVER_GAP_MS = 10 * 60_000;

/**
 * Whether a mode switch writes "Picking up where we left off" into the conversation: only after a real pause, and never
 * right after another one (switching chat to call and back mid-conversation wrote it twice, Nov 23 2026).
 */
export function keepsHandoverLine(last: { at: number; role: string; content: string } | null | undefined, now: number): boolean {
  if (!last) return false;
  if (last.role !== "user" && /^picking up where we left off/i.test(last.content.trim())) return false;
  return now - last.at > HANDOVER_GAP_MS;
}

/**
 * Whether the last conversation left something open (a job still running, or the agent's last line was a question or
 * an offer): only then does a quick "hey again" mention the topic.
 */
export function leftUnfinished(input: { jobOpen?: boolean; lastAgent?: string | null }): boolean {
  if (input.jobOpen) return true;
  const last = String(input.lastAgent ?? "").trim();
  if (!last || soundsLikeParting(last)) return false;
  return /\?\s*$/.test(last) || /\b(?:shall i|want me to|should i|do you want)\b/i.test(last);
}

/** A number from a string (a call's id), to pick a greeting with */
export function seedOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─── Speaking ───────────────────────────────────────────────────────────────

// Words ending in a full stop that don't end a sentence
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|incl|est|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|u\.s|a\.m|p\.m)\.$/i;
/** A sentence shorter than this waits for the next one, so the voice doesn't stop and start ("Sure.") */
const MIN_SENTENCE = 18;
/** A sentence longer than this is split at a comma or semicolon, so speech starts sooner */
const MAX_SENTENCE = 220;

/**
 * Splits streamed text into sentences ready to speak and the rest still being written. A sentence ends at . ! or ?
 * followed by a space or a new line (not a decimal point or an abbreviation); a line break ends one too. Very short
 * sentences are held and joined to the next; very long ones are cut at a comma.
 */
export function splitSpeakable(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let start = 0;
  let pending = "";
  const push = (s: string) => {
    const t = `${pending}${pending ? " " : ""}${s.trim()}`.trim();
    if (!t) return;
    if (t.length < MIN_SENTENCE) pending = t;
    else {
      ready.push(t);
      pending = "";
    }
  };
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    const next = buffer[i + 1];
    if (c === "\n") {
      push(buffer.slice(start, i));
      start = i + 1;
      continue;
    }
    if ((c === "." || c === "!" || c === "?") && next !== undefined && /\s/.test(next)) {
      const piece = buffer.slice(start, i + 1);
      if (c === "." && ABBREVIATIONS.test(piece)) continue;
      push(piece);
      start = i + 1;
      continue;
    }
    // A long run without a sentence end: cut at the last comma or semicolon so speech isn't held up
    if (i - start > MAX_SENTENCE) {
      const piece = buffer.slice(start, i);
      const cut = Math.max(piece.lastIndexOf(", "), piece.lastIndexOf("; "));
      if (cut > 40) {
        push(piece.slice(0, cut + 1));
        start = start + cut + 2;
      }
    }
  }
  const rest = `${pending}${pending && buffer.slice(start).trim() ? " " : ""}${buffer.slice(start).replace(/^\s+/, "")}`;
  return { ready, rest };
}

/** Where a bare link was (never read out: forSpeech says it's on screen instead) */
export const LINK_MARK = "\uE000";

/** Text as it should be read aloud: no markdown, links as their words (a bare link as LINK_MARK), no em dashes or bullet marks */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, ` ${LINK_MARK} `)
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Turn taking ────────────────────────────────────────────────────────────

/** When someone has started talking, finished their turn, or is talking over the agent (levels are RMS, 0 to 1) */
export const TURN = {
  /** The quietest level counted as speech (raised above the room's own noise, see below) */
  speechLevel: 0.018,
  /** Speech counts once it lasts this long (a cough or a click doesn't start a turn) */
  minSpeechMs: 160,
  /**
   * Silence this long after speech ends the turn: long enough for a breath or a pause to think, so the agent never
   * jumps in mid-thought (the owner found 0.75s cut people off)
   */
  endSilenceMs: 1600,
  /** After a long stretch of talking (thinking out loud), it waits longer still before answering */
  longTurnMs: 8000,
  longTurnSilenceMs: 2400,
  /** Talking over the agent: louder than normal speech (its own voice can leak into the mic) … */
  bargeLevel: 0.045,
  /** … for this long */
  bargeMs: 280,
  /** Speech must be this many times louder than the room's noise */
  noiseRatio: 3,
  /** Just unmuted: the room's noise is learned again quickly for this long (it may be a different room now) */
  relearnMs: 400,
  /** ... but never above this, so words said straight after unmuting aren't taken for the room */
  relearnNoiseCap: 0.015,
  /**
   * "Speech" that never once dips below the speech level for a second and a half after this long is steady noise (a
   * fan, traffic, a busy cafe), not a person: the room's noise is raised to it so the turn can end
   */
  steadyNoiseMs: 3000,
  steadyWindowMs: 1500,
  steadySwing: 2,
  /** The room's noise is kept in this range by ordinary learning (only steady noise, above, can raise it further) */
  noiseMin: 0.001,
  noiseMax: 0.02,
  steadyNoiseMax: 0.05,
  /** The agent's voice and its echo: nothing is learned while it speaks and for this long after */
  afterAgentHoldMs: 500,
  /** ... then the room is learned quickly for this long (the agent's reply may have changed the gain) */
  afterAgentQuickMs: 300,
};

export type TurnEvent = "speech_start" | "turn_end" | "barge_in" | null;

/**
 * Follows the microphone's level frame by frame. While listening it says when speech starts and when the turn ends;
 * while the agent speaks it says when the person talks over it. The room's noise is learned while it's quiet, so a
 * noisy room needs louder speech.
 */
export function createTurnDetector(opts: Partial<typeof TURN> = {}) {
  const t = { ...TURN, ...opts };
  let noise = 0.004;
  let speechMs = 0;
  let silenceMs = 0;
  let inSpeech = false;
  let loudMs = 0;
  /** Time left learning the room quickly with speech detection off (after unmuting) */
  let quickMs = 0;
  /** Time left not learning (the agent just stopped), then learning faster */
  let holdMs = 0;
  let fastMs = 0;
  /** The latest levels while listening, to tell steady noise from a person talking */
  let recent: number[] = [];
  const clamp = (n: number, max = t.noiseMax) => Math.min(max, Math.max(t.noiseMin, n));
  const threshold = () => Math.max(t.speechLevel, noise * t.noiseRatio);
  const clear = () => {
    inSpeech = false;
    speechMs = 0;
    silenceMs = 0;
    loudMs = 0;
    recent = [];
  };
  return {
    /** level: this frame's RMS; ms: how long the frame is; agentSpeaking: whether the agent's voice is playing */
    feed(level: number, ms: number, agentSpeaking: boolean): TurnEvent {
      if (quickMs > 0) {
        quickMs -= ms;
        noise = clamp(noise * 0.7 + level * 0.3, t.relearnNoiseCap);
        return null;
      }
      const th = threshold();
      if (agentSpeaking) {
        // Its own voice leaks into the mic: never learned as the room
        holdMs = t.afterAgentHoldMs;
        fastMs = t.afterAgentQuickMs;
        inSpeech = false;
        speechMs = 0;
        silenceMs = 0;
        recent = [];
        loudMs = level >= Math.max(t.bargeLevel, th) ? loudMs + ms : 0;
        if (loudMs >= t.bargeMs) {
          loudMs = 0;
          inSpeech = true;
          return "barge_in";
        }
        return null;
      }
      loudMs = 0;
      recent.push(level);
      if (recent.length * ms > t.steadyWindowMs) recent.shift();
      if (level >= th) {
        silenceMs = 0;
        speechMs += ms;
        if (!inSpeech && speechMs >= t.minSpeechMs) {
          inSpeech = true;
          return "speech_start";
        }
        // Not one quiet moment for a second and a half, a few seconds into a "turn": that's the room, not a person
        if (inSpeech && speechMs >= t.steadyNoiseMs && recent.length * ms >= t.steadyWindowMs) {
          const floor = Math.min(...recent);
          // ... and steady: a voice swings well above its quietest moments, a fan or traffic barely moves
          if (floor >= th && Math.max(...recent) < floor * t.steadySwing) {
            noise = clamp((floor * 1.15) / t.noiseRatio, t.steadyNoiseMax);
            recent = [];
          }
        }
        return null;
      }
      // Quiet. The room is learned only between turns (the dips between someone's words would creep it up until
      // their speech counted as quiet), never just after the agent spoke, faster down than up, within a sane range
      if (holdMs > 0) holdMs -= ms;
      else if (!inSpeech) {
        const fast = fastMs > 0;
        if (fast) fastMs -= ms;
        const a = level < noise ? (fast ? 0.3 : 0.1) : fast ? 0.15 : 0.02;
        noise = noise > t.noiseMax ? noise * (1 - a) + level * a : clamp(noise * (1 - a) + level * a);
      }
      if (!inSpeech) {
        speechMs = 0;
        return null;
      }
      silenceMs += ms;
      if (silenceMs >= (speechMs >= t.longTurnMs ? t.longTurnSilenceMs : t.endSilenceMs)) {
        inSpeech = false;
        speechMs = 0;
        silenceMs = 0;
        return "turn_end";
      }
      return null;
    },
    get speaking() {
      return inSpeech;
    },
    /** The room's noise as learned so far, and the level that counts as speech (for the debug overlay) */
    get noise() {
      return noise;
    },
    get threshold() {
      return threshold();
    },
    reset() {
      clear();
      quickMs = 0;
    },
    /** Starting fresh after unmuting: nothing in progress, and the room's noise learned again quickly */
    relearn() {
      clear();
      quickMs = t.relearnMs;
    },
  };
}

// ─── Mute, and turns that stall ─────────────────────────────────────────────

/**
 * Muting mid-turn: what was heard so far is sent as a finished turn ("send"), unless nothing was heard and nobody was
 * talking ("drop"). Only while it's listening (an answer on its way or playing carries on).
 */
export function muteTurn(s: { phase: string; heard: string; carry: string; speaking: boolean }): "send" | "drop" {
  if (s.phase !== "listening") return "drop";
  return s.heard.trim() || s.carry.trim() || s.speaking ? "send" : "drop";
}

/** A turn with no first word of its answer playing after this long is stalled: retried once, then given up on */
export const STALL_MS = 12_000;

/** "long": a long turn was just sent ("Got it, thinking…"); "slow": retrying ("Still working…"); "failed": it didn't go through (Retry) */
export type StallState = "long" | "slow" | "failed" | null;

/**
 * Watches a turn from when it's sent until its first words play. Anything coming back from the server starts the
 * clock again (it's working). The first time it runs out, onSlow (show "Still working…" and retry); the second time,
 * onGiveUp (tell the person it didn't go through, with a Retry).
 */
export function createTurnWatchdog(o: { ms?: number; onSlow: () => void; onGiveUp: () => void }) {
  const ms = o.ms ?? STALL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let active = false;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(fire, ms);
  };
  function fire() {
    timer = null;
    if (!active) return;
    if (attempt === 0) {
      attempt = 1;
      arm();
      o.onSlow();
    } else {
      active = false;
      o.onGiveUp();
    }
  }
  return {
    /** A turn was sent (`retry`: the same turn again, so a second stall gives up) */
    begin(retry = false) {
      active = true;
      if (!retry) attempt = 0;
      arm();
    },
    /** Something came back: the clock starts again */
    progress() {
      if (active) arm();
    },
    /** Its first words played, or the turn ended or was stopped */
    stop() {
      active = false;
      disarm();
    },
    get attempt() {
      return attempt;
    },
    get active() {
      return active;
    },
  };
}

/** A frame's loudness: the root mean square of its samples (-1 to 1) */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ─── Microphone audio ───────────────────────────────────────────────────────

/** Audio at the microphone's rate brought down to the rate speech to text takes (averaging each step, so no aliasing) */
export function downsample(input: ArrayLike<number>, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return Float32Array.from(input);
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let o = 0; o < out.length; o++) {
    const from = Math.floor(o * ratio);
    const to = Math.min(input.length, Math.floor((o + 1) * ratio));
    let sum = 0;
    for (let i = from; i < to; i++) sum += input[i];
    out[o] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

/** Samples (-1 to 1) as 16-bit little-endian PCM */
export function toPcm16(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

// ─── Learning ───────────────────────────────────────────────────────────────

/**
 * Something the agent learned in a call. A note is saved straight to one of its skills (knowledge: a fact; skill: a
 * method or rule for that job; example: what good looks like). A rewrite is a change to its core or a skill's
 * instructions: never written in the call, it goes to the agent's chat as a proposed edit a person applies.
 */
export type Learning = { type: "note" | "rewrite"; skill: string; kind: "knowledge" | "skill" | "example"; title: string; body: string };

export const LEARNINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "learnings"],
  properties: {
    topic: { type: "string", description: "What the person is asking or talking about in this moment, as a short phrase that fits after 'You were asking about' (up to eight words, no full stop)" },
    learnings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "skill", "kind", "title", "body"],
        properties: {
          type: { type: "string", enum: ["note", "rewrite"] },
          skill: { type: "string" },
          kind: { type: "string", enum: ["knowledge", "skill", "example"] },
          title: { type: "string" },
          body: { type: "string" },
        },
      },
    },
  },
};

/** At most this many learnings from one thing the person says */
export const MAX_LEARNINGS_PER_TURN = 3;

const SECRET_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // an email address
  /(?:\+?\(?\d[\s().-]{0,2}){10,}/, // a phone number or a long number
  /\b(?:\d[ -]?){13,19}\b/, // a card number
  /\b(?:sk|pk|rk|xi|key|token|secret|api)[-_][A-Za-z0-9_-]{12,}/i, // a key or token
  /\b[A-Za-z0-9+/_-]{32,}\b/, // a long random string (a key, a token, a hash)
  /\b(?:password|passcode|passwd|pin code|login is|api key|secret key|access token)\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // a US social security number
];

/** Whether a piece of text holds a secret or someone's personal details (never saved as a learning) */
export const looksSensitive = (text: string) => SECRET_PATTERNS.some((p) => p.test(text));

/**
 * What the model said the person taught, checked before anything is saved: only this agent's own skills (or "core"
 * for a rewrite of its core), titles and bodies trimmed to size, nothing holding a secret or personal details, no
 * repeats, at most three.
 */
export function parseLearnings(raw: unknown, skills: readonly string[]): Learning[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { learnings?: unknown }).learnings) ? ((raw as { learnings: unknown[] }).learnings) : [];
  const out: Learning[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const type = r.type === "rewrite" ? "rewrite" : r.type === "note" ? "note" : null;
    const kind = r.kind === "skill" || r.kind === "example" ? r.kind : "knowledge";
    const skill = String(r.skill ?? "").trim();
    const title = String(r.title ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const body = String(r.body ?? "")
      .trim()
      .slice(0, 2000);
    if (!type || !title || body.length < 12) continue;
    if (type === "note" && !skills.includes(skill)) continue;
    if (type === "rewrite" && skill !== "core" && !skills.includes(skill)) continue;
    if (looksSensitive(`${title}\n${body}`)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, skill, kind, title, body });
    if (out.length >= MAX_LEARNINGS_PER_TURN) break;
  }
  return out;
}

// ─── The call's stream ──────────────────────────────────────────────────────

/** One line of the turn's answer stream */
export type CallEvent =
  | { t: "text"; d: string }
  | { t: "learned"; items: LearnedItem[] }
  | { t: "done" }
  | { t: "error"; message: string }
  // Who speaks the text that follows (the assistant, or the specialist it called in)
  | { t: "speaker"; role: string; label: string; icon: string }
  // Who else is on the call besides the host (specialists joining or leaving): the whole line each time
  | { t: "team"; line: { role: string; label: string; icon: string }[] }
  // The job the call is working on (launching ads, an email request…) and its steps, or null when there's none
  | { t: "job"; job: JobView | null }
  // Open a screen in the app while the call carries on
  | { t: "navigate"; href: string }
  // A link card on the call ("take a look"): in the app or a new tab
  | { t: "card"; card: CallCard }
  // The assistant asks for files: the upload panel opens on the call
  | { t: "upload"; ask: UploadAsk }
  // The agent wants to see the screen: a frame of the shared screen, the ask to share it, or (phones) the upload panel
  | { t: "look" }
  // The agent said goodbye: the call hangs up once its last words have played
  | { t: "end" }
  // Carry the same conversation on in the other way (they asked to switch to a chat, or to a call)
  | { t: "switch"; to: "voice" | "text" }
  // Still working (sent every few seconds while a long answer or a tool is under way, so the line stays open)
  | { t: "ping" }
  // What the agent is working on now (a step bar on the call and the chat), or null once the answer comes
  | { t: "progress"; progress: CallProgress | null }
  // Where the turn's time went (one compact line, for the hidden debug overlay)
  | { t: "timing"; line: string };

/** Long work on a call or in the chat: the step under way ("Writing the copy"), the steps done, and a rough share done */
export type CallProgress = { step: string; done: string[]; pct: number; who?: string | null };

/** A link the call shows as a card: tapped, it opens in the app (the call stays up) or in a new tab */
export type CallCard = {
  id: string;
  title: string;
  detail: string;
  href: string;
  external: boolean;
  cta: string;
  /** A message drafted as the person (a Slack reply or an email): edited and approved on the card, or copied */
  draft?: CallDraft;
  /** A Kaizen document (create_document): open, download, or edit its text and draw it again */
  document?: CallDocument;
  /** Campaign, flow or SMS copy (create_copy_doc): read it, open the document view, approve it */
  copy?: CallCopyDoc;
  /** Times for an internal call (find_meeting_time): tap one, confirm, booked; or say yes on the call */
  slots?: CallSlots;
  /** A Connect / Reconnect card for one of their accounts: once it's connected, the conversation picks the ask back up */
  connect?: { service: "slack" | "gmail" | "drive" | "calendar" | "asana" };
};

/** Times offered for an internal call, as the slot card shows them (booked from the card or by a spoken yes) */
export type CallSlots = {
  proposalId: string;
  title: string;
  minutes: number;
  attendees: string[];
  timezone: string;
  options: { start: string; day: string; date: string; range: string; label: string }[];
  status: "open" | "booked";
  booked: { label: string; link: string | null; meet: string | null } | null;
  /** Whether More times may find another batch */
  more: boolean;
};

/** Copy written for the email team, shown on the call or chat as a document card */
export type CallCopyDoc = {
  id: string;
  kind: "campaign" | "flow" | "sms" | "creative" | "social";
  title: string;
  client: string | null;
  version: number;
  status: "draft" | "approved" | "requested";
  href: string;
  emails: { name: string; subject: string; preview: string; sections: { heading: string; body: string }[]; cta: string | null; designNotes: string[] }[];
  docUrl: string | null;
  asanaUrl: string | null;
};

/** A Kaizen-branded PDF shown on the call or chat */
export type CallDocument = { id: string; kind: "sow" | "proposal" | "handoff" | "one_pager"; title: string; client: string | null; version: number; href: string; download: string; placeholders: string[]; /** An email SOW's Word file */ docx?: string };

/** A file attached to a drafted email (a document's PDF) */
export type CallAttachment = { documentId: string; name: string; download: string };

/** A drafted message on the call: where it goes, its words, and what became of it */
export type CallDraft = { id: string; channel: "slack" | "email"; where: string; text: string; subject?: string | null; to?: string | null; status: "draft" | "sent" | "gmail_draft" | "slack_draft" | "copy"; attachments?: CallAttachment[]; compose?: string | null; /** Where the saved draft opens (Gmail or Slack) */ link?: string | null };

/** What the assistant asked to be uploaded: launch creatives, files for it to read, or a screenshot to look at */
export type UploadAsk = { purpose: "creatives" | "files" | "screen"; client: string | null; note: string };

/**
 * A learning as the call keeps it. Heard on the call it's pending: nothing is written to the agent until a person keeps
 * it on the review (a note becomes an item in its skill, id set; a rewrite goes to the chat as a proposal) or tosses
 * it. `key` names it on the review. Items from before the review have no status: those were saved straight away.
 */
export type LearnedItem = {
  key?: string;
  id: string | null;
  type: "note" | "rewrite";
  skill: string;
  kind?: Learning["kind"];
  title: string;
  body: string;
  status?: LearnStatus;
  undone?: boolean;
  /** The agent it was taught to, when that isn't the call's own (a specialist called in by the assistant) */
  role?: string;
};

export type LearnStatus = "pending" | "kept" | "tossed";

/** Where an item stands (one saved before reviews existed counts as kept) */
export const statusOf = (l: LearnedItem): LearnStatus => l.status ?? "kept";

/** The key an item is decided by (older items had none: their item id or title stands in) */
export const keyOf = (l: LearnedItem): string => l.key ?? l.id ?? l.title;

/** The items still waiting for a person to keep or toss */
export const pendingOf = (items: readonly LearnedItem[]) => items.filter((l) => statusOf(l) === "pending");

/** What was heard on a turn, as pending items (nothing is written to the agent yet) */
export function pendingItems(learnings: readonly Learning[], makeKey: () => string): LearnedItem[] {
  return learnings.map((l) => ({ key: makeKey(), id: null, type: l.type, skill: l.skill, kind: l.kind, title: l.title, body: l.body, status: "pending" as const }));
}

/** Keep (with the note's text as edited on the review) or toss one pending item */
export type Decision = { keep: boolean; title?: string; body?: string };

/**
 * The review's decisions applied to a call's items: only pending ones change; a kept one carries its edited title and
 * text (checked like a learning: not empty, nothing secret); every pending item needs a decision. Returns the items as
 * they'll be stored and the ones to write (kept), or why it can't be applied.
 */
export function decide(items: readonly LearnedItem[], decisions: Record<string, Decision>): { ok: true; items: LearnedItem[]; keep: LearnedItem[]; tossed: number } | { ok: false; error: string } {
  const keep: LearnedItem[] = [];
  const next: LearnedItem[] = [];
  let tossed = 0;
  for (const l of items) {
    if (statusOf(l) !== "pending") {
      next.push(l);
      continue;
    }
    const d = decisions[keyOf(l)];
    if (!d) return { ok: false, error: "Keep or toss every item first." };
    if (!d.keep) {
      tossed++;
      next.push({ ...l, status: "tossed" });
      continue;
    }
    const title = String(d.title ?? l.title)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const body = String(d.body ?? l.body)
      .trim()
      .slice(0, 2000);
    if (!title || body.length < 12) return { ok: false, error: `"${l.title}" needs a title and a sentence or two to keep.` };
    if (looksSensitive(`${title}\n${body}`)) return { ok: false, error: `"${title}" looks like it holds a secret or someone's details. Take that out, or toss it.` };
    const kept: LearnedItem = { ...l, title, body, status: "kept" };
    keep.push(kept);
    next.push(kept);
  }
  return { ok: true, items: next, keep, tossed };
}

/** The topic of a moment, from the same read that picks out learnings (null when there's none) */
export function parseTopic(raw: unknown): string | null {
  const t = raw && typeof raw === "object" ? (raw as { topic?: unknown }).topic : null;
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return s && !looksSensitive(s) ? s : null;
}

/** mm:ss for the call timer */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ─── How every agent talks, and hanging up ──────────────────────────────────

/** The firm rule for every spoken answer (calls with any agent and the assistant) */
export const CONCISE_RULE = `Keep it short. This is a firm rule: they're listening, not reading. Lead with the answer in one or two short sentences. Name at most three things in any list; if there are more, say how many more ("and two more") and offer them. Stay under about sixty words unless they ask for detail or a walkthrough ("tell me more", "walk me through it", "give me all of them"), and even then keep it tight. Then, only if it helps, one short question. Never repeat their question back, no filler ("great question", "sure thing, so"), and never close with "let me know if you need anything else".`;

/** How every spoken answer is written: for the ear, so the voice sounds like a person, not a document */
export const SPOKEN_RULE = `Write for the ear. Use contractions (it's, you'll, we're, that's). Round numbers the way people say them ("about thirty thousand dollars", "just over two x", "up about twelve percent") unless the exact figure matters. Spell out what a symbol would stand for, and say short forms the way people do on a call. Never read out a link, a web address or an email address: say you've put it on screen. A natural "so" or "okay" now and then is fine; never more than one in an answer. Don't end an answer with a generic open question ("what's on your mind?", "anything else?"): end on the point, or offer the obvious next step by name.`;

/** The same rule for the agents' text chats */
export const CONCISE_CHAT_RULE = `Be brief, as a firm rule: a few short lines by default, longer only when asked. No recap of the question, no filler, no "let me know if you need anything else".`;

/** What ends a call from the agent's side: written at the very end of its goodbye, never spoken */
export const END_MARKER = "[[END_CALL]]";

/** How every end marker starts (the plain goodbye's and the privacy hang-up's): the stream is cut from here on */
const END_MARKER_START = "[[END_CALL";

/** Ends a call that seemed to be picking up background chatter with no clear yes to "are you still there?" (logged) */
export const PRIVACY_END_MARKER = "[[END_CALL:no_clear_yes]]";

/** Whether a reply hung up because nobody clearly answered after background chatter (the reason logged for review) */
export const endedForPrivacy = (text: string) => text.includes(PRIVACY_END_MARKER);

/**
 * Calls only: a mic left open records whoever is in the room. Words that don't seem meant for the agent get one short
 * "are you still there?", and without a clear yes the call hangs up, so a private conversation isn't recorded.
 */
export const BACKGROUND_CHATTER_RULE = `Background chatter: what you hear is transcribed from their microphone, so it can pick up people talking nearby, a TV, or them talking to someone else. If what you hear doesn't seem meant for you (a side conversation, people talking to each other, fragments that don't follow from the call), don't answer it or comment on what was said: just ask, in a few words, "Are you still there?". If their next words are a clear yes ("yes", "yeah, I'm here", "sorry, go on", or they carry on talking to you), carry on. If they aren't (more chatter, something unrelated, nothing clear), say a very short goodbye ("I'll hang up for now, call me back anytime.") and then write ${PRIVACY_END_MARKER} at the very end.`;

export const END_CALL_RULE = `Hanging up: when they're clearly wrapping up the whole call ("ok that's all, thanks", "ok bye", "talk later", "that's it for now"), say a very short goodbye (a few words) and then write ${END_MARKER} at the very end. Never write it for a "bye" inside a longer thought, a thanks mid-conversation, or when they're still asking something.`;

/** Gentle support when someone is struggling, on every call */
export const DISTRESS_RULE = `If they sound genuinely distressed or unsafe (not just busy or annoyed), pause the work. Be kind and brief, ask how they're doing, suggest talking with someone they trust or their lead, and if they may be in danger, urge them to call their local emergency number (988 in the US).`;

/**
 * Takes the agent's reply as it streams and holds back the end marker (either kind): text is passed on as it comes,
 * except a tail that could be the start of a marker (held until it's clearly not); once a marker appears, what comes
 * before it is passed on, the rest is dropped and `ended` is set (`forPrivacy` too when it was the privacy hang-up).
 */
export function endMarkerFilter() {
  let held = "";
  let ended = false;
  /** The marker and what came after it (enough to tell which marker it was) */
  let tail = "";
  return {
    feed(delta: string): string {
      if (ended) {
        if (tail.length < 64) tail += delta;
        return "";
      }
      const s = held + delta;
      const at = s.indexOf(END_MARKER_START);
      if (at >= 0) {
        ended = true;
        held = "";
        tail = s.slice(at);
        return s.slice(0, at);
      }
      let keep = 0;
      for (let k = Math.min(END_MARKER_START.length - 1, s.length); k > 0; k--)
        if (END_MARKER_START.startsWith(s.slice(s.length - k))) {
          keep = k;
          break;
        }
      held = s.slice(s.length - keep);
      return s.slice(0, s.length - keep);
    },
    /** What's still held once the reply is complete (never part of the marker) */
    flush(): string {
      const h = held;
      held = "";
      return ended ? "" : h;
    },
    get ended() {
      return ended;
    },
    /** It ended on the privacy hang-up (background chatter, no clear yes) */
    get forPrivacy() {
      return ended && endedForPrivacy(tail);
    },
  };
}

/** A whole reply without the end marker, and whether it was there */
export function stripEndMarker(text: string): { text: string; ended: boolean } {
  const at = text.indexOf(END_MARKER_START);
  return at < 0 ? { text, ended: false } : { text: text.slice(0, at).trimEnd(), ended: true };
}

// ─── Recorded audio ─────────────────────────────────────────────────────────

/** The file ending for a recording's type: Safari records audio/mp4, Chrome and Firefox audio/webm or ogg */
export function audioExt(mime: string | null | undefined): "webm" | "m4a" | "ogg" | "wav" {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "audio/mp4" || m === "audio/aac" || m === "audio/x-m4a" || m === "video/mp4") return "m4a";
  if (m === "audio/ogg") return "ogg";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  return "webm";
}

/** Where one recorded part of a call goes in the call-audio bucket, named by its real type */
export const audioPartPath = (callId: string, index: number, startSeconds: number, mime?: string | null) =>
  `${callId}/${String(Math.max(0, Math.min(60, Math.floor(index)))).padStart(3, "0")}-${Math.max(0, Math.floor(startSeconds))}.${audioExt(mime)}`;
