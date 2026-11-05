import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOTMENT_RULE, DEFAULT_CARDS, conceptLine, describeAllotment, draws, slidesOf, unitsFor } from "@/lib/allotment";

// The owner's rule (Nov 2026): one concept per brief, every version of it counts, a carousel once per slide, sizes free.

describe("what a request takes from the allotment", () => {
  it("counts every version, net new and variations alike", () => {
    expect(draws({ image: { new: 1, variations: 4 } })).toEqual({ images: 5, videos: 0 });
    expect(draws({ image: { new: 4, variations: 4 } })).toEqual({ images: 8, videos: 0 });
    expect(draws({ video: { new: 1, variations: 2 } })).toEqual({ images: 0, videos: 3 });
  });

  it("counts a variations-only request (they used to be free)", () => {
    expect(draws({ image: { new: 0, variations: 3 } }).images).toBe(3);
  });

  it("counts a carousel once per slide, for every version", () => {
    expect(draws({ carousel: { new: 1, variations: 0, cards: 6 } }).images).toBe(6);
    expect(draws({ carousel: { new: 1, variations: 1, cards: 5 } }).images).toBe(10);
  });

  it("gives a carousel with no slide count the form's default", () => {
    expect(unitsFor("carousel", { new: 1 })).toBe(DEFAULT_CARDS);
    expect(slidesOf(null)).toBe(5);
  });

  it("holds slides to what the database allows (2 to 10)", () => {
    expect(slidesOf(1)).toBe(2);
    expect(slidesOf(14)).toBe(10);
  });

  it("puts images and carousels in one pool and videos in another", () => {
    expect(draws({ image: { new: 2, variations: 1 }, carousel: { new: 1, variations: 0, cards: 4 }, video: { new: 1, variations: 1 } })).toEqual({ images: 7, videos: 2 });
  });

  it("is zero for nothing, and never negative", () => {
    expect(draws({})).toEqual({ images: 0, videos: 0 });
    expect(unitsFor("image", { new: -2, variations: -1 })).toBe(0);
    expect(unitsFor("image", undefined)).toBe(0);
  });

  it("doesn't count sizes: counts don't depend on how many sizes are asked for", () => {
    // Sizes aren't part of the counts at all; a request for 4:5 and 9:16 of one version takes 1
    expect(draws({ image: { new: 1, variations: 0 } }).images).toBe(1);
  });
});

describe("how a brief says what it asks for", () => {
  it("says one concept and its versions", () => {
    expect(conceptLine("image", { new: 1, variations: 2 })).toBe("1 concept, 3 versions");
    expect(conceptLine("video", { new: 1, variations: 0 })).toBe("1 concept, 1 version");
  });

  it("says a carousel's slides", () => {
    expect(conceptLine("carousel", { new: 1, variations: 0, cards: 6 })).toBe("1 concept, carousel, 6 slides");
    expect(conceptLine("carousel", { new: 1, variations: 1, cards: 5 })).toBe("1 concept, carousel, 2 versions of 5 slides");
  });
});

describe("what the AI is told", () => {
  it("states the rule with the numbers", () => {
    const text = describeAllotment({ images: 10, videos: 3, imagesUsed: 4, videosUsed: 1, until: null }, { images: 6, videos: 0 });
    expect(text).toContain("this request takes 6, leaving 0");
    expect(text).toContain(ALLOTMENT_RULE);
    expect(ALLOTMENT_RULE).toMatch(/one concept per brief/i);
    expect(ALLOTMENT_RULE).toMatch(/once per slide/);
    expect(ALLOTMENT_RULE).not.toMatch(/variations (are|stay) free/i);
  });
});

describe("the database counts the same way", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261105180000_allotment_every_version.sql"), "utf8");

  it("stores every version per ticket, a carousel per slide with the same default", () => {
    expect(sql).toMatch(/allotment_units int generated always as/);
    expect(sql).toMatch(/new_count[\s\S]*variation_count[\s\S]*'carousel'[\s\S]*coalesce\(cards, 5\)/);
    expect(DEFAULT_CARDS).toBe(5);
  });

  it("sums it in the usage view", () => {
    expect(sql).toMatch(/sum\(r\.allotment_units\)/);
    expect(sql).not.toMatch(/sum\(r\.new_count\)/);
  });
});

describe("the Asana counter", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/asana.ts"), "utf8");

  it("counts by the new rule and recounts what was counted under the old one", () => {
    expect(src).not.toMatch(/A carousel counts as one image/);
    expect(src).toMatch(/A carousel counts once per slide/);
    expect(src).toMatch(/UNITS_RULE = "v2-every-version"/);
    expect(src).toMatch(/update\(`\$\{UNITS_RULE\}\\n/);
  });

  it("flags a task that bundles several concepts", () => {
    expect(src).toMatch(/concepts: \{ type: "integer" \}/);
    expect(src).toMatch(/distinct concepts in one task/);
  });
});
