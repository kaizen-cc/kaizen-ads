import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGAGEMENT_BAR,
  DEFAULT_POSTS_PER_MONTH,
  SOCIAL_CHECKS,
  platformInputs,
  promisedPosts,
  reachWeights,
  socialAccountScore,
  socialBand,
  socialCheckText,
  socialScore,
  type SocialDayRow,
  type SocialInputs,
  type SocialPostRow,
} from "@/lib/social-score";
import { boardTotals, hasPlatform, parsePlatform, platformRate, platformsOf, scoreFor, topAndBottom } from "@/lib/social/split";
import { needsSocialAutoAudit, postingTimes, socialRuleFindings, socialSnapshotOf } from "@/lib/social-ops/audit-core";
import { postsLine, socialPlainMessage } from "@/lib/social-ops/sprint-core";

const full: SocialInputs = { engagement: 0.05, growth: 0.02, reach: 1.2, cadence: 1.1, quality: 0.01, videoShare: 0.5, videoLift: 1.3, profile: 0.05 };
const none: SocialInputs = { engagement: null, growth: null, reach: null, cadence: null, quality: null, videoShare: null, videoLift: null, profile: null };

describe("the social score's checks", () => {
  it("weighs to 100, engagement heaviest", () => {
    expect(SOCIAL_CHECKS.reduce((n, c) => n + c.weight, 0)).toBe(100);
    expect([...SOCIAL_CHECKS].sort((a, b) => b.weight - a.weight)[0].key).toBe("engagement");
  });

  it("scores 100 with every check at or over its bar", () => {
    const s = socialScore(full);
    expect(s.score).toBe(100);
    expect(s.band).toBe("good");
    expect(s.weighingDown).toEqual([]);
  });

  it.each(SOCIAL_CHECKS.map((c) => [c.key, c.bar, c.weight] as const))("%s under its bar earns its share of its points", (key, bar, weight) => {
    const s = socialScore({ ...full, [key]: bar / 2 });
    const c = s.checks.find((x) => x.key === key)!;
    expect(c.met).toBe(false);
    expect(c.points).toBeCloseTo(weight / 2, 5);
    expect(s.score).toBe(Math.round(100 - weight / 2));
    expect(s.weighingDown[0].key).toBe(key);
  });

  it("never gives more than a check's points, nor less than zero", () => {
    const s = socialScore({ ...full, growth: -0.05, reach: 3 });
    expect(s.checks.find((c) => c.key === "growth")!.points).toBe(0);
    expect(s.checks.find((c) => c.key === "reach")!.points).toBe(15);
  });

  it("scores engagement against the client's own target", () => {
    const own = socialScore({ ...full, engagement: 0.03 }, { engagementBar: 0.06 });
    const c = own.checks.find((x) => x.key === "engagement")!;
    expect(c.bar).toBe(0.06);
    expect(c.points).toBeCloseTo(15, 5);
    // No target: the default bar
    expect(socialScore({ ...full, engagement: 0.03 }).checks.find((x) => x.key === "engagement")!.bar).toBe(DEFAULT_ENGAGEMENT_BAR);
  });

  it("drops a check with nothing to measure and scales the rest to 100", () => {
    const s = socialScore({ ...full, quality: null, videoLift: null, engagement: 0.025 });
    expect(s.unmeasured).toEqual(["quality", "videoLift"]);
    // 30 weight at 0.025/0.035 of its points, out of 86.25 measured
    expect(s.score).toBe(Math.round(((86.25 - 30 + 30 * (0.025 / 0.035)) / 86.25) * 100));
    expect(socialScore(none).score).toBe(0);
  });

  it("bands like email: green from 80, yellow from 60, red under", () => {
    expect([socialBand(80), socialBand(79), socialBand(60), socialBand(59)]).toEqual(["good", "watch", "watch", "bad"]);
  });

  it("reads values the social way", () => {
    expect(socialCheckText("change", 1.12)).toBe("+12%");
    expect(socialCheckText("change", 0.46)).toBe("-54%");
    expect(socialCheckText("change", 1)).toBe("flat");
    expect(socialCheckText("ratio", 1.5)).toBe("1.5x");
    expect(socialCheckText("ratio", 1)).toBe("1x");
    expect(socialCheckText("ratio", 12)).toBe("12x");
    expect(socialCheckText("pct", 0.045)).toBe("4.5%");
    expect(socialCheckText("pct", 0.006)).toBe("0.60%");
    expect(socialCheckText("pct", null)).toBe("n/a");
  });
});

