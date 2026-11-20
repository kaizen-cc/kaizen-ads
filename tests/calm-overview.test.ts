import { describe, expect, it } from "vitest";
import { isCreativeLead, leadPools, poolTotals } from "@/lib/lead-creative-core";
import { applyMarks, stableKeyOf } from "@/lib/today-counts";

describe("creative leads' Overview", () => {
  it("knows the three creative leads", () => {
    expect(["head_of_creative", "lead_graphic_designer", "lead_video_editor"].every(isCreativeLead)).toBe(true);
    expect(isCreativeLead("graphic_designer")).toBe(false);
    expect(isCreativeLead("head_of_meta")).toBe(false);
  });
  it("puts each lead's own pool first", () => {
    expect(leadPools("lead_graphic_designer")).toEqual(["images"]);
    expect(leadPools("lead_video_editor")).toEqual(["videos"]);
    expect(leadPools("head_of_creative")).toEqual(["images", "videos"]);
  });
  it("totals a pool across clients and counts who's behind by today", () => {
    const rows = [
      { counts: { images: 10, videos: 4, imagesUsed: 2, videosUsed: 4 }, elapsed: 0.5 },
      { counts: { images: 8, videos: null, imagesUsed: 6, videosUsed: 0 }, elapsed: 0.5 },
      { counts: { images: null, videos: 2, imagesUsed: 0, videosUsed: 0 }, elapsed: 0.9 },
    ];
    expect(poolTotals(rows, "images")).toEqual({ cap: 18, used: 8, behind: 1, clients: 2 });
    expect(poolTotals(rows, "videos")).toEqual({ cap: 6, used: 4, behind: 1, clients: 2 });
  });
});

describe("one item, one key", () => {
  it("keys the same message the same for the person it's on and their lead", () => {
    expect(stableKeyOf("owed:abc")).toBe("owed:abc");
    expect(stableKeyOf("owed-lead:abc")).toBe("owed:abc");
    expect(stableKeyOf("said2:x")).toBe("said:x");
    expect(stableKeyOf("fatigue:c:a")).toBe("fatigue:c:a");
  });
});

describe("snooze", () => {
  it("leaves a snoozed item off the day", () => {
    const item = (key: string) => ({ key, state: "seen" as const, topic: "mine" as const, tier: "normal" as const, client: "A", score: 50 });
    const t = { items: [item("a"), item("b")] };
    const out = applyMarks(t as never, new Map([["a", "snoozed"]]), new Set()) as typeof t;
    expect(out.items.map((i) => i.key)).toEqual(["b"]);
  });
});
