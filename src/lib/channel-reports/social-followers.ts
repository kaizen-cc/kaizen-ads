import type { SocialNumbers } from "./core";

// Followers across platforms, compared fairly. A platform whose follower count for the period before is missing (Meta
// often gives Instagram no follower number on older days) used to drop out of the prior total while still counting in
// this period's, so two platforms were compared against one ("20,474, up 220.8% vs 6,383"). Here the prior count is
// filled from this period's (followers now less the net change) and, when a platform still has none, there is no prior
// total at all: never a sum of a different set of platforms. Pure (types only), so core.ts and the PDF both use it.

type Side = Pick<SocialNumbers, "followers" | "followerChange" | "followersStart">;
type Pair = { now: Side; before: Side };

/** A platform's prior follower count filled in from this period's (followers now less the net change) when it's missing */
export function fillPriorFollowers<T extends Pair>(p: T): T {
  const start = p.now.followers != null && p.now.followerChange != null ? p.now.followers - p.now.followerChange : null;
  const before = p.before.followers ?? start;
  const followersStart = p.now.followersStart ?? start;
  if (before === p.before.followers && followersStart === p.now.followersStart) return p;
  return { ...p, now: { ...p.now, followersStart }, before: { ...p.before, followers: before } };
}

/** The prior total of followers over the same platforms as this period's total (null when any of them has no prior count) */
export function priorFollowersOver(now: Side[], before: Side[]): number | null {
  let total = 0;
  let any = false;
  for (let i = 0; i < now.length; i++) {
    if (now[i].followers == null) continue;
    const b = before[i]?.followers;
    if (b == null) return null;
    total += b;
    any = true;
  }
  return any ? total : null;
}

export type FollowerView = {
  /** Followers across the platforms at the period's end */
  total: number | null;
  /** Net followers over the period (gained less lost, or end against start), all platforms */
  change: number | null;
  /** The net change against the follower count the period started at */
  growth: number | null;
  /** The same platforms' total at the end of the period before (null when it can't be compared fairly) */
  prior: number | null;
};

/** Followers on a report: the total, the net change and its growth, and the prior total over the same platforms */
export function followerView(platforms: Pair[]): FollowerView {
  const filled = platforms.map(fillPriorFollowers);
  const counted = filled.filter((p) => p.now.followers != null);
  const total = counted.length ? counted.reduce((n, p) => n + (p.now.followers ?? 0), 0) : null;
  const changes = filled.filter((p) => p.now.followerChange != null);
  const change = changes.length ? changes.reduce((n, p) => n + (p.now.followerChange ?? 0), 0) : null;
  const start = total != null && change != null ? total - change : null;
  return { total, change, growth: start != null && start > 0 && change != null ? change / start : null, prior: priorFollowersOver(filled.map((p) => p.now), filled.map((p) => p.before)) };
}
