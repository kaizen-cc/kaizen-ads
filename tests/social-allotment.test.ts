import { describe, expect, it } from "vitest";
import {
  addedPlatforms,
  cleanSocialCustom,
  parseRange,
  platformsFor,
  SOCIAL_TIERS,
  socialAllotmentLine,
  socialAllotmentPace,
  socialPace,
  socialPools,
  socialVeryBehind,
  tierText,
  toSocialAllotment,
  type SocialAllotmentRow,
} from "@/lib/social-allotment-core";
import { ALLOTMENT_CHECK, SOCIAL_CHECKS, socialAccountScore, socialCheckLine, type SocialDayRow, type SocialPostRow } from "@/lib/social-score";
import { parseIgStories } from "@/lib/social/core";

// Silver: 16 posts, 10 statics, 2 video/reels, 4 IG stories, a cycle from Nov 1 to Dec 1
const row = (p: Partial<SocialAllotmentRow> = {}): SocialAllotmentRow => ({
  client_id: "c",
  posts_min: 16,
  posts_per_month: 16,
  statics_min: 10,
  statics_per_month: 10,
  videos_min: 2,
  videos_per_month: 2,
  stories_min: 4,
  stories_per_month: 4,
  cap_source: "package",
  package_key: "silver",
  package_label: "Silver",
  sprint_until: null,
  sprint_after: null,
  extra_videos: 0,
  platforms: ["facebook", "instagram"],
  posts_used: 0,
  statics_used: 0,
  videos_used: 0,
  stories_used: 0,
  posts_progress: 0,
  posts_done: 0,
  statics_done: 0,
  videos_done: 0,
  stories_done: 0,
  period_start: "2026-11-01",
  period_end: "2026-12-01",
  ...p,
});
const at = (day: string) => new Date(`${day}T12:00:00`);

describe("the social tiers from the pricing deck", () => {
  it("holds the deck's numbers and platforms", () => {
    const by = Object.fromEntries(SOCIAL_TIERS.map((t) => [t.key, t]));
    expect(by.basic).toMatchObject({ posts: 12, statics: 12, videos: 0, stories: 0, platforms: ["facebook", "instagram"], minimumMonths: 2 });
    expect(by.silver).toMatchObject({ posts: 16, statics: 10, videos: 2, stories: 4, minimumMonths: 2 });
    expect(by.gold).toMatchObject({ posts: 22, statics: 10, videos: 4, stories: 8, platforms: ["facebook", "instagram", "tiktok"], minimumMonths: 3 });
    expect(by.platinum).toMatchObject({ posts: 30, statics: 12, videos: 6, stories: 12, platforms: ["facebook", "instagram", "tiktok", "linkedin"] });
  });
  it("says what a tier holds, leaving out what it doesn't", () => {
    expect(tierText(SOCIAL_TIERS[0])).toBe("12 posts, 12 statics");
    expect(tierText(SOCIAL_TIERS[1])).toBe("16 posts, 10 statics, 2 video/reels, 4 IG stories");
  });
});

describe("the platforms a client posts on", () => {
  it("defaults to the tier's, else Facebook and Instagram", () => {
    expect(platformsFor(null, "gold")).toEqual(["facebook", "instagram", "tiktok"]);
    expect(platformsFor(null, null)).toEqual(["facebook", "instagram"]);
    expect(platformsFor([], "basic")).toEqual(["facebook", "instagram"]);
  });
  it("keeps a pick in a fixed order and drops anything unknown", () => {
    expect(platformsFor(["linkedin", "facebook", "myspace"], "basic")).toEqual(["facebook", "linkedin"]);
  });
  it("counts platforms beyond the tier as add-ons", () => {
    expect(addedPlatforms(["facebook", "instagram", "linkedin"], "basic")).toBe(1);
    expect(addedPlatforms(["facebook"], "gold")).toBe(0);
    expect(addedPlatforms(["facebook", "instagram", "linkedin"], null)).toBe(0);
  });
});

