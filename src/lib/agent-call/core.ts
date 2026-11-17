// Calling an AI agent by voice: the plain helpers shared by the server and the call screen (no keys, no calls).
// Splitting the reply into sentences to speak as they arrive, cleaning text for speech, telling when the person has
// finished talking (or is talking over the agent), turning microphone audio into what speech to text takes, and
// checking what the agent learned before it's saved.

/** The longest a call runs, in seconds; the screen shows the time left and hangs up at the end */
export const CALL_LIMIT_SECONDS = 30 * 60;

// ─── Voices ─────────────────────────────────────────────────────────────────

/** ElevenLabs' low-latency model, for speaking in a call (about 75ms to the first sound, half the characters' cost) */
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

// ─── Greeting ───────────────────────────────────────────────────────────────

/** The first name from a full name (or "there" when there's none) */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = String(fullName ?? "")
    .trim()
    .split(/\s+/)[0];
  return first && /\p{L}/u.test(first) ? first : "there";
}

// ─── Picking up where you left off ──────────────────────────────────────────

/** Called back within this many minutes of the last thing said: the same conversation carries on (a cut-off) */
export const RESUME_CONTINUE_MINUTES = 10;
/** Called again within this many hours the same day: "Hey again", remembering what was said */
export const RESUME_SOON_HOURS = 4;
/** The day a call falls on is New York's (where the team works), so a late call isn't "tomorrow" in UTC */
export const CALL_TIME_ZONE = "America/New_York";

/**
 * How a new call relates to the last one with the same agent: "continue" (cut off a moment ago: carry on as if nothing
 * happened), "soon" (a few hours later the same day: hey again), "later_today" (the morning's call, now the end of the
 * day: pick up or something new) or "fresh" (another day, or nothing was said last time).
 */
export type ResumeMode = "continue" | "soon" | "later_today" | "fresh";

/** The last call with the agent: when it was last talked in and how many turns it had */
export type PreviousCall = { startedAt: string; endedAt: string | null; lastTurnAt: string | null; turns: number };

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
  if (gap <= RESUME_CONTINUE_MINUTES * 60_000) return "continue";
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
  soon: {
    withTopic: ["Hey again, {name}! Good to hear from you so soon. More on {topic}, or something else?", "{name}, hey again! Back so soon. What's up?"],
    plain: ["Hey again, {name}! Good to hear from you so soon. What's up?", "{name}, hey again! Back so soon. What can I do?"],
  },
  later_today: {
    withTopic: ["Hey {name}! Want to pick up from our conversation earlier today about {topic}, or something new?", "Hi again, {name}. Do you want to carry on with {topic} from earlier, or something new?"],
    plain: ["Hey {name}! Want to pick up from our conversation earlier today, or something new?", "Hi again, {name}. Carry on from earlier today, or something new?"],
  },
};

/**
 * What the agent says when it picks up: the person's first name, in a line that fits how this call follows the last
 * one (a cut-off, a quick call back, later the same day, or a fresh start). `seed` picks among a few ways of saying it
 * so it never sounds canned (seedOf the call's id; 0 is the first way).
 */
