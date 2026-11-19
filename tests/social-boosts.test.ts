import { describe, expect, it } from "vitest";
import { adPostIds, boostLine, needsBoostFlag, toBoosted } from "@/lib/social-boosts-core";

describe("which post an ad runs", () => {
  it("reads the Facebook post and the Instagram post from the creative", () => {
    expect(adPostIds({ creative: { effective_object_story_id: "105708345506759_1141539355290273", effective_instagram_media_id: "18120525920050036" } })).toEqual({ storyId: "105708345506759_1141539355290273", igMediaId: "18120525920050036" });
  });
  it("ignores anything that isn't a post id", () => {
    expect(adPostIds({ creative: { effective_object_story_id: "not-a-post" } })).toEqual({ storyId: null, igMediaId: null });
    expect(adPostIds(null)).toEqual({ storyId: null, igMediaId: null });
  });
});

describe("boosted posts in words", () => {
  const row = (spend: number, ads = 1) => toBoosted({ client_id: "c", platform: "instagram", post_id: "1", permalink: null, caption: null, thumbnail_url: null, posted_at: null, format: "reel", ads, spend_30d: String(spend), impressions_30d: 1000, last_spend_day: "2026-11-18", ad_names: ["Boost: patio reel", null as never] });
  it("adds up the spend, posts and ads", () => {
    expect(boostLine([row(800.4, 2), row(440)])).toBe("$1,240 behind 2 posts (3 ads), last 30 days");
    expect(row(10).adNames).toEqual(["Boost: patio reel"]);
  });
  it("says when nothing is boosted", () => {
    expect(boostLine([])).toBe("Nothing boosted in the last 30 days");
  });
});

describe("telling the team nothing is boosted", () => {
  const base = { social: true, meta: true, linked: true, strategyOnly: false, boosted: 0, dayOfMonth: 19 };
  it("flags a social and Meta client with nothing boosted past the 10th", () => {
    expect(needsBoostFlag(base)).toBe(true);
  });
  it("leaves out early in the month, no Meta ads, unlinked, strategy only, or something boosted", () => {
    expect(needsBoostFlag({ ...base, dayOfMonth: 5 })).toBe(false);
    expect(needsBoostFlag({ ...base, meta: false })).toBe(false);
    expect(needsBoostFlag({ ...base, linked: false })).toBe(false);
    expect(needsBoostFlag({ ...base, strategyOnly: true })).toBe(false);
    expect(needsBoostFlag({ ...base, boosted: 2 })).toBe(false);
  });
});
