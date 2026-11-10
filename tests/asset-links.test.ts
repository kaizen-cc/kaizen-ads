import { describe, expect, it } from "vitest";
import { attachLinks, linkAssetItems, linkBriefAssets, linkFor, linkWord, splitLink, type CatalogFile } from "@/lib/asset-links";
import { cleanSpec, parseBrief } from "@/lib/brief-spec";

// Every asset a brief lists carries its Drive link, found from the name the writer used: never guessed.

const files: CatalogFile[] = [
  { name: "Dan_Interview_Mar2025.mp4", kind: "video", folder: "Interviews / Dan", url: "https://drive.google.com/file/d/dan1/view", folderUrl: "https://drive.google.com/drive/folders/fDan" },
  { name: "dance-party-oct.mov", kind: "video", folder: "Events / Fall Party", url: "https://drive.google.com/file/d/dance/view", folderUrl: "https://drive.google.com/drive/folders/fParty" },
  { name: "IMG_1.jpg", kind: "image", folder: "Photos", url: "https://drive.google.com/file/d/img1/view", folderUrl: "https://drive.google.com/drive/folders/fPhotos" },
  { name: "Storefront hero.jpg", kind: "image", folder: "Brand Shoot 2026", url: "https://drive.google.com/file/d/hero/view", folderUrl: null },
];

describe("linkFor", () => {
  it("finds the file a line names, whatever its punctuation", () => {
    expect(linkFor("Dan Interview Mar2025 (Drive: Interviews / Dan), the answer about price", files)).toBe("https://drive.google.com/file/d/dan1/view");
    expect(linkFor("Storefront hero for the end card", files)).toBe("https://drive.google.com/file/d/hero/view");
  });
  it("falls back to the folder it names", () => {
    expect(linkFor("Any clip from the Dan interview (Drive: Interviews / Dan)", files)).toBe("https://drive.google.com/drive/folders/fDan");
    expect(linkFor("Party footage (Drive: Fall Party)", files)).toBe("https://drive.google.com/drive/folders/fParty");
  });
  it("never guesses: a line that names nothing, or only a generic folder word, gets no link", () => {
    expect(linkFor("A clip of the team plating a dish", files)).toBeNull();
    expect(linkFor("photos of the product", files)).toBeNull();
    // A one-word file name is too loose
    expect(linkFor("IMG 1 of the bar", files)).toBeNull();
  });
});

describe("linkAssetItems and linkBriefAssets", () => {
  it("links Have lines only, once", () => {
    const out = linkAssetItems(
      [
        { item: "Dan Interview Mar2025 (Drive: Interviews / Dan)", status: "have" },
        { item: "Dan Interview Mar2025 b-roll", status: "need" },
        { item: "Storefront hero https://drive.google.com/file/d/other/view", status: "have" },
      ],
      files,
    );
    expect(out[0].item).toMatch(/https:\/\/drive\.google\.com\/file\/d\/dan1\/view$/);
    expect(out[1].item).not.toMatch(/https/);
    expect(out[2].item).toBe("Storefront hero https://drive.google.com/file/d/other/view");
  });
  it("keeps the brief's sections and puts the link on the line, and survives being cleaned again", () => {
    const brief = "The answer about price, in his words.\n\nInsight: Price comes up first on calls. (Source: call Oct 12)\n\nHook: What it really costs\n\nAssets:\n- Have: Dan Interview Mar2025 (Drive: Interviews / Dan), the price answer\n- Need: a 4:5 still of the storefront at night\n\nYour call: Pacing is yours.";
    const linked = linkBriefAssets(brief, files);
    const spec = parseBrief(linked).spec;
    expect(spec.assets[0].item).toContain("https://drive.google.com/file/d/dan1/view");
    expect(spec.assets[1].item).not.toContain("https");
    expect(spec.insight).toContain("Price comes up first");
    expect(cleanSpec(spec).assets[0].item).toContain("https://drive.google.com/file/d/dan1/view");
    expect(linkBriefAssets(linked, files)).toBe(linked);
  });
  it("leaves free text alone", () => {
    expect(linkBriefAssets("Just an idea about Dan Interview Mar2025", files)).toBe("Just an idea about Dan Interview Mar2025");
  });
});

describe("the PDF's lines", () => {
  it("get the link of the brief line they describe", () => {
    const out = attachLinks(["Dan's interview: the price answer", "Night storefront still (client to send)"], [{ item: "Dan Interview Mar2025, the price answer https://drive.google.com/file/d/dan1/view", status: "have" }]);
    expect(out[0]).toMatch(/dan1\/view$/);
    expect(out[1]).not.toMatch(/https/);
  });
  it("split back into text and link, with a short label", () => {
    expect(splitLink("Dan interview (Drive: Interviews) https://drive.google.com/file/d/dan1/view")).toEqual({ text: "Dan interview (Drive: Interviews)", url: "https://drive.google.com/file/d/dan1/view" });
    expect(linkWord("https://drive.google.com/drive/folders/x")).toBe("Open folder");
    expect(linkWord("https://drive.google.com/file/d/x/view")).toBe("Open in Drive");
  });
});
