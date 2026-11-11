import { describe, expect, it } from "vitest";
import { neededSizes, ratioProgress } from "@/lib/ratio-progress";

const file = (aspect: string) => ({ aspect, card: null });

describe("ratioProgress: the sizes needed against uploaded, per version", () => {
  it("V1 4:5 in, 9:16 missing; V2 not uploaded yet", () => {
    const p = ratioProgress({ format: "image", sizes: ["4x5", "9x16"], newCount: 2, variationCount: 0 }, [{ position: 1, isVariation: false, files: [file("4x5")] }]);
    expect(p.rows.map((r) => [r.label, r.uploaded, r.items.map((i) => `${i.label}${i.ok ? " ok" : ""}`)])).toEqual([
      ["V1", true, ["4:5 ok", "9:16"]],
      ["V2", false, ["4:5", "9:16"]],
    ]);
    expect([p.done, p.total]).toEqual([1, 4]);
  });

  it("variations count as versions of their own", () => {
    const p = ratioProgress({ format: "image", sizes: ["4x5"], newCount: 1, variationCount: 1 }, [{ position: 1, isVariation: false, files: [file("4x5")] }]);
    expect(p.rows.map((r) => [r.label, r.variation])).toEqual([
      ["V1", false],
      ["V2", true],
    ]);
  });

  it("carousels count slides", () => {
    const p = ratioProgress({ format: "carousel", sizes: ["4x5"], newCount: 1, variationCount: 0, cards: 5 }, [{ position: 1, isVariation: false, files: [1, 2, 3].map((card) => ({ aspect: "4x5", card })) }]);
    expect(p.rows[0].items).toEqual([{ label: "3 of 5 slides", ok: false }]);
  });

  it("1:1 isn't part of the standard; no sizes set means both standard sizes", () => {
    expect(neededSizes(["1x1", "4:5"])).toEqual(["4x5"]);
    expect(neededSizes([])).toEqual(["4x5", "9x16"]);
  });

  it("all in", () => {
    const p = ratioProgress({ format: "video", sizes: ["9x16", "4x5"], newCount: 1, variationCount: 0 }, [{ position: 1, isVariation: false, files: [file("9x16"), file("4x5")] }]);
    expect(p.done).toBe(p.total);
  });
});