describe("the social allotment", () => {
  it("shows each pool used/cap, in progress and published", () => {
    const a = toSocialAllotment(row({ posts_used: 9, posts_progress: 2, posts_done: 7, statics_used: 5, statics_done: 5 }));
    expect(socialAllotmentLine(a)).toBe("Posts 9/16 used · 2 in progress · 7 published · Statics 5/10 used · Video/reels 0/2 used · IG stories 0/4 used");
  });
  it("leaves out pools the tier doesn't hold, and ranges show as ranges", () => {
    const basic = toSocialAllotment(row({ package_key: "basic", package_label: "Basic", posts_per_month: 12, posts_min: 12, statics_per_month: 12, statics_min: 12, videos_per_month: 0, videos_min: 0, stories_per_month: 0, stories_min: 0 }));
    expect(socialPools(basic).map((p) => p.key)).toEqual(["posts", "statics"]);
    const custom = toSocialAllotment(row({ cap_source: "custom", package_key: "custom", posts_min: 8, posts_per_month: 10 }));
    expect(socialPools(custom)[0].range).toBe("8-10");
    expect(custom.label).toBe("Custom");
  });
  it("holds nothing for strategy only or no tier", () => {
    expect(socialPools(toSocialAllotment(row({ cap_source: "strategy" })))).toEqual([]);
    expect(socialAllotmentPace(toSocialAllotment(row({ cap_source: "strategy" })), at("2026-11-20"))).toBeNull();
    expect(socialAllotmentPace(toSocialAllotment(row({ cap_source: null, package_key: null, posts_per_month: null, statics_per_month: null, videos_per_month: null, stories_per_month: null })), at("2026-11-20"))).toBeNull();
  });
  it("reads a sprint with its day and what follows", () => {
    const a = toSocialAllotment(row({ cap_source: "sprint", package_key: "custom", sprint_until: "2026-12-15", sprint_after: "basic" }));
    expect(a.sprint).toEqual({ until: "2026-12-15", after: "basic" });
    expect(a.label).toBe("Sprint");
  });
});

describe("social allotment pacing", () => {
  it("gives the first 15% of the cycle grace", () => {
    expect(socialAllotmentPace(toSocialAllotment(row()), at("2026-11-04"))).toBeNull();
  });
  it("is the share used against the share of the cycle gone, over the cap counted at the cap", () => {
    // 32 pool units; 8 posts + 20 statics (10 counted) = 18 of 32
    const p = socialAllotmentPace(toSocialAllotment(row({ posts_used: 8, statics_used: 20 })), at("2026-11-16"))!;
    expect(p.used).toBeCloseTo(18 / 32, 5);
    expect(p.expected).toBeCloseTo(0.5, 1);
  });
  it("groups behind, on pace and over", () => {
    expect(socialPace(toSocialAllotment(row({ posts_used: 2 })), at("2026-11-20")).group).toBe("behind");
    expect(socialPace(toSocialAllotment(row({ posts_used: 16, statics_used: 10, videos_used: 2, stories_used: 4 })), at("2026-11-20")).group).toBe("pace");
    expect(socialPace(toSocialAllotment(row({ posts_used: 20, statics_used: 10, videos_used: 2, stories_used: 4 })), at("2026-11-20")).group).toBe("over");
  });
  it("is very behind under half the pace past half the cycle, and short in its last week", () => {
    expect(socialVeryBehind(toSocialAllotment(row({ posts_used: 3 })), at("2026-11-20"))?.kind).toBe("behind");
    expect(socialVeryBehind(toSocialAllotment(row({ posts_used: 10, statics_used: 8, videos_used: 1, stories_used: 2 })), at("2026-11-20"))).toBeNull();
    const late = socialVeryBehind(toSocialAllotment(row({ posts_used: 14, statics_used: 10, videos_used: 2, stories_used: 4 })), at("2026-11-27"));
    expect(late?.kind).toBe("last_week");
    expect(late?.text).toContain("Posts 14 of 16");
  });
});

describe("custom numbers", () => {
  it("reads ranges", () => {
    expect(parseRange("3-5")).toEqual([3, 5]);
    expect(parseRange("5-3")).toEqual([3, 5]);
    expect(parseRange("4")).toEqual([4, 4]);
    expect(parseRange("")).toEqual([0, 0]);
  });
  it("keeps every pool whole, in range, a min never above its max", () => {
    expect(cleanSocialCustom({ posts: 12.4, posts_min: 20, statics: -3, videos: 2, videos_min: 1, stories: 999 })).toEqual({ posts: 12, posts_min: 12, statics: 0, statics_min: 0, videos: 2, videos_min: 1, stories: 200, stories_min: 200 });
  });
});

