import { describe, expect, it } from "vitest";
import { copyDiff, copyShape, copyText, fitCopy, pushHistory, type CreativeCopy } from "@/lib/ticket-copy";
import type { Script } from "@/lib/ai";

const script = (onScreen: string): Script => ({
  framework: "PAS",
  style: "UGC",
  why: "",
  hooks: [{ type: "question", onScreen: "Hungry?", spoken: "Hungry?" }],
  title: "Calzone",
  placement: "Reels 9:16",
  objective: "Sales",
  lengthSeconds: 15,
  beats: [{ time: "0-3s", shot: "Cut open", onScreen, voiceover: "Look at that", sound: "" }],
  cta: "Order now",
  filming: [],
  testPlan: "",
  watchouts: [],
});

describe("ticket copy: the creative's own copy, per format", () => {
  it("knows what to cover: versions, and a carousel's slides", () => {
    expect(copyShape({ format: "image", newCount: 2, variationCount: 1 })).toEqual({ kind: "frames", versions: 3, slides: 0 });
    expect(copyShape({ format: "carousel", newCount: 1, variationCount: 0, cards: 4 })).toEqual({ kind: "slides", versions: 1, slides: 4 });
    expect(copyShape({ format: "video", newCount: 1, variationCount: 0 }).kind).toBe("script");
  });

  it("holds the AI's answer to the shape", () => {
    const frames = fitCopy({ versions: [{ headline: "  $8 Calzone  Mondays ", subline: "Every Monday" }] }, { kind: "frames", versions: 2, slides: 0 });
    expect(frames).toEqual({ kind: "frames", versions: [{ label: "V1", headline: "$8 Calzone Mondays", subline: "Every Monday" }, { label: "V2", headline: "", subline: "" }] });
    const slides = fitCopy({ versions: [{ slides: [{ headline: "One", subline: "" }] }] }, { kind: "slides", versions: 1, slides: 3 });
    expect(slides?.kind === "slides" && slides.versions[0].slides.length).toBe(3);
    expect(fitCopy({ versions: [] }, { kind: "frames", versions: 1, slides: 0 })).toBeNull();
    expect(fitCopy({ script: script("x") }, { kind: "script", versions: 1, slides: 0 })?.kind).toBe("script");
  });

  it("says what changed, line by line", () => {
    const a: CreativeCopy = { kind: "frames", versions: [{ label: "V1", headline: "Old", subline: "Same" }] };
    const b: CreativeCopy = { kind: "frames", versions: [{ label: "V1", headline: "New", subline: "Same" }, { label: "V2", headline: "Added", subline: "" }] };
    expect(copyDiff(a, b)).toEqual(['V1 headline: "Old" to "New"', 'Added V2: "Added"']);
    expect(copyDiff(b, a)).toEqual(['V1 headline: "New" to "Old"', "Removed V2"]);
    expect(copyDiff(null, a)).toEqual(["Wrote the copy"]);
    expect(copyDiff({ kind: "script", script: script("Hot") }, { kind: "script", script: script("Hotter") })).toEqual(['Scene 1 on screen: "Hot" to "Hotter"']);
  });

  it("keeps an undo history, newest last, capped", () => {
    const c = (h: string): CreativeCopy => ({ kind: "frames", versions: [{ label: "V1", headline: h, subline: "" }] });
    let h: CreativeCopy[] = [];
    for (let i = 0; i < 12; i++) h = pushHistory(h, c(String(i)));
    expect(h.length).toBe(10);
    expect(h.at(-1)).toEqual(c("11"));
    expect(pushHistory(h, null)).toBe(h);
  });

  it("reads as plain text for the AI", () => {
    expect(copyText({ kind: "frames", versions: [{ label: "V1", headline: "H", subline: "S" }] })).toBe("V1\nHeadline: H\nSubheadline: S");
  });
});
