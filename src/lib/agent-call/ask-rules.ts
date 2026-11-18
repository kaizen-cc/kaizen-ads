// The rules for reminders and tasks an agent makes on a call or in its chat (remind_me, ask_teammate), as plain
// functions with no keys or network, tested on their own:
//  - only when the person asked for one in so many words (or said yes when the agent offered one);
//  - the title is a clear action for that person, never the agent's own uncertainty or a decision it's unsure of;
//  - related things said on one call land on ONE checklist reminder, its items ticked off one by one.

export type CheckItem = { text: string; done: boolean };

/** Words that ask for a reminder or a task ("remind me", "put it on my list", "make it a task", "send me…") */
const ASKS = /\b(remind|reminder|to-?do|checklist|task|tasks|note (?:it|that|this) down|jot (?:it|that) down|put (?:it|that|this|them) (?:on|in)|add (?:it|that|this|them) to|on my list|my list|don'?t let me forget|follow[- ]?up|send me|set (?:it|that|one) (?:for|up)|make sure|have (?:the|them|him|her)|ask (?:the|them|him|her)|get (?:the|someone)|assign)\b/i;
const YES = /^\s*(yes|yeah|yep|yup|sure|please|ok(?:ay)?|do it|go ahead|sounds good|perfect|that works|absolutely|definitely)\b/i;
const NO = /^\s*(no|nope|nah|don'?t|not now|never ?mind|cancel|skip)\b/i;

/**
 * Whether the person's own words this turn ask for a reminder or a task: in so many words, or a yes to one the agent
 * just offered. Nothing said (a typed chat with no turn text) is left to the model's own judgment.
 */
export function askedForNote(said: string | null | undefined): boolean {
  const t = String(said ?? "").trim();
  if (!t) return true;
  if (NO.test(t)) return false;
  return ASKS.test(t) || YES.test(t);
}

/** Openings that make a reminder out of the agent's own doubt instead of something for the person to do */
const UNSURE = /^(?:decide|deciding|consider|considering|think about|thinking about|maybe|possibly|perhaps|figure out (?:if|whether)|check (?:if|whether) (?:we|you|i) should|whether)\b/i;

/** What's wrong with a reminder's title, said for the agent to fix, or null when it's a clear action */
export function titleProblem(title: string): string | null {
  const t = title.trim();
  if (!t) return "Give it a title: what they'll do, as a short action.";
  if (t.split(/\s+/).length < 2) return "Make the title a clear action for them, starting with a verb (Send…, Review…, Copy…).";
  if (t.endsWith("?")) return "A reminder is something to do, not a question. If you're unsure, ask them on the call instead.";
  if (UNSURE.test(t) || /\bwhether\b/i.test(t)) return "That's a decision you're unsure of, not a task they asked for. Ask them on the call instead of making a reminder.";
  return null;
}

/** A checklist from what the model gave: short lines, no blanks or repeats, at most 20 */
export function cleanItems(raw: unknown): CheckItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: CheckItem[] = [];
  for (const x of list) {
    const text = String(typeof x === "object" && x && "text" in x ? (x as { text: unknown }).text : x)
      .replace(/\s+/g, " ")
      .replace(/^[-*•\d.)\s]+/, "")
      .trim()
      .slice(0, 200);
    const done = typeof x === "object" && x !== null && (x as { done?: unknown }).done === true;
    if (text && !out.some((o) => o.text.toLowerCase() === text.toLowerCase())) out.push({ text, done });
    if (out.length >= 20) break;
  }
  return out;
}

/** The items added to a checklist already there (repeats left out, ticked items kept as they are) */
export function mergeItems(had: CheckItem[], add: CheckItem[]): CheckItem[] {
  return cleanItems([...had, ...add.filter((a) => !had.some((h) => h.text.toLowerCase() === a.text.toLowerCase()))]);
}

/** One item ticked or unticked; the rest as they were */
export function tickItem(items: CheckItem[], index: number, done: boolean): CheckItem[] {
  return items.map((it, i) => (i === index ? { ...it, done } : it));
}