describe("Instagram stories", () => {
  it("parses the live stories", () => {
    expect(parseIgStories({ data: [{ id: "1", media_type: "IMAGE", permalink: "https://x", timestamp: "2026-11-19T10:00:00+0000" }, { media_type: "VIDEO" }] })).toEqual([{ id: "1", mediaType: "IMAGE", permalink: "https://x", postedAt: "2026-11-19T10:00:00+0000" }]);
  });
});

// The account score with allotment pacing
const today = "2026-11-19";
const days: SocialDayRow[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.parse(`${today}T12:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
  return [
    { platform: "instagram", date: d, followers: 1000 + (30 - i), gained: 2, lost: 1, reach: 500, interactions: 30, profileViews: 25 },
    { platform: "facebook", date: d, followers: 800, gained: 1, lost: 1, reach: 300, interactions: 15, profileViews: 10 },
  ];
}).flat();
const posts: SocialPostRow[] = Array.from({ length: 10 }, (_, i) => [
  { platform: "instagram", postedAt: `2026-11-${String(i + 2).padStart(2, "0")}T15:00:00Z`, format: i % 3 ? "image" : "reel", reach: 400, interactions: 25, saves: 2, shares: 2 },
  { platform: "facebook", postedAt: `2026-11-${String(i + 2).padStart(2, "0")}T15:00:00Z`, format: "image", reach: 200, interactions: 10, saves: null, shares: 1 },
]).flat();

describe("allotment pacing in the social score", () => {
  it("is worth 10 of 100, beside the platform checks", () => {
    expect(ALLOTMENT_CHECK.weight).toBe(10);
    expect(SOCIAL_CHECKS.some((c) => c.key === ("allotment" as string))).toBe(false);
  });
  it("leaves the score as before when not measured", () => {
    const before = socialAccountScore({ days, posts, today })!;
    const none = socialAccountScore({ days, posts, today, allotment: null })!;
    expect(none.score).toBe(before.score);
    expect(none.checks.find((c) => c.key === "allotment")!.value).toBeNull();
    expect(none.unmeasured).toContain("allotment");
  });
  it("on pace takes nothing off; far behind costs all 10", () => {
    const base = socialAccountScore({ days, posts, today })!;
    const onPace = socialAccountScore({ days, posts, today, allotment: { used: 0.7, expected: 0.6 } })!;
    // The platform checks make 90 of 100, allotment pacing the other 10
    expect(Math.abs(onPace.score - (base.score * 0.9 + 10))).toBeLessThanOrEqual(1);
    const ok = onPace.checks.find((c) => c.key === "allotment")!;
    expect(ok.met).toBe(true);
    expect(ok.points).toBe(10);
    const behind = socialAccountScore({ days, posts, today, allotment: { used: 0.2, expected: 0.6 } })!;
    const c = behind.checks.find((x) => x.key === "allotment")!;
    expect(c.points).toBe(0);
    expect(behind.score).toBeLessThan(onPace.score);
    expect(onPace.score - behind.score).toBeGreaterThanOrEqual(9);
    const drag = behind.weighingDown.find((d) => d.key === "allotment")!;
    expect(drag.platform).toBe("account");
    expect(drag.cost).toBe(10);
    expect(socialCheckLine(drag, drag.platform)).toBe("Allotment pacing: 20% of the allotment used with 60% of the billing cycle gone, costing 10.0 of 10 points");
  });
  it("weighs every check to 100 when measured", () => {
    const s = socialAccountScore({ days, posts, today, allotment: { used: 0.5, expected: 0.6 } })!;
    expect(s.checks.reduce((n, c) => n + c.weight, 0)).toBeCloseTo(100, 5);
  });
  it("scores only the platforms the client posts on", () => {
    const s = socialAccountScore({ days, posts, today, platforms: ["instagram"] })!;
    expect(s.platforms.map((p) => p.platform)).toEqual(["instagram"]);
  });
});
