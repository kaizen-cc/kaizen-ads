import { describe, expect, it } from "vitest";
import { jobKeyOf, type BriefSource } from "@/lib/quick-brief";

// The card a brief was started from finds its background job by this key (the server queues the job under it), so
// its progress and then "Brief ready" survive leaving the page.

const winner = { adId: "120200", client: "A", detail: null, headline: null, text: null, thumbnail: null, ratio: 2, result: null, costPerResult: 10, usual: 20 };

describe("the key a background brief is found by", () => {
  it("is the ad, pattern, promise or brief it's written from", () => {
    expect(jobKeyOf({ kind: "winner", winner })).toBe("120200");
    expect(jobKeyOf({ kind: "refresh", adId: "9" })).toBe("9");
    expect(jobKeyOf({ kind: "market", adId: "m1", format: "video" })).toBe("m1");
    expect(jobKeyOf({ kind: "pattern", patternId: "p1" })).toBe("p1");
    expect(jobKeyOf({ kind: "promise", commitmentId: "c1" })).toBe("c1");
    expect(jobKeyOf({ kind: "suggestion", id: "s1" })).toBe("s1");
  });

  it("is an idea's label, cut to length", () => {
    const label = "x".repeat(300);
    expect(jobKeyOf({ kind: "idea", label, text: "" })).toBe(`idea:${"x".repeat(120)}`);
  });

  it("keeps one conversation's key while the talk goes on, and differs between conversations", () => {
    const start: BriefSource = { kind: "talk", turns: [{ role: "user", text: "3 statics for the new offer" }] };
    const later: BriefSource = { kind: "talk", turns: [{ role: "user", text: "3 statics for the new offer" }, { role: "ai", text: "Which offer?" }, { role: "user", text: "BFCM" }] };
    const other: BriefSource = { kind: "talk", turns: [{ role: "user", text: "A UGC video" }] };
    expect(jobKeyOf(start)).toBe(jobKeyOf(later));
    expect(jobKeyOf(start)).not.toBe(jobKeyOf(other));
    expect(jobKeyOf(start)).toMatch(/^talk:[0-9a-z]+$/);
  });
});