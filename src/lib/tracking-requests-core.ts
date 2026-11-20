// Requests for the Tracking Specialist, found in what the team and clients say (Slack, Gmail, Asana, call notes): a
// landing page, a tracking setup or a fix. Each becomes a task for them on its own (the owner's brief, Nov 20 2026).
// The pure part, tested in tests/tracking-requests.test.ts.

const TOPIC = /\b(landing ?pages?|lp\b|tracking|pixel|conversions? api|capi\b|gtm\b|tag manager|ga4\b|google analytics|utm|purchase event|conversion event|event match|thank[- ]you page|checkout tracking|server[- ]side tagging|enhanced conversions?)\b/i;
const ASK = /\b(can you|could you|please|pls|need(?:s|ed)? (?:to|a|an|the)|set ?up|fix|broken|not (?:firing|working|tracking|showing|recording)|isn'?t (?:firing|working|tracking)|stopped (?:firing|tracking|working)|missing|install|add|build|create|check)\b/i;

/** Whether a message is a request the Tracking Specialist should own: about tracking or a landing page, and asking for something */
export function isTrackingRequest(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (t.length < 12) return false;
  return TOPIC.test(t) && ASK.test(t);
}

/** The task's title: what's asked, short ("Fix: Meta pixel not firing on checkout") */
export function trackingTaskTitle(text: string): string {
  const one = text.replace(/\s+/g, " ").replace(/<[^>]+>/g, "").trim();
  const kind = /\blanding ?page|\blp\b/i.test(one) ? "Landing page" : /\bfix|broken|not (?:firing|working|tracking)|isn'?t|stopped|missing\b/i.test(one) ? "Fix tracking" : "Tracking setup";
  const clip = one.length > 110 ? `${one.slice(0, 107).replace(/\s+\S*$/, "")}…` : one;
  return `${kind}: ${clip}`;
}

export const SOURCE_LABEL: Record<string, string> = { slack_external: "the client's Slack channel", slack_internal: "Slack", gmail: "email", call: "a call", asana: "Asana" };
