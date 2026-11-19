import { cycleDaysLeft, emailCycleElapsed, LAST_WEEK_DAYS, PACE_GRACE, VERY_BEHIND_AFTER, VERY_BEHIND_RATIO } from "./email-allotment-core";

// A client's monthly organic social allotment, as Kaizen sells it (owner's pricing deck, Nov 19 2026): four pools a
// billing cycle (allotment_period_start(billing_day), from Stripe via Kaizen Track), each a range paced against its top:
// posts, static graphics, video/reels and IG stories. The cap comes from the client's tier (Basic, Silver, Gold,
// Platinum, plus added video/reels), their Custom numbers, or a Sprint (numbers until a day, then a tier or nothing).
// Strategy-only clients hold none. Used is what was published this cycle on the platforms the client posts on (the most
// on any one platform: a post goes out on each of them), plus the production line (posts requested in Kaizen OS this
// cycle and not yet out). The database view client_social_allotment counts with the same rule. Pure: the Services panel,
// the score, the alerts, the agents and the tests (tests/social-allotment.test.ts) agree.

export type SocialTierKey = "basic" | "silver" | "gold" | "platinum";
export type SocialPlatformKey = "facebook" | "instagram" | "tiktok" | "linkedin" | "google_business";
export type SocialPool = "posts" | "statics" | "videos" | "stories";

export const SOCIAL_PLATFORM_OPTIONS: readonly { key: SocialPlatformKey; label: string; short: string; read: boolean }[] = [
  { key: "facebook", label: "Facebook", short: "FB", read: true },
  { key: "instagram", label: "Instagram", short: "IG", read: true },
  { key: "tiktok", label: "TikTok", short: "TikTok", read: false },
  { key: "linkedin", label: "LinkedIn", short: "LinkedIn", read: false },
  { key: "google_business", label: "Google Business", short: "GMB", read: false },
];
export const isSocialPlatform = (v: unknown): v is SocialPlatformKey => SOCIAL_PLATFORM_OPTIONS.some((p) => p.key === v);

/** The tiers on the owner's pricing deck (the database's social_packages holds the same numbers) */
export const SOCIAL_TIERS: readonly {
  key: SocialTierKey;
  label: string;
  price: string;
  posts: number;
  statics: number;
  videos: number;
  stories: number;
  platforms: SocialPlatformKey[];
  extras: string;
  minimumMonths: number;
}[] = [
  { key: "basic", label: "Basic", price: "$600", posts: 12, statics: 12, videos: 0, stories: 0, platforms: ["facebook", "instagram"], extras: "Bi-weekly reports, monthly calendar", minimumMonths: 2 },
  { key: "silver", label: "Silver", price: "$1,000", posts: 16, statics: 10, videos: 2, stories: 4, platforms: ["facebook", "instagram"], extras: "Bi-weekly reports, monthly calendar, paid promotions, reach 5,000+ a month", minimumMonths: 2 },
  { key: "gold", label: "Gold", price: "$1,500", posts: 22, statics: 10, videos: 4, stories: 8, platforms: ["facebook", "instagram", "tiktok"], extras: "Bi-weekly reports, paid promotions, real-time tracking, reach 10,000+ a month", minimumMonths: 3 },
  { key: "platinum", label: "Platinum", price: "$2,250 + ad spend", posts: 30, statics: 12, videos: 6, stories: 12, platforms: ["facebook", "instagram", "tiktok", "linkedin"], extras: "Weekly reports, monthly calendar, paid promotions, A/B testing, CPA/ROAS; $1,000 minimum ad spend, $1,500 setup", minimumMonths: 3 },
];
export const isSocialTier = (v: unknown): v is SocialTierKey => SOCIAL_TIERS.some((t) => t.key === v);
export const socialTier = (k: string | null | undefined) => SOCIAL_TIERS.find((t) => t.key === k) ?? null;

/** Add-ons on the deck: an added video/reel and an added platform, $150 a month each; on-site shoots $500 to $2,000 */
export const ADDON_PRICE = 150;

/** What a tier holds, in words: "12 posts, 12 statics" / "16 posts, 10 statics, 2 video/reels, 4 IG stories" */
export function tierText(t: { posts: number; statics: number; videos: number; stories: number }) {
  return [`${t.posts} posts`, t.statics && `${t.statics} statics`, t.videos && `${t.videos} video/reels`, t.stories && `${t.stories} IG stories`].filter(Boolean).join(", ");
}

/** The platforms the client posts on: their own pick, else their tier's, else Facebook and Instagram */
export function platformsFor(chosen: readonly string[] | null | undefined, tierKey: string | null | undefined): SocialPlatformKey[] {
  const own = (chosen ?? []).filter(isSocialPlatform);
  if (chosen && own.length) return SOCIAL_PLATFORM_OPTIONS.map((p) => p.key).filter((k) => own.includes(k));
  return [...(socialTier(tierKey)?.platforms ?? ["facebook", "instagram"])];
}

