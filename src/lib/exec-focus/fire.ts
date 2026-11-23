import { soundsLikeChurn } from "@/lib/client-risk";

// "This client is on fire": the only things every exec hears about at once, skipping the ladder, whatever their focus.
// The owner's list, exactly (Nov 23 2026), and nothing else is a fire:
//   1. the client says they're leaving or cancelling
//   2. an ad account disabled, spend stopped, or a payment failed
//   3. an angry client message unanswered for more than one business day
//   4. an account severely off target for 2+ weeks with nothing in motion (no sprint, audit or plan moving)
// Each one says in one line why, and goes out once per client per day. Pure: no database.

/** A big account: this much spend in the last 30 days */
export const BIG_ACCOUNT_30D = 10_000;
/** Kept for older readers: tracking is no longer a fire on its own */
export const TRACKING_SPEND_7D = 1_000;
/** The main KPI this much worse than target... */
export const KPI_FIRE_DEVIATION = 0.5;
/** ...for this long */
export const KPI_FIRE_DAYS = 14;
/** One business day, in business hours (weekdays 8am to 6pm New York) */
export const ANGRY_BUSINESS_HOURS = 10;
/** Spend stopped only counts on an account that was really spending (a day's average before it stopped) */
export const STOPPED_MIN_DAILY = 30;

export type FireSignal =
  /** What a client said (an unanswered message, a change of direction, a call): leaving or cancelling is a fire at once */
  | { kind: "client_message"; text: string; fromClient: boolean }
  /** A note that the client said they may leave (src/lib/client-risk.ts, written from what the client said) */
  | { kind: "risk_flag"; note?: string | null }
  /** An angry client message nobody has answered: a fire after one business day */
  | { kind: "angry_unanswered"; text: string; businessHours: number }
  /** An account watch finding: disabled, payment failed, spend stopped */
  | { kind: "watch"; watchKind: string; severity: string; billed?: boolean; spend30?: number; dailyAverage?: number; accountStatus?: number | null; line?: string | null }
  /** Kept for older callers: never a fire on its own now */
  | { kind: "tracking"; spend7: number; results7: number; tracksConversions: boolean }
  /** The main KPI against target, and whether anything is in motion on the account */
  | { kind: "kpi"; deviation: number; days: number; inMotion?: boolean; topSpend?: boolean; atRisk?: boolean };

export type Fire = { fire: true; why: string } | { fire: false };

const NOT: Fire = { fire: false };

/** Furious, beyond a normal complaint */
const FURIOUS = /\b(furious|livid|unacceptable|completely unacceptable|outraged|extremely (?:disappointed|frustrated|upset)|beyond frustrated|fed up|this is ridiculous|waste of (?:our )?money|want (?:a|our money|a full) refund|demand(?:ing)? a refund|speak to (?:your|the) (?:boss|ceo|owner|manager)|lawyer|legal action|chargeback)\b/i;
/** A deadline or launch we missed */
const MISSED = /\b(missed (?:the |our )?(?:deadline|launch|date)|(?:still|been) waiting (?:on|for)|past due|was supposed to (?:launch|go live|be live|be done)|never (?:launched|went live)|you promised|we were promised|where (?:is|are) (?:the|our) (?:ads|creative|campaign|emails?))\b/i;
/** ...and the client escalating it */
const ESCALATED = /\b(unacceptable|escalat\w*|frustrat\w*|disappoint\w*|again\b|third time|second time|urgent(?:ly)?|asap|immediately|not ok(?:ay)?|seriously)\b/i;

/** What a client said, read for fire: leaving, furious, or a missed deadline they escalated (null when it isn't) */
export function messageFire(text: string | null | undefined): string | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (soundsLikeChurn(t)) return "said they may cancel or leave";
  if (FURIOUS.test(t)) return "is furious with us";
  if (MISSED.test(t) && ESCALATED.test(t)) return "escalated a missed launch or deadline";
  return null;
}

/** An angry message (furious, or an escalated miss), not a cancellation */
export const isAngry = (text: string | null | undefined) => {
  const why = messageFire(text);
  return Boolean(why && why !== "said they may cancel or leave");
};

/** Meta account_status for disabled, closing or closed */
const DEAD_ACCOUNT = new Set([2, 100, 101]);

const LINE_WORD: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", "facebook-ads": "Meta", "google-ads": "Google", "tiktok-ads": "TikTok", creative: "creative", "email-marketing": "email", email: "email", "social-media": "social", social: "social" };

/** Whether a signal means the client is on fire, and why in a few words (only the owner's four) */
export function fireOf(s: FireSignal): Fire {
  switch (s.kind) {
    case "client_message": {
      if (!s.fromClient) return NOT;
      return soundsLikeChurn(s.text) ? { fire: true, why: "said they may cancel or leave" } : NOT;
    }
    case "risk_flag":
      return { fire: true, why: "said they may cancel or leave" };
    case "angry_unanswered":
      return isAngry(s.text) && s.businessHours >= ANGRY_BUSINESS_HOURS ? { fire: true, why: `angry message unanswered for ${Math.max(1, Math.floor(s.businessHours / 10))}+ business ${s.businessHours >= 20 ? "days" : "day"}` } : NOT;
    case "watch": {
      const w = LINE_WORD[s.line ?? ""] ?? "the";
      if (s.watchKind === "payment_issue") return { fire: true, why: `${w} ad account payment failed` };
      if (s.watchKind === "delivery_issue" && s.accountStatus != null && DEAD_ACCOUNT.has(Number(s.accountStatus))) return { fire: true, why: `${w} ad account disabled` };
      if (s.watchKind === "spend_stopped" && (s.dailyAverage ?? (s.spend30 ?? 0) / 30) >= STOPPED_MIN_DAILY) return { fire: true, why: `${w} spend stopped` };
      return NOT;
    }
    case "tracking":
      return NOT;
    case "kpi":
      return s.deviation >= KPI_FIRE_DEVIATION && s.days >= KPI_FIRE_DAYS && !s.inMotion ? { fire: true, why: `main KPI ${Math.round(s.deviation * 100)}% off target for ${s.days}+ days with nothing in motion` } : NOT;
  }
}

/** The alert's title: the client and why, in one line */
export const fireTitle = (client: string, why: string) => `${client} is on fire: ${why}`.replace(/\s*\u2014\s*/g, ", ").slice(0, 200);

/** Once per client per day (New York): every fire alert for a client that day shares this key */
export const fireKey = (clientId: string, now = new Date()) => `fire:${clientId}:${now.toLocaleDateString("en-CA", { timeZone: "America/New_York" })}`;

/**
 * How far worse than target a KPI is (0.5 = 50% worse). Cost KPIs (CPA, CPL) are worse when higher, ROAS when lower.
 * Null when there's nothing to compare.
 */
export function kpiWorse(o: { value: number | null | undefined; target: number | null | undefined; roas: boolean; results?: number | null }): number | null {
  const t = Number(o.target);
  if (!Number.isFinite(t) || t <= 0) return null;
  if (o.roas) {
    const v = Number(o.value ?? 0);
    return Math.max(0, (t - v) / t);
  }
  if (o.results === 0) return 1;
  const v = Number(o.value);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(0, (v - t) / t);
}

/** The top-spend accounts: the top fifth by 30-day spend, and anything at or over the big-account line */
export function topSpenders(spend: ReadonlyMap<string, number>): Set<string> {
  const sorted = [...spend.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, Math.ceil(sorted.length / 5));
  return new Set([...sorted.slice(0, n).map(([k]) => k), ...sorted.filter(([, v]) => v >= BIG_ACCOUNT_30D).map(([k]) => k)]);
}
