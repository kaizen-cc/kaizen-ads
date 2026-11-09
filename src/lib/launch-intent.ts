// How a buyer's message in a launch conversation reads, before any model: "just build it" (take every proposal and
// build now), frustration or repeating themselves (stop asking, say in one line what happens, do it), and what a
// message about a launch that's already created wants ("where is it?", "add the keywords to it"). Pure: the chat, the
// Google and Meta launch flows and the tests (tests/launch-intent.test.ts) agree.

/** "Just build it", "build everything", "build the full campaign", "do it all": every proposal taken, built now */
export const BUILD_ALL =
  /\b(just|go ahead and|please|pls|ya|yeah|yes|ok)?\s*(build|make|create|launch|do) (it all|it|everything|all of it|the (full|whole|entire|complete) (thing|campaign|launch)|the rest)\b(?!\s+(later|tomorrow|next))|\bbuild everything\b|\beverything\b.*\b(build|create|go)\b|\bjust do it\b|\bstop asking\b/i;

/** Wants everything built now, every proposal accepted */
export function wantsEverything(message: string) {
  const m = message.trim();
  if (!m) return false;
  // "don't build it yet", "build it later" isn't
  if (/\b(don'?t|do not|not yet|wait|hold off|later)\b/i.test(m)) return false;
  return BUILD_ALL.test(m);
}

const SWEAR = /\b(fuck\w*|shit\w*|wtf|ffs|damn\w*|bullshit|jesus|omfg|goddamn\w*|crap)\b/i;
const IMPATIENT = /\bwhy (are|r) (you|u) (talking|asking|still asking|taking) (so )?(long|much)?|\bwhy (are|r) (you|u) talking so long\b|\bstop asking\b|\btoo many questions\b|\bi (already|just) (said|told|answered)|\bi said\b|\bhow many times\b|\bjust do (it|what i said)\b|\bno no no\b|\bcome on\b/i;

const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** How much of one message is another's (shared words over the smaller set), 0 to 1 */
export function overlap(a: string, b: string) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size < 4 || y.size < 4) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/**
 * The buyer is frustrated or repeating an instruction: swearing, "why are you talking so long", "I already said", or
 * the same ask as one of their last messages. Then nothing more is asked: the reply says in one line what it'll do.
 */
export function frustrated(message: string, earlier: string[] = []) {
  if (SWEAR.test(message) || IMPATIENT.test(message)) return true;
  return earlier.slice(-4).some((t) => overlap(message, t) >= 0.6);
}

export type AppliedIntent = "where" | "add" | "new" | null;

/**
 * What a message about a launch that's already created wants: "where" (where is it, a link, I can't see it), "add"
 * (put keywords, ads or locations into it, finish it, what's missing), "new" (a different, new campaign: a launch of
 * its own), or null (something else: the chat answers it, knowing the launch is done).
 */
export function appliedIntent(message: string, campaignNames: string[] = []): AppliedIntent {
  const m = message.toLowerCase();
  const names = campaignNames.some((n) => n && m.includes(n.toLowerCase()));
  const sameOne = names || /\b(it|that|this|same|existing|the campaign|that campaign|the one (you|u))\b/.test(m);
  if (/\b(a|another|second|separate|different) new (search |pmax |performance max )?campaign\b|\bnew campaign (for|called|named)\b/.test(m) && !/\bsame campaign\b/.test(m)) return "new";
  if (/\b(add|put|finish|complete|build out|fill( in)?|missing|inside|into it|to it|same campaign|didn'?t (get|create|add)|no (keywords|ads|locations)|empty|shell|nothing inside|fix the locations?)\b/.test(m) && sameOne) return "add";
  if (/\b(keywords?|ads?|ad copy|rsas?|locations?|ad groups?)\b/.test(m) && /\b(add|put|include|need|want|build|create|missing|where)\b/.test(m) && sameOne) return "add";
  if (/\bwhere('?s| is| are)\b|\bcan'?t (find|see)\b|\bdon'?t see\b|\bnot (there|showing|visible)\b|\blink\b|\bopen (it|in google)\b|\bdid (it|you) (create|build|launch|go)\b|\bis it (live|there|created|done)\b/.test(m)) return "where";
  return null;
}