// Nov 18 2026: day 18 of a 30-day month
const today = "2026-11-18";
const shift = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function days(platform: string, reach: number, interactions: number, opts: { followersFrom?: number; perDay?: number; before?: number; profile?: number; gained?: number; lost?: number } = {}): SocialDayRow[] {
  const out: SocialDayRow[] = [];
  for (let i = -59; i <= 0; i++) {
    const inWindow = i >= -29;
    out.push({
      platform,
      date: shift(i),
      followers: opts.followersFrom != null ? opts.followersFrom + (i + 59) * (opts.perDay ?? 0) : null,
      gained: opts.gained != null && inWindow ? opts.gained : null,
      lost: opts.lost != null && inWindow ? opts.lost : null,
      reach: inWindow ? reach : (opts.before ?? reach),
      interactions: inWindow ? interactions : interactions,
      profileViews: opts.profile != null && inWindow ? opts.profile : null,
    });
  }
  return out;
}

const post = (platform: string, day: number, format: string, reach: number, interactions: number, saves: number | null = null, shares: number | null = null): SocialPostRow => ({ platform, postedAt: `${shift(day)}T15:00:00Z`, format, reach, interactions, saves, shares });

describe("each platform on its own", () => {
  const ig = days("instagram", 1000, 45, { followersFrom: 10_000, perDay: 2, before: 2000, profile: 40 });
  const fb = days("facebook", 300, 21, { gained: 3, lost: 1 });
  const posts = [post("instagram", -2, "reel", 3000, 180, 20, 10), post("instagram", -5, "image", 1000, 30, 4, 1), post("instagram", -12, "carousel", 1500, 60, 10, 5), post("facebook", -3, "image", 400, 20, null, 2), post("instagram", -40, "image", 500, 10)];

  it("keeps Instagram's and Facebook's numbers apart", () => {
    const i = platformInputs({ platform: "instagram", days: [...ig, ...fb], posts, today });
    const f = platformInputs({ platform: "facebook", days: [...ig, ...fb], posts, today });
    expect(i.numbers.reach).toBe(30_000);
    expect(f.numbers.reach).toBe(9_000);
    expect(i.inputs.engagement).toBeCloseTo(0.045, 5);
    expect(f.inputs.engagement).toBeCloseTo(0.07, 5);
    expect(i.numbers.posts).toBe(3);
    expect(f.numbers.posts).toBe(1);
  });

  it("reads growth from the follower counts when two are 14 days apart, else gained less lost", () => {
    const i = platformInputs({ platform: "instagram", days: ig, posts, today });
    // 30 days at +2 a day from the count on the window's first day
    expect(i.numbers.netFollowers).toBe(58);
    expect(i.inputs.growth).toBeCloseTo(58 / (10_000 + 30 * 2), 5);
    const f = platformInputs({ platform: "facebook", days: fb, posts, today });
    expect(f.numbers.netFollowers).toBe(60);
    // No count at all: nothing to divide by, so unmeasured
    expect(f.inputs.growth).toBeNull();
  });

  it("measures reach against the 30 days before, profile visits, saves and shares, and video against static", () => {
    const i = platformInputs({ platform: "instagram", days: ig, posts, today });
    expect(i.inputs.reach).toBeCloseTo(0.5, 5);
    expect(i.inputs.profile).toBeCloseTo(0.04, 5);
    expect(i.inputs.quality).toBeCloseTo((30 + 5 + 15) / 5500, 5);
    expect(i.inputs.videoShare).toBeCloseTo(1 / 3, 5);
    expect(i.inputs.videoLift).toBeCloseTo(0.06 / (90 / 2500), 5);
  });

  it("paces this month's posts against the package's promise for the month so far", () => {
    const i = platformInputs({ platform: "instagram", days: ig, posts, today, promisedPerMonth: 12 });
    // 3 posts this month (Nov 6, 13, 16) against 12 * 18/30 = 7.2 expected
    expect(i.numbers.postsThisMonth).toBe(3);
    expect(i.inputs.cadence).toBeCloseTo(3 / 7.2, 5);
    // The first three days of a month are left out unless the promise is met
    expect(platformInputs({ platform: "instagram", days: ig, posts: [], today: "2026-11-02", promisedPerMonth: 12 }).inputs.cadence).toBeNull();
  });

  it("uses the default cadence without a package, and says so", () => {
    const s = socialAccountScore({ days: ig, posts, today })!;
    expect(s.promised).toEqual({ perMonth: DEFAULT_POSTS_PER_MONTH, fromPackage: false });
    expect(socialAccountScore({ days: ig, posts, today, promisedPerMonth: 20 })!.promised).toEqual({ perMonth: 20, fromPackage: true });
  });

  it("weights the overall by each platform's reach", () => {
    const s = socialAccountScore({ days: [...ig, ...fb], posts, today, engagementTarget: 0.04 })!;
    expect(s.platforms.map((p) => p.platform)).toEqual(["instagram", "facebook"]);
    const [wi, wf] = reachWeights(s.platforms.map((p) => p.numbers));
    expect(wi).toBeCloseTo(30 / 39, 5);
    expect(s.score).toBe(Math.round(s.platforms[0].score * wi + s.platforms[1].score * wf));
    // Every drag names its platform, worst first
    expect(s.weighingDown.every((d, i, l) => i === 0 || l[i - 1].cost >= d.cost)).toBe(true);
    expect(new Set(s.weighingDown.map((d) => d.platform))).toEqual(new Set(["instagram", "facebook"]));
  });

  it("gives equal shares when nothing has reach, and nothing to score with no rows", () => {
    expect(reachWeights([{ reach: null }, { reach: 0 }])).toEqual([0.5, 0.5]);
    expect(socialAccountScore({ days: [], posts: [], today })).toBeNull();
  });
});

