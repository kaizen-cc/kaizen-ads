import { describe, expect, it } from "vitest";
import { clampFormatRecord, clampFormats, filterByFormat, firstFormat, fitsAnyFormat, fitsFormat, formatList, formatsFor, formatsPhrase, formatsOutside, formatsRule, keepFormats, marketFormatOf, normalizeFormat, seesAllFormats } from "@/lib/creative-formats";

// The owner's rule: everywhere the app suggests or lets someone request creative, the formats fit the person's
// position. A graphic designer only images and carousels, a video editor only video, everyone else both.

describe("formatsFor", () => {
  it("keeps a graphic designer to single images and carousels", () => {
    expect([...formatsFor("graphic_designer")]).toEqual(["image", "carousel"]);
  });
  it("keeps a video editor to video", () => {
    expect([...formatsFor("video_editor")]).toEqual(["video"]);
  });
  it("gives heads of creative, executives, buyers and everyone else every format", () => {
    for (const r of ["head_of_creative", "executive", "media_buyer", "google_buyer", "head_of_meta", "head_of_google", "copywriter", "customer_success", null, undefined, "something_new"])
      expect(formatList(r)).toEqual(["image", "carousel", "video"]);
  });
  it("reads a signed-in staff member, and a lead or exec always sees everything", () => {
    expect(formatList({ role: "video_editor" })).toEqual(["video"]);
    expect(formatList({ role: "graphic_designer", isLead: true })).toEqual(["image", "carousel", "video"]);
    expect(formatList({ role: "video_editor", isExec: true })).toEqual(["image", "carousel", "video"]);
  });
});

describe("lead makers", () => {
  it("keeps a lead graphic designer to single images and carousels, like a graphic designer", () => {
    expect(formatList("lead_graphic_designer")).toEqual(["image", "carousel"]);
    expect(formatList({ role: "lead_graphic_designer", isLead: false, isExec: false })).toEqual(["image", "carousel"]);
  });
  it("keeps a lead video editor to video, like a video editor", () => {
    expect(formatList("lead_video_editor")).toEqual(["video"]);
    expect(formatList({ role: "lead_video_editor" })).toEqual(["video"]);
  });
});

describe("filters", () => {
  const designer = formatsFor("graphic_designer");
  const editor = formatsFor("video_editor");
  it("normalizes stored format words", () => {
    expect(normalizeFormat("Video")).toBe("video");
    expect(normalizeFormat("carousel_ad")).toBe("carousel");
    expect(normalizeFormat("single image")).toBe("image");
    expect(normalizeFormat(null)).toBeNull();
    expect(normalizeFormat("dpa")).toBeNull();
  });
  it("keeps an item whose format can't be told", () => {
    expect(fitsFormat(designer, null)).toBe(true);
    expect(fitsFormat(designer, "video")).toBe(false);
    expect(fitsFormat(editor, "carousel")).toBe(false);
  });
  it("keeps a mixed brief when one of its formats fits", () => {
    expect(fitsAnyFormat(designer, ["video", "image"])).toBe(true);
    expect(fitsAnyFormat(designer, ["video"])).toBe(false);
    expect(fitsAnyFormat(editor, [])).toBe(true);
  });
  it("filters a list", () => {
    const items = [{ f: "image" }, { f: "video" }, { f: "carousel" }, { f: null }];
    expect(filterByFormat(items, designer, (x) => x.f).map((x) => x.f)).toEqual(["image", "carousel", null]);
    expect(filterByFormat(items, editor, (x) => x.f).map((x) => x.f)).toEqual(["video", null]);
    expect(filterByFormat(items, formatsFor("executive"), (x) => x.f)).toHaveLength(4);
  });
});

describe("clamps", () => {
  it("drops formats someone can't request, and starts them in their own format when none is left", () => {
    expect(clampFormats([{ format: "video", new: 2, variations: 0 }, { format: "image", new: 1, variations: 1 }], formatsFor("graphic_designer"))).toEqual([{ format: "image", new: 1, variations: 1 }]);
    expect(clampFormats([{ format: "image", new: 2, variations: 0 }], formatsFor("video_editor"))).toEqual([{ format: "video", new: 1, variations: 0 }]);
  });
  it("clamps a request form's formats", () => {
    expect(clampFormatRecord({ video: { new: 1, variations: 0 }, carousel: { new: 2, variations: 0 } }, ["image", "carousel"])).toEqual({ carousel: { new: 2, variations: 0 } });
    expect(clampFormatRecord({ image: { new: 1, variations: 0 } }, ["video"])).toEqual({ video: { new: 1, variations: 0 } });
  });
  it("keeps only what fits, adding nothing, and says what was left out", () => {
    const rec = { image: { new: 1, variations: 0 } };
    expect(keepFormats(rec, ["image", "carousel"])).toBe(rec);
    expect(keepFormats({ video: { new: 1, variations: 0 } }, ["image", "carousel"])).toEqual({});
    expect(formatsOutside(["video", "image"], ["image", "carousel"])).toEqual(["video"]);
  });
  it("words it for people and prompts", () => {
    expect(firstFormat(formatsFor("video_editor"))).toBe("video");
    expect(formatsPhrase(formatsFor("graphic_designer"))).toBe("single images and carousels");
    expect(seesAllFormats(formatsFor("media_buyer"))).toBe(true);
    expect(formatsRule(formatsFor("media_buyer"))).toBe("");
    expect(formatsRule(formatsFor("video_editor"))).toContain('"video"');
  });
  it("reads a market ad's format from Motion's word and its media", () => {
    expect(marketFormatOf({ format: "carousel", media: [] })).toBe("carousel");
    expect(marketFormatOf({ format: null, media: [{ type: "video" }] })).toBe("video");
    expect(marketFormatOf({ format: null, media: [{ type: "image" }, { type: "video" }] })).toBe("image");
  });
});
