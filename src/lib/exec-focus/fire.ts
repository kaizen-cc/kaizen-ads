import { soundsLikeChurn } from "@/lib/client-risk";

// "This client is on fire": the few things every exec hears about, whatever their focus. Kept conservative on purpose,
// so the alert still means something: a client saying they're leaving or furious, billed for a line that's gone idle,
// an account spending with tracking broken or spend stopped on a big account, the main KPI far off for a week on a
// top-spend or at-risk client, a missed launch or deadline the client escalated. Each one is critical, says in one line
// why, and goes out once per client per day. Pure: no database.

/** A big account: this much spend in the last 30 days */
export const BIG_ACCOUNT_30D = 10_000;
/** Tracking looks broken: this much spent in 7 days with nothing tracked */
export const TRACKING_SPEND_7D = 1_000;
/** The main KPI this much worse than target over the last 7 days */
export const KPI_FIRE_DEVIATION = 0.5;
export const KPI_FIRE_DAYS = 7;

export type FireSignal =
  /** What a client said (an unanswered message, a change of direction, a call) */
  | { kind: "client_message"; text: string; fromClient: boolean }
  /** A teammate flagged the client as probably leaving */
  | { kind: "risk_flag"; note?: string | null }
  /** An account watch finding */
  | { kind: "watch"; watchKind: string; severity: string; billed?: boolean; spend30?: number; line?: string | null }
  /** An ad account's last 7 days */
  | { kind: "tracking"; spend7: number; results7: number; tracksConversions: boolean }
  /** The main KPI against target */
  | { kind: "kpi"; deviation: number; days: number; topSpend: boolean; atRisk: boolean };

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

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const LINE_WORD: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", "facebook-ads": "Meta", "google-ads": "Google", "tiktok-ads": "TikTok", creative: "creative", "email-marketing": "email", email: "email", "social-media": "social", social: "social" };

/** Whether a signal means the client is on fire, and why in a few words */
export function fireOf(s: FireSignal): Fire {
  switch (s.kind) {
    case "client_message": {
      if (!s.fromClient) return NOT;
      const why = messageFire(s.text);
      return why ? { fire: true, why } : NOT;
    }
    case "risk_flag":
      return { fire: true, why: "flagged as probably leaving" };
    case "watch": {
      const w = LINE_WORD[s.line ?? ""] ?? "a service";
      if (s.watchKind === "idle" && s.billed && s.severity === "critical") return { fire: true, why: `billed for ${w} with nothing running` };
      if (s.watchKind === "spend_stopped" && (s.spend30 ?? 0) >= BIG_ACCOUNT_30D) return { fire: true, why: `${w} spend stopped on a ${money(s.spend30 ?? 0)}/month account` };
      return NOT;
    }
    case "tracking":
      return s.tracksConversions && s.spend7 >= TRACKING_SPEND_7D && s.results7 === 0 ? { fire: true, why: `${money(s.spend7)} spent in 7 days with no conversions tracked` } : NOT;
    case "kpi":
      return s.deviation >= KPI_FIRE_DEVIATION && s.days >= KPI_FIRE_DAYS && (s.topSpend || s.atRisk) ? { fire: true, why: `main KPI ${Math.round(s.deviation * 100)}% off target for ${s.days}+ days${s.atRisk ? " on an at-risk client" : " on a top-spend account"}` } : NOT;
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
