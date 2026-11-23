import { clock } from "./core";

// A call's transcript as a plain text file to download: the date, who the call was with, then every line with when
// it was said into the call and who said it ("[00:42] Santi: ..."). Pure: the rows come from the call's chat.

export type TranscriptLine = { at: string; who: "user" | "agent"; speaker?: string | null; text: string };

const pad = (s: string) => (s.length < 5 ? s.padStart(5, "0") : s);

/** mm:ss (or h:mm:ss) into the call, never negative */
export function stamp(at: string, startedAt: string): string {
  const s = Math.max(0, Math.floor((Date.parse(at) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return "00:00";
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(clock(s % 3600))}`;
  return pad(clock(s));
}

/**
 * Lines in the order they were said: by time, and on the same instant the person's line before the answer to it
 * (a turn's two lines used to be saved together, both stamped when the answer finished). Ties otherwise keep their order.
 */
export function orderLines<T extends Pick<TranscriptLine, "at" | "who">>(lines: readonly T[]): T[] {
  return lines
    .map((l, i) => ({ l, i, t: Date.parse(l.at) }))
    .sort((a, b) => {
      const ta = Number.isFinite(a.t) ? a.t : 0;
      const tb = Number.isFinite(b.t) ? b.t : 0;
      if (ta !== tb) return ta - tb;
      if (a.l.who !== b.l.who) return a.l.who === "user" ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.l);
}

/**
 * When a turn's lines are kept: the person's at the moment the turn arrived (when they said it), the answer when it
 * finished, always after the person's line (never the same instant, so nothing sorts the answer first)
 */
export function turnTimes(heardAt: number | null | undefined, answeredAt: number): { said: string; answered: string } {
  const said = Math.min(typeof heardAt === "number" && Number.isFinite(heardAt) ? heardAt : answeredAt - 1, answeredAt - 1);
  return { said: new Date(said).toISOString(), answered: new Date(Math.max(answeredAt, said + 1)).toISOString() };
}

export function formatTranscript(input: { startedAt: string; endedAt?: string | null; agentLabel: string; personName: string; lines: TranscriptLine[] }): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(input.startedAt));
  const length = input.endedAt ? ` (${clock((Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000)})` : "";
  const head = [`Call with the ${input.agentLabel}`, `${day} New York time${length}`, `${input.personName} and the ${input.agentLabel}`, ""];
  const body = orderLines(input.lines)
    .filter((l) => l.text.trim())
    .map((l) => `[${stamp(l.at, input.startedAt)}] ${l.who === "user" ? input.personName : (l.speaker ?? input.agentLabel)}: ${l.text.replace(/\s+/g, " ").trim()}`);
  return [...head, ...(body.length ? body : ["(Nothing was said on this call.)"]), ""].join("\n");
}

/** The file's name: the agent and the call's day ("call-assistant-2026-11-17.txt") */
export function transcriptFileName(startedAt: string, agentLabel: string): string {
  const day = new Date(startedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const who = agentLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `call-${who || "agent"}-${day}.txt`;
}

// ─── The same words twice ───────────────────────────────────────────────────

/** Two turns this close together with the very same words are one utterance sent twice (a late transcript, a resend) */
export const REPEAT_WINDOW_MS = 45_000;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Whether a turn repeats the last one word for word within the window (a short "yes" or "okay" said twice is a real
 * answer each time, so only lines of four words or more count).
 */
export function isRepeatTurn(text: string, last: { text: string; at: number } | null | undefined, now: number, windowMs = REPEAT_WINDOW_MS): boolean {
  if (!last) return false;
  const a = norm(text);
  if (a.split(" ").length < 4) return false;
  return a === norm(last.text) && now - last.at >= 0 && now - last.at <= windowMs;
}

/**
 * The key a turn is claimed under (null for a short line, which is never treated as a repeat): the same words give the
 * same key, so two copies of one utterance arriving at once claim the same slot and only the first is answered.
 */
export function repeatKey(text: string): string | null {
  const a = norm(text);
  if (a.split(" ").length < 4) return null;
  // A small, filter-safe fingerprint (FNV-1a, 32 bits, twice with different seeds)
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < a.length; i++) {
      h ^= a.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `${fnv(2166136261)}${fnv(374761393)}`;
}

/** Whether two moments are close enough for the same words to be one utterance sent twice */
export const withinRepeat = (now: number, then: number, windowMs = REPEAT_WINDOW_MS) => now - then >= 0 && now - then <= windowMs;
