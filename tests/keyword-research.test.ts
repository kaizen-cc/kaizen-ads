import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai", () => ({ askJson: vi.fn(), aiEnabled: () => false, clientContext: vi.fn(), contextBlock: vi.fn() }));

const { cleanKeywords, looksLikeChain, sortIdeas } = await import("@/lib/keyword-research");

describe("keyword research", () => {
  it("spots another business's name", () => {
    expect(looksLikeChain("mcdonald's near me")).toBe(true);
    expect(looksLikeChain("chick fil a catering")).toBe(true);
    expect(looksLikeChain("home depot countertops")).toBe(true);
    expect(looksLikeChain("restaurant near me")).toBe(false);
    expect(looksLikeChain("bbq catering houston")).toBe(false);
  });

  it("cleans picked keywords: lower case, no match marks, one per text, match and negative", () => {
    const out = cleanKeywords([
      { text: '  "BBQ Catering"  ', match: "phrase", negative: false, searches: 880 },
      { text: "bbq catering", match: "phrase", negative: false },
      { text: "[smoked brisket]", match: "exact", negative: false },
      { text: "mcdonald's near me", match: "broad", negative: true },
      { text: "", match: "phrase", negative: false },
      { text: "brunch", match: "nonsense" as never, negative: false },
    ]);
    expect(out.map((k) => `${k.text}|${k.match}|${k.negative}`)).toEqual(["bbq catering|phrase|false", "smoked brisket|exact|false", "mcdonald's near me|broad|true", "brunch|phrase|false"]);
    expect(out[0].searches).toBe(880);
  });

  it("without the AI, keeps ideas and sets chains apart", async () => {
    const { map, sorted } = await sortIdeas("A restaurant", "test", ["breakfast near me", "mcdonald's near me"]);
    expect(sorted).toBe(false);
    expect(map.get("breakfast near me")?.group).toBe("relevant");
    expect(map.get("mcdonald's near me")?.group).toBe("competitor");
  });
});
