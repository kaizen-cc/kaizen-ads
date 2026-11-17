// The email account score (0 to 100): how healthy a client's Klaviyo account is, from the seven checks Kaizen's email
// team runs plus the month's revenue pace. Email has no single KPI like ads (too many moving parts), so the score is what colours an account, orders
// the team's day and shows what is weighing it down. Pure, so the board, the Overview, the reports, the audits and the
// AI all score an account the same way. Window: the last 30 days (flows come as Klaviyo's 30-day numbers).
//
// Each check has a bar and a weight. Money weighs most. A check at or over its bar gets all its points; under it, its
// share of the bar (27% attributed against a 30% bar earns 90% of its points), so the score moves smoothly.
//
// Revenue pace (where the month's attributed revenue lands at this pace, against the month's target: last month +10%, or
// a higher one typed on the board) is worth a quarter of the score, so an account with strong rates but far behind on
// revenue can't sit at 100. Its credit is steeper: on pace earns it all, half the pace or less earns nothing. It's left
// out (the rest scaled up, exactly as before it existed) with no target or in the first days of the month. The other
// seven keep their old proportions (20/20/15/11/11/11/12 scaled to 75).

export type EmailCheckKey = "pace" | "attributed" | "rpr" | "deliverability" | "campaignOpen" | "campaignClick" | "flowOpen" | "flowClick";

export const EMAIL_CHECKS: readonly { key: EmailCheckKey; label: string; bar: number; weight: number; unit: "pct" | "money" | "score" }[] = [
  { key: "pace", label: "Revenue pace", bar: 1, weight: 25, unit: "pct" },
  { key: "attributed", label: "Attributed revenue", bar: 0.3, weight: 15, unit: "pct" },
  { key: "rpr", label: "Revenue per recipient", bar: 0.15, weight: 15, unit: "money" },
  { key: "deliverability", label: "Deliverability", bar: 65, weight: 11.25, unit: "score" },
  { key: "campaignOpen", label: "Campaign open rate", bar: 0.3, weight: 8.25, unit: "pct" },
  { key: "campaignClick", label: "Campaign click rate", bar: 0.01, weight: 8.25, unit: "pct" },
  { key: "flowOpen", label: "Flow open rate", bar: 0.35, weight: 8.25, unit: "pct" },
  { key: "flowClick", label: "Flow click rate", bar: 0.015, weight: 9, unit: "pct" },
];

/** Revenue pace earns nothing at half the pace or less, all of it on pace, in a straight line between */
const PACE_FLOOR = 0.5;

/** Green from 80, yellow from 60, red under 60 */
export type EmailBand = "good" | "watch" | "bad";
export const emailBand = (score: number): EmailBand => (score >= 80 ? "good" : score >= 60 ? "watch" : "bad");

/** The last 30 days of an account, as rates and totals (null where Klaviyo gave nothing to measure) */
export type EmailInputs = {
  /** Where the month lands at this pace over its target (1 = on pace); null with no target or too early in the month */
  pace?: number | null;
  /** Klaviyo-attributed revenue / the store's revenue */
  attributed: number | null;
  /** Attributed revenue / recipients (campaigns and flows) */
  rpr: number | null;
  /** private deliverability 0 to 100 (see deliverabilityScore) */
  deliverability: number | null;
  campaignOpen: number | null;
  campaignClick: number | null;
  flowOpen: number | null;
  flowClick: number | null;
};

export type EmailCheck = { key: EmailCheckKey; label: string; value: number | null; bar: number; weight: number; points: number; met: boolean; unit: "pct" | "money" | "score" };
export type EmailScore = { score: number; band: EmailBand; checks: EmailCheck[]; /** The checks costing the most points, worst first */ weighingDown: EmailCheck[]; /** Checks with nothing to measure (left out, the rest scaled up to 100) */ unmeasured: EmailCheckKey[] };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The score. A check with nothing to measure (no store revenue synced, no campaigns sent) is left out and the others are
 * scaled to 100, so a flows-only account isn't punished for having no campaigns; it's listed as unmeasured.
 */