/** Platforms beyond the tier's own count (each an add-on on the deck) */
export function addedPlatforms(platforms: readonly string[], tierKey: string | null | undefined): number {
  const t = socialTier(tierKey);
  return t ? Math.max(0, platforms.length - t.platforms.length) : 0;
}

// ─── The allotment ───────────────────────────────────────────────────────────

/** One pool: its range (min to max, paced against max), used this cycle (published and in motion), in motion, published */
export type SocialPoolCap = { min: number | null; max: number | null; used: number; progress: number; done: number };

export type SocialAllotment = Record<SocialPool, SocialPoolCap> & {
  source: "package" | "custom" | "sprint" | "strategy" | null;
  packageKey: string | null;
  label: string | null;
  sprint: { until: string; after: string | null } | null;
  extraVideos: number;
  platforms: SocialPlatformKey[];
  cycle: { start: string; end: string } | null;
};

export type SocialAllotmentRow = {
  client_id: string;
  posts_min: number | null;
  posts_per_month: number | null;
  statics_min: number | null;
  statics_per_month: number | null;
  videos_min: number | null;
  videos_per_month: number | null;
  stories_min: number | null;
  stories_per_month: number | null;
  cap_source: SocialAllotment["source"];
  package_key: string | null;
  package_label: string | null;
  sprint_until: string | null;
  sprint_after: string | null;
  extra_videos: number | null;
  platforms: string[] | null;
  posts_used: number;
  statics_used: number;
  videos_used: number;
  stories_used: number;
  posts_progress: number;
  posts_done: number;
  statics_done: number;
  videos_done: number;
  stories_done: number;
  period_start: string | null;
  period_end: string | null;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const pool = (min: unknown, max: unknown, used: unknown, progress: unknown, done: unknown): SocialPoolCap => ({ min: num(min), max: num(max), used: Number(used) || 0, progress: Number(progress) || 0, done: Number(done) || 0 });

export const toSocialAllotment = (r: SocialAllotmentRow): SocialAllotment => ({
  posts: pool(r.posts_min, r.posts_per_month, r.posts_used, r.posts_progress, r.posts_done),
  statics: pool(r.statics_min, r.statics_per_month, r.statics_used, 0, r.statics_done),
  videos: pool(r.videos_min, r.videos_per_month, r.videos_used, 0, r.videos_done),
  stories: pool(r.stories_min, r.stories_per_month, r.stories_used, 0, r.stories_done),
  source: r.cap_source,
  packageKey: r.package_key,
  label: r.cap_source === "package" ? r.package_label : r.cap_source === "sprint" ? "Sprint" : r.cap_source === "custom" ? "Custom" : r.cap_source === "strategy" ? "Strategy only" : null,
  sprint: r.cap_source === "sprint" && r.sprint_until ? { until: r.sprint_until, after: r.sprint_after } : null,
  extraVideos: Number(r.extra_videos) || 0,
  platforms: platformsFor(r.platforms, r.package_key),
  cycle: r.period_start && r.period_end ? { start: String(r.period_start).slice(0, 10), end: String(r.period_end).slice(0, 10) } : null,
});

export const SOCIAL_POOL_LABEL: Record<SocialPool, string> = { posts: "Posts", statics: "Statics", videos: "Video/reels", stories: "IG stories" };
const POOLS: readonly SocialPool[] = ["posts", "statics", "videos", "stories"];

export type SocialPoolView = { key: SocialPool; label: string; cap: number; min: number | null; range: string; used: number; progress: number; done: number; left: number; over: number };

/** Each pool with a cap above zero (a pool the tier doesn't hold, like Basic's stories, is left out) */
export function socialPools(a: SocialAllotment | null | undefined): SocialPoolView[] {
  if (!a || !a.source || a.source === "strategy") return [];
  return POOLS.flatMap((key) => {
    const p = a[key];
    if (p.max == null || p.max <= 0) return [];
    const range = p.min != null && p.min < p.max ? `${p.min}-${p.max}` : String(p.max);
    return [{ key, label: SOCIAL_POOL_LABEL[key], cap: p.max, min: p.min, range, used: p.used, progress: p.progress, done: p.done, left: Math.max(0, p.max - p.used), over: Math.max(0, p.used - p.max) }];
  });
}

/** "Posts 7/12 used · 2 in progress · 5 published · Statics 4/12 used": per pool, never summed */
export function socialAllotmentLine(a: SocialAllotment | null | undefined): string | null {
  const pools = socialPools(a);
  if (!pools.length) return null;
  return pools.map((p) => `${p.label} ${p.used}/${p.range} used${p.over ? ` · ${p.over} over` : ""}${p.progress ? ` · ${p.progress} in progress` : ""}${p.done && p.done !== p.used ? ` · ${p.done} published` : ""}`).join(" · ");
}

/** Behind pace, on pace, over, or none set (for grouping every client), against each pool's top */
export function socialPace(a: SocialAllotment | null | undefined, now = new Date()): { group: "behind" | "pace" | "over" | "none"; score: number } {
  const pools = socialPools(a);
  if (!pools.length) return { group: "none", score: 1e9 };
  const over = pools.filter((p) => p.over > 0);
  const elapsed = Math.max(0.05, emailCycleElapsed(a?.cycle, now));
  const ratio = Math.min(...pools.map((p) => p.used / Math.max(1, p.cap) / elapsed));
  if (ratio >= 0.7 && over.length) return { group: "over", score: 1e6 + Math.max(...over.map((p) => p.over / Math.max(1, p.cap))) };
  return { group: ratio < 0.7 ? "behind" : "pace", score: ratio };
}

/**
 * Allotment pacing for the social score: the share of the cycle's allotment used (each pool's top, over the cap counted
 * at the cap so posting more adds nothing) against how far through the billing cycle the client is. Null (not measured)
 * for strategy-only clients, clients with no tier, and in the first 15% of a cycle.
 */
export function socialAllotmentPace(a: SocialAllotment | null | undefined, now = new Date()): { used: number; expected: number; ratio: number; elapsed: number } | null {
  if (!a || !a.source || a.source === "strategy") return null;
  const pools = POOLS.map((k) => a[k]).filter((p) => p.max != null && p.max > 0);
  const cap = pools.reduce((n, p) => n + (p.max ?? 0), 0);
  if (!cap) return null;
  const elapsed = emailCycleElapsed(a.cycle, now);
  if (elapsed < PACE_GRACE) return null;
  const used = pools.reduce((n, p) => n + Math.min(p.used, p.max ?? 0), 0) / cap;
  return { used, expected: elapsed, ratio: used / Math.max(0.01, elapsed), elapsed };
}

/**
 * VERY behind: under half of where the cycle says with more than half of it gone ("behind"), or in the cycle's last
 * week with any pool short of the bottom of its range ("last_week"). Null otherwise.
 */
export function socialVeryBehind(a: SocialAllotment | null | undefined, now = new Date()): { kind: "behind" | "last_week"; text: string } | null {
  const p = socialAllotmentPace(a, now);
  if (!p || !a) return null;
  const left = cycleDaysLeft(a.cycle, now);
  const short = socialPools(a)
    .filter((x) => x.used < (x.min ?? x.cap))
    .map((x) => `${x.label} ${x.used} of ${x.range}`);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (left != null && left < LAST_WEEK_DAYS && short.length) return { kind: "last_week", text: `${left} day${left === 1 ? "" : "s"} left in the cycle and still short: ${short.join(", ")}.` };
  if (p.elapsed > VERY_BEHIND_AFTER && p.ratio < VERY_BEHIND_RATIO) return { kind: "behind", text: `${pct(p.used)} of the social allotment used with ${pct(p.elapsed)} of the cycle gone${short.length ? ` (${short.join(", ")})` : ""}.` };
  return null;
}

// ─── Custom numbers ──────────────────────────────────────────────────────────

export type SocialCustom = { posts: number; posts_min: number; statics: number; statics_min: number; videos: number; videos_min: number; stories: number; stories_min: number; sprint_until?: string; after?: SocialTierKey | null };

const whole = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

/** "3-5" → [3, 5]; "4" → [4, 4]; "" → [0, 0] */
export function parseRange(v: string | number | null | undefined): [number, number] {
  const [a, b] = String(v ?? "")
    .split("-")
    .map((x) => Math.max(0, Number(x) || 0));
  return b == null ? [a ?? 0, a ?? 0] : [Math.min(a, b), Math.max(a, b)];
}

/** Custom or sprint numbers made safe: whole, in range, a min never above its max */
export function cleanSocialCustom(c: Partial<Record<SocialPool | `${SocialPool}_min`, unknown>>): Omit<SocialCustom, "sprint_until" | "after"> {
  const pair = (max: unknown, min: unknown, cap: number) => {
    const hi = whole(max, cap);
    return [Math.min(hi, whole(min ?? hi, cap)), hi] as const;
  };
  const [pMin, pMax] = pair(c.posts, c.posts_min, 120);
  const [sMin, sMax] = pair(c.statics, c.statics_min, 120);
  const [vMin, vMax] = pair(c.videos, c.videos_min, 60);
  const [tMin, tMax] = pair(c.stories, c.stories_min, 200);
  return { posts: pMax, posts_min: pMin, statics: sMax, statics_min: sMin, videos: vMax, videos_min: vMin, stories: tMax, stories_min: tMin };
}
