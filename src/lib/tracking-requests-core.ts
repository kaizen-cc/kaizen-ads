// Requests for the Tracking Specialist, found in what the team and clients say (Slack, Gmail, Asana, call notes): a
// landing page, a tracking setup or a fix. Each becomes a task for them on its own (the owner's brief, Nov 20 2026).
// The pure part, tested in tests/tracking-requests.test.ts.
//
// Precision over recall (Nov 25 2026 safety check: a weekly Google report became "Fix tracking", a creative-shoot note
// and a BFCM note became "Tracking setup", a "we're behind" email was filed under two clients): the thing and the ask
// have to be in the same sentence, "tracking" on its own isn't enough, and reports, recaps and updates never count.

// What's tracked or built: specific words only ("tracking" alone is how people say "on track")
const TOPIC = /\b(landing ?pages?(?! views?)|pixel|conversions? api|capi\b|gtm\b|google tag manager|tag manager|ga4\b|google analytics|utm(?: parameters?| tags?| links?)?|purchase event|conversion (?:event|action|tracking)s?|event match(?:ing)?|thank[- ]you page|checkout tracking|server[- ]side (?:tagging|tracking)|enhanced conversions?|tracking (?:code|tag|script|setup|set up|link|is (?:broken|off|wrong|down)|isn'?t working|issue|problem)|(?:meta|facebook|google|tiktok) tag)\b/i;

// Asked of us: a request, or something broken, in that sentence
const ASK = /\b(can (?:you|we|someone)|could (?:you|we|someone)|would you|please|pls|need(?:s|ed)? (?:to (?:set up|fix|add|install|implement|put|place|build|check|create|update)|a new|an? |the)|set ?up|install|implement|not (?:firing|working|tracking|recording|showing up)|isn'?t (?:firing|working|tracking|recording)|stopped (?:firing|tracking|working|recording)|broken|is wrong|double[- ]count\w*)\b/i;

// Never a request for the Tracking Specialist: a report, a recap, an update, a status note
const NOT_ASK = /\b(weekly report|monthly report|recap|weekly (?:performance|update)|here'?s (?:your|the|this week'?s|this month'?s)\b[^.!?\n]{0,40}\b(?:report|recap|update|breakdown|results)|quick update|status update|performance (?:report|update|summary)|results (?:for|from) (?:last|this) (?:week|month)|reporting period|week over week|month over month|creative shoot|shoot (?:day|schedule)|we'?re (?:behind|running behind)|update on (?:your|the|our) (?:points|questions|notes)|ready for your (?:final )?(?:preview|review|approval))\b/i;

const sentences = (t: string) =>
  t
    .replace(/<[^>]+>/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether a message is a request the Tracking Specialist should own: one sentence names the thing and asks for it */
export function isTrackingRequest(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (t.trim().length < 12) return false;
  if (NOT_ASK.test(t)) return false;
  // A long greeting-led message is an email or an update (ours or theirs), not a single ask: only its first lines count
  const lines = sentences(t);
  const look = /^(hi|hey|hello|good (?:morning|afternoon)|dear)\b/i.test(t.trim()) && t.length > 400 ? lines.slice(0, 3) : lines;
  return look.some((s) => s.length <= 400 && TOPIC.test(s) && ASK.test(s));
}

/** The sentence that asks (what the task is about) */
export function askingSentence(text: string): string {
  const s = sentences(text).find((x) => TOPIC.test(x) && ASK.test(x));
  return (s ?? text).replace(/\s+/g, " ").trim();
}

/** The task's title: what's asked, short ("Fix tracking: the Meta pixel isn't firing on checkout") */
export function trackingTaskTitle(text: string): string {
  const one = askingSentence(text);
  const kind = /\blanding ?page/i.test(one) ? "Landing page" : /\b(fix|broken|not (?:firing|working|tracking|recording)|isn'?t|stopped|is wrong|double[- ]count)/i.test(one) ? "Fix tracking" : "Tracking setup";
  const clip = one.length > 110 ? `${one.slice(0, 107).replace(/\s+\S*$/, "")}…` : one;
  return `${kind}: ${clip}`;
}

/**
 * Which client a request is for when the same message reached several (an email cc'd across accounts was filed under
 * two clients): the one it names, else none of them (the specialist sees it unassigned rather than under the wrong one).
 */
export function clientFor(text: string, candidates: readonly { id: string; name: string }[]): string | null {
  if (candidates.length <= 1) return candidates[0]?.id ?? null;
  const t = text.toLowerCase();
  const named = candidates.filter((c) => c.name.length >= 3 && t.includes(c.name.toLowerCase()));
  return named.length === 1 ? named[0].id : null;
}

/** The same words, however spaced: one request, however many places it was seen */
export const sameText = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);

export const SOURCE_LABEL: Record<string, string> = { slack_external: "the client's Slack channel", slack_internal: "Slack", gmail: "email", call: "a call or its Gemini meeting notes", asana: "Asana" };
