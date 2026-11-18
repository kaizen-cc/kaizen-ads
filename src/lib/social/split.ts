import { rollingRate } from "@/lib/channel-kpis/calc";
import { SOCIAL_PLATFORMS, type PlatformNumbers, type SocialAccountScore, type SocialPlatform } from "@/lib/social-score";

// Organic social split by platform: the Social board's platform filter and overview, and the Social sheet's platform
// pills (All, Instagram, Facebook, TikTok once it's read). The sync already keeps a row per platform per day and per post
// (src/lib/social/store.ts); this only picks and adds them up. Pure, so it is tested without a browser or a database.

export type PlatformPick = "all" | SocialPlatform;

export const parsePlatform = (raw: string | null | undefined): PlatformPick => (SOCIAL_PLATFORMS.includes(raw as SocialPlatform) ? (raw as SocialPlatform) : "all");

/** The platforms a set of accounts has (for the pills: only the ones with anything read) */
export function platformsOf(scores: (SocialAccountScore | null | undefined)[]): SocialPlatform[] {
  const seen = new Set(scores.flatMap((s) => (s?.platforms ?? []).map((p) => p.platform)));
  return SOCIAL_PLATFORMS.filter((p) => seen.has(p));
}

/** Whether an account shows under a platform filter */
export const hasPlatform = (s: SocialAccountScore | null | undefined, pick: PlatformPick) => pick === "all" || Boolean(s?.platforms.some((p) => p.platform === pick));

/** One platform's score and numbers from the account's, or the overall's when "all" */
export function scoreFor(s: SocialAccountScore | null | undefined, pick: PlatformPick): { score: number; band: SocialAccountScore["band"]; numbers: PlatformNumbers | null } | null {
  if (!s) return null;
  if (pick === "all") return { score: s.score, band: s.band, numbers: totalNumbers(s.platforms.map((p) => p.numbers)) };
  const p = s.platforms.find((x) => x.platform === pick);
  return p ? { score: p.score, band: p.band, numbers: p.numbers } : null;
}

const add = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((n, x) => n + (x ?? 0), 0) : null);

/** Every platform's numbers added up (the rate is interactions over reach of the total, never an average of rates) */
export function totalNumbers(list: PlatformNumbers[]): PlatformNumbers | null {
  if (!list.length) return null;
  const reach = add(list.map((p) => p.reach));
  const interactions = add(list.map((p) => p.interactions));
  return {
    platform: list[0].platform,
    followers: add(list.map((p) => p.followers)),
    netFollowers: add(list.map((p) => p.netFollowers)),
    reach,
    reachBefore: add(list.map((p) => p.reachBefore)),
    views: add(list.map((p) => p.views)),
    interactions,
    rate: reach != null && reach > 0 && interactions != null ? interactions / reach : null,
    profileViews: add(list.map((p) => p.profileViews)),
    posts: list.reduce((n, p) => n + p.posts, 0),
    postsThisMonth: list.reduce((n, p) => n + p.postsThisMonth, 0),
    videoPosts: list.reduce((n, p) => n + p.videoPosts, 0),
    saves: add(list.map((p) => p.saves)),
    shares: add(list.map((p) => p.shares)),
    lastPostAt: list.map((p) => p.lastPostAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
  };
}

/** The board's overview over many accounts, for one platform or all: reach, interactions, the rate, followers, posts */
export function boardTotals(scores: (SocialAccountScore | null | undefined)[], pick: PlatformPick): PlatformNumbers | null {
  const list = scores.flatMap((s) => (s?.platforms ?? []).filter((p) => pick === "all" || p.platform === pick).map((p) => p.numbers));
  return totalNumbers(list);
}

/** The 7-day engagement rate for one platform (or all added up), a point per day from `from` to `to` */
export function platformRate(days: { platform: string; date: string; interactions: number | null; reach: number | null }[], pick: PlatformPick, from: string, to: string): (number | null)[] {
  const by = new Map<string, { date: string; interactions: number | null; reach: number | null }>();
  for (const d of days) {
    if (pick !== "all" && d.platform !== pick) continue;
    const x = by.get(d.date) ?? { date: d.date, interactions: null, reach: null };
    if (d.interactions != null) x.interactions = (x.interactions ?? 0) + d.interactions;
    if (d.reach != null) x.reach = (x.reach ?? 0) + d.reach;
    by.set(d.date, x);
  }
  return rollingRate([...by.values()], from, to);
}

export type RatedPost<T> = T & { rate: number | null };

/** The best and weakest posts on a platform (or all) by engagement over reach, posts with no reach left out */
export function topAndBottom<T extends { platform: string; reach: number | null; interactions: number | null }>(posts: T[], pick: PlatformPick, n = 3): { top: RatedPost<T>[]; bottom: RatedPost<T>[] } {
  const rated = posts
    .filter((p) => pick === "all" || p.platform === pick)
    .map((p) => ({ ...p, rate: p.reach && p.reach > 0 && p.interactions != null ? p.interactions / p.reach : null }))
    .filter((p) => p.rate != null)
    .sort((a, b) => b.rate! - a.rate!);
  const top = rated.slice(0, n);
  const bottom = rated.length > n ? rated.slice(-n).reverse().filter((p) => !top.includes(p)) : [];
  return { top, bottom };
}
