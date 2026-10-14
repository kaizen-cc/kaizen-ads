import { describe, expect, it } from "vitest";
import { aspectLabel, aspectOf, groupFiles, type StagedFile } from "@/lib/uploads/media";

const f = (name: string, folder: string | null = null, w = 1080, h = 1350): StagedFile => ({
  file: new File(["x"], name),
  folder,
  id: name,
  width: w,
  height: h,
  durationMs: null,
  thumb: null,
  preview: null,
  aspect: aspectOf(w, h),
});

describe("aspectOf", () => {
  it("names standard ratios", () => {
    expect(aspectOf(1080, 1080)).toBe("1x1");
    expect(aspectOf(1080, 1350)).toBe("4x5");
    expect(aspectOf(1080, 1920)).toBe("9x16");
    expect(aspectOf(1920, 1080)).toBe("16x9");
  });
  it("keeps odd sizes as pixels", () => {
    expect(aspectOf(1200, 700)).toBe("1200x700");
    expect(aspectLabel("1200x700")).toBe("1200×700");
    expect(aspectLabel("4x5")).toBe("4:5");
  });
});

describe("groupFiles", () => {
  it("puts sizes of one idea in one design", () => {
    const g = groupFiles([f("Calzone_4x5.jpg"), f("Calzone_9x16.jpg", null, 1080, 1920), f("Calzone - Story.png", null, 1080, 1920), f("Price-first_1x1.jpg")], "image");
    expect(g.map((d) => [d.name, d.files.length])).toEqual([
      ["Calzone", 3],
      ["Price First", 1],
    ]);
  });
  it("uses the folder when the file name is only a size", () => {
    const g = groupFiles([f("1x1.jpg", "Hero shot"), f("9x16.jpg", "Hero shot"), f("4x5.jpg", "Menu")], "image");
    expect(g.map((d) => d.files.length).sort()).toEqual([1, 2]);
  });
  it("makes one carousel per folder, cards in name order", () => {
    const g = groupFiles([f("card 10.jpg", "BFCM"), f("card 2.jpg", "BFCM"), f("card 1.jpg", "BFCM")], "carousel");
    expect(g).toHaveLength(1);
    expect(g[0].files.map((x) => x.file.name)).toEqual(["card 1.jpg", "card 2.jpg", "card 10.jpg"]);
  });
});