describe("the posting promise from a package's words", () => {
  it.each([
    ["12 posts a month", 12],
    ["16 posts/mo across Instagram and Facebook", 16],
    ["3 posts per week", 13],
    ["Posting 4x a week", 17],
    ["Gold: 20 feed posts per month, 8 reels", 20],
    ["Community management only", null],
    [null, null],
  ] as const)("%s", (text, n) => expect(promisedPosts(text)).toBe(n));
});

describe("the board and the sheet split by platform", () => {
  const ig = days("instagram", 1000, 45, { followersFrom: 10_000, perDay: 1 });
  const fb = days("facebook", 500, 10, { followersFrom: 2000, perDay: 0 });
  const a = socialAccountScore({ days: [...ig, ...fb], posts: [], today })!;
  const b = socialAccountScore({ days: ig, posts: [], today })!;

  it("lists only the platforms read, in a fixed order", () => {
    expect(platformsOf([b, a, null])).toEqual(["instagram", "facebook"]);
    expect(parsePlatform("tiktok")).toBe("tiktok");
    expect(parsePlatform("myspace")).toBe("all");
  });

  it("filters accounts by platform", () => {
    expect(hasPlatform(b, "facebook")).toBe(false);
    expect(hasPlatform(b, "all")).toBe(true);
    expect(hasPlatform(a, "facebook")).toBe(true);
  });

  it("adds reach and interactions up before working out the rate", () => {
    const all = boardTotals([a, b], "all")!;
    expect(all.reach).toBe(30_000 + 15_000 + 30_000);
    expect(all.rate).toBeCloseTo((1350 + 300 + 1350) / 75_000, 5);
    expect(boardTotals([a, b], "facebook")!.reach).toBe(15_000);
    expect(scoreFor(a, "facebook")!.score).toBe(a.platforms[1].score);
    expect(scoreFor(a, "all")!.score).toBe(a.score);
  });

  it("charts one platform's 7-day rate or every platform's together", () => {
    const rows = [...ig, ...fb].map((d) => ({ platform: d.platform, date: d.date, reach: d.reach, interactions: d.interactions }));
    const one = platformRate(rows, "instagram", shift(-29), today);
    expect(one).toHaveLength(30);
    expect(one.at(-1)).toBeCloseTo(0.045, 5);
    expect(platformRate(rows, "all", shift(-29), today).at(-1)).toBeCloseTo(55 / 1500, 5);
  });

  it("picks the top and weakest posts by engagement over reach", () => {
    const ps = [post("instagram", -1, "reel", 100, 10), post("instagram", -2, "image", 100, 1), post("facebook", -3, "image", 100, 5), post("instagram", -4, "image", null as unknown as number, 50)];
    const { top, bottom } = topAndBottom(ps, "all", 1);
    expect(top[0].rate).toBeCloseTo(0.1, 5);
    expect(bottom[0].rate).toBeCloseTo(0.01, 5);
    expect(topAndBottom(ps, "facebook", 3).top).toHaveLength(1);
  });
});

