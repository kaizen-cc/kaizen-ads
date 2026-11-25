import { describe, expect, it } from "vitest";
import { adCopyLine } from "@/lib/reports/weekly-core";

// Every Meta report shows each top ad clearly: its picture, name, format, a line of what it says, its numbers, and a
// link to review it. The line is its headline, else the start of its primary text.
describe("an ad's words on its card", () => {
  it("the headline in quotes first", () => {
    expect(adCopyLine({ headline: "  Fresh pizza,   delivered ", body: "Order now.", cta: null, url: null })).toBe("“Fresh pizza, delivered”");
  });
  it("else the primary text's first sentence, shortened", () => {
    expect(adCopyLine({ headline: null, body: "Free garlic knots with every large pizza this week only. Order now!", cta: null, url: null })).toBe("Free garlic knots with every large pizza this week only.");
    const long = adCopyLine({ headline: null, body: "a ".repeat(80), cta: null, url: null });
    expect(long!.length).toBeLessThanOrEqual(90);
    expect(long!.endsWith("…")).toBe(true);
  });
  it("nothing when the ad has no words read", () => {
    expect(adCopyLine(undefined)).toBeNull();
    expect(adCopyLine({ headline: " ", body: null, cta: null, url: null })).toBeNull();
  });
});
