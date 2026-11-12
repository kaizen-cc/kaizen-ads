import { describe, expect, it } from "vitest";
import { dayOfEndTime, igFormat, invalidMetric, matchPage, missingPermission, parseFbPosts, parseIgMedia, parseIgPostInsights, parseSeries, parseTotals, pickSocialWindow, plainSocialError, socialClientState, withIgInsights } from "@/lib/social/core";
import { ENGAGEMENT_BENCH, bestAndWeakest, engagementRate, filterPosts, followerGrowth, followerSeries, formatStats, longestGap, postRate, postsPerWeek, socialHealth, socialStatus, sortPosts, sumField, windowOf, withRates, type DailyRow, type PlatformPulse } from "@/lib/social/insights";
import { combineFollowers, dailyTotal, rateSeries } from "@/lib/social/charts";

const row = (date: string, platform: "instagram" | "facebook", o: Partial<DailyRow> = {}): DailyRow => ({ platform, date, followers: null, gained: null, lost: null, reach: null, views: null, profileViews: null, engaged: null, interactions: null, ...o });

describe("reading Meta's answers", () => {
  it("dates a day's value by the midnight it closes", () => {
    expect(dayOfEndTime("2026-11-02T08:00:00+0000")).toBe("2026-11-01");
    expect(dayOfEndTime("2026-03-09T07:00:00+0000")).toBe("2026-03-08");
    expect(dayOfEndTime("nonsense")).toBeNull();
  });

  it("reads a daily series per metric and ignores breakdown values", () => {
    const s = parseSeries({ data: [{ name: "reach", values: [{ value: 10, end_time: "2026-11-02T08:00:00+0000" }, { value: 20, end_time: "2026-11-03T08:00:00+0000" }] }, { name: "follower_count", values: [{ value: { a: 1 }, end_time: "2026-11-02T08:00:00+0000" }] }] });
    expect(s.get("reach")?.get("2026-11-01")).toBe(10);
    expect(s.get("reach")?.get("2026-11-02")).toBe(20);
    expect(s.get("follower_count")?.size).toBe(0);
  });

  it("reads total_value answers", () => {
    const t = parseTotals({ data: [{ name: "views", total_value: { value: 120 } }, { name: "profile_views", total_value: { value: 0 } }] });
    expect(t.get("views")).toBe(120);
    expect(t.get("profile_views")).toBe(0);
  });

  it("reads Instagram media into formats and counts", () => {
    const posts = parseIgMedia({ data: [{ id: "1", media_type: "VIDEO", media_product_type: "REELS", like_count: 10, comments_count: 2, timestamp: "2026-11-01T10:00:00+0000", permalink: "https://ig/1", thumbnail_url: "t" }, { id: "2", media_type: "CAROUSEL_ALBUM", comments_count: 1 }] });
    expect(posts[0]).toMatchObject({ format: "reel", interactions: 12, thumbnail: "t" });
    expect(posts[1]).toMatchObject({ format: "carousel", likes: null, interactions: 1 });
    expect(igFormat("IMAGE", "FEED")).toBe("image");
    expect(igFormat("VIDEO", "FEED")).toBe("video");
  });

  it("lays Instagram insights on a post: total interactions win, else the parts add up", () => {
    const [p] = parseIgMedia({ data: [{ id: "1", media_type: "IMAGE", like_count: 10, comments_count: 2 }] });
    const ins = parseIgPostInsights({ data: [{ name: "reach", values: [{ value: 500 }] }, { name: "saved", values: [{ value: 5 }] }, { name: "shares", values: [{ value: 3 }] }, { name: "views", values: [{ value: 700 }] }] });
    expect(withIgInsights(p, ins)).toMatchObject({ reach: 500, saves: 5, shares: 3, views: 700, interactions: 20, insightsOk: true });
    const withTotal = withIgInsights(p, { ...ins, totalInteractions: 33 });
    expect(withTotal.interactions).toBe(33);
    expect(withIgInsights(p, null).insightsOk).toBe(false);
  });

  it("reads Facebook posts: reactions, comments and shares", () => {
    const posts = parseFbPosts({ data: [{ id: "9_1", message: "hi", created_time: "2026-11-01T10:00:00+0000", reactions: { summary: { total_count: 8 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 }, attachments: { data: [{ media_type: "video" }] } }, { id: "9_2", full_picture: "p", attachments: { data: [{ media_type: "photo" }] } }, { id: "9_3", message: "text only" }] });
    expect(posts[0]).toMatchObject({ format: "video", likes: 8, comments: 2, shares: 1, interactions: 11 });
    expect(posts[1].format).toBe("image");
    expect(posts[2].format).toBe("text");
  });
});

describe("finding the client's Page", () => {
  const pages = [{ id: "1", name: "Joe's Pizza" }, { id: "2", name: "Joes Pizza Catering" }, { id: "3", name: "Acme Gym" }];
  it("prefers an exact name, ignoring case, spaces and punctuation", () => {
    expect(matchPage(pages, "Joes Pizza")?.id).toBe("1");
    expect(matchPage(pages, "ACME GYM")?.id).toBe("3");
  });
  it("matches one name inside the other when it's the only fit", () => {
    expect(matchPage(pages, "Acme Gym Houston")?.id).toBe("3");
  });
  it("doesn't guess between equal fits", () => {
    expect(matchPage([{ id: "1", name: "Blue Fox Spa" }, { id: "2", name: "Blue Fox Gym" }], "Blue Fox")).toBeNull();
  });
  it("takes a list of one only when asked", () => {
    expect(matchPage([{ id: "7", name: "Totally Different" }], "Acme")).toBeNull();
    expect(matchPage([{ id: "7", name: "Totally Different" }], "Acme", { onlyOneFallback: true })?.id).toBe("7");
  });
  it("doesn't match on a very short name", () => {
    expect(matchPage([{ id: "1", name: "Ace Hardware" }], "Ace")).toBeNull();
  });
});

describe("what a failure means", () => {
  it("names the permission Meta names", () => {
    expect(missingPermission("ig_insights", { message: "(#10) This endpoint requires the 'instagram_manage_insights' permission", code: 10 })).toBe("instagram_manage_insights");
  });
  it("falls back to the permission the read needs", () => {
    expect(missingPermission("fb_insights", { message: "(#200) Requires extended permission", code: 200 })).toBe("read_insights");
    expect(missingPermission("ig_insights", { message: "Permissions error", code: 10 })).toBe("instagram_manage_insights");
    expect(missingPermission("fb_posts", { message: "(#10) nope", code: 10 })).toBe("pages_read_engagement");
  });
  it("is not a permission when the object can't be seen or Meta is busy", () => {
    expect(missingPermission("fb_basic", { message: "Unsupported get request. Object with ID '1' does not exist, cannot be loaded due to missing permissions, or does not support this operation", code: 100 })).toBeNull();
    expect(missingPermission("fb_basic", { message: "Meta: rate limited", code: 4 })).toBeNull();
  });
  it("tells an invalid metric from the rest", () => {
    expect(invalidMetric({ message: "(#100) The value must be a valid insights metric", code: 100 })).toBe(true);
    expect(invalidMetric({ message: "Meta: rate limited", code: 4 })).toBe(false);
  });
  it("says exactly which permission to add", () => {
    const e = plainSocialError("Meta (insights): (#10) permission", ["instagram_manage_insights", "read_insights"]);
    expect(e?.severity).toBe("bad");
    expect(e?.message).toContain("instagram_manage_insights, read_insights");
    expect(e?.fix).toContain("Add instagram_manage_insights, read_insights");
    expect(plainSocialError(null, [])).toBeNull();
    expect(plainSocialError("Meta is rate limiting (#4)")?.severity).toBe("warn");
    expect(plainSocialError("The system user has no access to this Page")?.fix).toMatch(/assign the Page/i);
  });
  it("never has an em dash in what people read", () => {
    const texts = [plainSocialError("x", ["read_insights"]), plainSocialError("No Page found: link one"), plainSocialError("Meta isn't connected")].map((e) => `${e?.message} ${e?.fix}`);
    for (const t of texts) expect(t).not.toContain("—");
  });
});

describe("each client's state for Sync health", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("is missing without a Page or Instagram account", () => {
    expect(socialClientState(null, now).state).toBe("missing");
    expect(socialClientState({ pageId: null, igId: null, lastSyncedAt: null, error: null }, now).state).toBe("missing");
  });
  it("is failing on a missing permission, with the fix", () => {
    const s = socialClientState({ pageId: "1", igId: "2", lastSyncedAt: "2026-11-12T11:00:00Z", error: null, missing: ["instagram_manage_insights"] }, now);
    expect(s.state).toBe("failing");
    expect(s.error?.permissions).toEqual(["instagram_manage_insights"]);
  });
  it("is pending, connected or behind by the last read", () => {
    expect(socialClientState({ pageId: "1", igId: null, lastSyncedAt: null, error: null }, now).state).toBe("pending");
    expect(socialClientState({ pageId: "1", igId: null, lastSyncedAt: "2026-11-12T08:00:00Z", error: null }, now).state).toBe("connected");
    expect(socialClientState({ pageId: "1", igId: null, lastSyncedAt: "2026-11-10T08:00:00Z", error: null }, now).state).toBe("behind");
  });
  it("reads in full when it never has or a day has passed", () => {
    expect(pickSocialWindow({ lastFullAt: null })).toBe("full");
    expect(pickSocialWindow({ lastFullAt: "2026-11-12T10:00:00Z", now })).toBe("recent");
    expect(pickSocialWindow({ lastFullAt: "2026-11-11T10:00:00Z", now })).toBe("full");
  });
});

