import { isPeopleMatter } from "@/lib/people-matters";
// The general done-check, the pure part (tests/done-check.test.ts): items on anyone's Today or Overview close
// themselves when Slack, Gmail or call and Gemini notes show they're done (the owner, Nov 20 2026). Precision first:
// an item only closes on a quote that's really in what was said, said after the item opened, and that says it's done
// without hedging. Anything less is "moving" (or "nothing"), never a close.

export type DoneState = "done" | "moving" | "nothing";

export type Evidence = { n: number; at: string; source: string; author: string | null; text: string; url: string | null };

export type Verdict = { state: DoneState; quote: string; evidence: number | null; sure: boolean };

/** Text as compared: no Slack mentions, links or punctuation, lowercase, single spaces ("Tracking fixed <@U123>" = "tracking fixed") */
export const norm = (s: string) =>
  s
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Words that undo a "done": not yet, waiting, planned, an open question */
const HEDGE = /\b(not (?:yet|quite|working|firing|set ?up|done|live|fixed)|isn'?t (?:working|firing|set|done|live|fixed|tracking|sending)|aren'?t|haven'?t|hasn'?t|didn'?t|doesn'?t|won'?t|can'?t|still (?:not|broken|missing|waiting|need)|need(?:s)? to|should|will|going to|gonna|plan(?:ning)? to|tomorrow|next week|later|almost|partially|mostly|i think|maybe|might|hopefully|trying|working on|in progress|\?)/i;

