// The email lines that rank several conversion metrics (Toast online orders first, reservations second...) and pace
// the month's revenue. Pure (no database, no browser), so the board, the score and the sync agree, and it's tested alone.
//   - the ranked list of metrics that count as the sale, and each rank's weight in the score's money checks
//   - the monthly revenue target: at least last month + 10%, a higher manual target wins
//   - the month's running revenue, day by day, for the scrubbable chart

/** One Klaviyo metric that counts as a sale, as kept on the connection (the integration tells same-named ones apart) */
export type ConversionMetric = { id: string; name: string; integration: string | null };

/** At most four ranked metrics: each extra one costs the sync a few more Reporting API calls */
export const MAX_CONVERSION_METRICS = 4;

export const RANK_LABEL = ["Primary", "Secondary", "Tertiary", "Fourth"] as const;

/** Each rank's share of the money checks, by how many metrics are picked (percent, adding up to 100) */
export const RANK_WEIGHTS: Record<number, readonly number[]> = { 1: [100], 2: [65, 35], 3: [55, 30, 15], 4: [50, 25, 15, 10] };

export const rankWeights = (n: number): readonly number[] => RANK_WEIGHTS[Math.max(1, Math.min(MAX_CONVERSION_METRICS, n))] ?? [100];

/**
 * The ranked list from the connection: the saved list when there is one, with the primary (conversion_metric_id, the
 * column everything older reads) always first; else the primary alone. Duplicates and blanks dropped, four at most.
 */
export function conversionMetricsOf(raw: unknown, primary: { id: string | null; name: string | null }): ConversionMetric[] {
  const list: ConversionMetric[] = [];
  const add = (m: { id?: unknown; name?: unknown; integration?: unknown }) => {
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id || list.some((x) => x.id === id)) return;
    list.push({ id, name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : "Conversion", integration: typeof m.integration === "string" && m.integration.trim() ? m.integration.trim() : null });
  };
  const saved = Array.isArray(raw) ? (raw as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : [];
  const savedPrimary = primary.id ? saved.find((m) => m.id === primary.id) : null;
  if (primary.id) add({ id: primary.id, name: primary.name ?? savedPrimary?.name ?? "Placed Order", integration: savedPrimary?.integration ?? null });
  for (const m of saved) add(m);
  return list.slice(0, MAX_CONVERSION_METRICS);
}

/**
 * Values blended by rank weight. `values` runs in rank order (primary first); a null (no data for that metric) is left
 * out and the weights of the rest are scaled to add up again. Null when none has data.
 */
export function blendByRank(values: (number | null)[]): number | null {
  const w = rankWeights(values.length);
  let sum = 0;
  let total = 0;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    sum += v * (w[i] ?? 0);
    total += w[i] ?? 0;
  });
  return total > 0 ? sum / total : null;
}

/** Each rank's weight once the metrics without data are left out (fractions adding up to 1, 0 for one with no data) */
export function effectiveWeights(has: boolean[]): number[] {
  const w = rankWeights(has.length);
  const total = has.reduce((t, h, i) => t + (h ? (w[i] ?? 0) : 0), 0);
  return has.map((h, i) => (h && total > 0 ? (w[i] ?? 0) / total : 0));
}

// ─── The monthly revenue target ────────────────────────────────────────────

/** Every month should beat the last: the automatic target is last month's attributed revenue plus this */
export const TARGET_GROWTH = 0.1;

export type RevenueTarget = {
  /** Last calendar month's attributed revenue (the primary metric), null when nothing was read for it */
  lastMonth: number | null;
  /** Last month + 10%, null without a last month to grow from */
  floor: number | null;
  /** The target typed on the board, if any */
  manual: number | null;
  /** What the month is paced against: the floor, or the manual target when it's higher */
  target: number | null;
  source: "floor" | "manual" | null;
};

/**
 * The month's revenue target: last month x 1.10, computed by itself. A target set by hand counts only when it's above
 * that floor, never below it. A client with no last month (just connected, nothing earned) has the manual one or none.
 */
export function revenueTarget(lastMonth: number | null | undefined, manual: number | null | undefined): RevenueTarget {
  const last = lastMonth != null && Number.isFinite(lastMonth) && lastMonth > 0 ? lastMonth : null;
  const floor = last == null ? null : Math.round(last * (1 + TARGET_GROWTH) * 100) / 100;
  const set = manual != null && Number.isFinite(manual) && manual > 0 ? manual : null;
  if (floor == null && set == null) return { lastMonth: last, floor: null, manual: null, target: null, source: null };
  if (set != null && (floor == null || set > floor)) return { lastMonth: last, floor, manual: set, target: set, source: "manual" };
  return { lastMonth: last, floor, manual: set, target: floor, source: "floor" };
}

