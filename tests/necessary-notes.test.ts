import { describe, expect, it } from "vitest";
import { isNecessary, necessaryNotes, reviewSummary, type ReviewNote } from "@/lib/necessary-notes";

const n = (severity: ReviewNote["severity"], area: string, note: string, design = "D1"): ReviewNote => ({ severity, area, note, design });

describe("isNecessary: a comment must point to a real problem", () => {
  it("keeps real problems: typos, a wrong offer, safe zones, the brief, the client's rules, policy", () => {
    for (const x of [
      n("fix", "Text", 'The headline says "Calzome" instead of "Calzone".'),
      n("fix", "Offer", 'Badge reads "20% OFF" but the brief\'s offer is 25% off this week only.'),
      n("fix", "Placement", "The price sits in the bottom third of the 9:16, where the Reels caption covers it."),
      n("watch", "Brief", "The brief asks to show the calzone cut open; D2 shows it whole."),
      n("watch", "Brand", "The logo is the old one; the Brand Bible's logo rule says the new mark only."),
      n("watch", "Policy", "Calls out a personal attribute (\"Struggling with your weight?\"), which Meta policy doesn't allow."),
      n("fix", "Craft", "The product shot is pixelated at phone size."),
    ])
      expect(isNecessary(x), x.note).toBe(true);
  });

  it("drops taste, suggestions and filler", () => {
    for (const x of [
      n("watch", "Craft", "The headline could be punchier."),
      n("watch", "Craft", "Consider a warmer colour palette to feel more premium."),
      n("fix", "Brand", "Maybe try a more dynamic layout."),
      n("watch", "Craft", "Overall looks great, nice work on the lighting."),
      n("watch", "Craft", "The background feels a bit busy."),
      n("watch", "Text", "Fine."),
    ])
      expect(isNecessary(x), x.note).toBe(false);
  });

  it("a suggestion with a real problem behind it stays", () => {
    expect(isNecessary(n("watch", "Placement", "Consider moving the CTA up: it's under Meta's interface in the 9:16 safe zone."))).toBe(true);
  });

  it("a client's ask is always checked; a good note is never a comment", () => {
    expect(isNecessary(n("watch", "Client ask", "Done: the logo is bigger."))).toBe(true);
    expect(isNecessary(n("good", "Craft", "The cheese pull is sharp."))).toBe(false);
  });

  it("a watch note in a hard area needs a spec behind it", () => {
    expect(isNecessary(n("watch", "Text", "The headline is long at 14 words for a phone; the price gets lost."))).toBe(true);
    expect(isNecessary(n("watch", "Text", "The words could flow better together here."))).toBe(false);
  });
});

describe("necessaryNotes", () => {
  it("drops filler, keeps one working-well note, and says a point once per design", () => {
    const kept = necessaryNotes([
      n("fix", "Text", 'Typo: "Calzome" in the headline.'),
      n("fix", "Text", 'Typo: "Calzome" in the headline.'),
      n("fix", "Text", 'Typo: "Calzome" in the headline.', "D2"),
      n("watch", "Craft", "Could be punchier."),
      n("good", "Craft", "The cheese pull is sharp."),
      n("good", "Craft", "Lovely lighting."),
    ]);
    expect(kept.map((k) => `${k.design} ${k.severity}`)).toEqual(["D1 fix", "D2 fix", "D1 good"]);
  });

  it("summarizes fixes first", () => {
    const s = reviewSummary([n("watch", "Brief", "The brief asks for the product cut open; it's whole."), n("fix", "Text", "Typo in the CTA."), n("good", "Craft", "Sharp.")]);
    expect([s.fixes, s.watch, s.top[0].severity, s.good?.note]).toEqual([1, 1, "fix", "Sharp."]);
  });
});
