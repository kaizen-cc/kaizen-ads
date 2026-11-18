import { describe, expect, it } from "vitest";
import { ASSISTANT_TINT, assistantTintOf, cleanAssistantName, colorFromWords, fitTone, normalizeHex, pickedColor } from "@/lib/agent-look";
import { cleanEdit, parseSlackUser, reimportPatch, seedPatch, tenureOf, themeBreakdown } from "@/lib/profile";
import { findVoice, groupOf, groupVoices, mergeVoices, optionOf, parseVoices, voiceMatches } from "@/lib/voices";

const slackBody = {
  user: { id: "U123", real_name: "Dana Cruz", profile: { real_name: "Dana Cruz", title: "Media Buyer", status_text: "Heads down on reports", is_custom_image: true, image_512: "https://avatars.slack-edge.com/dana_512.jpg" } },
};

describe("seeding a profile from Slack (once, never overwriting)", () => {
  const person = parseSlackUser(slackBody)!;

  it("reads the real name, title, status and picture", () => {
    expect(person).toMatchObject({ id: "U123", name: "Dana Cruz", title: "Media Buyer", status: "Heads down on reports", image: "https://avatars.slack-edge.com/dana_512.jpg" });
  });

  it("reads users.profile.get's shape too, and leaves out Slack's stand-in picture", () => {
    const p = parseSlackUser({ profile: { real_name: "Sam", is_custom_image: false, image_512: "https://secure.gravatar.com/x.png" } })!;
    expect(p.name).toBe("Sam");
    expect(p.image).toBeNull();
    expect(parseSlackUser({})).toBeNull();
  });

  it("fills every empty field the first time", () => {
    const patch = seedPatch({ display_name: null, title: null, bio: null, avatar_url: null, profile_seeded_at: null }, person, "https://kaizen/avatars/dana.jpg");
    expect(patch).toEqual({ display_name: "Dana Cruz", title: "Media Buyer", bio: "Heads down on reports", avatar_url: "https://kaizen/avatars/dana.jpg" });
  });

  it("never overwrites a field that already has something", () => {
    const patch = seedPatch({ display_name: "Dani", title: "Head of Meta", bio: null, avatar_url: "https://kaizen/mine.jpg", profile_seeded_at: null }, person, "https://kaizen/avatars/dana.jpg");
    expect(patch).toEqual({ bio: "Heads down on reports" });
  });

  it("does nothing once it has been seeded, however much Slack has changed", () => {
    expect(seedPatch({ display_name: null, title: null, bio: null, avatar_url: null, profile_seeded_at: "2026-11-19T10:00:00Z" }, person, "https://x/y.jpg")).toBeNull();
  });

  it("seeds an empty patch (and so marks it done) when Slack has no such person", () => {
    expect(seedPatch({ profile_seeded_at: null }, null, null)).toEqual({});
  });

  it("re-imports only the one field asked for, and nothing when Slack has none", () => {
    expect(reimportPatch("title", person, null)).toEqual({ title: "Media Buyer" });
    expect(reimportPatch("bio", person, null)).toEqual({ bio: "Heads down on reports" });
    expect(reimportPatch("avatar_url", person, null)).toBeNull();
    expect(reimportPatch("title", { ...person, title: null }, null)).toBeNull();
    expect(reimportPatch("title", null, null)).toBeNull();
  });
});

describe("editing a profile", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  it("trims and limits the text fields, and only touches the ones given", () => {
    const r = cleanEdit({ title: "  Head   of Meta  ", bio: "x".repeat(900) }, now);
    expect(r.ok && r.patch.title).toBe("Head of Meta");
    expect(r.ok && r.patch.bio?.length).toBe(500);
    expect(r.ok && "display_name" in r.patch).toBe(false);
    expect(cleanEdit({ title: "   " }, now)).toEqual({ ok: true, patch: { title: null } });
  });
  it("checks the start date", () => {
    expect(cleanEdit({ start_date: "2024-02-03" }, now)).toEqual({ ok: true, patch: { start_date: "2024-02-03" } });
    expect(cleanEdit({ start_date: "" }, now)).toEqual({ ok: true, patch: { start_date: null } });
    expect(cleanEdit({ start_date: "2024-02-31" }, now).ok).toBe(false);
    expect(cleanEdit({ start_date: "next week" }, now).ok).toBe(false);
    expect(cleanEdit({ start_date: "2027-01-01" }, now).ok).toBe(false);
    expect(cleanEdit({ start_date: "1975-01-01" }, now).ok).toBe(false);
  });
});

describe("time with the company", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  it("says it in years and months", () => {
    expect(tenureOf("2024-08-19", now)).toBe("2 years, 3 months");
    expect(tenureOf("2025-11-19", now)).toBe("1 year");
    expect(tenureOf("2026-06-30", now)).toBe("4 months");
    expect(tenureOf("2026-11-10", now)).toBe("Just joined");
    expect(tenureOf("2026-12-01", now)).toBe("Starting soon");
    expect(tenureOf(null, now)).toBeNull();
    expect(tenureOf("garbage", now)).toBeNull();
  });
});

describe("who uses light, dark or system", () => {
  it("counts each choice, and people who never chose apart", () => {
    expect(themeBreakdown([{ theme: "dark" }, { theme: "dark" }, { theme: "light" }, { theme: "system" }, { theme: null }])).toEqual({ dark: 2, light: 1, system: 1, unset: 1, total: 5 });
  });
});

