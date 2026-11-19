import { describe, expect, it } from "vitest";
import { mergePlacements, placementKey } from "@/lib/ad-placements";
import type { MetaRow } from "@/lib/client-creative";

// The team's ask: a story and a post of the same ad are one creative on the client page, not two.

const ad = (id: string, name: string, over: Partial<MetaRow> = {}): MetaRow => ({
  id, name, headline: null, text: null, thumbnail: `${id}.jpg`, spend: 0, results: 0, result: "lead", costPerResult: null, ctr: 0, hookRate: null, avgWatchSec: null, videoSeconds: null, watchPct: null, ...over,
});

describe("placementKey", () => {
  it("drops the placement words so story and post match", () => {
    expect(placementKey("Image 3 - Story")).toBe(placementKey("Image 3 - Feed"));
    expect(placementKey("FCS | Spanish Fast 9:16")).toBe(placementKey("FCS | Spanish Fast 1x1"));
    expect(placementKey("Stories - Testimonial")).toBe(placementKey("Post - Testimonial"));
  });
  it("leaves an ad that names no placement on its own", () => {
    expect(placementKey("Image 3")).toBeNull();
  });
});

describe("mergePlacements", () => {
  it("counts the story and post of one ad once, with the post's preview and both ads' numbers", () => {
    const out = mergePlacements([
      ad("s", "Image 3 - Story", { spend: 60, results: 2, ctr: 1 }),
      ad("f", "Image 3 - Feed", { spend: 40, results: 3, ctr: 2, headline: "Speak Spanish fast" }),
      ad("o", "Image 4 - Feed", { spend: 10, results: 1 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "f", thumbnail: "f.jpg", headline: "Speak Spanish fast", spend: 100, results: 5, costPerResult: 20 });
    expect(out[0].ctr).toBeCloseTo(1.4);
    expect(out[1].id).toBe("o");
  });
  it("keeps different ads apart, and same-named ads without a placement too", () => {
    expect(mergePlacements([ad("a", "Image 1 - Story"), ad("b", "Image 2 - Story"), ad("c", "Video A"), ad("d", "Video A")])).toHaveLength(4);
  });
});
