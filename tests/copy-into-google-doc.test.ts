import { describe, expect, it } from "vitest";
import { copyDocLines, docAppendRequests, googleDocIdOf, nextEmailNumber, normalizeCopy } from "@/lib/copy-docs/core";

// Issue #141: the Copywriter couldn't write into a client's existing copy doc ("November campaigns"), so the team pasted
// it by hand. The copy now goes into the end of that doc in the same layout, numbered on from the emails already there.

const copy = normalizeCopy({
  kind: "campaign",
  title: "Black Friday and Cyber Monday",
  short_name: "BFCM",
  emails: [
    { name: "Black Friday Deals", subject: "The edit, now lighter", preview: "More than sixty houses", sections: [{ heading: "Black Friday at La Jetée", body: "Savings across the houses" }, { heading: "Amouage", body: "Ten percent off" }], cta: { label: "Shop the sale", url: "https://example.com/sale" }, design_notes: ["Pictures only", "No codes"] },
    { name: "Cyber Monday", subject: "Last chance", preview: "New houses added", sections: [{ heading: "Cyber Monday", body: "The page closes tonight" }], cta: { label: "Shop now", url: "" }, design_notes: [] },
  ],
  brief: { send_date: "2026-11-27" },
});

describe("copy into an existing Google Doc", () => {
  it("numbers on from the emails already in the doc", () => {
    expect(nextEmailNumber("KZN x La Jetée | November Campaigns | Email #1\nSubject Line: a\n...Email #6\nSubject Line: b")).toBe(7);
    expect(nextEmailNumber("A doc with no emails yet")).toBe(1);
  });

  it("writes the Template Library layout", () => {
    const lines = copyDocLines(copy, { client: "La Jetée", from: 7 });
    const text = lines.map((l) => l.text);
    expect(text).toContain("KZN x La Jetée | November Campaigns | Email #7");
    expect(text).toContain("KZN x La Jetée | November Campaigns | Email #8");
    for (const l of ["Subject Line: The edit, now lighter", "Preview Text: More than sixty houses", "Headline: Black Friday at La Jetée", "Sub-headline: Savings across the houses", "Hero CTA: Shop the sale (https://example.com/sale)", "Block 1 Headline: Amouage", "Block 1 Copy: Ten percent off"]) expect(text).toContain(l);
    expect(lines.find((l) => l.text.startsWith("Subject Line"))?.bold).toBe("Subject Line: ".length);
    expect(lines.filter((l) => l.bullet).map((l) => l.text)).toEqual(["Pictures only", "No codes"]);
  });

  it("appends at the end of the doc with the labels bold and the notes as bullets", () => {
    const lines = [
      { text: "Email #7", bold: 8 },
      { text: "Design Notes:", bold: 13 },
      { text: "A", bold: 0, bullet: true },
      { text: "B", bold: 0, bullet: true },
    ];
    const reqs = docAppendRequests(lines, 100);
    expect(reqs[0]).toEqual({ insertText: { location: { index: 99 }, text: "\nEmail #7\nDesign Notes:\nA\nB" } });
    // "Email #7" starts right after the inserted line break
    expect(reqs).toContainEqual({ updateTextStyle: { range: { startIndex: 100, endIndex: 108 }, textStyle: { bold: true }, fields: "bold" } });
    expect(reqs).toContainEqual({ updateTextStyle: { range: { startIndex: 109, endIndex: 122 }, textStyle: { bold: true }, fields: "bold" } });
    const bullets = reqs.filter((r) => "createParagraphBullets" in r);
    expect(bullets).toHaveLength(1);
    expect((bullets[0].createParagraphBullets as { range: unknown }).range).toEqual({ startIndex: 123, endIndex: 126 });
    expect(docAppendRequests([], 100)).toEqual([]);
  });

  it("reads a Doc's id from its link", () => {
    expect(googleDocIdOf("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?tab=t.0")).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(googleDocIdOf("https://drive.google.com/drive/folders/abc")).toBeNull();
  });
});
