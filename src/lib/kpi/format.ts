import type { Status } from "./calc";

/** $1,234 · $45.10 · $0.34 */
export function money(x: number | null | undefined) {
  if (x == null) return "—";
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: x < 100 && x % 1 ? 2 : 0, maximumFractionDigits: x < 100 ? 2 : 0 })}`;
}

/** A KPI value: cost per result as money, ROAS as a multiple. */
export const kpiValue = (x: number | null | undefined, roas: boolean) => (x == null ? "—" : roas ? `${x.toFixed(2)}x` : money(x));

/** +16% / −20% */
export const pct = (x: number | null | undefined, digits = 0) =>
  x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(digits)}%`;

export const STATUS: Record<Status, { label: string; tone: string; dot: string; text: string }> = {
  excellent: { label: "Crushing it", tone: "bg-ok text-white", dot: "bg-ok", text: "text-ok" },
  good: { label: "On target", tone: "bg-ok-soft text-ok", dot: "bg-ok", text: "text-ok" },
  close: { label: "Close", tone: "bg-warn-soft text-warn", dot: "bg-warn", text: "text-warn" },
  off: { label: "Off target", tone: "bg-bad-soft text-bad", dot: "bg-bad", text: "text-bad" },
  idle: { label: "Not spending", tone: "bg-surface-2 text-faint", dot: "bg-faint/60", text: "text-faint" },
  setup: { label: "Needs setup", tone: "bg-surface-2 text-muted", dot: "border border-faint", text: "text-muted" },
};

/** Tone of a deviation against the same bands as the status (positive = worse). */
export function deviationTone(x: number | null | undefined) {
  if (x == null) return "text-faint";
  if (x <= -0.2) return "text-ok";
  if (x <= 0) return "text-ok";
  if (x <= 0.15) return "text-warn";
  return "text-bad";
}