describe("red social accounts audit themselves (the email rule)", () => {
  const now = Date.parse("2026-11-18T15:00:00Z");
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  it("audits a red account with no audit, never a yellow or green one", () => {
    expect(needsSocialAutoAudit(55, null, now)).toBe(true);
    expect(needsSocialAutoAudit(60, null, now)).toBe(false);
    expect(needsSocialAutoAudit(null, null, now)).toBe(false);
  });
  it("refreshes after three days untouched, never while someone works on it", () => {
    expect(needsSocialAutoAudit(40, { status: "ready", createdAt: ago(73), touched: false }, now)).toBe(true);
    expect(needsSocialAutoAudit(40, { status: "ready", createdAt: ago(71), touched: false }, now)).toBe(false);
    expect(needsSocialAutoAudit(40, { status: "ready", createdAt: ago(200), touched: true }, now)).toBe(false);
  });
  it("waits on a running audit (15 minutes) and a failed one (6 hours)", () => {
    expect(needsSocialAutoAudit(40, { status: "running", createdAt: ago(0.1), touched: false }, now)).toBe(false);
    expect(needsSocialAutoAudit(40, { status: "running", createdAt: ago(0.3), touched: false }, now)).toBe(true);
    expect(needsSocialAutoAudit(40, { status: "failed", createdAt: ago(5), touched: false }, now)).toBe(false);
    expect(needsSocialAutoAudit(40, { status: "failed", createdAt: ago(7), touched: false }, now)).toBe(true);
  });
});

describe("the social audit's and sprint's plain parts", () => {
  const ig = days("instagram", 1000, 20, { followersFrom: 10_000, perDay: 0, before: 3000 });
  const s = socialAccountScore({ days: ig, posts: [], today, engagementTarget: 0.04 })!;

  it("turns every check under its bar into a finding on its platform", () => {
    const f = socialRuleFindings(s);
    expect(f.length).toBe(s.weighingDown.length);
    expect(f[0].title.startsWith("Instagram: ")).toBe(true);
    expect(f.find((x) => x.title.includes("engagement"))?.area).toBe("engagement");
  });

  it("keeps a snapshot a sprint can compare (with each check's unit and every platform's score)", () => {
    const snap = socialSnapshotOf(s, "2026-11-18T00:00:00Z");
    expect(snap.score).toBe(s.score);
    expect(snap.platforms).toEqual([{ platform: "instagram", score: s.platforms[0].score }]);
    expect(snap.checks.find((c) => c.key === "reach")?.unit).toBe("change");
  });

  it("groups posting times by slot and weekday, New York time", () => {
    const t = postingTimes([post("instagram", -1, "image", 100, 5), post("instagram", -2, "image", 100, 15)]);
    // 15:00 UTC is 10am in New York in November: the morning slot
    expect(t.find((x) => x.slot.startsWith("morning"))).toEqual({ slot: "morning (6 to 11)", posts: 2, rate: 0.1 });
  });

  it("says what the posts show against the ticks", () => {
    const t = { todo: 2, doing: 0, done: 1, skipped: 0 };
    expect(postsLine(t, 0)).toContain("Nothing has been posted since the last check, so I can't see");
    expect(postsLine({ ...t, done: 0 }, 2)).toContain("no move is ticked");
    expect(postsLine(t, null)).toBe("");
    const m = { delta: 4, gained: ["Follower growth"], lost: [], open: ["Engagement rate"] };
    expect(socialPlainMessage("improving", m, t, { score: 64 }, 3)).toBe("The social score is 64 (up 4 since the sprint began). Follower growth now meets its bar. Still under the bar: Engagement rate. 1 of 3 moves done: keep going. I can see 3 posts since the last check.");
    expect(socialPlainMessage("done", m, t, { score: 82 })).toContain("back in the green");
  });
});
