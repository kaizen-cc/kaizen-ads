// Per-service pauses (public.watch_pauses), as plain functions: which clients have a line paused today, so the daily
// recap, the Overview and the KPI board leave that line out until the date. Nothing is ever deleted: a pause ends by
// date or by someone ending it, and the line comes back by itself.

export type PauseRow = { client_id: string; service: string; until: string; reason?: string | null; cleared_at?: string | null };
export type ActivePause = { until: string; reason: string };

/** The services a recap line stands for (the slugs the account watch uses) */
export const PAUSE_SERVICE = { email: "email-marketing", social: "social-media" } as const;

/** Whether a pause still holds on a day: not ended early, and the day is on or before its date */
export const pauseHolds = (p: { until: string; cleared_at?: string | null } | null | undefined, today: string) => Boolean(p && !p.cleared_at && p.until.slice(0, 10) >= today);

/** The pauses that hold today for one service, by client */
export function activePauses(rows: readonly PauseRow[], service: string, today: string): Map<string, ActivePause> {
  const out = new Map<string, ActivePause>();
  for (const r of rows) {
    if (r.service !== service || !pauseHolds(r, today)) continue;
    const had = out.get(r.client_id);
    if (!had || r.until > had.until) out.set(r.client_id, { until: r.until.slice(0, 10), reason: r.reason ?? "" });
  }
  return out;
}

/** Whatever belongs to clients that are not paused on the line */
export const withoutPaused = <T,>(items: readonly T[], clientOf: (x: T) => string | null | undefined, paused: ReadonlyMap<string, unknown>): T[] => items.filter((x) => { const c = clientOf(x); return !c || !paused.has(c); });
