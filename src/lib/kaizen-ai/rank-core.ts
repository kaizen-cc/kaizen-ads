// Ranking clients on one line by one number (the rank_clients tool): which lines a person may rank, the metrics each
// line has, the period's dates, and the ranking itself. Plain helpers, tested on their own.

export type RankLine = "email" | "social" | "meta" | "google";
export type RankPeriod = "7" | "30" | "90" | "month";
export type RankOrder = "top" | "bottom";

export const RANK_METRICS: Record<RankLine, readonly string[]> = {
  email: ["score", "attributed_revenue", "revenue_pace", "revenue_per_recipient", "open_rate", "click_rate"],
  social: ["score", "engagement", "followers_gained"],
  meta: ["kpi_vs_target", "spend", "results", "roas"],
  google: ["kpi_vs_target", "spend", "results", "roas"],
};

/** The metric a line ranks by when none is named: its main KPI */
export const DEFAULT_METRIC: Record<RankLine, string> = { email: "score", social: "score", meta: "kpi_vs_target", google: "kpi_vs_target" };

export const MAX_RANK = 25;

type Who = { role: string | null | undefined; isExec?: boolean | null; isLead?: boolean | null };

/**
 * The lines this person may rank, the boards' own rule: executives and leads every line (the heads of email and social
 * their own line); the email and social teams their own line; everyone else on the ads side Meta and Google (a Meta
 * or Google buyer only their own platform's board).
 */
export function rankLinesFor(me: Who, channelLine: "email" | "social" | null, adsPlatform: "meta" | "google" | null): RankLine[] {
  if (me.isExec) return ["email", "social", "meta", "google"];
  if (channelLine) return [channelLine];
  if (me.isLead) return ["email", "social", "meta", "google"];
  if (adsPlatform) return [adsPlatform];
  return ["meta", "google"];
}

/** The days a period covers, through `today` (yyyy-mm-dd): the last 7, 30 or 90 days, or this month so far */
export function periodRange(period: RankPeriod, today: string): { from: string; to: string; label: string } {
  if (period === "month") return { from: `${today.slice(0, 8)}01`, to: today, label: "this month so far" };
  const n = Number(period);
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to: today, label: `the last ${n} days` };
}

export const asPeriod = (v: unknown): RankPeriod => (v === "7" || v === 7 ? "7" : v === "90" || v === 90 ? "90" : v === "month" ? "month" : "30");

/** A client's number for the ranking: value orders it (higher is better), shown is how it's said, why one line */
export type RankEntry = { client: string; value: number | null; shown: string; why: string };

/** The ranking: clients without a number left out (and counted), best first for top, worst first for bottom */
export function rankEntries(rows: readonly RankEntry[], order: RankOrder, limit: number): { ranked: (RankEntry & { rank: number })[]; without: number } {
  const n = Math.min(MAX_RANK, Math.max(1, Math.trunc(limit) || 3));
  const have = rows.filter((r) => r.value != null && Number.isFinite(r.value));
  have.sort((a, b) => (order === "top" ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)) || a.client.localeCompare(b.client));
  return { ranked: have.slice(0, n).map((r, i) => ({ ...r, rank: i + 1 })), without: rows.length - have.length };
}

/** A sum over day rows in a range (null when no day had the field) */
export function sumDays(days: readonly Record<string, unknown>[], field: string, from: string, to: string): number | null {
  let any = false;
  let s = 0;
  for (const d of days) {
    const day = String(d.date ?? "");
    if (day < from || day > to || d[field] == null) continue;
    any = true;
    s += Number(d[field]) || 0;
  }
  return any ? s : null;
}

/** "$12.4k", "$860" */
export function moneyWords(x: number, currency: string | null = "USD"): string {
  const sign = !currency || currency === "USD" ? "$" : `${currency} `;
  const a = Math.abs(x);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 10_000 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
  return `${x < 0 ? "-" : ""}${sign}${s}`;
}

export const pctWords = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/**
 * Against the KPI target as a number where higher is better: the 14 day deviation (positive = worse than target) turned
 * round, so 0.2 reads "20% better than target".
 */
export function vsTarget(deviation: number | null | undefined): { value: number | null; shown: string } {
  if (deviation == null || !Number.isFinite(deviation)) return { value: null, shown: "no target read" };
  const v = -deviation;
  const p = Math.round(Math.abs(v) * 100);
  return { value: v, shown: p === 0 ? "on target" : `${p}% ${v > 0 ? "better" : "worse"} than target` };
}
