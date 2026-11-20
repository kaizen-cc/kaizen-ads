// The rules for reminders and tasks an agent makes on a call or in its chat (remind_me, ask_teammate), as plain
// functions with no keys or network, tested on their own:
//  - only when the person asked for one in so many words (or said yes when the agent offered one);
//  - the title is a clear action for that person, never the agent's own uncertainty or a decision it's unsure of;
//  - related things said on one call land on ONE checklist reminder, its items ticked off one by one.

export type CheckItem = { text: string; done: boolean };

/**
 * Words that ask for a reminder or a task, the way people actually say it ("remind me", "put it on my list", "make that
 * an item for me today on my overview", "add a task for me", "don't let me forget", "I need to remember to…"). Generous
 * on purpose: nobody should have to repeat a magic phrase.
 */
const ASKS =
  /\b(remind|reminder|reminders|to-?do|to do list|checklist|task|tasks|item|items|note (?:it|that|this) down|jot (?:it|that|this) down|write (?:it|that|this) down|put (?:it|that|this|them|one)\b|add (?:it|that|this|them|one)\b|add (?:a|an|another)\b|on my (?:list|overview|plate|day|calendar|radar)|(?:my|the) (?:list|overview|day)|for me (?:today|tomorrow|later|on)|don'?t (?:let me )?forget|(?:i|we) (?:need|have|got|gotta) to remember|need to remember|so i remember|keep (?:it|that|this) (?:on|in)|keep track|track (?:it|that|this)|flag (?:it|that|this) for me|save (?:it|that|this) for (?:me|later)|follow[- ]?up|send me|set (?:it|that|one) (?:for|up)|make sure|have (?:the|them|him|her)|ask (?:the|them|him|her)|get (?:the|someone)|assign|make (?:it|that|this) (?:a|an|one)|make (?:a|an) (?:note|item|task|reminder))\b/i;
const YES = /^\s*(?:(?:um+|uh+|oh|well|so|and|right)[,\s]+)?(yes|yeah|yep|yup|ya|sure|please|ok(?:ay)?|alright|all right|do it|go ahead|go for it|sounds good|sounds great|perfect|great|fine|that'?s fine|that(?:'d| would)? be (?:fine|great|good|perfect)|that works|works for me|absolutely|definitely|correct|exactly|right|cool)\b/i;
/** A correction of who or when, after the agent proposed something ("it should be on the Meta buyer", "no, tomorrow") */
const CORRECTION = /\b(it should (?:be|go)|should (?:be|go) (?:on|to)|send it to|give it to|put it on|make it (?:for|on)|(?:no|actually),? (?:the|it'?s|make it|for|on|to))\b/i;
const NO = /^\s*(no|nope|nah|don'?t|not now|never ?mind|cancel|skip)\b/i;

/**
 * Whether the person's own words this turn ask for a reminder or a task: in so many words, or a yes to one the agent
 * just offered. Nothing said (a typed chat with no turn text) is left to the model's own judgment.
 */
export function askedForNote(said: string | null | undefined): boolean {
  const t = String(said ?? "").trim();
  if (!t) return true;
  if (CORRECTION.test(t) || /\bdon'?t (?:let me )?forget\b/i.test(t)) return true;
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

/** One item taken off a checklist (matched by its words, so a list that moved since it was drawn still loses the right one) */
export function removeItem(items: CheckItem[], text: string): CheckItem[] {
  const t = text.trim().toLowerCase();
  return items.filter((it) => it.text.trim().toLowerCase() !== t);
}
