import { describe, expect, it } from "vitest";
import { applyEdits, splitBible } from "@/lib/bible-sections";
import { googleLinksIn, GUIDELINE_MARK, GUIDELINES_SECTION, hasGuidelines, isGuidelineFile, isGuidelineRow, mentionsGuideline, renderGuidelines, saysNotShared, type GuidelineRead } from "@/lib/brand-guidelines-core";

describe("brand guideline signals", () => {
  it("catches guidelines, logos, colors and fonts wherever they're shared", () => {
    expect(mentionsGuideline("Michelle updated the brand kit colors after the call")).toBe(true);
    expect(mentionsGuideline("She provided brand guidelines on the Oct 2 call")).toBe(true);
    expect(mentionsGuideline("New logo attached, primary is #2F4A3A")).toBe(true);
    expect(mentionsGuideline("Use Playfair for headlines, the font from the style guide")).toBe(true);
    expect(mentionsGuideline("Can we move the call to Thursday?")).toBe(false);
    expect(mentionsGuideline(null)).toBe(false);
  });

  it("knows a guideline file by its name", () => {
    expect(isGuidelineFile("Brand Guidelines")).toBe(true);
    expect(isGuidelineFile("logo-sand.png")).toBe(true);
    expect(isGuidelineFile("Q3 invoice.pdf")).toBe(false);
  });

  it("finds Google links shared in a message", () => {
    expect(googleLinksIn("Here you go https://docs.google.com/document/d/abc123/edit) thanks")).toEqual(["https://docs.google.com/document/d/abc123/edit"]);
    expect(googleLinksIn("no links")).toEqual([]);
  });
});

describe("a Bible that says the guideline isn't shared", () => {
  it("is flagged", () => {
    expect(saysNotShared("- Brand guideline: not shared")).toBe(true);
    expect(saysNotShared("Hex codes aren't on file yet; logo files are a gap")).toBe(true);
    expect(saysNotShared("Brand guidelines: [Brand Guidelines](https://docs.google.com/x), approved Nov 20")).toBe(false);
    expect(saysNotShared(null)).toBe(false);
  });
});

describe("the guidelines section", () => {
  const read: GuidelineRead = {
    found: true,
    colors: [{ name: "Deep green", hex: "#2F4A3A", use: "primary", source: "Slack, Oct 6" }],
    fonts: [{ name: "Playfair | Display", use: "headlines", source: "Drive: Brand Guidelines, Sep 30" }],
    logos: [{ name: "Sand logo", link: "https://drive.google.com/file/d/1", use: "on dark", source: "Drive, Sep 29" }],
    rules: [{ rule: "Never stretch the logo", source: "Drive: Brand Guidelines, Sep 30" }],
  };

  it("tags every line with its source and keeps tables intact", () => {
    const md = renderGuidelines(read, "Nov 20, 2026");
    expect(md).toContain("| Deep green | #2F4A3A | primary | Slack, Oct 6 |");
    expect(md).toContain("| Playfair / Display | headlines |");
    expect(md).toContain("- [Sand logo](https://drive.google.com/file/d/1): on dark (Drive, Sep 29)");
    expect(md).toContain("- Never stretch the logo (Drive: Brand Guidelines, Sep 30)");
  });

  it("goes into the Bible as its own section, before the change log", () => {
    const bible = "# Bible\n\n## 1. Read this first\n\nShort.\n\n## 12. Change log\n\n- Oct 1: built\n";
    const out = applyEdits(bible, [{ section: GUIDELINES_SECTION, markdown: renderGuidelines(read, "Nov 20, 2026") }]).markdown;
    const titles = splitBible(out).map((s) => s.title);
    expect(titles.indexOf("Brand guidelines")).toBeGreaterThan(-1);
    expect(titles.indexOf("Brand guidelines")).toBeLessThan(titles.findIndex((t) => /change log/i.test(t)));
  });

  it("proposes nothing when the material holds nothing", () => {
    expect(hasGuidelines(read)).toBe(true);
    expect(hasGuidelines({ found: true, colors: [], fonts: [], logos: [], rules: [] })).toBe(false);
    expect(hasGuidelines({ ...read, found: false })).toBe(false);
  });
});

describe("stored without a database change", () => {
  it("tells a guideline proposal from a team answer to an open question", () => {
    expect(isGuidelineRow({ kind: "question_answer", proposed: { ...GUIDELINE_MARK, fingerprint: "abc", gap: true } })).toBe(true);
    expect(isGuidelineRow({ kind: "question_answer", proposed: null })).toBe(false);
    expect(isGuidelineRow({ kind: "avatar_add", proposed: { name: "Busy mom", tier: "Primary", body: "" } })).toBe(false);
  });
});
