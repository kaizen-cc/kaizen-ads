import type { Status, Trend } from "./calc";

// Are we trending toward the account's success KPI? Not just where it stands today, or month over month: where it's
// heading against the target. The last 3 days and the month-over-month move each push the direction; the status says
// how far there is to go.

export type Success = "on_track" | "close" | "off_track";
/** Where the target came from: the client confirmed it, Kaizen set it, or the industry benchmark stands in for one */
export type TargetFrom = "client" | "strategy" | "benchmark";
export type BenchmarkTarget = { value: number; metric: string; unit: string; source: string; year: string; vertical: string };

export const SUCCESS: Record<Success, { label: string; tone: string }> = {
  on_track: { label: "On track", tone: "bg-ok-soft text-ok" },
  close: { label: "Getting there", tone: "bg-warn-soft text-warn" },
  off_track: { label: "Off track", tone: "bg-bad-soft text-bad" },
};

export const TARGET_FROM: Record<TargetFrom, string> = { client: "Client's target", strategy: "Kaizen's target", benchmark: "Industry benchmark" };

/** +1 heading toward the target, -1 away, 0 flat. vsMonth: + is worse than last month. */
export function direction(trend: Trend | null, vsMonth: number | null) {
  const d = (trend === "improving" ? 1 : trend === "slipping" ? -1 : 0) + (vsMonth == null ? 0 : vsMonth <= -0.1 ? 1 : vsMonth >= 0.1 ? -1 : 0);
  return Math.sign(d);
}

export function successOf(status: Status, trend: Trend | null, vsMonth: number | null): Success | null {
  if (status === "setup" || status === "idle" || status === "unset") return null;
  const dir = direction(trend, vsMonth);
  if (status === "excellent" || status === "good") return dir < 0 && status === "good" ? "close" : "on_track";
  if (status === "close") return dir > 0 ? "on_track" : dir < 0 ? "off_track" : "close";
  return dir > 0 ? "close" : "off_track";
}

export function successLine(s: Success, from: TargetFrom) {
  const against = from === "benchmark" ? "the industry benchmark" : "the target";
  return s === "on_track" ? `Trending to ${against}` : s === "close" ? `Moving toward ${against}, not there yet` : `Not heading toward ${against}`;
}
