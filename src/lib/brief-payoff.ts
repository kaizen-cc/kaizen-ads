// Promises without the payoff (the lead video editor's feedback, Nov 10 2026): a brief built the whole concept around
// "the hack most people miss when buying a seat" and never said what the hack was. A hook that promises a reveal, a
// tip, a hack, a secret or "what most people miss" is only a concept once the brief says exactly what it is, where it
// comes from and how it shows on screen. When only the client knows it, the brief says so plainly and gives a fallback
// that works without it. The rule every brief writer gets, and the cheap code check behind it. Pure: tested in
// tests/brief-payoff.test.ts.

/** Phrases that promise the viewer something specific: the brief has to deliver it */
const PROMISE =
  /\b(?:(?:the|this|one|a|my|our|his|her|their|\d{1,2}|two|three|four|five|six|seven)\s+(?:(?:simple|little|easy|quick|best|biggest|only|real|top|secret|insider|pro)\s+)?(?:hacks?|tricks?|tips?|secrets?|mistakes?)\b|hacks?\s+(?:to|for|that)\b|secret\s+(?:to|of|is|that|most)\b|(?:most|many|few)\s+(?:people|fans|buyers|customers|homeowners|parents|guests|drivers|owners)\s+(?:miss|overlook|forget|ignore|don'?t (?:know|notice|realize|see)|get wrong|never (?:see|notice|know|try))\b|what\s+(?:nobody|no one|they don'?t|most people don'?t)\s+tells?\s+you\b|the\s+one\s+thing\b|little[- ]known\b|insider\s+(?:tip|trick|secret|move)s?\b|nobody\s+(?:talks about|tells you|knows)\b)/i;

/** The first promise in a text ("the hack", "most people miss"), or null */
export function promiseIn(text: string): string | null {
  const m = PROMISE.exec(text.replace(/\s+/g, " "));
  return m ? m[0].trim() : null;
}

/** The rule, for every brief writer and reviewer (roles, never names; no em dashes) */
export const PAYOFF_RULE = `PAY OFF EVERY PROMISE. A hook or title that promises a reveal, a tip, a hack, a trick, a secret, a mistake or "what most people miss" is only a concept once the brief delivers it. In "Why it works", say exactly what it is (the actual hack, the actual tip, the actual seat and why), where it comes from (client memory, the Brand Bible, a call, the footage, a document they sent) in "(Source: ...)", and how it shows on screen. When the context doesn't hold the payoff and only the client could tell us, don't build the concept on it: choose a different hook whose payoff we know. Only when the idea is worth keeping anyway, keep it with the question under "Confirm with client" and a line in the opening that starts "Fallback:" giving a version that works without it, said plainly. Never write a hook that teases something the brief doesn't say.`;

/**
 * Does a quick preview's concept name what its hook promises? It does when it says "the hack is ..." or "the tip: ...",
 * or talks about it in its own words without the teasing phrase; not when it repeats the tease or leaves the payoff
 * "to confirm".
 */
export function conceptPays(concept: string): boolean {
  if (/payoff to confirm/i.test(concept)) return false;
  const p = promiseIn(concept);
  if (!p) return concept.trim().split(/\s+/).length >= 8;
  const at = concept.toLowerCase().indexOf(p.toLowerCase());
  const after = concept.slice(at + p.length);
  return /^[^.!?]{0,40}?(?::\s*\S|\s(?:is|are|means|being)\s|\s\()/i.test(after);
}

export type PayoffCheck = {
  /** The promise found in the title, hook or the opening lines, or null when there's none */
  promise: string | null;
  /** The brief delivers it: an insight with its source, or an answered fact */
  paid: boolean;
  /** It waits on the client (an unanswered "Confirm with client" question) */
  pending: boolean;
  /** A fallback version is given for when the client can't confirm it */
  fallback: boolean;
};

type SpecLike = { hook: string; insight: string; insightSource: string; confirm: { question: string; answer: string }[]; /** V1's line is the hook when there's no Hook line */ versions?: string[] };

/**
 * Does this brief pay off what its hook promises? Read from the title, the Hook and the opening lines (never the Do
 * and Don't lists, where "tips" is just a word).
 */
export function checkPayoff(i: { title?: string; overview: string; spec: SpecLike; /** The whole brief, where a fallback line may sit */ text?: string }): PayoffCheck {
  const opening = i.overview.split(/\n/).slice(0, 4).join(" ");
  const hook = i.spec.hook.trim() || (i.spec.versions?.[0] ?? "").replace(/^V\d{1,2}\s*[:.)\-–]\s*/i, "");
  const promise = promiseIn([i.title ?? "", hook, opening].join(" . "));
  const insight = i.spec.insight.trim();
  const sourced = Boolean(i.spec.insightSource.trim()) && insight.length > 30 && !(promiseIn(insight) && insight.split(/\s+/).length < 14);
  const answered = i.spec.confirm.some((c) => c.answer.trim());
  const pending = i.spec.confirm.some((c) => c.question.trim() && !c.answer.trim());
  const fallback = /(?:^|\n)\s*fallback\s*:|\bfallback version\b|\bif (?:it'?s|that'?s|this is|the client) (?:not|can'?t|doesn'?t) confirm/i.test(i.text ?? i.overview);
  return { promise, paid: Boolean(promise) && (sourced || answered), pending, fallback };
}
