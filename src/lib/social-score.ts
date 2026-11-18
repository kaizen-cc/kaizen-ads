import { emailBand, type EmailBand } from "./email-score";
import { barFor, engagementChain, postSums, type RateBasis, type RateParts } from "./social/rate";

// The organic social account score (0 to 100): how healthy a client's Instagram, Facebook (and TikTok, once its organic
// numbers are read) accounts are, from eight checks the social team runs. Pure, so the board, the Overview, the recap,
// the reports, the audits and the agents all score an account the same way. Window: the last 30 days, New York dates.
//
// Each check has a bar and a weight. A check at or over its bar gets all its points; under it, its share of the bar, so
// the score moves smoothly. Engagement against the client's own target weighs most. A check with nothing to measure (no
// saves read, no video posted, no profile visits given) is left out and the rest scaled to 100, exactly like email.
// Bands are email's: green from 80, yellow from 60, red under 60.
//
// Engagement is interactions over reach. When Meta gives no reach it is over views, then per post over followers (src/lib/social/rate.ts);
// a rate is only ever held to a bar of its own kind: the client's target (else 5%) for reach, 3% for views, 1% for followers, so
// numbers on different bases are never compared. The check says which basis it used.
//
// Bars were set from the live accounts in Nov 2026 (median engagement 4.5% on Instagram, 6.6% on Facebook; follower
// growth about 1% a month; saves and shares about 0.5% of reach; profile visits about 4% of reach; a third to a half of
// posts are video): each bar sits at what a healthy account already does, so the score reads "at the bar" as healthy.

export type SocialPlatform = "instagram" | "facebook" | "tiktok";
export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ["instagram", "facebook", "tiktok"];
export const PLATFORM_LABEL: Record<SocialPlatform, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };

export type SocialCheckKey = "engagement" | "growth" | "reach" | "cadence" | "quality" | "videoShare" | "videoLift" | "profile";
export type SocialUnit = "pct" | "change" | "ratio";

/** Kaizen's engagement target for every social account (at least 5% of reach engages); a client's own target overrides it */
export const DEFAULT_ENGAGEMENT_BAR = 0.05;
/** Posts a month when the client's package doesn't say (three a week), per platform */
export const DEFAULT_POSTS_PER_MONTH = 12;

export const SOCIAL_CHECKS: readonly { key: SocialCheckKey; label: string; bar: number; weight: number; unit: SocialUnit }[] = [
  { key: "engagement", label: "Engagement rate", bar: DEFAULT_ENGAGEMENT_BAR, weight: 30, unit: "pct" },
  { key: "growth", label: "Follower growth", bar: 0.01, weight: 15, unit: "pct" },
  { key: "reach", label: "Reach vs the 30 before", bar: 1, weight: 15, unit: "change" },
  { key: "cadence", label: "Posts vs the package", bar: 1, weight: 15, unit: "pct" },
  { key: "quality", label: "Saves and shares per reach", bar: 0.006, weight: 10, unit: "pct" },
  { key: "videoShare", label: "Video and Reels share", bar: 0.4, weight: 3.75, unit: "pct" },
  { key: "videoLift", label: "Video vs static engagement", bar: 1, weight: 3.75, unit: "ratio" },
  { key: "profile", label: "Profile visits per reach", bar: 0.04, weight: 7.5, unit: "pct" },
];

export type SocialBand = EmailBand;
export const socialBand = emailBand;

export type SocialInputs = Record<SocialCheckKey, number | null>;
export type SocialCheck = { key: SocialCheckKey; label: string; value: number | null; bar: number; weight: number; points: number; met: boolean; unit: SocialUnit; /** Engagement only: what the rate is over (null: the standard, reach) */ basis?: RateBasis | null };
export type SocialScore = { score: number; band: SocialBand; checks: SocialCheck[]; weighingDown: SocialCheck[]; unmeasured: SocialCheckKey[] };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The score of one platform. `engagementBar`: the client's engagement target (the default bar without one). */
export function socialScore(i: Partial<SocialInputs>, opts: { engagementBar?: number | null; engagementBasis?: RateBasis | null } = {}): SocialScore {
  const checks: SocialCheck[] = SOCIAL_CHECKS.map((c) => {
    const bar = c.key === "engagement" ? barFor(opts.engagementBasis, opts.engagementBar ?? c.bar) : c.bar;
    const raw = i[c.key];
    const value = raw == null || !Number.isFinite(raw) ? null : raw;
    const share = value === null ? null : clamp01(value / bar);
    return { key: c.key, label: c.label, value, bar, weight: c.weight, unit: c.unit, points: share === null ? 0 : share * c.weight, met: value !== null && value >= bar, ...(c.key === "engagement" ? { basis: opts.engagementBasis ?? null } : {}) };
  });
  const measured = checks.filter((c) => c.value !== null);
  const possible = measured.reduce((n, c) => n + c.weight, 0);
  const got = measured.reduce((n, c) => n + c.points, 0);
  const score = possible ? Math.round((got / possible) * 100) : 0;
  const weighingDown = measured.filter((c) => !c.met).sort((a, b) => b.weight - b.points - (a.weight - a.points));
  return { score, band: socialBand(score), checks, weighingDown, unmeasured: checks.filter((c) => c.value === null).map((c) => c.key) };
}

