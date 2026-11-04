import { describe, expect, it } from "vitest";
import { isLoomSpace, loomFolders, loomLinks, pastedLooms } from "@/lib/loom-links";

const A = "64ab914990654627836faa953282f302";
const B = "23f08cf6a8a648b8b17c55c551548cab";
const F = "0123456789abcdef0123456789abcdef";

describe("Loom links in text", () => {
  it("finds share, embed and Slack-formatted links, once each", () => {
    const text = `see <https://www.loom.com/share/${A}?sid=x|Audit> and https://loom.com/embed/${B}\nagain https://www.loom.com/share/${A}`;
    expect(loomLinks(text).map((l) => l.id)).toEqual([A, B]);
    expect(loomLinks(text)[0].url).toBe(`https://www.loom.com/share/${A}`);
  });

  it("keeps folder links apart from videos", () => {
    const text = `https://www.loom.com/share/folder/${F} and https://www.loom.com/share/${A}`;
    expect(loomFolders(text).map((f) => f.id)).toEqual([F]);
    expect(loomLinks(text).map((l) => l.id)).toEqual([A]);
    expect(pastedLooms(text).map((l) => l.id)).toEqual([A]);
  });

  it("reads a pasted list with bare ids and a CSV export", () => {
    const text = `${A}\n"Title","https://www.loom.com/share/${B}"\n${A.toUpperCase()}\nnot-an-id-${F}x`;
    expect(pastedLooms(text).map((l) => l.id)).toEqual([B, A]);
  });

  it("spots a Space link", () => {
    expect(isLoomSpace("https://www.loom.com/spaces/Team-123")).toBe(true);
    expect(isLoomSpace(`https://www.loom.com/share/${A}`)).toBe(false);
  });
});
