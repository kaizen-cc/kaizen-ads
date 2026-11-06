import type { BudgetPeriod, BudgetSpec } from "./types";

// Turning a sheet's budget periods into what Meta takes. Sheets usually give a TOTAL per period ("$1,500 for Oct
// 5–11"), not a daily amount, so it's never copied in as is: the buyer picks how it maps, and the math is here.
//   per_period_daily    a daily budget per period (total ÷ its days), changed at each period's start (budget schedules)
//   lifetime_per_period one ad set (or campaign) per period, each with the period's total as its lifetime budget
//   single_lifetime     one lifetime budget for what's left of the whole flight (Meta paces it; the tiers aren't kept)
// Periods already over are left out; the one under way gets what's left of it (prorated by days, or all of it).

export type BudgetMode = "per_period_daily" | "lifetime_per_period" | "single_lifetime";
export type BudgetLine = { label: string; start: string; end: string; days: number; amount: number; daily: number };
export type BudgetMap = { mode: BudgetMode; lines: BudgetLine[]; total: number; skipped: string[]; notes: string[] };

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T12:00:00Z`);
export const daysBetween = (start: string, end: string) => Math.round((t(end) - t(start)) / DAY) + 1;
const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;
/** Down to the cent, so a period never spends more than its total */
const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

/**
 * The periods that still run from today, with each one's amount and daily budget. current: "prorate" gives the period
 * under way its share for the days left; "full" puts its whole total into the days left (when nothing of it was spent).
 */
export function mapBudget(periods: BudgetPeriod[], mode: BudgetMode, today: string, current: "prorate" | "full" = "prorate"): BudgetMap {
  const lines: BudgetLine[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const p of periods) {
    if (!p.start || !p.end || p.amount == null) {
      skipped.push(`${p.label}: no dates or amount`);
      continue;
    }
    if (p.end < today) {
      skipped.push(`${p.label}: already over`);
      continue;
    }
    const days = daysBetween(p.start, p.end);
    if (p.start >= today) {
      lines.push({ label: p.label, start: p.start, end: p.end, days, amount: cents(p.amount), daily: floorCents(p.amount / days) });
      continue;
    }
    const left = daysBetween(today, p.end);
    const amount = current === "prorate" ? cents((p.amount * left) / days) : cents(p.amount);
    lines.push({ label: `${p.label} (from today)`, start: today, end: p.end, days: left, amount, daily: floorCents(amount / left) });
    notes.push(current === "prorate" ? `${p.label} is under way: ${left} of its ${days} days are left, so it gets $${amount.toFixed(2)} of its $${p.amount.toFixed(2)}.` : `${p.label} is under way: its whole $${p.amount.toFixed(2)} goes into the ${left} days left.`);
  }
  // Gaps between periods mean days with no budget: say so
  for (let i = 1; i < lines.length; i++) if (lines[i].start > addDays(lines[i - 1].end, 1)) notes.push(`No budget between ${lines[i - 1].end} and ${lines[i].start}.`);
  const total = cents(lines.reduce((s, l) => s + l.amount, 0));
  if (mode === "single_lifetime" && lines.length > 1) notes.push("One lifetime budget: Meta paces the total across the flight itself, so the weekly tiers won't be followed exactly.");
  return { mode, lines, total, skipped, notes };
}

/** Is the sheet's own math consistent? (total vs spent vs the periods' sum), in plain words */
export function budgetSanity(total: number | null, spent: number | null, periods: BudgetPeriod[]): string[] {
  const out: string[] = [];
  const sum = cents(periods.reduce((s, p) => s + (p.amount ?? 0), 0));
  if (total != null && spent != null) {
    const left = cents(total - spent);
    if (Math.abs(left - sum) > 1) out.push(`The periods add up to $${sum.toFixed(2)}, but the total less what's spent is $${left.toFixed(2)} (a $${Math.abs(cents(left - sum)).toFixed(2)} difference).`);
  } else if (total != null && Math.abs(total - sum) > 1 && sum > 0) out.push(`The periods add up to $${sum.toFixed(2)}, not the $${total.toFixed(2)} total.`);
  return out;
}

/**
 * The budget as Meta takes it on one object (a campaign with Advantage campaign budget, or an ad set):
 * per_period_daily → a daily budget for the first period, and a budget schedule for each later period that raises it
 * by the difference (Meta's budget scheduling adds on top of the daily budget for a window). lifetime → the total.
 */
export function budgetSpec(map: BudgetMap): BudgetSpec | null {
  if (!map.lines.length) return null;
  if (map.mode === "single_lifetime") return { type: "lifetime", amount: map.total };
  if (map.mode === "lifetime_per_period") return { type: "lifetime", amount: map.lines[0].amount };
  const base = Math.min(...map.lines.map((l) => l.daily));
  const schedules = map.lines.filter((l) => l.daily > base).map((l) => ({ start: l.start, end: l.end, amount: cents(l.daily - base) }));
  return { type: "daily", amount: base, ...(schedules.length ? { schedules } : {}) };
}

/** What a daily budget with schedules spends over the flight (to check it against the sheet) */
export function specSpend(spec: BudgetSpec, start: string, end: string): number {
  if (spec.type === "lifetime") return spec.amount;
  const days = daysBetween(start, end);
  const extra = (spec.schedules ?? []).reduce((s, x) => s + x.amount * daysBetween(x.start, x.end), 0);
  return cents(spec.amount * days + extra);
}

/** Meta's money is in cents (the account's currency's minor unit) */
export const toMinor = (dollars: number) => String(Math.round(dollars * 100));