// ─── From the synced rows to the inputs ────────────────────────────────────

export type SocialDayRow = { platform: string; date: string; followers: number | null; gained: number | null; lost: number | null; reach: number | null; interactions: number | null; profileViews: number | null; views?: number | null };
export type SocialPostRow = { platform: string; postedAt: string | null; format: string | null; reach: number | null; interactions: number | null; saves: number | null; shares: number | null; caption?: string | null; permalink?: string | null; views?: number | null; likes?: number | null; comments?: number | null };

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nyDay = (iso: string) => (iso.length === 10 ? iso : new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
const sumOf = (xs: (number | null)[]): number | null => (xs.some((x) => x != null) ? xs.reduce<number>((n, x) => n + (x ?? 0), 0) : null);
const isVideo = (f: string | null) => f === "reel" || f === "video";

/** One platform's numbers over the window, as the sheet and the agents show them */
export type PlatformNumbers = {
  platform: SocialPlatform;
  followers: number | null;
  /** Net followers over the 30 days (counts when two are 14+ days apart, else gained less lost) */
  netFollowers: number | null;
  reach: number | null;
  reachBefore: number | null;
  views: number | null;
  interactions: number | null;
  rate: number | null;
  /** What the rate is over: reach (the standard), views, or followers per post; null with no rate */
  rateBasis: RateBasis | null;
  /** Each basis's numbers, so platforms and accounts add up exactly */
  rateParts: RateParts;
  profileViews: number | null;
  posts: number;
  postsThisMonth: number;
  videoPosts: number;
  saves: number | null;
  shares: number | null;
  lastPostAt: string | null;
};

/**
 * One platform's inputs and numbers from its rows. `promisedPerMonth`: the package's posts a month (the default without
 * one). The cadence check paces this month's posts against the month so far and, like email's revenue pace, is left out
 * in the first three days of the month unless the promise is already met.
 */
export function platformInputs(d: { platform: SocialPlatform; days: SocialDayRow[]; posts: SocialPostRow[]; today: string; promisedPerMonth?: number | null }): { inputs: SocialInputs; numbers: PlatformNumbers } {
  const { today } = d;
  const from = shift(today, -29);
  const before = shift(today, -59);
  const days = d.days.filter((x) => x.platform === d.platform);
  const now = days.filter((x) => x.date >= from && x.date <= today);
  const prev = days.filter((x) => x.date >= before && x.date < from);
  const reach = sumOf(now.map((x) => x.reach));
  const reachBefore = sumOf(prev.map((x) => x.reach));
  const interactions = sumOf(now.map((x) => x.interactions));
  const profileViews = sumOf(now.map((x) => x.profileViews));
  const counted = [...days].filter((x) => x.followers != null && x.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const latest = counted.at(-1) ?? null;
  const first = counted.find((x) => x.date >= from) ?? null;
  const gained = sumOf(now.map((x) => x.gained));
  const lost = sumOf(now.map((x) => x.lost));
  let net: number | null = null;
  let growth: number | null = null;
  if (latest && first && latest.date !== first.date && Date.parse(`${latest.date}T12:00:00Z`) - Date.parse(`${first.date}T12:00:00Z`) >= 14 * 86_400_000 && first.followers! > 0) {
    net = latest.followers! - first.followers!;
    growth = net / first.followers!;
  } else if (gained != null) {
    net = gained - (lost ?? 0);
    const start = latest?.followers != null ? latest.followers - net : null;
    growth = start != null && start > 0 ? net / start : null;
  }
  const posts = d.posts.filter((p) => p.platform === d.platform && p.postedAt);
  const recent = posts.filter((p) => nyDay(p.postedAt!) >= from && nyDay(p.postedAt!) <= today);
  const monthStart = `${today.slice(0, 8)}01`;
  const thisMonth = posts.filter((p) => nyDay(p.postedAt!) >= monthStart && nyDay(p.postedAt!) <= today).length;
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const promised = d.promisedPerMonth != null && d.promisedPerMonth > 0 ? d.promisedPerMonth : DEFAULT_POSTS_PER_MONTH;
  const expected = (promised * dayOfMonth) / daysInMonth;
  const cadence = thisMonth >= promised ? thisMonth / promised : dayOfMonth <= 3 ? null : thisMonth / expected;
  const withReach = recent.filter((p) => p.reach != null && p.reach > 0);
  const qualityRows = withReach.filter((p) => p.saves != null || p.shares != null);
  const qualityReach = qualityRows.reduce((n, p) => n + (p.reach ?? 0), 0);
  const quality = qualityReach > 0 ? qualityRows.reduce((n, p) => n + (p.saves ?? 0) + (p.shares ?? 0), 0) / qualityReach : null;
  const rateOf = (xs: SocialPostRow[]) => {
    const r = xs.reduce((n, p) => n + (p.reach ?? 0), 0);
    return r > 0 ? xs.reduce((n, p) => n + (p.interactions ?? 0), 0) / r : null;
  };
  const vids = withReach.filter((p) => isVideo(p.format));
  const stills = withReach.filter((p) => !isVideo(p.format));
  const vr = vids.length ? rateOf(vids) : null;
  const sr = stills.length ? rateOf(stills) : null;
  // The rate down the chain: reach, else views, else followers per post; the posts' own numbers fill what Meta left out
  const chain = engagementChain({ interactions, reach, views: sumOf(now.map((x) => x.views ?? null)), followers: latest?.followers ?? null, posts: recent.length, fromPosts: postSums(recent) });
  const inputs: SocialInputs = {
    engagement: chain.rate,
    growth,
    reach: reach != null && reachBefore != null && reachBefore > 0 ? reach / reachBefore : null,
    cadence,
    quality,
    videoShare: recent.length ? recent.filter((p) => isVideo(p.format)).length / recent.length : null,
    videoLift: vr != null && sr != null && sr > 0 ? vr / sr : null,
    profile: reach != null && reach > 0 && profileViews != null ? profileViews / reach : null,
  };
  return {
    inputs,
    numbers: {
      platform: d.platform,
      followers: latest?.followers ?? null,
      netFollowers: net,
      reach,
      reachBefore,
      views: sumOf(now.map((x) => x.views ?? null)),
      interactions,
      rate: inputs.engagement,
      rateBasis: chain.basis,
      rateParts: chain.parts,
      profileViews,
      posts: recent.length,
      postsThisMonth: thisMonth,
      videoPosts: recent.filter((p) => isVideo(p.format)).length,
      saves: sumOf(recent.map((p) => p.saves)),
      shares: sumOf(recent.map((p) => p.shares)),
      lastPostAt: posts.map((p) => p.postedAt!).sort().at(-1) ?? null,
    },
  };
}

// ─── The account: every platform, and the overall ──────────────────────────

export type PlatformScore = SocialScore & { platform: SocialPlatform; inputs: SocialInputs; numbers: PlatformNumbers };
/** A check under its bar on one platform, for the account's "what weighs it down" (worst first, by reach-weighted points) */
export type SocialDrag = SocialCheck & { platform: SocialPlatform; /** Points of the overall score it costs */ cost: number };

export type SocialAccountScore = {
  /** Every platform's score weighted by its reach (an equal share each when none has reach) */
  score: number;
  band: SocialBand;
  platforms: PlatformScore[];
  /** The overall's checks: each platform's checks blended by reach, so the board's hover reads like email's */
  checks: SocialCheck[];
  weighingDown: SocialDrag[];
  unmeasured: SocialCheckKey[];
  /** Where the cadence's promise came from */
  promised: { perMonth: number; fromPackage: boolean };
  window: { from: string; to: string };
};

/** The platforms that have anything read (rows or posts) */
export function platformsIn(days: { platform: string }[], posts: { platform: string }[]): SocialPlatform[] {
  const seen = new Set([...days.map((d) => d.platform), ...posts.map((p) => p.platform)]);
  return SOCIAL_PLATFORMS.filter((p) => seen.has(p));
}

/** Each platform's share of the overall: its reach over all reach, equal shares when nothing has reach */
export function reachWeights(platforms: { reach: number | null }[]): number[] {
  const total = platforms.reduce((n, p) => n + (p.reach ?? 0), 0);
  if (total > 0) return platforms.map((p) => (p.reach ?? 0) / total);
  return platforms.map(() => (platforms.length ? 1 / platforms.length : 0));
}

/** The whole account, scored: each platform on its own and the overall weighted by reach. Null with nothing read. */
export function socialAccountScore(d: { days: SocialDayRow[]; posts: SocialPostRow[]; today: string; engagementTarget?: number | null; promisedPerMonth?: number | null }): SocialAccountScore | null {
  const list = platformsIn(d.days, d.posts);
  if (!list.length) return null;
  const platforms: PlatformScore[] = list.map((platform) => {
    const { inputs, numbers } = platformInputs({ platform, days: d.days, posts: d.posts, today: d.today, promisedPerMonth: d.promisedPerMonth });
    return { ...socialScore(inputs, { engagementBar: d.engagementTarget, engagementBasis: numbers.rateBasis }), platform, inputs, numbers };
  });
  const scored = platforms.filter((p) => p.unmeasured.length < p.checks.length);
  if (!scored.length) return null;
  const w = reachWeights(scored.map((p) => p.numbers));
  const score = Math.round(scored.reduce((n, p, i) => n + p.score * w[i], 0));
  const checks: SocialCheck[] = SOCIAL_CHECKS.map((c) => {
    const parts = scored.map((p, i) => ({ c: p.checks.find((x) => x.key === c.key)!, w: w[i] })).filter((x) => x.c.value != null);
    const ww = parts.reduce((n, x) => n + x.w, 0) || parts.length;
    const value = parts.length ? parts.reduce((n, x) => n + x.c.value! * (x.w || 1), 0) / ww : null;
    const bar = parts[0]?.c.bar ?? c.bar;
    // Platforms on different bases hold different bars: a blended engagement is met only when each platform met its own
    const mixed = c.key === "engagement" && new Set(parts.map((x) => x.c.bar)).size > 1;
    const basis = c.key === "engagement" ? (new Set(parts.map((x) => x.c.basis ?? null)).size === 1 ? (parts[0]?.c.basis ?? null) : null) : undefined;
    const points = parts.length ? parts.reduce((n, x) => n + x.c.points * (x.w || 1), 0) / ww : 0;
    return { key: c.key, label: c.label, value, bar, weight: c.weight, unit: c.unit, points, met: value != null && (mixed ? parts.every((x) => x.c.met) : value >= bar), ...(basis !== undefined ? { basis } : {}) };
  });
  const possible = checks.filter((c) => c.value != null).reduce((n, c) => n + c.weight, 0);
  const weighingDown: SocialDrag[] = scored
    .flatMap((p, i) => p.weighingDown.map((c) => ({ ...c, platform: p.platform, cost: possible ? ((c.weight - c.points) * w[i] * 100) / possible : 0 })))
    .sort((a, b) => b.cost - a.cost);
  return {
    score,
    band: socialBand(score),
    platforms,
    checks,
    weighingDown,
    unmeasured: checks.filter((c) => c.value == null).map((c) => c.key),
    promised: { perMonth: d.promisedPerMonth && d.promisedPerMonth > 0 ? d.promisedPerMonth : DEFAULT_POSTS_PER_MONTH, fromPackage: Boolean(d.promisedPerMonth && d.promisedPerMonth > 0) },
    window: { from: shift(d.today, -29), to: d.today },
  };
}

/**
 * The posts a month the client's social package promises, read from its words ("12 posts a month", "3 posts per week",
 * "16 posts/mo"). Null when it says nothing countable (the score then uses the default and says so).
 */
export function promisedPosts(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const m = t.match(/(\d{1,3})\s*(?:organic\s+|feed\s+|social\s+)?(?:posts?|pieces? of content|reels?)\s*(?:a|per|\/|each|every)?\s*(month|mo\b|week|wk\b)/);
  if (m) return Number(m[2].startsWith("w") ? Math.round(Number(m[1]) * 4.33) : Number(m[1])) || null;
  const w = t.match(/(\d{1,2})\s*(?:x|times)\s*(?:a|per|\/)\s*week/);
  if (w) return Math.round(Number(w[1]) * 4.33) || null;
  return null;
}

/** A check's value or bar as text (the email score's checkText covers pct; change and ratio are social's) */
export function socialCheckText(unit: SocialUnit, x: number | null): string {
  if (x == null) return "n/a";
  if (unit === "change") {
    const d = Math.round((x - 1) * 100);
    return d === 0 ? "flat" : `${d > 0 ? "+" : ""}${d}%`;
  }
  if (unit === "ratio") return `${x >= 10 ? x.toFixed(0) : x.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}x`;
  const d = x === 0 ? 0 : Math.abs(x) < 0.01 ? 2 : Math.abs(x) < 0.1 ? 1 : 0;
  return `${(x * 100).toFixed(d)}%`;
}

/** One check as a line for the agents: "Instagram engagement rate: 3.1% against a 3.5% bar, costing 3.4 of 30 points" */
export function socialCheckLine(c: SocialCheck, platform?: SocialPlatform): string {
  const name = `${platform ? `${PLATFORM_LABEL[platform]} ` : ""}${platform ? c.label.toLowerCase() : c.label}`;
  if (c.value == null) return `${name}: nothing to measure (bar ${socialCheckText(c.unit, c.bar)}, ${c.weight} points, left out)`;
  return `${name}: ${socialCheckText(c.unit, c.value)} against a ${socialCheckText(c.unit, c.bar)} bar${c.met ? ", met" : `, costing ${(c.weight - c.points).toFixed(1)} of ${c.weight} points`}`;
}
