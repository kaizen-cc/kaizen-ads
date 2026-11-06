import { describe, expect, it } from "vitest";
import { applyAvatarChange, avatarHint, avatarsOf, mentionsAvatar } from "@/lib/bible-avatars";
import { cleanTitle, normalizePriority } from "@/lib/task-title";

const BIBLE = `# Brand Bible

## 1. Read this first

Short.

## 3. Audience profiles

Who buys.

### A · Fresh-Fish Seeker (Likely)
Wants the catch of the day.

### B · Weekend Host (Hypothesis)
Hosts friends on Saturdays.

## 12. Change log

- Oct 1: built
`;

describe("priority", () => {
  it("reads Asana's words as one set", () => {
    expect(normalizePriority("Hi")).toBe("high");
    expect(normalizePriority("HIGH")).toBe("high");
    expect(normalizePriority("High!!")).toBe("high");
    expect(normalizePriority("URGENT")).toBe("urgent");
    expect(normalizePriority("Urgent")).toBe("urgent");
    expect(normalizePriority("Medium")).toBe("normal");
    expect(normalizePriority("Low")).toBe("normal");
    expect(normalizePriority(null)).toBe("normal");
  });
  it("lets an URGENT title outrank the field", () => {
    expect(normalizePriority("High", "URGENT: URGENT: Crust - Poster")).toBe("urgent");
    expect(normalizePriority(null, "HIGH PRIORITY: Reel")).toBe("high");
  });
  it("strips repeated urgency prefixes from the title", () => {
    expect(cleanTitle("URGENT: URGENT: Crust - Poster").title).toBe("Crust - Poster");
    expect(cleanTitle("URGENT URGENT: Reel").title).toBe("Reel");
    expect(cleanTitle("Urgent care clinic ad").urgent).toBe(false);
  });
});

describe("avatars", () => {
  it("reads the Bible's avatars", () => {
    const list = avatarsOf(BIBLE);
    expect(list.map((a) => a.name)).toEqual(["Fresh-Fish Seeker", "Weekend Host"]);
    expect(list[0].letter).toBe("A");
  });

  it("adds a new avatar with the next letter", () => {
    const md = applyAvatarChange(BIBLE, { kind: "avatar_add", proposed: { name: "Gift Giver", tier: "Hypothesis", body: "Buys for others." }, reason: "Reviews" }, "Nov 6, 2026")!;
    expect(md).toContain("### C · Gift Giver (Hypothesis)");
    expect(md).toContain("### A · Fresh-Fish Seeker (Likely)");
    expect(avatarsOf(md)).toHaveLength(3);
  });

  it("retires without deleting", () => {
    const md = applyAvatarChange(BIBLE, { kind: "avatar_retire", avatar: "Weekend Host", reason: "Never hit target" }, "Nov 6, 2026")!;
    const b = avatarsOf(md).find((a) => a.name === "Weekend Host")!;
    expect(b.retired).toBe("Nov 6, 2026");
    expect(b.body).toContain("Hosts friends on Saturdays.");
    expect(b.body).toContain("Never hit target");
  });

  it("changes one, keeping the old profile as retired", () => {
    const md = applyAvatarChange(BIBLE, { kind: "avatar_change", avatar: "Fresh-Fish Seeker", proposed: { name: "Fresh-Fish Seeker", tier: "Proven", body: "Buys weekly." }, reason: "Results" }, "Nov 6, 2026")!;
    const list = avatarsOf(md);
    expect(list.filter((a) => a.name === "Fresh-Fish Seeker")).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: "Fresh-Fish Seeker", tier: "Proven", retired: null });
    expect(list[list.length - 1].retired).toBe("Nov 6, 2026, replaced");
    // A retired one can't be changed again
    expect(applyAvatarChange(md, { kind: "avatar_retire", avatar: "Nobody", reason: "x" }, "Nov 7, 2026")).toBeNull();
  });

  it("matches tickets to avatars by name", () => {
    expect(mentionsAvatar("Weekend Host", "Avatar: weekend host, broad")).toBe(true);
    expect(mentionsAvatar("Weekend Host", "Weekday hosting")).toBe(false);
  });

  it("says plainly how an avatar's ads are doing", () => {
    expect(avatarHint(null).tone).toBe("none");
    const base = { resultLabel: "purchases", roas: false, target: 20, revenue: 0 };
    expect(avatarHint({ ...base, ads: 4, spend: 400, results: 30, winners: 2, losers: 0 }).tone).toBe("great");
    expect(avatarHint({ ...base, ads: 4, spend: 400, results: 4, winners: 0, losers: 3 }).tone).toBe("failing");
    expect(avatarHint({ ...base, ads: 4, spend: 400, results: 15, winners: 1, losers: 2 }).tone).toBe("work");
    expect(avatarHint({ ...base, ads: 1, spend: 20, results: 0, winners: 0, losers: 0 }).tone).toBe("early");
  });
});
