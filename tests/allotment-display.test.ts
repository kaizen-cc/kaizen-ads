import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allotmentLine, allotmentOver, allotmentPool, allotmentPools, usageCounts } from "@/lib/allotment";

// The owner's rule (Nov 2026): every place shows the allotment per pool, never images and videos summed into one
// number, never an overage clamped away. Sierra Dreams: 50 images + 10 videos, 86 images and 7 videos used.

const sierra = { images: 50, videos: 10, imagesUsed: 86, videosUsed: 7 };

describe("the allotment, shown the one way", () => {
  it("shows each pool on its own, the overage kept", () => {
    expect(allotmentLine(sierra)).toBe("Images 86/50 · 36 over · Videos 7/10");
    const [img, vid] = allotmentPools(sierra);
    expect(img).toMatchObject({ key: "images", cap: 50, used: 86, left: 0, over: 36, state: "over" });
    expect(vid).toMatchObject({ key: "videos", cap: 10, used: 7, left: 3, over: 0, state: "ok" });
    expect(allotmentOver(sierra)).toBe(true);
  });

  it("never sums the pools into one number or clamps to 0 left", () => {
    const line = allotmentLine(sierra)!;
    expect(line).not.toMatch(/93/);
    expect(line).not.toMatch(/60/);
    expect(line).not.toMatch(/0 of/);
  });

  it("marks a full pool, and one within its cap", () => {
    expect(allotmentPool("videos", 10, 10).state).toBe("full");
    expect(allotmentPool("images", 10, 4)).toMatchObject({ left: 6, over: 0, state: "ok", text: "Images 4/10" });
  });

  it("leaves out a pool that isn't set, or has nothing to say", () => {
    expect(allotmentPools({ images: 20, videos: null, imagesUsed: 3, videosUsed: 2 }).map((p) => p.key)).toEqual(["images"]);
    expect(allotmentPools({ images: 20, videos: 0, imagesUsed: 3, videosUsed: 0 }).map((p) => p.key)).toEqual(["images"]);
    // Videos made without a video allotment are over it, not hidden
    expect(allotmentLine({ images: 20, videos: 0, imagesUsed: 3, videosUsed: 2 })).toBe("Images 3/20 · Videos 2/0 · 2 over");
    expect(allotmentLine({ images: null, videos: null, imagesUsed: 0, videosUsed: 0 })).toBeNull();
    expect(allotmentLine(null)).toBeNull();
  });

  it("reads a client_allotment_usage row", () => {
    expect(usageCounts({ images_per_month: 50, videos_per_month: 10, images_used: 86, videos_used: 7 })).toEqual(sierra);
    expect(usageCounts(null)).toBeNull();
  });
});

describe("every allotment display goes through the helper", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the new-request client picker shows pools, not a summed, clamped total", () => {
    const src = read("src/app/(team)/requests/new/start-flow.tsx");
    expect(src).not.toMatch(/left this cycle/);
    expect(src).toMatch(/AllotmentPools/);
  });

  it("the client page header and creative card don't sum images and videos", () => {
    const view = read("src/app/(team)/clients/[slug]/client-view.tsx");
    expect(view).not.toMatch(/imagesUsed \+ videosUsed\}\/\$\{images \+ videos\}/);
    expect(view).not.toMatch(/allotted: images \+ videos/);
    expect(read("src/app/(team)/clients/[slug]/business-overview.tsx")).toMatch(/allotmentPools/);
  });

  it("home, the overview, the board's allotment rows and the daily recap read pools", () => {
    expect(read("src/lib/home.ts")).not.toMatch(/images_per_month \?\? 0\) \+ \(u\.videos_per_month/);
    expect(read("src/lib/creative-kpis.ts")).not.toMatch(/images_per_month \?\? 0\) \+ \(u\.videos_per_month/);
    expect(read("src/lib/today.ts")).not.toMatch(/c\.used\}\/\$\{c\.allotment\}/);
    expect(read("src/app/(team)/pipeline/views/shared.tsx")).not.toMatch(/c\.used\} of \{c\.allotment\}/);
  });
});