export function greetingFor(fullName: string | null | undefined, roleLabel: string, mode: ResumeMode = "fresh", topic: string | null = null, seed = 0): string {
  const name = firstNameOf(fullName);
  const t = topicPhrase(topic);
  const set = GREETINGS[mode];
  const list = t && set.withTopic.length ? set.withTopic : set.plain;
  const line = list[Math.abs(Math.trunc(seed)) % list.length];
  const out = line.replace("{name}", name).replace("{label}", roleLabel).replace("{topic}", t ?? "");
  return out.charAt(0).toUpperCase() + out.slice(1);
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

/** Text as it should be read aloud: no markdown, links as their words, no em dashes or bullet marks */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
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
  return {
    /** level: this frame's RMS; ms: how long the frame is; agentSpeaking: whether the agent's voice is playing */
    feed(level: number, ms: number, agentSpeaking: boolean): TurnEvent {
      const threshold = Math.max(t.speechLevel, noise * t.noiseRatio);
      if (agentSpeaking) {
        inSpeech = false;
        speechMs = 0;
        silenceMs = 0;
        loudMs = level >= Math.max(t.bargeLevel, threshold) ? loudMs + ms : 0;
        if (loudMs >= t.bargeMs) {
          loudMs = 0;
          inSpeech = true;
          return "barge_in";
        }
        return null;
      }
      loudMs = 0;
      if (level >= threshold) {
        silenceMs = 0;
        speechMs += ms;
        if (!inSpeech && speechMs >= t.minSpeechMs) {
          inSpeech = true;
          return "speech_start";
        }
        return null;
      }
      // Quiet: learn the room's noise slowly (only from quiet frames, so speech never raises it)
      noise = noise * 0.95 + level * 0.05;
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
    reset() {
      inSpeech = false;
      speechMs = 0;
      silenceMs = 0;
      loudMs = 0;
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
  // A specialist joined the call, or left it (role null)
  | { t: "guest"; role: string | null; label: string | null; icon: string | null }
  // Open a screen in the app while the call carries on
  | { t: "navigate"; href: string }
  // A link card on the call ("take a look"): in the app or a new tab
  | { t: "card"; card: CallCard }
  // The assistant asks for files: the upload panel opens on the call
  | { t: "upload"; ask: UploadAsk }
  // The agent wants to see the screen: a frame of the shared screen, the ask to share it, or (phones) the upload panel
  | { t: "look" }
  // The agent said goodbye: the call hangs up once its last words have played
  | { t: "end" };

/** A link the call shows as a card: tapped, it opens in the app (the call stays up) or in a new tab */
export type CallCard = { id: string; title: string; detail: string; href: string; external: boolean; cta: string };

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
export const CONCISE_RULE = `Be brief. This is a firm rule. By default answer in one to three short spoken sentences. Go longer only when they ask for it ("tell me more", "walk me through it"), and even then keep it tight. Never repeat their question back, no filler ("great question", "sure thing, so"), and never close with "let me know if you need anything else".`;

/** The same rule for the agents' text chats */
export const CONCISE_CHAT_RULE = `Be brief, as a firm rule: a few short lines by default, longer only when asked. No recap of the question, no filler, no "let me know if you need anything else".`;

/** What ends a call from the agent's side: written at the very end of its goodbye, never spoken */
export const END_MARKER = "[[END_CALL]]";

export const END_CALL_RULE = `Hanging up: when they're clearly wrapping up the whole call ("ok that's all, thanks", "ok bye", "talk later", "that's it for now"), say a very short goodbye (a few words) and then write ${END_MARKER} at the very end. Never write it for a "bye" inside a longer thought, a thanks mid-conversation, or when they're still asking something.`;

/** Gentle support when someone is struggling, on every call */
export const DISTRESS_RULE = `If they sound genuinely distressed or unsafe (not just busy or annoyed), pause the work. Be kind and brief, ask how they're doing, suggest talking with someone they trust or their lead, and if they may be in danger, urge them to call their local emergency number (988 in the US).`;

/**
 * Takes the agent's reply as it streams and holds back the end marker: text is passed on as it comes, except a tail
 * that could be the start of the marker (held until it's clearly not); once the marker appears, what comes before it
 * is passed on, the rest is dropped and `ended` is set.
 */
export function endMarkerFilter() {
  let held = "";
  let ended = false;
  return {
    feed(delta: string): string {
      if (ended) return "";
      const s = held + delta;
      const at = s.indexOf(END_MARKER);
      if (at >= 0) {
        ended = true;
        held = "";
        return s.slice(0, at);
      }
      let keep = 0;
      for (let k = Math.min(END_MARKER.length - 1, s.length); k > 0; k--)
        if (END_MARKER.startsWith(s.slice(s.length - k))) {
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
  };
}

/** A whole reply without the end marker, and whether it was there */
export function stripEndMarker(text: string): { text: string; ended: boolean } {
  const at = text.indexOf(END_MARKER);
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
