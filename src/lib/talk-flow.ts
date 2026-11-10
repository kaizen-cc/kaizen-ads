// "Talk it through", step by step (pure, tested in tests/talk-flow.test.ts). The conversation asks what it needs in
// the chat itself (its questions are part of the strategist's message, answered by typing or with a quick pick), and
// the moment it has enough (or the person says "write it") the full brief is written right there and the request
// opens in Ready to send. The quick preview is optional ("Preview first"), never a stop on the way.

/** What happens after a turn: ask (questions in the chat), write (clear: the full brief now), or land (written: Ready to send) */
export type TalkStep = "ask" | "write" | "land";

export function talkStep(r: { previewReady?: boolean; patch: unknown | null }): TalkStep {
  if (r.patch) return "land";
  if (r.previewReady) return "write";
  return "ask";
}

/** The person saying to go ahead and write it ("write it", "go ahead", "just draft it now", "looks good, write it") */
const WRITE_NOW = /^\s*(?:(?:ok(?:ay)?|great|perfect|cool|yes|yep|sure|looks good|sounds good|that'?s it)[,.!\s]+)*(?:please\s+)?(?:just\s+)?(?:go ahead(?:\s+and)?\s*)?(?:(?:write|draft|build|make)\s+(?:it|the brief|this|the full brief)(?:\s+(?:now|up))?|go ahead|go for it|do it|ship it)(?:\s+please)?\s*[.!]*\s*$/i;
export const wantsWrite = (text: string) => WRITE_NOW.test(text);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The questions (and conflicts) to show inside the strategist's message: only those its reply doesn't already say,
 * so nothing is asked twice and nothing ends up in a side panel.
 */
export function inlineAsks(reply: string, asks: { questions: string[]; conflicts: string[] }) {
  const said = norm(reply);
  const fresh = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x && !said.includes(norm(x)));
  return { questions: fresh(asks.questions), conflicts: fresh(asks.conflicts) };
}

/** Quick picks under the strategist's latest questions: answers that need no typing */
export const QUICK_PICKS = ["Your call on these", "Write it now"] as const;