export function emailScore(i: EmailInputs): EmailScore {
  const checks: EmailCheck[] = EMAIL_CHECKS.map((c) => {
    const value = i[c.key] ?? null;
    const share = value === null || !Number.isFinite(value) ? null : c.key === "pace" ? clamp01((value - PACE_FLOOR) / (c.bar - PACE_FLOOR)) : clamp01(value / c.bar);
    return { key: c.key, label: c.label, value: value ?? null, bar: c.bar, weight: c.weight, unit: c.unit, points: share === null ? 0 : share * c.weight, met: value !== null && value >= c.bar };
  });
  const measured = checks.filter((c) => c.value !== null);
  const possible = measured.reduce((n, c) => n + c.weight, 0);
  const got = measured.reduce((n, c) => n + c.points, 0);
  const score = possible ? Math.round((got / possible) * 100) : 0;
  const weighingDown = measured.filter((c) => !c.met).sort((a, b) => b.weight - b.points - (a.weight - a.points));
  return { score, band: emailBand(score), checks, weighingDown, unmeasured: checks.filter((c) => c.value === null).map((c) => c.key) };
}

/** A deliverability grade, as Klaviyo shows it beside each of its five metrics */
export type DeliverabilityGrade = "excellent" | "good" | "fair" | "poor";
const GRADE_POINTS: Record<DeliverabilityGrade, number> = { excellent: 20, good: 16, fair: 8, poor: 0 };

/**
 * Each metric's lines, matched to Klaviyo's deliverability score: "good" is Klaviyo's recommended line (open above 33%,
 * click above 1.2%, bounce under 1%, unsubscribe under 0.3%, spam under 0.01%); excellent is well past it, fair a little
 * short, poor well short. higher: a bigger rate is better.
 */
export const DELIVERABILITY_LINES: readonly { key: "open" | "click" | "bounce" | "unsubscribe" | "spam"; label: string; higher: boolean; excellent: number; good: number; fair: number }[] = [
  { key: "open", label: "Open rate", higher: true, excellent: 0.4, good: 0.33, fair: 0.25 },
  { key: "click", label: "Click rate", higher: true, excellent: 0.02, good: 0.012, fair: 0.008 },
  { key: "bounce", label: "Bounce rate", higher: false, excellent: 0.005, good: 0.01, fair: 0.02 },
  { key: "unsubscribe", label: "Unsubscribe rate", higher: false, excellent: 0.002, good: 0.003, fair: 0.005 },
  { key: "spam", label: "Spam complaint rate", higher: false, excellent: 0.00005, good: 0.0001, fair: 0.0005 },
];

export function deliverabilityGrade(line: (typeof DELIVERABILITY_LINES)[number], rate: number): DeliverabilityGrade {
  const at = (bar: number) => (line.higher ? rate >= bar : rate <= bar);
  return at(line.excellent) ? "excellent" : at(line.good) ? "good" : at(line.fair) ? "fair" : "poor";
}

/**
 * The deliverability score (0 to 100), built the way Klaviyo builds its own (which its API doesn't share): its five
 * metrics over the last 30 days of email sends, each graded against Klaviyo's recommended line and worth 20 points
 * (excellent 20, good 16, fair 8, poor 0). An account with an excellent open rate and bounce rate, a good click rate and
 * unsubscribe rate and a fair spam rate scores 80, as Klaviyo shows. Null when nothing was sent.
 */
export function deliverabilityScore(s: { recipients: number; delivered: number; bounced: number; spam: number; unsubscribes: number; opens: number; clicks?: number | null }): { score: number; parts: { label: string; rate: number; points: number; of: number; grade: DeliverabilityGrade }[] } | null {
  if (!(s.recipients > 0) || !(s.delivered > 0)) return null;
  const rates: Record<(typeof DELIVERABILITY_LINES)[number]["key"], number | null> = {
    open: s.opens / s.delivered,
    click: s.clicks == null ? null : s.clicks / s.delivered,
    bounce: s.bounced / s.recipients,
    unsubscribe: s.unsubscribes / s.delivered,
    spam: s.spam / s.delivered,
  };
  const parts = DELIVERABILITY_LINES.filter((l) => rates[l.key] != null).map((l) => {
    const rate = rates[l.key]!;
    const grade = deliverabilityGrade(l, rate);
    return { label: l.label, rate, points: GRADE_POINTS[grade], of: 20, grade };
  });
  const of = parts.reduce((n, p) => n + p.of, 0);
  return { score: Math.round((parts.reduce((n, p) => n + p.points, 0) / of) * 100), parts };
}