describe("windows and rates", () => {
  const rows = [row("2026-11-01", "instagram", { reach: 100, interactions: 10 }), row("2026-11-02", "instagram", { reach: 100, interactions: 20 }), row("2026-11-02", "facebook", { reach: 50, interactions: null })];
  it("adds a field over a window and leaves null where nothing was read", () => {
    expect(sumField(rows, "reach", "2026-11-01", "2026-11-02")).toBe(250);
    expect(sumField(rows, "views", "2026-11-01", "2026-11-02")).toBeNull();
    expect(sumField(rows, "reach", "2026-10-01", "2026-10-31")).toBeNull();
  });
  it("computes the engagement rate from interactions over reach", () => {
    expect(engagementRate(30, 200)).toBeCloseTo(0.15);
    expect(engagementRate(30, 0)).toBeNull();
    expect(engagementRate(null, 200)).toBeNull();
    expect(windowOf(rows, "2026-11-01", "2026-11-02").rate).toBeCloseTo(30 / 250);
  });
  it("rates a post on its reach, else on followers, and says which", () => {
    expect(postRate({ interactions: 10, reach: 200 }, 1000)).toEqual({ rate: 0.05, basis: "reach" });
    expect(postRate({ interactions: 10, reach: null }, 1000)).toEqual({ rate: 0.01, basis: "followers" });
    expect(postRate({ interactions: 10, reach: null }, null)).toEqual({ rate: null, basis: null });
    expect(postRate({ interactions: null, reach: 5 }, 100)).toEqual({ rate: null, basis: null });
  });
});

