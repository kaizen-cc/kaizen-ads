import { shiftDay, type SocialClientState, type SocialPlainError } from "@/lib/social/core";
import { bestAndWeakest, formatStats, type PostView } from "@/lib/social/insights";
import type { ClientSocial } from "@/lib/social/store";

// What the organic_social tool hands the AI, worked out from a client's social pulse (src/lib/social/store.ts
// clientSocial, which already does the metric math). Pure, so the period maths and the "not linked yet" wording are
// tested without a database (tests/social-report.test.ts). Rates come in as 0..1 and go out as percentages.

const r1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 10);

type Points = { date: string; value: number | null }[];

/** A series summed over [from, to] (null when no day in it has a value) */
function sumBetween(points: Points, from: string, to: string): number | null {
  let total = 0;
  let any = false;
  for (const p of points) {
    if (p.date < from || p.date > to || p.value == null) continue;
    total += p.value;
    any = true;
  }
  return any ? total : null;
}

/** Followers on a day, or the nearest earlier day that has a count */
function followersOn(series: ClientSocial["followers"], day: string): number | null {
  let hit: number | null = null;
  for (const p of series) if (p.date <= day && p.followers != null) hit = p.followers;
  return hit;
}

const change = (now: number | null, before: number | null) => (now != null && before != null && before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

export type SocialReportOpts = { days: number; top: number };

/** The numbers for the last `days` days (through today) against the same length before (when 90 days of numbers cover it) */
export function organicSocialReport(d: ClientSocial, o: SocialReportOpts) {
  const days = Math.min(90, Math.max(7, Math.round(o.days)));
  const from = shiftDay(d.today, -(days - 1));
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(from, -days);
  // The daily series cover 90 days: a comparison period outside them is left out rather than guessed
  const hasPrev = days * 2 <= 90;
  const reach = sumBetween(d.reach, from, d.today);
  const prevReach = hasPrev ? sumBetween(d.reach, prevFrom, prevTo) : null;
  const inter = sumBetween(d.interactions, from, d.today);
  const prevInter = hasPrev ? sumBetween(d.interactions, prevFrom, prevTo) : null;
  const rate = reach && inter != null ? inter / reach : null;
  const prevRate = prevReach && prevInter != null ? prevInter / prevReach : null;
  const fNow = followersOn(d.followers, d.today);
  const fStart = followersOn(d.followers, shiftDay(from, -1));

  const posts: PostView[] = d.posts.filter((p) => p.postedAt != null && p.postedAt.slice(0, 10) >= from);
  const { best, weakest } = bestAndWeakest(posts, Math.min(10, Math.max(1, o.top)));
  const postOut = (p: PostView) => ({
    posted: p.postedAt?.slice(0, 10) ?? null,
    platform: p.platform,
    format: p.format,
    caption: p.caption ? p.caption.replace(/\s+/g, " ").slice(0, 140) : null,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    saves: p.saves,
    reach: p.reach,
    views: p.views,
    interactions: p.interactions,
    engagement_rate_pct: pct(p.rate),
    rate_is_over: p.rateBasis === "followers" ? "followers (this post's reach isn't given)" : p.rateBasis === "reach" ? "reach" : null,
    link: p.permalink,
  });

  return {
    period: { from, to: d.today, days },
    data_through: d.through,
    followers: { now: fNow, change: fNow != null && fStart != null ? fNow - fStart : null, change_pct: change(fNow, fStart) },
    reach: { total: reach, previous: prevReach, change_pct: change(reach, prevReach) },
    interactions: { total: inter, previous: prevInter },
    engagement_rate_pct: pct(rate),
    previous_engagement_rate_pct: pct(prevRate),
    // Views, profile visits and follows gained and lost are kept per platform for the last 30 days only
    last_30_days_account: { views: d.now.views, profile_views: d.now.profileViews, accounts_engaged: d.now.engaged, follows_gained: d.now.gained, follows_lost: d.now.lost },
    platforms: d.platforms.map((p) => ({
      platform: p.platform,
      account: p.name,
      followers: p.followers,
      followers_change_30d: p.growth?.change ?? null,
      followers_change_the_30_before: p.growth?.prevChange ?? null,
      reach_30d: p.now.reach,
      reach_the_30_before: p.before.reach,
      engagement_rate_30d_pct: pct(p.now.rate),
      posts_30d: p.posts30,
      posts_per_week: r1(p.postsPerWeek),
      last_post: p.lastPostAt?.slice(0, 10) ?? null,
      longest_gap_days_30d: p.longestGap,
      reach_and_engagement_read: p.insightsRead,
    })),
    posts_in_period: posts.length,
    posts_per_week: r1(posts.length / (days / 7)),
    formats: formatStats(posts).map((f) => ({ format: f.format, posts: f.count, typical_engagement_rate_pct: pct(f.typicalRate), average_reach: f.avgReach == null ? null : Math.round(f.avgReach) })),
    top_posts: best.map(postOut),
    weakest_posts: weakest.map(postOut),
    health: d.health.map((h) => ({ tone: h.tone === "bad" ? "red" : h.tone === "warn" ? "amber" : "green", finding: h.title, detail: h.detail, what_to_do: h.action })),
    warning: d.warning,
  };
}

/** What to say when there are no numbers: whether the Page is linked, failing or just not read yet, and the next step */
export function socialMissingNote(state: SocialClientState | null, error: SocialPlainError | null, buysSocial: boolean): string {
  const pre = buysSocial ? "" : "This client doesn't have Social Media Management on their services, so no Page is expected yet. ";
  if (state === "failing")
    return `${pre}Their Page or Instagram is linked but the last read failed: ${error?.message ?? "Meta refused the read"}. An executive can fix it from the client's Social tab or Sync health${error?.fix ? ` (${error.fix})` : ""}. Until then, work from the context and calls.`;
  if (state === "pending") return `${pre}Their Page is linked but the first read hasn't run yet. The numbers arrive within a day; check back tomorrow.`;
  if (state === "connected" || state === "behind") return `${pre}Their Page is linked but no numbers have come back yet (a brand new account, or Meta isn't giving insights for it). Check the client's Social tab for the exact reason.`;
  return `${pre}This client's Facebook Page and Instagram account aren't linked yet, so there are no numbers. To fix it: ask the client to share the Page and the Instagram account with Kaizen's Business Manager (Page access for Kaizen's system user), or pick the Page on the client's Social tab. The numbers are read the day after.`;
}
