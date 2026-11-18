// How long a spoken answer may run. The instructions ask for about sixty words; this is the guard behind them: once an
// answer has said more than its cap, it stops at the end of that sentence and offers the rest, so a question never
// turns into a two minute monologue. Asking for detail ("walk me through it", "tell me more") raises the cap. Pure.

/** About twice the sixty words asked for (the model gets room; a lecture doesn't) */
export const SPOKEN_CAP_WORDS = 110;
/** When they asked for the detail */
export const DETAIL_CAP_WORDS = 280;

const DETAIL = /\b(?:tell me (?:more|everything|all)|more (?:detail|on that)|in detail|walk me through|go through (?:it|them|all|each|everything)|step by step|break (?:it|that) down|explain(?: it| that)?(?: fully| in full)?|all of them|the (?:full|whole|rest of the) list|the rest|full (?:rundown|picture|breakdown)|keep going|go on|long version)\b/i;

/** Whether what they said asks for the long version */
export const asksForDetail = (said: string | null | undefined) => DETAIL.test(String(said ?? ""));

/** The cap for an answer to what they said ("" for a hand-over between agents: short) */
export const spokenCapFor = (said: string | null | undefined) => (asksForDetail(said) ? DETAIL_CAP_WORDS : SPOKEN_CAP_WORDS);

/** The line said when an answer is cut at its cap */
export const MORE_LINE = "Want the rest?";

const wordsIn = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/**
 * Watches an answer as it's written. `feed` returns the part to say (all of it until the cap, then up to the end of
 * the sentence it's in, then nothing); `capped` turns true at that sentence end, and `tail` is the offer to say then
 * (empty when the last sentence already asked something).
 */
export function createLengthGuard(cap: number) {
  let words = 0;
  let said = "";
  let capped = false;
  return {
    feed(d: string): string {
      if (capped || !d) return "";
      if (words + wordsIn(d) < cap) {
        words += wordsIn(d);
        said += d;
        return d;
      }
      // Over the cap: up to the end of this sentence, then stop
      const end = d.search(/[.!?](?=\s|$|["')\]])/);
      if (end === -1) {
        words += wordsIn(d);
        said += d;
        return d;
      }
      const out = d.slice(0, end + 1);
      said += out;
      words += wordsIn(out);
      capped = true;
      return out;
    },
    get capped() {
      return capped;
    },
    get words() {
      return words;
    },
    /** The offer once cut (nothing when the answer already ended on a question) */
    get tail(): string {
      if (!capped) return "";
      return /\?\s*["')\]]?\s*$/.test(said.trim()) ? "" : ` ${MORE_LINE}`;
    },
  };
}