/** Curly apostrophes as straight ones ("isn’t" = "isn't"), so the checks below read Slack's typography */
export const apos = (s: string) => s.replace(/[’‘`]/g, "'");

/** A message saying it's broken (but "not broken" isn't) */
const BROKEN_RE = /(?<!\bnot |n't |never )\b(broken|not (?:firing|working|tracking|sending|recording|showing|reaching)|(?:is|are|was|were)n'?t (?:firing|working|sending|tracking|showing|reaching|recording|coming through)|still not (?:seeing|showing|firing|working|getting)|stopped (?:firing|working|tracking|sending)|double[- ]counting|no (?:server|capi) events|sent nothing|conversions are zero|zero conversions|(?:won'?t|doesn'?t|don'?t) (?:work|fire|track))\b/i;
export const BROKEN = { test: (s: string) => BROKEN_RE.test(apos(s)) };

/** What tracking is called ("call tracking" isn't conversion tracking) */
const SUBJ = String.raw`(?<!call )(?:tracking|pixel|capi|conversions? api|ga4|gtm|(?:purchase|lead|checkout|conversion) (?:events?|tracking))`;
/** A clause saying it IS set up and working: the thing, then (is/are) a done word, right next to each other */
const CONFIRM = new RegExp(
  String.raw`\b${SUBJ}\s+(?:is\s+|are\s+|was\s+|were\s+|'s\s+|has been\s+|have been\s+)?(?:now\s+|all\s+|fully\s+|properly\s+)?(?:fixed|ready|working|set up|done|live|verified|firing|good to go)\b` +
    String.raw`|\b(?:we|i|we've|i've|we have|i have|has|have)\s+(?:fixed|verified)\s+(?:the\s+)?${SUBJ}\b` +
    String.raw`|\btested it and it'?s (?:ok|okay|working|fine)\b`,
  "i",
);
/** Words that make a clause a condition, a plan or a doubt rather than a fact ("once the pixel is set up", "no pixel set up yet") */
const NOT_A_FACT =
  /\b(no|not|never|without|yet|once|until|unless|if|provided|when|can|could|would|should|will|must|need|needs|needed|wait|waiting|promised|preparing|pending|before|planning|plan|going to|soon|hopefully|maybe|think|confirm|check|checking|ensure|make sure|get|getting|let's|please|email|klaviyo|as soon as|needs to be|will be|notify|notifies|tell|tells|inform|informs|ask|asks)\b|\bwith\s+(?:\w+\s+)?(?:tracking|pixel)\b|\b(?:is|are|was|has|did)\s+(?:the\s+|all\s+)?(?:tracking|pixel|capi|ga4|gtm)\b|\?/i;

/** One clause that confirms tracking, or null: sentences split at . ! ? ; : and at "but" */
export function confirmingClause(text: string): string | null {
  const clauses = apos(text)
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/<?https?:\/\/\S+/g, " ")
    .split(/(?<=[.!?\n;:])\s+|,?\s+but\s+/i);
  for (const c of clauses) {
    const m = CONFIRM.exec(c);
    if (!m || BROKEN.test(c)) continue;
    // "after the video creative is aligned and the pixel fixed": a condition word before the done word, with no comma
    // between them, makes it a future condition ("After a long meeting, tracking is not broken" still counts)
    if (/\b(after|once|when|until|as soon as|before)\b/i.test(c.slice(0, m.index).split(",").pop() ?? "")) continue;
    if (NOT_A_FACT.test(c.replace(/\bnot broken\b/gi, ""))) continue;
    return c.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return null;
}

/**
 * Tracking is a state, so for a tracking item the newest word decides, without a model: walking newest first, a
 * message reporting it broken stops the walk (stays open); the first message with a clause plainly saying it's set
 * up and working closes it. Returns the closing evidence and clause, or null.
 */
export function stateConfirmed(evidence: readonly Evidence[]): { ev: Evidence; quote: string } | null {
  const newest = [...evidence].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const e of newest) {
    if (BROKEN.test(e.text)) return null;
    const quote = confirmingClause(e.text);
    if (quote) return { ev: e, quote };
  }
  return null;
}

/**
 * The model's verdict, held to the guardrails: a "done" needs a quote found in one of the evidence messages (Slack
 * mentions, links and punctuation aside), that message dated after the item opened, the model sure, and no hedge or
 * breakage in the quote. For a state (tracking is set up), the newest word wins: a later message saying it's broken
 * makes it moving. Otherwise it's at most "moving" (a real quote that hedges) or "nothing".
 */
export function guard(v: Verdict, evidence: readonly Evidence[], since: string, opts: { latestWins?: boolean } = {}): Verdict {
  if (v.state !== "done") return { ...v, state: v.state === "moving" ? "moving" : "nothing" };
  const quote = norm(v.quote);
  const ev = v.evidence != null ? evidence.find((e) => e.n === v.evidence) : null;
  const inText = ev ? norm(ev.text).includes(quote) : evidence.some((e) => norm(e.text).includes(quote));
  const after = ev ? Date.parse(ev.at) >= Date.parse(since) : false;
  if (!v.sure || quote.length < 8 || !inText || !after) return { ...v, state: quote && inText ? "moving" : "nothing" };
  if (HEDGE.test(apos(v.quote)) || BROKEN.test(v.quote)) return { ...v, state: "moving" };
  if (opts.latestWins && ev && evidence.some((e) => Date.parse(e.at) > Date.parse(ev.at) && BROKEN.test(e.text))) return { ...v, state: "moving" };
  return v;
}

/**
 * Items never closed automatically, whatever the evidence (owner, Nov 24 2026): a decision only a person makes (pricing,
 * fees, scope, hiring, churn), an approval or sign-off, a contract. At most they show as moving.
 */
const NEVER_AUTO = /\b(decid\w*|decision|approv\w*|sign[- ]?off|pricing|price|fees?|retainer|scope|contract|hir(e|ing)|churn\w*|renew\w*|negotiat\w*|refund|discount)\b/i;
export const mayAutoClose = (title: string) => !NEVER_AUTO.test(title);

/** Kinds that are a state (true until something says otherwise): the latest word wins and the whole history counts */
export const STATE_KINDS = new Set(["notrack", "dog"]);

const SOURCE_WORD: Record<string, string> = { slack_internal: "Slack", slack_external: "Slack", gmail: "email", call: "call notes", drive: "notes" };
export const sourceWord = (s: string) => SOURCE_WORD[s] ?? s;

/** "Closed automatically: "tracking's verified" (Slack, Nov 18)" */
export function closedNote(quote: string, source: string, at: string): string {
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  // A people matter is never quoted where the team can see it (owner, Nov 24 2026)
  const q = isPeopleMatter(quote) ? "confirmed in the messages" : quote.replace(/\s+/g, " ").trim();
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
