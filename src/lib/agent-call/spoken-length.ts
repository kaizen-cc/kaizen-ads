// How long a spoken answer may run. The instructions ask for about sixty words; this is the guard behind them: once an
// answer has said more than its cap, it stops at the end of that sentence and offers the rest, so a question never
// turns into a two minute monologue. Asking for detail ("walk me through it", "tell me more") raises the cap, and so
// does planning: ideas, topics or a plan asked for, or a short numbered list being said (three ideas are said whole).
// Only truly long monologues are cut, and never two answers in a row (see nextCapFor). Pure.

/** Well past the sixty words asked for (the model gets room; a lecture doesn't) */
export const SPOKEN_CAP_WORDS = 150;
/** When they asked for the detail */
export const DETAIL_CAP_WORDS = 280;
/** A short list being said (three ideas, three topics) or planning asked for: the list is said whole up to this */
export const LIST_CAP_WORDS = 260;

const DETAIL = /\b(?:tell me (?:more|everything|all)|more (?:detail|on that)|in detail|walk me through|go through (?:it|them|all|each|everything)|step by step|break (?:it|that) down|explain(?: it| that)?(?: fully| in full)?|all of them|the (?:full|whole|rest of the) list|the rest|full (?:rundown|picture|breakdown)|keep going|go on|long version)\b/i;

const PLANNING = /\b(?:ideas?|brainstorm\w*|plan(?:s|ning)?|topics?|concepts?|angles?|options|suggest\w*|what (?:should|could) we (?:send|post|run|do))\b/i;

/** Whether what they said asks for the long version */
export const asksForDetail = (said: string | null | undefined) => DETAIL.test(String(said ?? ""));

/** Whether they asked for ideas, topics or a plan (answered as a short list, said whole) */
export const asksForPlanning = (said: string | null | undefined) => PLANNING.test(String(said ?? ""));

/** The cap for an answer to what they said ("" for a hand-over between agents: the usual cap) */
export const spokenCapFor = (said: string | null | undefined) => (asksForDetail(said) ? DETAIL_CAP_WORDS : asksForPlanning(said) ? LIST_CAP_WORDS : SPOKEN_CAP_WORDS);

/** The cap for this answer given whether the one before was cut: never cut twice in a row */
export const nextCapFor = (said: string | null | undefined, lastWasCut: boolean) => (lastWasCut ? Number.MAX_SAFE_INTEGER : spokenCapFor(said));

/** A numbered or ordinal list is being said ("1.", "2)", "First,", "Second idea") */
const LIST_ITEM = /(?:^|[\s(])(?:[1-9][.)](?=\s)|(?:first|second|third|fourth|fifth|number (?:one|two|three))\b[,:]?)/gi;
export const listItems = (s: string) => (s.match(LIST_ITEM) ?? []).length;

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
      // A short list on its way (two items or more said): it's said whole, up to the list cap
      const limit = cap < LIST_CAP_WORDS && listItems(said + d) >= 2 ? LIST_CAP_WORDS : cap;
      if (words + wordsIn(d) < limit) {
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
