import { describe, expect, it } from "vitest";
import { allotmentWithProgress, describeAllotment, inProgress, toAllotment } from "@/lib/allotment";
import { avatarsOf, matchAvatar } from "@/lib/bible-sections";
import { motionBlock, motionLine, motionMatches, type MotionItem } from "@/lib/in-motion";
import { applySeed, jobKeyOf, quickEdited, seedBlock, type QuickBrief } from "@/lib/quick-brief";
import { linkKind, linksIn, linkSaveInput } from "@/lib/saved-references";

// The Head of Creative's feedback on briefing (Nov 6 2026): in progress beside used, what's in motion on the board and
// in Asana, any link as a reference, one talked-through brief refined (not rewritten), avatars from the Brand Bible.

describe("in progress beside used", () => {
  const a = toAllotment({ client_id: "c", images_per_month: 25, videos_per_month: 5, images_used: 0, videos_used: 2, progress_images: 14, progress_videos: 0 });
  it("says what's coming next to what's used, per pool", () => {
    expect(allotmentWithProgress(a)).toBe("Images 0/25 used · 14 in progress · Videos 2/5 used");
    expect(inProgress(a, "images")).toBe(14);
  });
  it("tells the AI not to overproduce against it", () => {
    expect(describeAllotment(a)).toMatch(/In progress right now .*14 images/);
  });
});

describe("already in motion", () => {
  const items: MotionItem[] = [
    { key: "R123", source: "board", number: 123, title: "Holiday promo bundle", stage: "in_production", stageLabel: "in production", format: "image", brief: "The holiday promo: 20% off gift boxes", href: "/board?t=123", avatar: null, angle: null, createdAt: null },
    { key: "A9", source: "asana", number: null, title: "Spring menu launch", stage: "requested", stageLabel: "briefed", format: "video", brief: "", href: null, avatar: null, angle: null, createdAt: null },
  ];
  it("reads as the ticket and its stage", () => {
    expect(motionLine(items[0])).toBe("#123 Holiday promo bundle (in production)");
    expect(motionLine(items[1])).toBe("Asana: Spring menu launch (briefed)");
  });
  it("finds the one a brief overlaps", () => {
    expect(motionMatches(items, "New holiday promo gift boxes for December").map((m) => m.key)).toEqual(["R123"]);
    expect(motionBlock(items)).toContain("never claim there's no request");
  });
});

describe("avatars from the Brand Bible", () => {
  const bible = `# Bible\n\n## 2. Offers\n\nStuff\n\n## 3. Audience profiles\n\nIntro\n\n### Pain to angle matrix\n\n| a | b |\n\n### A · Liquidating Seller (Likely)\n\nA business owner closing down.\n\n### B · Big-Truck Buyer (Hypothesis)\n\n**Who:** fleet buyers\n\n## 4. Voice\n\nPlain.`;
  it("lists the lettered profiles, by name", () => {
    expect(avatarsOf(bible)).toEqual([
      { name: "Liquidating Seller", tier: "Likely", who: "A business owner closing down." },
      { name: "Big-Truck Buyer", tier: "Hypothesis", who: "Who: fleet buyers" },
    ]);
  });
  it("matches a name however it's written", () => {
    const list = avatarsOf(bible);
    expect(matchAvatar(list, "B · big-truck buyer")?.name).toBe("Big-Truck Buyer");
    expect(matchAvatar(list, "Weekend Warrior")).toBeNull();
  });
});

describe("one brief, refined", () => {
  const base: QuickBrief = { title: "Gift boxes", concept: "c", angle: "a", audience: "x", hook: "h", formats: [{ format: "image", new: 1, variations: 0 }], why: "", note: "" };
  it("keeps the talk's job key while the talk goes on", () => {
    const turns = [{ role: "user" as const, text: "3 statics for the holiday promo" }];
    expect(jobKeyOf({ kind: "talk", turns })).toBe(jobKeyOf({ kind: "talk", turns: [...turns, { role: "ai", text: "ok" }], current: base, refs: ["https://pin.it/x"] }));
  });
  it("carries the avatar and references into the full brief", () => {
    const seed = { ...base, avatar: "Liquidating Seller", refs: ["https://www.tiktok.com/@a/video/1"] };
    expect(quickEdited(base, seed)).toBe(true);
    expect(seedBlock(seed)).toContain("Avatar: Liquidating Seller");
    const out = applySeed({ title: "t", formats: [], refs: ["https://a.com"] }, seed);
    expect(out).toMatchObject({ avatar: "Liquidating Seller", avatarTest: false, refs: ["https://www.tiktok.com/@a/video/1", "https://a.com"] });
  });
});

describe("any link as a reference", () => {
  it("knows what each link is", () => {
    expect(linkKind("https://app.motionapp.com/share/abc")).toBe("motion");
    expect(linkKind("https://pin.it/1abc")).toBe("pinterest");
    expect(linkKind("https://www.instagram.com/p/xyz/")).toBe("instagram");
    expect(linkKind("https://www.tiktok.com/@a/video/1")).toBe("tiktok");
    expect(linkKind("https://www.facebook.com/ads/library/?id=123456789")).toBe("meta_ad_library");
    expect(linkKind("https://youtu.be/abc")).toBe("youtube");
    expect(linkKind("https://brand.com/offer")).toBe("link");
  });
  it("pulls links out of a chat message", () => {
    expect(linksIn("like this one https://pin.it/abc, and https://youtu.be/x.")).toEqual(["https://pin.it/abc", "https://youtu.be/x"]);
  });
  it("saves a link by its address", () => {
    const s = linkSaveInput({ url: "https://pin.it/abc", kind: "pinterest", title: "Pin", subtitle: null, thumbnail: null, site: "Pinterest", adId: null });
    expect(s).toMatchObject({ source: "link", url: "https://pin.it/abc", title: "Pin", subtitle: "Pinterest" });
  });
});
