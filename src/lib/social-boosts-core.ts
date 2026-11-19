// Boosted posts (Head of Social, Nov 19 2026): the organic posts the ads team is putting money behind. Pure parts,
// shared by the sync, the KPI sheet, the alerts, the assistant and the tests (tests/social-boosts.test.ts).

export type BoostedPost = {
  clientId: string;
  platform: "facebook" | "instagram";
  postId: string;
  permalink: string | null;
  caption: string | null;
  thumbnail: string | null;
  postedAt: string | null;
  format: string | null;
  ads: number;
  spend30d: number;
  impressions30d: number;
  lastSpendDay: string | null;
  adNames: string[];
};

export type BoostedRow = {
  client_id: string;
  platform: string;
  post_id: string;
  permalink: string | null;
  caption: string | null;
  thumbnail_url: string | null;
  posted_at: string | null;
  format: string | null;
  ads: number;
  spend_30d: number | string | null;
  impressions_30d: number | string | null;
  last_spend_day: string | null;
  ad_names: string[] | null;
};

export const toBoosted = (r: BoostedRow): BoostedPost => ({
  clientId: r.client_id,
  platform: r.platform === "instagram" ? "instagram" : "facebook",
  postId: r.post_id,
  permalink: r.permalink,
  caption: r.caption,
  thumbnail: r.thumbnail_url,
  postedAt: r.posted_at,
  format: r.format,
  ads: Number(r.ads) || 0,
  spend30d: Number(r.spend_30d) || 0,
  impressions30d: Number(r.impressions_30d) || 0,
  lastSpendDay: r.last_spend_day,
  adNames: (r.ad_names ?? []).filter(Boolean),
});

/** What Meta says an ad's creative runs: the Facebook post ("<page>_<post>") and the Instagram post, when it's a post */
export function adPostIds(ad: { creative?: { effective_object_story_id?: string | null; effective_instagram_media_id?: string | null } | null } | null | undefined): { storyId: string | null; igMediaId: string | null } {
  const c = ad?.creative ?? null;
  const story = c?.effective_object_story_id && /^\d+_\d+$/.test(c.effective_object_story_id) ? c.effective_object_story_id : null;
  const ig = c?.effective_instagram_media_id && /^\d+$/.test(c.effective_instagram_media_id) ? c.effective_instagram_media_id : null;
  return { storyId: story, igMediaId: ig };
}

/** "$1,240 behind 3 posts (5 ads)" / "Nothing boosted in the last 30 days" */
export function boostLine(posts: readonly BoostedPost[]): string {
  if (!posts.length) return "Nothing boosted in the last 30 days";
  const spend = posts.reduce((n, p) => n + p.spend30d, 0);
  const ads = posts.reduce((n, p) => n + p.ads, 0);
  return `$${Math.round(spend).toLocaleString("en-US")} behind ${posts.length} post${posts.length === 1 ? "" : "s"} (${ads} ad${ads === 1 ? "" : "s"}), last 30 days`;
}

/**
 * Whether to tell the social strategist and the media buyer that nothing is boosted: the client buys Social Media and
 * Meta ads, its Page or Instagram is linked (so a boost could be matched), nothing was boosted in the last 30 days, and
 * it's past the first 10 days of the month (a new month starts quiet).
 */
export function needsBoostFlag(c: { social: boolean; meta: boolean; linked: boolean; strategyOnly: boolean; boosted: number; dayOfMonth: number }): boolean {
  return c.social && c.meta && c.linked && !c.strategyOnly && c.boosted === 0 && c.dayOfMonth > 10;
}
