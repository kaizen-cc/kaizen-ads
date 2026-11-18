/**
 * Google's conversion value (the revenue Google attributes), and when it can be trusted as revenue.
 *
 * Google always sends a `conversions_value`, but an account whose purchase conversion doesn't pass the order value
 * reports a default of 1 per conversion (value == the count: 6331 conversions, 6331 value) or a token amount (a lead
 * account: 617 conversions, 27 value). Dividing that by spend gives a ROAS that looks real and isn't. This is the one
 * place that decides, so every reader (KPI cards, the assistant, reports) says the same thing.
 */

/** Real revenue per conversion is at least this many dollars; below it the value is a default or a placeholder. */
export const MIN_REAL_VALUE_PER_CONVERSION = 2;

/** What to say when value isn't real: a tracking fix, never a ROAS. */
export const VALUE_NOT_TRACKED = "conversion value not tracked (likely a tracking fix: the purchase conversion isn't passing order value)";

export type ConversionValue = {
  /** Value looks like real revenue */
  tracked: boolean;
  /** The revenue to show: the value when tracked, otherwise null */
  revenue: number | null;
  /** Value over spend, only when tracked and there is spend */
  roas: number | null;
  /** Value per conversion (informational, even when not trusted) */
  perConversion: number | null;
  /** One plain sentence for people and agents */
  note: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Whether `value` over `conversions` looks like real order value (not a default of 1 per conversion, nor a token amount). */
export function valueLooksReal(conversions: number, value: number): boolean {
  if (!(conversions > 0) || !(value > 0)) return false;
  return value / conversions >= MIN_REAL_VALUE_PER_CONVERSION;
}

/** Conversion value and ROAS for some spend, conversions and value, with ROAS only when the value is real. */
export function conversionValue(i: { spend: number; conversions: number; value: number | null | undefined }): ConversionValue {
  const conversions = Number(i.conversions) || 0;
  const value = Number(i.value) || 0;
  const spend = Number(i.spend) || 0;
  const perConversion = conversions > 0 ? r2(value / conversions) : null;
  if (!conversions) return { tracked: false, revenue: null, roas: null, perConversion, note: "no conversions in this period, so no conversion value" };
  if (!valueLooksReal(conversions, value)) return { tracked: false, revenue: null, roas: null, perConversion, note: VALUE_NOT_TRACKED };
  const roas = spend > 0 ? r2(value / spend) : null;
  return { tracked: true, revenue: r2(value), roas, perConversion, note: `${money(value)} conversion value${roas != null ? `, ${roas.toFixed(2)}x ROAS` : ""}` };
}

export type ActionValue = { action: string; conversions: number; value: number; valuePerConversion: number | null; carriesValue: boolean };

/**
 * Conversions and value per conversion action (the `action:<name>` keys the Google sync stores), biggest value first,
 * so a purchase action that carries order value can be told from lead actions that carry none.
 */
export function actionBreakdown(rows: { actions?: Record<string, number> | null; action_values?: Record<string, number> | null }[]): ActionValue[] {
  const by = new Map<string, { c: number; v: number }>();
  const slot = (name: string) => by.get(name) ?? by.set(name, { c: 0, v: 0 }).get(name)!;
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.actions ?? {})) if (k.startsWith("action:")) slot(k.slice(7)).c += Number(n) || 0;
    for (const [k, n] of Object.entries(r.action_values ?? {})) if (k.startsWith("action:")) slot(k.slice(7)).v += Number(n) || 0;
  }
  return [...by.entries()]
    .map(([action, e]) => ({ action, conversions: r2(e.c), value: r2(e.v), valuePerConversion: e.c > 0 ? r2(e.v / e.c) : null, carriesValue: valueLooksReal(e.c, e.v) }))
    .sort((a, b) => b.value - a.value || b.conversions - a.conversions);
}

/** The line the assistant and agents read for one window of a Google KPI (null when revenue wasn't stored yet). */
export function valueLine(label: string, a: { spend: number; results: number; revenue?: number } | undefined): string | null {
  if (!a || a.revenue == null) return null;
  return `${label}: ${conversionValue({ spend: a.spend, conversions: a.results, value: a.revenue }).note}`;
}
