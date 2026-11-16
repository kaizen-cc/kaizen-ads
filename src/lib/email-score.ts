// The email account score (0 to 100): how healthy a client's Klaviyo account is, from the seven checks Kaizen's email
// team runs. Email has no single KPI like ads (too many moving parts), so the score is what colours an account, orders
// the team's day and shows what is weighing it down. Pure, so the board, the Overview, the reports, the audits and the
// AI all score an account the same way. Window: the last 30 days (flows come as Klaviyo's 30-day numbers).
//
// Each check has a bar and a weight. Money weighs most. A check at or over its bar gets all its points; under it, its
// share of the bar (27% attributed against a 30% bar earns 90% of 20 points), so the score moves smoothly.

export type EmailCheckKey = "attributed" | "rpr" | "deliverability" | "campaignOpen" | "campaignClick" | "flowOpen" | "flowClick";

export const EMAIL_CHECKS: readonly { key: EmailCheckKey; label: string; bar: number; weight: number; unit: "pct" | "money" | "score" }[] = [
  { key: "attributed", label: "Attributed revenue", bar: 0.3, weight: 20, unit: "pct" },
  { key: "rpr", label: "Revenue per recipient", bar: 0.15, weight: 20, unit: "money" },
  { key: "deliverability", label: "Deliverability", bar: 65, weight: 15, unit: "score" },
  { key: "campaignOpen", label: "Campaign open rate", bar: 0.3, weight: 11, unit: "pct" },
  { key: "campaignClick", label: "Campaign click rate", bar: 0.01, weight: 11, unit: "pct" },
  { key: "flowOpen", label: "Flow open rate", bar: 0.35, weight: 11, unit: "pct" },
  { key: "flowClick", label: "Flow click rate", bar: 0.015, weight: 12, unit: "pct" },
];

/** Green from 80, yellow from 60, red under 60 */
export type EmailBand = "good" | "watch" | "bad";
export const emailBand = (score: number): EmailBand => (score >= 80 ? "good" : score >= 60 ? "watch" : "bad");

/** The last 30 days of an account, as rates and totals (null where Klaviyo gave nothing to measure) */
export type EmailInputs = {
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
    const value = i[c.key];
    const share = value === null || !Number.isFinite(value) ? null : clamp01(value / c.bar);
    return { key: c.key, label: c.label, value: value ?? null, bar: c.bar, weight: c.weight, unit: c.unit, points: share === null ? 0 : share * c.weight, met: value !== null && value >= c.bar };
  });
  const measured = checks.filter((c) => c.value !== null);
  const possible = measured.reduce((n, c) => n + c.weight, 0);
  const got = measured.reduce((n, c) => n + c.points, 0);
  const score = possible ? Math.round((got / possible) * 100) : 0;
  const weighingDown = measured.filter((c) => !c.met).sort((a, b) => b.weight - b.points - (a.weight - a.points));
  return { score, band: emailBand(score), checks, weighingDown, unmeasured: checks.filter((c) => c.value === null).map((c) => c.key) };
}

/**
 * Kaizen's own deliverability score (0 to 100): Klaviyo shows one in its dashboard but doesn't offer it through its
 * API, so it's built from the same signals, over the last 30 days of sends. Full marks at or under the healthy line,
 * nothing at or past the danger line, straight in between:
 *   bounce rate (bounced / recipients)      30 pts   healthy 0.5%   danger 3%
 *   spam complaints (spam / delivered)      30 pts   healthy 0.05%  danger 0.3%
 *   unsubscribe rate (unsubs / delivered)   20 pts   healthy 0.3%   danger 1.5%
 *   open rate (unique opens / delivered)    20 pts   healthy 35%    danger 10%
 * Null when nothing was sent.
 */
export function deliverabilityScore(s: { recipients: number; delivered: number; bounced: number; spam: number; unsubscribes: number; opens: number }): { score: number; parts: { label: string; rate: number; points: number; of: number }[] } | null {
  if (!(s.recipients > 0) || !(s.delivered > 0)) return null;
  const down = (rate: number, healthy: number, danger: number) => clamp01((danger - rate) / (danger - healthy));
  const up = (rate: number, healthy: number, danger: number) => clamp01((rate - danger) / (healthy - danger));
  const bounce = s.bounced / s.recipients;
  const spam = s.spam / s.delivered;
  const unsub = s.unsubscribes / s.delivered;
  const open = s.opens / s.delivered;
  const parts = [
    { label: "Bounce rate", rate: bounce, points: 30 * down(bounce, 0.005, 0.03), of: 30 },
    { label: "Spam complaints", rate: spam, points: 30 * down(spam, 0.0005, 0.003), of: 30 },
    { label: "Unsubscribe rate", rate: unsub, points: 20 * down(unsub, 0.003, 0.015), of: 20 },
    { label: "Open rate", rate: open, points: 20 * up(open, 0.35, 0.1), of: 20 },
  ];
  return { score: Math.round(parts.reduce((n, p) => n + p.points, 0)), parts };
}
