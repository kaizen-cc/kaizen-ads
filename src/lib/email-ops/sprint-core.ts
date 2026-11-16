// The email sprint's plain parts: what a check measures, how the score moved since the sprint began, what to tell the
// strategist and when to look again. Pure so it is tested without a database. A sprint follows an audit's plan; its
// checks re-measure the email score and its seven checks, because that is the only judge an email account has.

import { emailBand, type EmailBand, type EmailScore } from "@/lib/email-score";

/** The score and each check as the sprint keeps them (small, so a row can hold the baseline, the latest and every check) */
export type ScoreSnapshot = { score: number; band: EmailBand; at: string; checks: { key: string; label: string; value: number | null; bar: number; met: boolean; points: number; weight: number }[] };

export function snapshotOf(s: EmailScore, at = new Date().toISOString()): ScoreSnapshot {
  return { score: s.score, band: s.band, at, checks: s.checks.map((c) => ({ key: c.key, label: c.label, value: c.value, bar: c.bar, met: c.met, points: Math.round(c.points * 10) / 10, weight: c.weight })) };
}

export type SprintVerdict = "no_action" | "on_track" | "improving" | "worse" | "done" | "started";

export type Movement = {
  delta: number;
  /** Checks that now meet their bar and did not at the start */
  gained: string[];
  /** Checks that met their bar at the start and no longer do */
  lost: string[];
  /** Checks still under the bar, worst first (by points still to earn) */
  open: string[];
};

/** How the score moved between two snapshots, and which checks changed side of their bar */
export function movement(from: ScoreSnapshot, to: ScoreSnapshot): Movement {
  const was = new Map(from.checks.map((c) => [c.key, c]));
  const gained = to.checks.filter((c) => c.met && was.get(c.key) && !was.get(c.key)!.met).map((c) => c.label);
  const lost = to.checks.filter((c) => !c.met && c.value != null && was.get(c.key)?.met).map((c) => c.label);
  const open = to.checks
    .filter((c) => c.value != null && !c.met)
    .sort((a, b) => b.weight - b.points - (a.weight - a.points))
    .map((c) => c.label);
  return { delta: to.score - from.score, gained, lost, open };
}

export type ActionTally = { todo: number; doing: number; done: number; skipped: number };
export const tally = (statuses: readonly string[]): ActionTally => ({
  todo: statuses.filter((s) => s === "todo").length,
  doing: statuses.filter((s) => s === "doing").length,
  done: statuses.filter((s) => s === "done").length,
  skipped: statuses.filter((s) => s === "skipped").length,
});

/**
 * The verdict of a check, from the score movement and the actions ticked. Nothing ticked yet: "no_action" (the nudge).
 * Back in the green: "done". The score up by 3 points or more: "improving"; down by 3 or more: "worse"; otherwise "on_track".
 */
export function verdictOf(m: Movement, t: ActionTally, now: ScoreSnapshot): SprintVerdict {
  if (now.band === "good") return "done";
  if (t.done + t.doing === 0) return "no_action";
  if (m.delta >= 3) return "improving";
  if (m.delta <= -3) return "worse";
  return "on_track";
}

const DAY = 86_400_000;

/** When to look again: a regression tomorrow, nothing ticked in two days, otherwise the metrics need a few days to move */
export function nextCheckAt(v: SprintVerdict, now = Date.now()): string {
  const days = v === "worse" ? 1 : v === "no_action" ? 2 : v === "done" ? 7 : v === "started" ? 3 : 3;
  return new Date(now + days * DAY).toISOString();
}

/** The check's message when no AI is available, or as the AI's facts: plain, first person, specific */
export function plainMessage(v: SprintVerdict, m: Movement, t: ActionTally, now: ScoreSnapshot): string {
  const lead = `The score is ${now.score} (${m.delta === 0 ? "unchanged" : `${m.delta > 0 ? "up" : "down"} ${Math.abs(m.delta)} since the sprint began`}).`;
  const gained = m.gained.length ? ` ${m.gained.join(", ")} now meets its bar.` : "";
  const lost = m.lost.length ? ` ${m.lost.join(", ")} slipped under its bar.` : "";
  const open = m.open.length ? ` Still under the bar: ${m.open.slice(0, 3).join(", ")}.` : "";
  if (v === "done") return `${lead} The account is back in the green.${gained}`;
  if (v === "no_action") return `${lead} Nothing on the plan is started yet. The moves marked for today come first.${open}`;
  if (v === "worse") return `${lead}${lost}${open} ${t.done} of ${t.done + t.doing + t.todo} moves done: worth checking what changed in Klaviyo since the last look.`;
  if (v === "improving") return `${lead}${gained}${open} ${t.done} of ${t.done + t.doing + t.todo} moves done: keep going.`;
  return `${lead}${gained}${lost}${open} Metrics take a few days to move after a change, so I will look again soon.`;
}

/** The band an unmeasured sprint start would have (guards a missing score) */
export const bandFor = emailBand;