// ─── The month's revenue, day by day (the chart) ───────────────────────────

export type PaceHealth = "ok" | "warn" | "bad" | "none";

export type RevenuePoint = {
  date: string;
  /** Day of the month, 1 based */
  day: number;
  /** That day's attributed revenue; null for days still to come */
  value: number | null;
  /** Running total through this day; null for days still to come */
  cum: number | null;
  /** Last month's running total by the same day of the month (null past its last day or with no last month) */
  prevCum: number | null;
  /** Where an even month lands the target by the end of this day */
  pace: number | null;
  /** Where the month stands by this day at the current pace (days still to come) */
  projected: number | null;
  health: PaceHealth;
};

export type MonthRevenue = {
  points: RevenuePoint[];
  /** Index of today in points */
  today: number;
  mtd: number;
  projected: number | null;
  target: number | null;
  /** Projected month end over the target */
  ratio: number | null;
  health: PaceHealth;
};

/** The first days of a month are too thin to colour red */
const EARLY = 3;

/** How a running total sits against the even pace: at or past it green, within 15% amber, further under red */
export function paceHealth(cum: number, pace: number | null, day: number): PaceHealth {
  if (pace == null || pace <= 0) return "none";
  const r = cum / pace;
  if (r >= 1) return "ok";
  if (day <= EARLY) return "none";
  return r >= 0.85 ? "warn" : "bad";
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The month so far, one point per calendar day (the days still to come carry the target's pace and the projection), with
 * last month's running total by the same day as a ghost to beat. Today counts as half a day for the projection, as the
 * board's pace does.
 */
export function monthRevenue(input: {
  days: { date: string; value: number }[];
  prevDays: { date: string; value: number }[];
  month: { today: string; start: string; dayOfMonth: number; daysInMonth: number; prevStart: string; prevEnd: string };
  target: number | null;
}): MonthRevenue {
  const { month, target } = input;
  const by = new Map<string, number>();
  for (const d of input.days) by.set(d.date, (by.get(d.date) ?? 0) + d.value);
  const prevBy = new Map<string, number>();
  for (const d of input.prevDays) prevBy.set(d.date, (prevBy.get(d.date) ?? 0) + d.value);
  // Last month's running total by day of the month
  const prevCums: number[] = [];
  if (input.prevDays.length) {
    let s = 0;
    for (let d = month.prevStart; d <= month.prevEnd; d = nextDay(d)) {
      s += prevBy.get(d) ?? 0;
      prevCums.push(s);
    }
  }
  const elapsed = Math.max(0.5, month.dayOfMonth - 0.5);
  const points: RevenuePoint[] = [];
  let cum = 0;
  let date = month.start;
  for (let day = 1; day <= month.daysInMonth; day++, date = nextDay(date)) {
    const past = day <= month.dayOfMonth;
    const pace = target != null && target > 0 ? (target * day) / month.daysInMonth : null;
    const value = past ? (by.get(date) ?? 0) : null;
    if (past) cum += value ?? 0;
    points.push({
      date,
      day,
      value,
      cum: past ? Math.round(cum * 100) / 100 : null,
      prevCum: prevCums.length ? (prevCums[day - 1] ?? null) : null,
      pace,
      projected: past ? null : (cum / elapsed) * day,
      health: past ? paceHealth(cum, pace, day) : "none",
    });
  }
  const projected = month.dayOfMonth >= 1 ? (cum / elapsed) * month.daysInMonth : null;
  const ratio = target != null && target > 0 && projected != null ? projected / target : null;
  // The month's colour: already at the target is green; otherwise where it lands (not judged in the first days)
  const health: PaceHealth = target == null || target <= 0 ? "none" : cum >= target || (ratio != null && ratio >= 1) ? "ok" : month.dayOfMonth <= EARLY ? "none" : ratio != null && ratio >= 0.85 ? "warn" : "bad";
  return { points, today: Math.max(0, Math.min(points.length - 1, month.dayOfMonth - 1)), mtd: Math.round(cum * 100) / 100, projected, target, ratio, health };
}
