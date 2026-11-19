import { describe, expect, it } from "vitest";
import { allotmentGaps, allotmentSlice, createBriefHref, cycleFor, daysBetween, nextBucket, poolGap, resetsLabel, sliceGaps, weekLoad, weeklyCapacity, type UsageLike } from "@/lib/creative-allotments";
import { allotmentNext } from "@/lib/creative-allotments-items";

const client = { name: "Acme", slug: "acme" };
const row = (over: Partial<UsageLike> = {}): UsageLike => ({
  client_id: "c1",
  images_per_month: 10,
  videos_per_month: 4,
  images_used: 0,
  videos_used: 0,
  asana_waiting_images: 0,
  asana_waiting_videos: 0,
  progress_images: 0,
  progress_videos: 0,
  period_start: "2026-11-05",
  period_end: "2026-12-05",
  ...over,
});

describe("cycle math", () => {
  it("starts on the billing day and resets the same day next month", () => {
    expect(cycleFor(5, "2026-11-18")).toEqual({ start: "2026-11-05", end: "2026-12-05" });
    expect(cycleFor(20, "2026-11-18")).toEqual({ start: "2026-10-20", end: "2026-11-20" });
    expect(cycleFor(18, "2026-11-18")).toEqual({ start: "2026-11-18", end: "2026-12-18" });
  });
  it("caps the day at the 28th and falls back to the 1st", () => {
    expect(cycleFor(31, "2026-02-27")).toEqual({ start: "2026-01-28", end: "2026-02-28" });
    expect(cycleFor(null, "2026-11-18")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
  });
  it("crosses the year", () => {
    expect(cycleFor(10, "2027-01-03")).toEqual({ start: "2026-12-10", end: "2027-01-10" });
  });
  it("uses the view's cycle when given, its own otherwise", () => {
    expect(poolGap(row(), client, "videos", "2026-11-18")!.resetsOn).toBe("2026-12-05");
    expect(poolGap(row({ period_start: null, period_end: null, billing_day: 20 }), client, "videos", "2026-11-18")!.resetsOn).toBe("2026-11-20");
  });
  it("says when it resets", () => {
    expect(daysBetween("2026-11-18", "2026-12-05")).toBe(17);
    expect(resetsLabel("2026-12-05", 17)).toBe("resets Dec 5");
    expect(resetsLabel("2026-11-20", 2)).toBe("resets in 2 days");
    expect(resetsLabel("2026-11-19", 1)).toBe("resets tomorrow");
  });
});

describe("requested and in motion", () => {
  it("nothing requested and nothing on its way is nothing in motion", () => {
    const g = poolGap(row(), client, "videos", "2026-11-18")!;
    expect(g.state).toBe("nothing");
    expect(g.missing).toBe(4);
    expect(g.line).toMatch(/^Nothing in motion/);
  });
  it("briefs sent and Asana briefs not started both count as requested (the view's used holds both, once)", () => {
    const g = poolGap(row({ videos_used: 2, asana_waiting_videos: 1, progress_videos: 2 }), client, "videos", "2026-12-03")!;
    expect(g.requested).toBe(2);
    expect(g.missing).toBe(2);
    expect(g.line).toBe("2 videos missing · resets in 2 days");
    expect(g.detail).toContain("nothing delivered yet");
  });
  it("in motion from an earlier cycle isn't nothing in motion", () => {
    // Still in the production line from last cycle: it counts against this cycle too
    const g = poolGap(row({ videos_used: 3, progress_videos: 3 }), client, "videos", "2026-11-18")!;
    expect(g.state).toBe("missing");
    expect(g.inMotion).toBe(3);
    expect(g.requested).toBe(3);
    expect(g.missing).toBe(1);
  });
  it("over the allotment is said, not hidden", () => {
    const g = poolGap(row({ images_used: 13 }), client, "images", "2026-11-18")!;
    expect(g.state).toBe("over");
    expect(g.over).toBe(3);
    expect(g.missing).toBe(0);
    expect(nextBucket(g)).toBeNull();
  });
  it("a pool without a cap has no gap", () => {
    expect(poolGap(row({ videos_per_month: null }), client, "videos", "2026-11-18")).toBeNull();
    expect(poolGap(row({ videos_per_month: 0 }), client, "videos", "2026-11-18")).toBeNull();
  });
});

describe("pacing", () => {
  it("spreads the cap evenly: what's due by a week from today", () => {
    // Day 13 of 30, 0 of 10 asked: by day 20 two thirds should be asked (7)
    const g = poolGap(row(), client, "images", "2026-11-18")!;
    expect(g.dueThisWeek).toBe(7);
    expect(g.pace).toBe("7 this week to stay on pace");
  });
  it("ahead of pace owes nothing this week", () => {
    const g = poolGap(row({ images_used: 8 }), client, "images", "2026-11-08")!;
    expect(g.dueThisWeek).toBe(0);
    expect(g.pace).toBe("On pace this week");
  });
  it("in the last week everything missing is due", () => {
    const g = poolGap(row({ images_used: 3 }), client, "images", "2026-12-01")!;
    expect(g.dueThisWeek).toBe(7);
  });
  it("adds up the team's week against a usual week", () => {
    const gaps = allotmentGaps([row(), row({ client_id: "c2", videos_used: 4 })], new Map([["c1", client], ["c2", { name: "Bolt", slug: "bolt" }]]), "2026-11-18");
    const cap = weeklyCapacity([{ pool: "images", units: 40 }, { pool: "videos", units: 8 }], 8);
    expect(cap).toEqual({ images: 5, videos: 1 });
    const [img, vid] = weekLoad(gaps, cap);
    expect(img.due).toBe(14);
    expect(img.line).toContain("9 more than a usual week (5)");
    expect(vid.clients).toBe(1);
    expect(weeklyCapacity([], 8)).toEqual({ images: null, videos: null });
  });
});

describe("urgency and Next for me", () => {
  const clients = new Map([["c1", client], ["c2", { name: "Bolt", slug: "bolt" }]]);
  it("orders by the gap over the days to reset", () => {
    const soon = row({ client_id: "c2", period_start: "2026-10-20", period_end: "2026-11-20" });
    const gaps = allotmentGaps([row(), soon], clients, "2026-11-18");
    expect(gaps[0].clientId).toBe("c2");
    expect(nextBucket(gaps[0])).toBe("now");
  });
  it("Now when the reset is close, Keep an eye on when it's due this week, cleared once briefed", () => {
    const later = poolGap(row(), client, "videos", "2026-11-08")!;
    expect(nextBucket(later)).toBe("watch");
    const close = poolGap(row({ videos_used: 2 }), client, "videos", "2026-12-01")!;
    expect(nextBucket(close)).toBe("now");
    const briefed = poolGap(row({ videos_used: 4 }), client, "videos", "2026-12-01")!;
    expect(nextBucket(briefed)).toBeNull();
  });
  it("makes rows with Suggest briefs and Create brief for that client and format", () => {
    const g = poolGap(row({ videos_used: 1 }), client, "videos", "2026-12-03")!;
    const [x] = allotmentNext({ gaps: [g], fresh: [] });
    expect(x.bucket).toBe("now");
    expect(x.item.title).toBe("3 videos missing");
    expect(x.item.when).toBe("Resets in 2 days");
    expect(x.item.href).toBe("/requests/new?client=acme&format=video");
    expect(x.item.briefIdea.format).toBe("video");
    expect(x.item.briefIdea.text).toMatch(/winning ads/);
    expect(createBriefHref("a b", null)).toBe("/requests/new?client=a%20b");
  });
  it("accounts off target need fresh creative (kept to the watch list)", () => {
    const out = allotmentNext({ gaps: [], fresh: [{ clientId: "c1", client: "Acme", slug: "acme", why: "Meta CPA off target by 30%", targetId: "t1" }] });
    expect(out).toHaveLength(1);
    expect(out[0].bucket).toBe("watch");
    expect(out[0].item.title).toBe("Needs fresh creative");
  });
});

describe("role slicing", () => {
  const gaps = allotmentGaps([row(), row({ client_id: "c2" })], new Map([["c1", client], ["c2", { name: "Bolt", slug: "bolt" }]]), "2026-11-18");
  const seated = new Set(["c1"]);
  it("the head of creative sees every client and pool", () => {
    expect(sliceGaps(gaps, { role: "head_of_creative" }, new Set())).toHaveLength(4);
    expect(sliceGaps(gaps, { role: "media_buyer", isExec: true }, new Set())).toHaveLength(4);
  });
  it("the lead graphic designer every client's images, the lead video editor every client's video", () => {
    const g = sliceGaps(gaps, { role: "lead_graphic_designer" }, new Set());
    expect(g.map((x) => x.pool)).toEqual(["images", "images"]);
    const v = sliceGaps(gaps, { role: "lead_video_editor" }, new Set());
    expect(v.map((x) => x.pool)).toEqual(["videos", "videos"]);
  });
  it("designers and editors their seated clients in their pool", () => {
    expect(sliceGaps(gaps, { role: "graphic_designer" }, seated).map((x) => `${x.clientId}:${x.pool}`)).toEqual(["c1:images"]);
    expect(sliceGaps(gaps, { role: "video_editor" }, seated).map((x) => `${x.clientId}:${x.pool}`)).toEqual(["c1:videos"]);
  });
  it("anyone else sees none", () => {
    expect(allotmentSlice({ role: "copywriter" })).toBeNull();
    expect(sliceGaps(gaps, { role: "media_buyer" }, seated)).toEqual([]);
  });
  it("a client left out (paused) never shows", () => {
    expect(allotmentGaps([row()], new Map(), "2026-11-18")).toEqual([]);
  });
});
