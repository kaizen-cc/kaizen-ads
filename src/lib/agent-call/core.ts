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

/** What the agent says when it picks up: the person's first name and one line offering help */
export function greetingFor(fullName: string | null | undefined, roleLabel: string): string {
  const name = firstNameOf(fullName);
  return `Hey ${name}, it's the ${roleLabel}. What can I help you with?`;
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
  /** Silence this long after speech ends the turn */
  endSilenceMs: 750,
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
      if (silenceMs >= t.endSilenceMs) {
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
  required: ["learnings"],
  properties: {
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
  | { t: "error"; message: string };

/** A learning as the call screen shows it: saved (with its item, for Undo) or sent to the chat as a proposal */
export type LearnedItem = { id: string | null; type: "note" | "rewrite"; skill: string; title: string; body: string; undone?: boolean };

/** mm:ss for the call timer */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
