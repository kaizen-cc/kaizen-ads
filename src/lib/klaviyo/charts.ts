import { BENCHMARKS, shiftDay, type DeliverabilityWeek } from "./insights";

// Numbers behind the Email tab's Overview charts. Pure, so they're tested without a browser.

type Band = { warn: number; bad: number };

/**
 * One rate's score, 0 to 100, against its healthy line (warn) and the line mailbox providers act on (bad):
 *   at or under warn           100
 *   warn to bad                100 down to 50, in a straight line
 *   bad to twice bad           50 down to 0, in a straight line
 *   twice bad or more          0
 */
export function rateScore(rate: number, band: Band): number {
  if (rate <= band.warn) return 100;
  if (rate <= band.bad) return 100 - 50 * ((rate - band.warn) / (band.bad - band.warn));
  return Math.max(0, 50 - 50 * ((rate - band.bad) / band.bad));
}

/** How much each rate counts: spam complaints hurt a sender's reputation most, then bounces and unsubscribes */
export const SCORE_WEIGHTS = { spam: 0.4, bounce: 0.3, unsubscribe: 0.3 } as const;

/** Score at or above this is healthy (all three rates inside their healthy lines, or one just touching its bad line) */
export const SCORE_HEALTHY = 90;
/** Under this, act: a rate is well past the line mailbox providers filter on */
export const SCORE_ACT = 70;

/**
 * A week's deliverability score, 0 to 100 (higher is better): the weighted average of the bounce, spam and unsubscribe
 * scores (rateScore), spam 40%, bounce 30%, unsubscribe 30%. A rate that wasn't measured is left out and the others
 * share its weight; with none measured there is no score (null).
 *   90 to 100  healthy
 *   70 to 90   watch
 *   under 70   act
 */
export function deliverabilityScore(rates: { bounce: number | null; spam: number | null; unsubscribe: number | null }): number | null {
  let sum = 0;
  let weight = 0;
  for (const k of ["spam", "bounce", "unsubscribe"] as const) {
    const r = rates[k];
    if (r == null) continue;
    sum += rateScore(r, BENCHMARKS[k]) * SCORE_WEIGHTS[k];
    weight += SCORE_WEIGHTS[k];
  }
  return weight ? Math.round(sum / weight) : null;
}

export type ScoreWeek = { week: string; score: number; bounceRate: number | null; spamRate: number | null; unsubscribeRate: number | null; campaigns: number };

/** The weekly deliverability rates as scores, oldest first; weeks with nothing measured are dropped */
export function scoreWeeks(weeks: DeliverabilityWeek[]): ScoreWeek[] {
  const out: ScoreWeek[] = [];
  for (const w of weeks) {
    const score = deliverabilityScore({ bounce: w.bounceRate, spam: w.spamRate, unsubscribe: w.unsubscribeRate });
    if (score != null) out.push({ week: w.week, score, bounceRate: w.bounceRate, spamRate: w.spamRate, unsubscribeRate: w.unsubscribeRate, campaigns: w.campaigns });
  }
  return out;
}

export type RprPoint = { date: string; rpr: number | null; revenue: number; recipients: number };

/**
 * Revenue per recipient by day, smoothed over the 7 days up to and including it (revenue / recipients of campaigns and
 * flows, summed over the window, so a quiet day doesn't jump to zero or a spike). Null while the window has no recipients.
 */
export function rprSeries(days: { date: string; revenue: number; recipients: number }[], window = 7): RprPoint[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((d) => {
    const from = shiftDay(d.date, -(window - 1));
    let revenue = 0;
    let recipients = 0;
    for (const x of sorted) {
      if (x.date >= from && x.date <= d.date) {
        revenue += x.revenue;
        recipients += x.recipients;
      }
    }
    return { date: d.date, rpr: recipients > 0 ? revenue / recipients : null, revenue, recipients };
  });
}
