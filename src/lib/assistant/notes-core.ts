// A call's notes keep only what the person said, asked for or agreed to (Peter's Nov 26 2026 feedback: a three-turn
// call where he barely spoke came back with four "follow-ups" that were the assistant's own rundown of his open
// items). The pure rules, tested in tests/call-notes.test.ts; the notes are written in src/lib/assistant/notes.ts.

/** Where a follow-up came from: only the first three are the person's */
export const FOLLOW_UP_SOURCES = ["they_asked", "they_agreed", "they_said_they_will", "assistant_read_out", "assistant_offered"] as const;
export type FollowUpSource = (typeof FOLLOW_UP_SOURCES)[number];
const THEIRS = new Set<FollowUpSource>(["they_asked", "they_agreed", "they_said_they_will"]);

/** Fewer words than this from the person (greetings and "are you there" not counted): the call has no follow-ups or decisions */
export const MIN_PERSON_WORDS = 8;

// "hello", "are you there", "can you hear me", "Jarvis", "ok", "yes": checking the line, not saying anything
const FILLER = /\b(hello|hi|hey|yo|ok(ay)?|yes|yeah|yep|no|nope|thanks|thank you|are you there|can you hear me|you there|hmm|um+|uh+|jarvis|assistant)\b/gi;

/** How many words the person said that carry something (filler and checking the line set aside) */
export function personWords(turns: readonly { role: string; content: string }[]): number {
  return turns
    .filter((t) => t.role === "user")
    .map((t) => t.content.replace(FILLER, " ").replace(/[^\p{L}\p{N}\s']/gu, " "))
    .join(" ")
    .split(/\s+/)
    .filter((w) => w.length > 1).length;
}

export type RawFollowUp = { what: string; due?: string | null; client?: string | null; from?: string | null };

/**
 * The decisions and follow-ups worth keeping: none at all when the person said little; follow-ups only from what they
 * asked for, agreed to or said they'd do (never what the assistant read out from their list or offered unanswered).
 */
export function keepNoteItems<F extends RawFollowUp>(o: { decisions: readonly string[]; followUps: readonly F[]; personWords: number }): { decisions: string[]; followUps: F[] } {
  if (o.personWords < MIN_PERSON_WORDS) return { decisions: [], followUps: [] };
  return { decisions: [...o.decisions], followUps: o.followUps.filter((f) => THEIRS.has(f.from as FollowUpSource)) };
}