describe("followers over time", () => {
  it("walks back one day at a time", () => {
    const rows = [row("2026-11-03", "facebook", { followers: 1000, gained: 5, lost: 1 }), row("2026-11-02", "facebook", { gained: 10, lost: 4 })];
    const s = followerSeries(rows, { from: "2026-11-01", today: "2026-11-03", current: null, lossKnown: true });
    // 11-02 = 1000 - (5 - 1) = 996; 11-01 = 996 - (10 - 4) = 990
    expect(s.map((p) => p.followers)).toEqual([990, 996, 1000]);
    expect(s.every((p) => !p.estimated)).toBe(true);
  });

  it("uses the live count for today and marks Instagram's rebuilt days as estimates (no unfollows given)", () => {
    const rows = [row("2026-11-03", "instagram", { gained: 3 }), row("2026-11-02", "instagram", { gained: 2 })];
    const s = followerSeries(rows, { from: "2026-11-01", today: "2026-11-03", current: 500, lossKnown: false });
    expect(s.map((p) => p.followers)).toEqual([495, 497, 500]);
    expect(s[0].estimated).toBe(true);
    expect(s[2].estimated).toBe(false);
  });

  it("stays empty with nothing known", () => {
    const s = followerSeries([], { from: "2026-11-01", today: "2026-11-02", current: null, lossKnown: true });
    expect(s.every((p) => p.followers == null)).toBe(true);
    expect(followerGrowth(s, "2026-11-02")).toBeNull();
  });

  it("measures 30 days of growth against the 30 before", () => {
    const rows: DailyRow[] = [];
    for (let i = 0; i < 61; i++) {
      const d = new Date(Date.parse("2026-09-12T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      // 1000 at day 0, +1 a day for 30 days, then +3 a day
      rows.push(row(d, "facebook", { followers: i <= 30 ? 1000 + i : 1030 + (i - 30) * 3 }));
    }
    const today = rows[rows.length - 1].date;
    const s = followerSeries(rows, { from: rows[0].date, today, current: null, lossKnown: true });
    const g = followerGrowth(s, today)!;
    expect(g.now).toBe(1120);
    expect(g.change).toBe(90);
    expect(g.prevChange).toBe(30);
    expect(g.pct).toBeCloseTo(90 / 1030);
  });

  it("adds platforms up, a day carried back from a later count counting as an estimate", () => {
    const a = followerSeries([row("2026-11-02", "facebook", { followers: 100 })], { from: "2026-11-01", today: "2026-11-02", current: null, lossKnown: true });
    const b = followerSeries([row("2026-11-02", "instagram", { followers: 50 })], { from: "2026-11-01", today: "2026-11-02", current: null, lossKnown: false });
    const c = combineFollowers([a, b]);
    expect(c[1].followers).toBe(150);
    expect(c[0]).toMatchObject({ followers: 150, estimated: true });
    expect(combineFollowers([a, followerSeries([], { from: "2026-11-01", today: "2026-11-02", current: null, lossKnown: true })])[1].followers).toBe(100);
  });
});

const post = (id: string, o: Partial<ReturnType<typeof parseIgMedia>[number]> = {}) => ({ id, platform: "instagram" as const, format: "image" as const, caption: null, permalink: null, thumbnail: null, postedAt: "2026-11-10T12:00:00Z", likes: 10, comments: 1, shares: null, saves: null, reach: 100, views: null, interactions: 11, insightsOk: true, ...o });

describe("posts", () => {
  const posts = withRates(
    [post("a", { interactions: 50, reach: 100 }), post("b", { interactions: 5, reach: 100 }), post("c", { interactions: 20, reach: 100, format: "reel" }), post("d", { interactions: 1, reach: 100 }), post("e", { interactions: 30, reach: 100, platform: "facebook", postedAt: "2026-08-01T12:00:00Z" })],
    { instagram: 1000, facebook: 500 },
  );
  it("sorts by a column and turns it around", () => {
    expect(sortPosts(posts, "rate").map((p) => p.id)).toEqual(["a", "e", "c", "b", "d"]);
    expect(sortPosts(posts, "rate", "asc")[0].id).toBe("d");
    expect(sortPosts(posts, "date")[0].id).not.toBe("e");
  });
  it("filters by platform and window", () => {
    expect(filterPosts(posts, { platform: "all", days: 30 }, "2026-11-12").map((p) => p.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(filterPosts(posts, { platform: "facebook", days: 90 }, "2026-11-12")).toHaveLength(0);
    expect(filterPosts(posts, { platform: "facebook", days: 90 }, "2026-08-20")).toHaveLength(1);
  });
  it("picks the best and weakest, never the same post twice", () => {
    const { best, weakest } = bestAndWeakest(posts, 2);
    expect(best.map((p) => p.id)).toEqual(["a", "e"]);
    expect(weakest.map((p) => p.id)).toEqual(["d", "b"]);
    expect(bestAndWeakest(posts.slice(0, 2)).weakest).toEqual([]);
  });
  it("sums formats by count with a typical rate", () => {
    const f = formatStats(posts);
    expect(f.find((x) => x.format === "image")?.count).toBe(4);
    expect(f.find((x) => x.format === "reel")?.typicalRate).toBeCloseTo(0.2);
  });
  it("counts posts a week and the longest silence", () => {
    const ps = [{ postedAt: "2026-11-01T12:00:00Z" }, { postedAt: "2026-11-02T12:00:00Z" }, { postedAt: "2026-11-09T12:00:00Z" }];
    expect(postsPerWeek(ps, "2026-11-01", "2026-11-14")).toBe(1.5);
    // Posts on the 1st, 2nd and 9th, then nothing to the 14th: the gap 2nd to 9th is 6 empty days
    expect(longestGap(ps, "2026-11-01", "2026-11-14")).toBe(6);
    expect(longestGap([], "2026-11-01", "2026-11-14")).toBe(14);
  });
});

describe("health", () => {
  const empty = { reach: null, views: null, interactions: null, profileViews: null, engaged: null, gained: null, lost: null, rate: null };
  const pulse = (o: Partial<PlatformPulse> = {}): PlatformPulse => ({ platform: "instagram", name: "acme", followers: 1000, growth: null, now: empty, before: empty, posts30: 12, postsPerWeek: 2.8, lastPostAt: "2026-11-11T12:00:00Z", longestGap: 3, formats: [], insightsRead: true, ...o });
  const run = (o: Partial<PlatformPulse>) => socialHealth({ today: "2026-11-12", platforms: [pulse(o)] });

  it("flags an account that stopped posting, worst first", () => {
    const h = run({ lastPostAt: "2026-10-20T12:00:00Z", postsPerWeek: 0.2 });
    expect(h[0]).toMatchObject({ tone: "bad" });
    expect(h[0].title).toMatch(/23 days/);
    expect(h[0].action).toBeTruthy();
  });
  it("flags lost followers red and strong growth green", () => {
    expect(run({ growth: { now: 900, change: -40, pct: -0.04, prevChange: 5, estimated: false } }).some((f) => f.id === "instagram-followers-down" && f.tone === "bad")).toBe(true);
    expect(run({ growth: { now: 1100, change: 60, pct: 0.06, prevChange: 5, estimated: false } }).some((f) => f.id === "instagram-followers-up" && f.tone === "good")).toBe(true);
  });
  it("reads reach against the 30 days before", () => {
    const w = (reach: number) => ({ ...empty, reach });
    expect(run({ now: w(500), before: w(1000) }).find((f) => f.id === "instagram-reach-down")?.tone).toBe("bad");
    expect(run({ now: w(750), before: w(1000) }).find((f) => f.id === "instagram-reach-down")?.tone).toBe("warn");
    expect(run({ now: w(1300), before: w(1000) }).find((f) => f.id === "instagram-reach-up")?.tone).toBe("good");
  });
  it("holds the engagement rate against its lines", () => {
    expect(run({ now: { ...empty, rate: 0.01 } }).some((f) => f.id === "instagram-engagement-low")).toBe(true);
    expect(run({ now: { ...empty, rate: ENGAGEMENT_BENCH.high + 0.01 } }).some((f) => f.id === "instagram-engagement-good")).toBe(true);
    expect(run({ now: { ...empty, rate: 0.03 }, before: { ...empty, rate: 0.05 } }).some((f) => f.id === "instagram-engagement-down")).toBe(true);
  });
  it("notes no reels and a winning format", () => {
    expect(run({ formats: [{ format: "image", count: 12, typicalRate: 0.02, avgReach: 100 }] }).some((f) => f.id === "instagram-no-reels")).toBe(true);
    const win = run({ formats: [{ format: "reel", count: 4, typicalRate: 0.09, avgReach: 900 }, { format: "image", count: 8, typicalRate: 0.03, avgReach: 200 }] });
    expect(win.some((f) => f.id === "instagram-format-winner" && f.tone === "good")).toBe(true);
    expect(win.some((f) => f.id === "instagram-no-reels")).toBe(false);
  });
  it("is healthy with nothing red, and needs attention with a red", () => {
    expect(socialStatus([{ tone: "good" }]).label).toBe("Healthy");
    expect(socialStatus([{ tone: "warn" }, { tone: "warn" }, { tone: "warn" }]).label).toBe("Watch");
    expect(socialStatus([{ tone: "bad" }]).tone).toBe("bad");
  });
  it("never writes an em dash", () => {
    const h = run({ lastPostAt: "2026-10-01T12:00:00Z", growth: { now: 900, change: -40, pct: -0.04, prevChange: 5, estimated: false }, now: { ...empty, reach: 10, rate: 0.01 }, before: { ...empty, reach: 100, rate: 0.05 } });
    for (const f of h) expect(`${f.title} ${f.detail} ${f.action}`).not.toContain("—");
  });
});

describe("chart series", () => {
  it("totals a field across platforms per day, null where nothing was read", () => {
    const rows = [row("2026-11-01", "instagram", { reach: 10 }), row("2026-11-01", "facebook", { reach: 5 }), row("2026-11-03", "instagram", { reach: 7 })];
    expect(dailyTotal(rows, "reach", "2026-11-01", "2026-11-03").map((p) => p.value)).toEqual([15, null, 7]);
  });
  it("smooths the engagement rate over 7 days", () => {
    const rows: DailyRow[] = [];
    for (let i = 0; i < 14; i++) rows.push(row(`2026-11-${String(i + 1).padStart(2, "0")}`, "instagram", { reach: 100, interactions: i < 7 ? 2 : 6 }));
    const s = rateSeries(rows, "2026-11-08", "2026-11-14");
    expect(s).toHaveLength(7);
    expect(s[0].rate).toBeCloseTo((2 * 6 + 6) / 700);
    expect(s[6].rate).toBeCloseTo(0.06);
  });
});
