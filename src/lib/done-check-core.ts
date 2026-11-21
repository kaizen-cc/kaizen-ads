// The general done-check, the pure part (tests/done-check.test.ts): items on anyone's Today or Overview close
// themselves when Slack, Gmail or call and Gemini notes show they're done (the owner, Nov 20 2026). Precision first:
// an item only closes on a quote that's really in what was said, said after the item opened, and that says it's done
// without hedging. Anything less is "moving" (or "nothing"), never a close.

export type DoneState = "done" | "moving" | "nothing";

export type Evidence = { n: number; at: string; source: string; author: string | null; text: string; url: string | null };

export type Verdict = { state: DoneState; quote: string; evidence: number | null; sure: boolean };

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’`]/g, "").replace(/\s+/g, " ").trim();

/** Words that undo a "done": still broken, not yet, waiting, an open question */
const HEDGE = /\b(not (?:yet|quite|working|firing|set ?up|done|live|fixed)|isn'?t|aren'?t|wasn'?t|haven'?t|hasn'?t|didn'?t|doesn'?t|don'?t|won'?t|can'?t|still (?:not|broken|missing|waiting|need)|need(?:s)? to|should|will|going to|gonna|plan(?:ning)? to|tomorrow|next week|later|almost|partially|mostly|some(?:what)?|i think|maybe|might|hopefully|should be|trying|working on|in progress|\?)/i;

/**
 * The model's verdict, held to the guardrails: a "done" needs a quote found word for word in one of the evidence
 * messages, that message dated after the item opened, the model sure, and no hedge in the quote. Otherwise it's at most
 * "moving" (a real quote that hedges) or "nothing".
 */
export function guard(v: Verdict, evidence: readonly Evidence[], since: string): Verdict {
  if (v.state !== "done") return { ...v, state: v.state === "moving" ? "moving" : "nothing" };
  const quote = norm(v.quote);
  const ev = v.evidence != null ? evidence.find((e) => e.n === v.evidence) : null;
  const inText = ev ? norm(ev.text).includes(quote) : evidence.some((e) => norm(e.text).includes(quote));
  const after = ev ? Date.parse(ev.at) >= Date.parse(since) : false;
  if (!v.sure || quote.length < 8 || !inText || !after) return { ...v, state: quote && inText ? "moving" : "nothing" };
  if (HEDGE.test(v.quote)) return { ...v, state: "moving" };
  return v;
}

const SOURCE_WORD: Record<string, string> = { slack_internal: "Slack", slack_external: "Slack", gmail: "email", call: "call notes", drive: "notes" };
export const sourceWord = (s: string) => SOURCE_WORD[s] ?? s;

/** "Closed automatically: "tracking's verified" (Slack, Nov 18)" */
export function closedNote(quote: string, source: string, at: string): string {
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  const q = quote.replace(/\s+/g, " ").trim();
  return `Closed automatically: "${q.length > 140 ? `${q.slice(0, 137)}…` : q}" (${sourceWord(source)}, ${day})`;
}

/** What each kind of item needs to be done, in words the classifier reads */
export const DONE_MEANS: Record<string, string> = {
  notrack: "the client's conversion tracking (pixel, Conversions API, GA4, tags, purchase or lead events) is set up and working",
  dog: "the problem this alert describes is fixed or resolved",
  ask: "the task asked of the person is done",
  onboard_intake: "the client's marketing intake form has been filled out or received",
  onboard_call: "the client's onboarding call is booked or has happened",
  onboard_assets: "the client has sent or uploaded their assets (logos, photos, footage, brand files)",
  stuck_copy: "the copy for this creative has been written or added",
  stuck_client: "the client replied about or approved this creative",
  asana: "this task is done",
};

const TRACKING_WORDS = /\b(tracking|tracked|pixel|capi|conversions? api|gtm|tag manager|ga4|google analytics|purchase event|lead event|conversion|events? (?:firing|fire|set ?up)|server[- ]side|utm)\b/i;
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "client", "their", "your", "not", "set", "has", "have"]);
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "");

/** What the messages about an item mention: tracking words for tracking items, else the item's own main words */
export function subjectOf(kind: string, title: string): RegExp | null {
  if (kind === "notrack" || /track|pixel|capi|conversion|ga4|gtm/i.test(title)) return TRACKING_WORDS;
  if (kind === "onboard_intake") return /\b(intake|form|questionnaire)\b/i;
  if (kind === "onboard_call") return /\b(onboarding call|kickoff|kick-off|call|meeting|booked|calendar)\b/i;
  if (kind === "onboard_assets") return /\b(assets?|logos?|photos?|footage|drive|brand files?|uploaded)\b/i;
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).slice(0, 6).map(escape);
  return words.length ? new RegExp(`\\b(${words.join("|")})`, "i") : null;
}

/** Kinds whose evidence is about tracking (the Tracking Specialist sees their auto-closes) */
export const TRACKING_KINDS = new Set(["notrack", "dog"]);