describe("assistant colors", () => {
  it("validates hex codes in the forms people type", () => {
    expect(normalizeHex("#2A9D8F")).toBe("#2a9d8f");
    expect(normalizeHex(" 2a9d8f ")).toBe("#2a9d8f");
    expect(normalizeHex("#2a9")).toBe("#22aa99");
    for (const bad of ["#12345", "#gggggg", "teal", "", null, 12, "#1234567"]) expect(normalizeHex(bad)).toBeNull();
  });
  it("brings a near-white or near-black pick to the middle so it reads on both themes, and leaves a good one alone", () => {
    expect(fitTone("#d39b2a")).toBe("#d39b2a");
    const light = fitTone("#f5f5f5");
    const dark = fitTone("#050505");
    expect(light).not.toBe("#f5f5f5");
    expect(dark).not.toBe("#050505");
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    // Lightness lands in the 40-62% band: neither is near white or black any more
    const lum = (h: string) => (parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16)) / 3;
    expect(lum(light)).toBeLessThan(180);
    expect(lum(dark)).toBeGreaterThan(80);
  });
  it("accepts swatches, names and any valid hex, and falls back to the default", () => {
    expect(pickedColor("#2A9D8F")).toBe("#2a9d8f");
    expect(pickedColor("#123456")).toMatch(/^#[0-9a-f]{6}$/);
    expect(pickedColor("nope")).toBeNull();
    expect(assistantTintOf("nope")).toBe(ASSISTANT_TINT);
    expect(colorFromWords("Teal")).toBe("#2a9d8f");
    expect(colorFromWords("#abc")).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorFromWords("chartreuse")).toBeNull();
  });
  it("cleans the name it's given", () => {
    expect(cleanAssistantName("  Juno  ")).toBe("Juno");
    expect(cleanAssistantName("<b>Max</b> the   great and powerful assistant")?.length).toBeLessThanOrEqual(24);
    expect(cleanAssistantName("   ")).toBeNull();
    expect(cleanAssistantName(null)).toBeNull();
    expect(cleanAssistantName("O'Neil-Smith")).toBe("O'Neil-Smith");
  });
});

describe("the voice list", () => {
  const v2 = { voices: [{ voice_id: "cloneAAAAAAAA", name: "Kyle", category: "cloned", preview_url: "https://x/k.mp3", labels: { accent: "american" } }, { voice_id: "bad" }, null, "nope"], has_more: false };
  const v1 = { voices: [{ voice_id: "cloneAAAAAAAA", name: "Kyle", category: "cloned", preview_url: null }, { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", category: "premade", preview_url: "https://x/g.mp3", labels: { gender: "male", accent: "british", age: "middle-aged", descriptive: "warm" } }, { voice_id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", category: "premade", labels: { gender: "female" } }] };
  const lib = { voices: [{ public_owner_id: "owner1234", voice_id: "libVoice1234", name: "Anna", gender: "female", accent: "irish", preview_url: "https://x/a.mp3" }] };

  it("skips malformed entries and reads labels and the library's flat fields", () => {
    expect(parseVoices(v2).map((v) => v.id)).toEqual(["cloneAAAAAAAA"]);
    expect(parseVoices({})).toEqual([]);
    expect(parseVoices(null)).toEqual([]);
    const [anna] = parseVoices(lib, "library");
    expect(anna).toMatchObject({ id: "libVoice1234", category: "library", ownerId: "owner1234", labels: { gender: "female", accent: "irish" } });
  });

  it("merges every source into one list: one voice once (a missing sample filled in), so a thin first answer isn't the whole list", () => {
    const merged = mergeVoices([parseVoices(v2), parseVoices(v1)]);
    expect(merged.map((v) => v.id).sort()).toEqual(["JBFqnCBsd6RMkjVDRZzb", "XB0fDUnXU5powFXDhCwa", "cloneAAAAAAAA"]);
    expect(merged.find((v) => v.id === "cloneAAAAAAAA")?.previewUrl).toBe("https://x/k.mp3");
    expect(mergeVoices([parseVoices(v1), parseVoices(v2)]).find((v) => v.id === "cloneAAAAAAAA")?.previewUrl).toBe("https://x/k.mp3");
  });

  it("groups voices: own, defaults, library, each by name, empty groups left out", () => {
    const all = mergeVoices([parseVoices(v2), parseVoices(v1), parseVoices(lib, "library")]).map(optionOf);
    expect(groupOf({ category: "cloned" })).toBe("yours");
    expect(groupOf({ category: "premade" })).toBe("default");
    expect(groupOf({ category: "library", ownerId: "o" })).toBe("library");
    const groups = groupVoices(all);
    expect(groups.map((g) => g.key)).toEqual(["yours", "default", "library"]);
    expect(groups[1].voices.map((v) => v.name)).toEqual(["Charlotte", "George"]);
    expect(groupVoices(all.filter((v) => v.group === "default")).map((g) => g.key)).toEqual(["default"]);
    expect(groups[1].voices.find((v) => v.name === "George")?.about).toBe("male, british, middle-aged, warm");
  });

  it("searches by name and by description, and finds a named voice only when it's unambiguous", () => {
    const all = mergeVoices([parseVoices(v1), parseVoices(lib, "library")]).map(optionOf);
    expect(all.filter((v) => voiceMatches(v, "british warm")).map((v) => v.name)).toEqual(["George"]);
    expect(all.filter((v) => voiceMatches(v, "")).length).toBe(all.length);
    expect(findVoice(all, "george").match?.id).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(findVoice(all, "JBFqnCBsd6RMkjVDRZzb").match?.name).toBe("George");
    expect(findVoice(all, "zzz")).toEqual({ match: null, candidates: [] });
    const twins = [...all, { ...all[0], id: "other1234567", name: "George Two" }];
    expect(findVoice(twins, "george").match?.name).toBe("George");
    expect(findVoice([{ id: "a1234567", name: "Ann Lee" }, { id: "b1234567", name: "Ann Ray" }], "ann").match).toBeNull();
  });
});
