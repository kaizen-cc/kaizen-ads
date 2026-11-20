import { describe, expect, it } from "vitest";
import { applyEdits, splitBible } from "@/lib/bible-sections";
import { backfillOrder, extractHexColors, latestGuidelineFiles, mergeHexColors, googleLinksIn, GUIDELINE_MARK, GUIDELINES_SECTION, hasGuidelines, isGuidelineFile, isGuidelineRow, mentionsGuideline, renderGuidelines, saysNotShared, type GuidelineRead } from "@/lib/brand-guidelines-core";

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

describe("finding guideline files", () => {
  const items = [
    { client_id: "a", title: "Brand Guidelines", url: "https://docs.google.com/document/d/1", occurred_at: "2026-09-30T10:00:00Z" },
    { client_id: "a", title: "Q3 invoice.pdf", url: null, occurred_at: "2026-11-01T10:00:00Z" },
    { client_id: "a", title: "logo-sand.png", url: null, occurred_at: "2026-10-05T10:00:00Z" },
    { client_id: "b", title: "Meeting notes", url: null, occurred_at: "2026-10-05T10:00:00Z" },
  ];
  it("keeps the newest guideline file per client and ignores other files", () => {
    const m = latestGuidelineFiles(items);
    expect(m.get("a")).toBe("2026-10-05T10:00:00Z");
    expect(m.has("b")).toBe(false);
  });
  it("reads each client once, guideline clients first, and again only for a newer file", () => {
    const latest = latestGuidelineFiles(items);
    expect(backfillOrder(["b", "a", "c"], [], latest)).toEqual(["a", "b", "c"]);
    const done = [{ clientId: "a", doneAt: "2026-11-20T00:00:00Z", filesAt: "2026-10-05T10:00:00Z" }];
    expect(backfillOrder(["a", "b"], done, latest)).toEqual(["b"]);
    latest.set("a", "2026-11-19T00:00:00Z");
    expect(backfillOrder(["a", "b"], done, latest)).toEqual(["b", "a"]);
    expect(backfillOrder(["a", "b", "c"], [], latest, 2)).toHaveLength(2);
  });
});

describe("hex colors in a guideline", () => {
  it("pulls each hex with its label and source, once", () => {
    const text = "Primary: Deep green #2F4A3A\nSand | #e8dcc4 | background\n#fff (white) and again #2f4a3a\nissue #12345 is not a color";
    const c = extractHexColors(text, "Drive: Brand Guidelines");
    expect(c.map((x) => x.hex)).toEqual(["#2F4A3A", "#E8DCC4", "#FFFFFF"]);
    expect(c[0].name).toBe("Primary: Deep green");
    expect(c[1].name).toBe("Sand");
    expect(c[2].name).toBe("white");
    expect(c.every((x) => x.source === "Drive: Brand Guidelines")).toBe(true);
  });
  it("adds only the colors the read missed", () => {
    const read: GuidelineRead = { found: false, colors: [{ name: "Green", hex: "#2f4a3a", use: "primary", source: "x" }], fonts: [], logos: [], rules: [] };
    const merged = mergeHexColors(read, extractHexColors("Sand #E8DCC4, Green #2F4A3A", "Drive"));
    expect(merged.colors.map((x) => x.hex)).toEqual(["#2f4a3a", "#E8DCC4"]);
    expect(merged.found).toBe(true);
    expect(hasGuidelines(merged)).toBe(true);
  });
});

describe("stored without a database change", () => {
  it("tells a guideline proposal from a team answer to an open question", () => {
    expect(isGuidelineRow({ kind: "question_answer", proposed: { ...GUIDELINE_MARK, fingerprint: "abc", gap: true } })).toBe(true);
    expect(isGuidelineRow({ kind: "question_answer", proposed: null })).toBe(false);
    expect(isGuidelineRow({ kind: "avatar_add", proposed: { name: "Busy mom", tier: "Primary", body: "" } })).toBe(false);
  });
});

import { isBrandFile, isBrandFolder, linksIn } from "@/lib/brand-guidelines-core";

describe("brand folders and intake links (Nov 20 2026)", () => {
  it("anything in the Headquarters' Brand or Guidelines folder counts, whatever it's called", () => {
    expect(isBrandFolder("Brand")).toBe(true);
    expect(isBrandFolder("Brand Guidelines")).toBe(true);
    expect(isBrandFolder("Logos")).toBe(true);
    expect(isBrandFolder(" Michelle Behre - Headquarters")).toBe(false);
    expect(isBrandFile({ title: "IMG_2041.png", meta: { folder: "Brand" } })).toBe(true);
    expect(isBrandFile({ title: "Brand Guidelines ", meta: { folder: "Headquarters" } })).toBe(true);
    expect(isBrandFile({ title: "Invoice.pdf", meta: { folder: "Billing" } })).toBe(false);
  });
  it("pulls every link from an intake answer, never a search page", () => {
    expect(linksIn("https://docs.google.com/presentation/d/1TLZ/edit?usp=sharing")).toEqual(["https://docs.google.com/presentation/d/1TLZ/edit?usp=sharing"]);
    expect(linksIn("Here: https://www.dropbox.com/scl/fi/abc/guide.pdf?dl=0.")).toEqual(["https://www.dropbox.com/scl/fi/abc/guide.pdf?dl=0"]);
    expect(linksIn("https://www.google.com/search?q=apartments")).toEqual([]);
    expect(linksIn("Will send in slack")).toEqual([]);
  });
});

describe("never a photo shoot or junk (Michelle Behre's Drive, Nov 20 2026)", () => {
  const shoot = " Michelle Behre - Headquarters / Images / 2026_08-28 Brandon and Alex - Pendry Natirar Proposal / Posts / THE ENGAGEMENT SESSION";
  it("a couple named Brandon isn't a brand folder", () => {
    expect(isBrandFolder(shoot)).toBe(false);
    expect(isBrandFile({ title: "0006-Michelle Behre Photography_Pendry Natirar-MBG_9740.jpg", meta: { folder: shoot } })).toBe(false);
    expect(isBrandFile({ title: "Michelle Behre Photo Brandon and Alex Film Lifestyle Photo Collage Instagram Reel.mp4", meta: { folder: shoot } })).toBe(false);
    expect(isBrandFile({ title: "Michelle Behre Photo_Jude Jacob Color Palette Instagram Story.jpg", meta: { folder: "Images / Story" } })).toBe(false);
  });
  it("junk files never count, even in the brand folder", () => {
    expect(isBrandFile({ title: ".DS_Store", meta: { folder: " Michelle Behre - Headquarters / Logos and Brand Guide" } })).toBe(false);
    expect(isBrandFile({ title: ".BridgeSort", meta: { folder: "Brand" } })).toBe(false);
  });
  it("the real brand folder and guideline files do", () => {
    const brand = " Michelle Behre - Headquarters / Logos and Brand Guide";
    expect(isBrandFile({ title: "michelle-behre-monogram-sand-rgb-900px-w-72ppi.png", meta: { folder: brand } })).toBe(true);
    expect(isBrandFile({ title: "Michelle Behre Photography Brand Style Lookbook.pdf", meta: { folder: brand } })).toBe(true);
    expect(isBrandFile({ title: "Brand Guidelines ", meta: { folder: " Michelle Behre - Headquarters" } })).toBe(true);
    expect(isGuidelineFile("michelle-behre-horizontal-wordmark-deep-green-cmyk.pdf")).toBe(true);
  });
});
