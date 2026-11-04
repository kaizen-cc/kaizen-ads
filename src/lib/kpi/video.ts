// Video ad metrics, per ad: how many people stop on it (hook rate) and how much of it they watch (average watch time as
// a share of the video's length). Plain functions, shared by the server loaders and the badges that show them.
//
// "See more" rate on the primary text isn't here: Meta's insights don't report clicks on "See more" (no field or action
// type for it, only all clicks vs link clicks), so it can't be measured per ad.

/** 3-second views per impression. 30% and up is a hook that stops the scroll. */
export const HOOK_GOOD = 30;
/** Average watch time as a share of the video. 35% and up holds people. */
export const WATCH_GOOD = 35;

export const VIDEO_HELP = {
  hook: `Hook rate: 3-second video views per impression, how many people stop scrolling for it. Good is ${HOOK_GOOD}% or more; under ${Math.round(HOOK_GOOD * 0.67)}% the first seconds aren't stopping anyone.`,
  watch: `Average watch time as a share of the video's length: how much of it people actually watch. Good is ${WATCH_GOOD}% or more; under ${Math.round(WATCH_GOOD * 0.67)}% they leave early, so the middle needs work.`,
} as const;

type Action = { action_type?: string; value?: unknown };
const first = (v: unknown) => Number(((v ?? []) as Action[])[0]?.value) || 0;
const sumOf = (v: unknown, type: string) => ((v ?? []) as Action[]).filter((a) => a.action_type === type).reduce((s, a) => s + (Number(a.value) || 0), 0);

export type VideoMetrics = {
  impressions: number;
  /** 3-second views (Meta's video_view action) */
  views3s: number;
  /** Video starts (video_play_actions) */
  plays: number;
  hookRate: number | null;
  /** Seconds, averaged over every play in the period */
  avgWatchSec: number | null;
  videoSeconds: number | null;
  watchPct: number | null;
};

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * One ad's video metrics over some days of Meta insights. Meta gives an average watch time per day, so the period's
 * average weights each day by its plays.
 */
export function videoMetrics(days: Record<string, unknown>[], videoSeconds: number | null = null): VideoMetrics {
  let impressions = 0;
  let views3s = 0;
  let plays = 0;
  let watched = 0;
  let weighted = 0;
  for (const m of days) {
    impressions += Number(m.impressions) || 0;
    views3s += sumOf(m.actions, "video_view");
    const p = first(m.video_play_actions);
    plays += p;
    const avg = first(m.video_avg_time_watched_actions);
    if (p && avg) {
      watched += avg * p;
      weighted += p;
    }
  }
  const avgWatchSec = weighted ? r1(watched / weighted) : null;
  const seconds = videoSeconds && videoSeconds > 0 ? videoSeconds : null;
  return {
    impressions,
    views3s,
    plays,
    hookRate: impressions && views3s ? r1((views3s / impressions) * 100) : null,
    avgWatchSec,
    videoSeconds: seconds,
    // A long-watched loop can average more than its length: capped at 100%
    watchPct: avgWatchSec != null && seconds ? Math.min(100, r1((avgWatchSec / seconds) * 100)) : null,
  };
}

/** Good at or above the line, borderline within a third under it, weak below that. */
export function videoTone(value: number | null, good: number): "ok" | "warn" | "bad" | null {
  if (value == null) return null;
  return value >= good ? "ok" : value >= good * 0.67 ? "warn" : "bad";
}

export const TONE_CLASS = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" } as const;
