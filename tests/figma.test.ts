import { describe, expect, it } from "vitest";
import { nodeText, parseFigmaLink } from "@/lib/figma";

describe("Figma links and files", () => {
  it("reads a file key and a frame from a link", () => {
    expect(parseFigmaLink("https://www.figma.com/design/AbCdEfGhIj123/Kore-BFCM?node-id=12-34&t=x")).toEqual({ key: "AbCdEfGhIj123", node: "12:34", kind: "design" });
    expect(parseFigmaLink("https://figma.com/board/ZZZZZZZZZZ12/Map")).toMatchObject({ key: "ZZZZZZZZZZ12", node: null, kind: "board" });
    expect(parseFigmaLink("https://example.com/design/AbCdEfGhIj123")).toBeNull();
  });
  it("walks a file into pages, frames and text", () => {
    const r = nodeText({ id: "0:0", name: "Doc", type: "DOCUMENT", children: [{ id: "1:1", name: "Ads", type: "CANVAS", children: [{ id: "2:2", name: "Hero 4x5", type: "FRAME", absoluteBoundingBox: { width: 1080, height: 1350 }, children: [{ id: "3:3", name: "Headline", type: "TEXT", characters: "Black Friday  50% off" }] }] }] });
    expect(r.frames).toEqual([{ id: "2:2", name: "Hero 4x5", page: "Ads", size: "1080×1350" }]);
    expect(r.text).toContain("# Page: Ads");
    expect(r.text).toContain("- Black Friday 50% off");
  });
});
