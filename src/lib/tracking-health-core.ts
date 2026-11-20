// Tracking health for the Tracking Specialist (the owner, Nov 20 2026), the pure rules (tests/tracking-health.test.ts).
// Every active client that buys paid ads gets a status (ok, potential issue, not set up) and a tier by age:
// - a flagged potential issue (a watchdog flag, an audit finding, a mismatch, a conversion rate drop) or an open tracking
//   request is escalated (important) from the start, and critical once it's 2 weeks old;
// - tracking not set up is worth a look in the client's first week, escalated after 1 week and critical at 2 weeks.
// A "not set up" is aged from the client's onboarding (enrollment) date; a flag or a request from when it was opened.

export type HealthTier = "critical" | "high" | "normal";
export type HealthStatus = "issue" | "not_set_up" | "ok";

const DAY = 86_400_000;
export const daysSince = (iso: string | null | undefined, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY)) : 0);

/** An open flag or request: important from the start, critical at 2 weeks */
export function flagTier(days: number): HealthTier {
  return days >= 14 ? "critical" : "high";
}

/** Tracking not set up: worth a look the first week, important after it, critical at 2 weeks */
export function notSetUpTier(days: number): HealthTier {
  return days >= 14 ? "critical" : days > 7 ? "high" : "normal";
}

/** The score the day's review sorts by, per tier (src/lib/today.ts: 80+ critical, 60+ important) */
export const TIER_SCORE: Record<HealthTier, number> = { critical: 88, high: 72, normal: 56 };

const RANK: Record<HealthTier, number> = { critical: 0, high: 1, normal: 2 };

export type HealthInput = {
  onboardedAt: string;
  setUp: boolean;
  flags: { kind: string; title: string; openedAt: string }[];
  requests: { title: string; openedAt: string }[];
};

export type Health = { status: HealthStatus; tier: HealthTier | null; why: string[]; daysOnboarded: number; ageDays: number };

/** One client's tracking health: worst of its flags, its open requests and whether tracking is set up */
export function healthOf(i: HealthInput, now = Date.now()): Health {
  const daysOnboarded = daysSince(i.onboardedAt, now);
  const why: string[] = [];
  let tier: HealthTier | null = null;
  let age = 0;
  const worse = (t: HealthTier, d: number) => {
    if (tier == null || RANK[t] < RANK[tier] || (t === tier && d > age)) {
      tier = t;
      age = d;
    }
  };
  for (const f of i.flags) {
    const d = daysSince(f.openedAt, now);
    worse(flagTier(d), d);
    why.push(`${f.title} (${d === 0 ? "today" : `${d}d`})`);
  }
  for (const r of i.requests) {
    const d = daysSince(r.openedAt, now);
    worse(flagTier(d), d);
    why.push(`Request: ${r.title} (${d === 0 ? "today" : `${d}d`})`);
  }
  if (!i.setUp) {
    worse(notSetUpTier(daysOnboarded), daysOnboarded);
    why.push(`Tracking not set up, ${daysOnboarded} ${daysOnboarded === 1 ? "day" : "days"} since onboarding`);
  }
  const status: HealthStatus = i.flags.length || i.requests.length ? "issue" : i.setUp ? "ok" : "not_set_up";
  return { status, tier, why, daysOnboarded, ageDays: age };
}

/** Worst first: critical, then important, then worth a look, then ok; older first within a tier */
export function worstFirst<T extends { health: Health; client: string }>(rows: readonly T[]): T[] {
  const r = (h: Health) => (h.tier ? RANK[h.tier] : 3);
  return [...rows].sort((a, b) => r(a.health) - r(b.health) || b.health.ageDays - a.health.ageDays || a.client.localeCompare(b.client));
}
