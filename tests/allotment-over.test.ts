import { describe, expect, it } from "vitest";
import { allotmentFull, noBriefsWhy, overAllotment, overDisclaimer, overNote, overText } from "@/lib/allotment-over";
import { clientGroup, sourceChip } from "@/lib/creative-desk-core";

const usage = (images: number | null, imagesUsed: number, videos: number | null = null, videosUsed = 0) => ({ images, videos, imagesUsed, videosUsed });

describe("over the allotment, on purpose", () => {
  it("says how far over a request takes the client, and what it adds", () => {
    const [l] = overAllotment(usage(25, 34), { image: { new: 2, variations: 2 } });
    expect(l).toMatchObject({ pool: "images", cap: 25, used: 34, adds: 4, after: 38, over: 13, already: true });
    expect(overText(l)).toBe("34 of 25 images this cycle, this adds 4 more (13 over)");
    expect(overDisclaimer([l])).toBe("Over allotment: 34 of 25 images this cycle, this adds 4 more (13 over)");
  });
  it("flags a request that takes a client with room past the cap", () => {
    const [l] = overAllotment(usage(10, 8), { image: { new: 4, variations: 0 } });
    expect(l).toMatchObject({ after: 12, over: 2, already: false });
  });
  it("is quiet when it fits, and for a pool the request doesn't touch unless that pool is over", () => {
    expect(overAllotment(usage(10, 4), { image: { new: 3, variations: 0 } })).toEqual([]);
    expect(overAllotment(usage(10, 4, 4, 4), { image: { new: 1, variations: 0 } })).toEqual([]);
    expect(overAllotment(usage(10, 4, 4, 6), { image: { new: 1, variations: 0 } }).map((l) => l.pool)).toEqual(["videos"]);
  });
  it("logs who pushed it and why on the ticket and the Asana task", () => {
    const lines = overAllotment(usage(25, 34), { image: { new: 1, variations: 0 } });
    expect(overNote(lines, "A Lead", "launch moved up")).toBe("Over allotment: 34 of 25 images this cycle, this adds 1 more (10 over). Pushed through by A Lead: launch moved up.");
    expect(overNote(lines, "A Lead", "")).toMatch(/\(no reason given\)\.$/);
    expect(overNote([], "A Lead", "x")).toBeNull();
  });
  it("leaves a client alone only when every capped pool is used up", () => {
    expect(allotmentFull(usage(25, 34))).toBe(true);
    expect(allotmentFull(usage(25, 25))).toBe(true);
    expect(allotmentFull(usage(25, 34, 4, 2))).toBe(false);
    expect(allotmentFull(usage(null, 0))).toBe(false);
  });
  it("says why a card has no briefs", () => {
    expect(noBriefsWhy([{ pool: "images", cap: 25, used: 34 }])).toBe("No briefs suggested: over the allotment by 9 images this cycle (34 of 25)");
    expect(noBriefsWhy([{ pool: "images", cap: 25, used: 34 }, { pool: "videos", cap: 4, used: 1 }])).toBeNull();
  });
});

describe("the Clients tab's groups and sources", () => {
  const p = (o: Partial<Parameters<typeof clientGroup>[0][number]>) => ({ cap: 10, requested: 5, missing: 5, over: 0, dueThisWeek: 0, state: "missing" as const, ...o });
  it("groups a client by its most pressing pool", () => {
    expect(clientGroup([p({ dueThisWeek: 3 })])).toBe("now");
    expect(clientGroup([p({ state: "nothing", requested: 0, missing: 10 })])).toBe("now");
    expect(clientGroup([p({})])).toBe("pace");
    expect(clientGroup([p({ requested: 10, missing: 0, state: "covered" })])).toBe("covered");
    expect(clientGroup([p({ requested: 14, missing: 0, over: 4, state: "over" })])).toBe("over");
    // Over on images but behind on video: it needs briefs now
    expect(clientGroup([p({ requested: 14, missing: 0, over: 4, state: "over" }), p({ dueThisWeek: 1 })])).toBe("now");
  });
  it("names what each brief is built on", () => {
    expect(sourceChip({ kind: "pacing", drafted: { trigger: "pacing", citation: { source: "market" } } }).label).toBe("In the market");
    expect(sourceChip({ kind: "pacing", drafted: { trigger: "pacing", citation: { source: "peer" } } }).label).toBe("Winning for a similar client");
    expect(sourceChip({ kind: "offer", drafted: { trigger: "offer", citation: { source: "email" } } }).label).toBe("The client asked");
    expect(sourceChip({ kind: "pacing", drafted: { trigger: "pacing", citation: { source: "numbers" } } }).label).toBe("Pacing");
    expect(sourceChip({ kind: "fatigue", drafted: { trigger: "fatigue", citation: { source: "ad" } } }).label).toBe("Refresh a tired ad");
  });
});
