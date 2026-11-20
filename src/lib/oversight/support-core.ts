// The support positions' dashboards, the pure part (no database): what the customer success coordinator and the
// onboarding specialist see on their Overview under Today (the tracking specialist's reads the tracking watchdogs).

const DAY = 86_400_000;

// ─── Customer success: response times and sentiment ────────────────────────

/** Median hours between a client's message and our reply (answered ones only); null with nothing answered */
export function medianReplyHours(rows: readonly { asked_at: string; answered_at: string | null }[]): number | null {
  const hrs = rows.filter((r) => r.answered_at).map((r) => (Date.parse(r.answered_at!) - Date.parse(r.asked_at)) / 3_600_000).filter((h) => Number.isFinite(h) && h >= 0).sort((a, b) => a - b);
  if (!hrs.length) return null;
  const m = Math.floor(hrs.length / 2);
  return hrs.length % 2 ? hrs[m] : (hrs[m - 1] + hrs[m]) / 2;
}

const POSITIVE = /\b(thank(?:s| you)|love|loving|great|amazing|awesome|perfect|excellent|happy|pleased|excited|fantastic|appreciate|well done|nice work|good job|impressed|wonderful|beautiful|brilliant)\b/gi;
const NEGATIVE = /\b(disappoint\w*|frustrat\w*|unhappy|upset|concern\w*|worr(?:y|ied)|not happy|terrible|awful|bad|poor|wrong|mistake|issue|problem|delay\w*|late|slow|still waiting|no response|haven'?t heard|ridiculous|unacceptable|refund|cancel\w*|confus\w*|annoy\w*|why (?:is|are|did|hasn'?t)|what happened|not working|broken)\b/gi;

/** A client message's tone, -1 to 1, from its words (a rough read: confidence "guessing") */
export function toneOf(text: string | null | undefined): number {
  const t = String(text ?? "");
  const pos = (t.match(POSITIVE) ?? []).length;
  const neg = (t.match(NEGATIVE) ?? []).length;
  if (!pos && !neg) return 0;
  return (pos - neg) / (pos + neg);
}

export type Sentiment = { now: number | null; before: number | null; trend: "up" | "down" | "flat" | null; messages: number };

/**
 * A client's sentiment: the average tone of their own messages in the last 14 days against the 14 before (only
 * messages with a tone count). Down by 0.3 or more is a slide.
 */
export function sentiment(msgs: readonly { at: string; text: string | null }[], now = Date.now()): Sentiment {
  const recent: number[] = [];
  const earlier: number[] = [];
  for (const m of msgs) {
    const t = toneOf(m.text);
    if (!t) continue;
    const age = now - Date.parse(m.at);
    if (age <= 14 * DAY) recent.push(t);
    else if (age <= 28 * DAY) earlier.push(t);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const a = avg(recent);
  const b = avg(earlier);
  const trend = a == null || b == null ? null : a - b <= -0.3 ? "down" : a - b >= 0.3 ? "up" : "flat";
  return { now: a, before: b, trend, messages: recent.length + earlier.length };
}

/** Low sentiment first, then a slide, then slow replies, then quiet */
export function csRank(r: { sentiment: Sentiment; replyHours: number | null; waiting: number; quietDays: number | null }) {
  let s = 0;
  if (r.sentiment.now != null && r.sentiment.now < 0) s += 50 + Math.round(-r.sentiment.now * 30);
  if (r.sentiment.trend === "down") s += 20;
  if (r.replyHours != null && r.replyHours > 24) s += Math.min(20, Math.round(r.replyHours / 12));
  s += Math.min(20, r.waiting * 5);
  if (r.quietDays == null || r.quietDays >= 5) s += 10;
  return s;
}

// ─── Onboarding: no delivery date until the intake is in ────────────────────

export type OnboardingState = { daysIn: number; intake: boolean; assets: boolean; access: boolean; checkInDays: number | null; blockers: string[]; stuck: boolean };

/**
 * Where a new client's onboarding stands: the intake form (no delivery date until it's in), brand assets, ad account
 * access, and the weekly check-in in their channel (7 days without one is missed). Stuck: any blocker after 5 days.
 */
export function onboardingState(i: { createdAt: string; today: string; intakeAt: string | null; assets: boolean; needsAccess: boolean; access: boolean; lastCheckIn: string | null }): OnboardingState {
  const day = (s: string) => Date.parse(`${s.slice(0, 10)}T12:00:00Z`);
  const daysIn = Math.max(0, Math.floor((day(i.today) - day(i.createdAt)) / DAY));
  const checkInDays = i.lastCheckIn ? Math.max(0, Math.floor((day(i.today) - day(i.lastCheckIn)) / DAY)) : null;
  const blockers: string[] = [];
  if (!i.intakeAt) blockers.push("No intake form: no delivery dates until it's in");
  if (!i.assets) blockers.push("No brand assets");
  if (i.needsAccess && !i.access) blockers.push("No ad account access");
  if (daysIn >= 7 && (checkInDays == null || checkInDays >= 7)) blockers.push(checkInDays == null ? "No check-in in their channel yet" : `No weekly check-in for ${checkInDays} days`);
  return { daysIn, intake: Boolean(i.intakeAt), assets: i.assets, access: !i.needsAccess || i.access, checkInDays, blockers, stuck: blockers.length > 0 && daysIn >= 5 };
}
