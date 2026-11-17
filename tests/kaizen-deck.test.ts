import { describe, expect, it } from "vitest";
import { cleanSlide, cleanSlides, clip, deckFileName, pickImage, toneOf } from "@/lib/kaizen-ai/deck-core";

describe("clip", () => {
  it("leaves short text alone and cuts long text at a word", () => {
    expect(clip("  a   b ", 10)).toBe("a b");
    const out = clip("one two three four five six seven", 15);
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/thre…$/);
  });
});

describe("toneOf", () => {
  it("reads good, bad, and falls back to watch", () => {
    expect(toneOf("Good")).toBe("good");
    expect(toneOf("red")).toBe("bad");
    expect(toneOf("maybe")).toBe("watch");
    expect(toneOf(undefined)).toBe("watch");
  });
});

describe("cleanSlide", () => {
  it("limits bullets and drops empty slides", () => {
    const s = cleanSlide({ kind: "bullets", title: "T", bullets: ["a", "b", "c", "d", "e", "f", ""] });
    expect(s && s.kind === "bullets" && s.bullets).toHaveLength(5);
    expect(cleanSlide({ kind: "stats", stats: [] })).toBeNull();
    expect(cleanSlide({ kind: "quote", text: "" })).toBeNull();
  });
  it("treats an unknown kind as bullets when there are bullets", () => {
    expect(cleanSlide({ kind: "wat", title: "T", bullets: ["x"] })?.kind).toBe("bullets");
  });
  it("keeps verdict rows with their tone, at most five", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, tone: i % 2 ? "bad" : "good", note: "n" }));
    const s = cleanSlide({ kind: "scorecard", title: "T", rows });
    expect(s && s.kind === "scorecard" && s.rows.map((r) => r.tone)).toEqual(["good", "bad", "good", "bad", "good"]);
  });
});

describe("cleanSlides", () => {
  it("adds a cover when there is none and caps the count", () => {
    const many = Array.from({ length: 50 }, () => ({ kind: "section", title: "S" }));
    const out = cleanSlides(many, "Deck", "Sub");
    expect(out[0]).toMatchObject({ kind: "cover", title: "Deck", text: "Sub" });
    expect(out).toHaveLength(30);
  });
  it("keeps the model's own cover", () => {
    expect(cleanSlides([{ kind: "cover", title: "Mine" }, { kind: "section", title: "S" }], "Deck", "")[0]).toMatchObject({ title: "Mine" });
  });
});

describe("pickImage", () => {
  const files = [{ name: "Ad-One.PNG", kind: "image" }, { name: "notes.pdf", kind: "pdf" }, { name: "two.jpg", kind: "image" }];
  it("finds by name, part of a name, or number among the pictures", () => {
    expect(pickImage(files, "ad-one.png")?.name).toBe("Ad-One.PNG");
    expect(pickImage(files, "two")?.name).toBe("two.jpg");
    expect(pickImage(files, "2")?.name).toBe("two.jpg");
    expect(pickImage(files, "3")).toBeNull();
    expect(pickImage(files, null)).toBeNull();
  });
});

describe("deckFileName", () => {
  it("makes a safe pdf name", () => {
    expect(deckFileName("OceanBox: creative / assessment!")).toBe("OceanBox-creative-assessment.pdf");
    expect(deckFileName("???")).toBe("deck.pdf");
  });
});
