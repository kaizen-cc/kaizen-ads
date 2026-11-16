import { describe, expect, it } from "vitest";
import { deliverabilityScore, emailBand, emailScore, EMAIL_CHECKS } from "@/lib/email-score";

const healthy = { attributed: 0.35, rpr: 0.2, deliverability: 80, campaignOpen: 0.4, campaignClick: 0.02, flowOpen: 0.45, flowClick: 0.03 };

describe("emailScore", () => {
  it("weights add to 100", () => {
    expect(EMAIL_CHECKS.reduce((n, c) => n + c.weight, 0)).toBe(100);
  });
  it("every check met is 100 and green", () => {
    const s = emailScore(healthy);
    expect(s.score).toBe(100);
    expect(s.band).toBe("good");
    expect(s.weighingDown).toEqual([]);
  });
  it("gives partial credit under a bar", () => {
    // 27% attributed against a 30% bar: 90% of its 20 points, so 2 points short
    expect(emailScore({ ...healthy, attributed: 0.27 }).score).toBe(98);
  });
  it("orders what weighs it down by points lost", () => {
    // RPR at a fifth of its bar loses 16 points, campaign clicks at 40% lose 6.6: 77, yellow
    const s = emailScore({ ...healthy, rpr: 0.03, campaignClick: 0.004 });
    expect(s.score).toBe(77);
    expect(s.weighingDown.map((c) => c.key)).toEqual(["rpr", "campaignClick"]);
    expect(s.band).toBe("watch");
  });
  it("leaves out what it can't measure and scales the rest", () => {
    const s = emailScore({ ...healthy, campaignOpen: null, campaignClick: null });
    expect(s.score).toBe(100);
    expect(s.unmeasured).toEqual(["campaignOpen", "campaignClick"]);
  });
  it("bands at 80 and 60", () => {
    expect(emailBand(80)).toBe("good");
    expect(emailBand(79)).toBe("watch");
    expect(emailBand(60)).toBe("watch");
    expect(emailBand(59)).toBe("bad");
  });
});

describe("deliverabilityScore", () => {
  it("is 100 for a clean list and null with nothing sent", () => {
    expect(deliverabilityScore({ recipients: 1000, delivered: 998, bounced: 2, spam: 0, unsubscribes: 1, opens: 400 })?.score).toBe(100);
    expect(deliverabilityScore({ recipients: 0, delivered: 0, bounced: 0, spam: 0, unsubscribes: 0, opens: 0 })).toBeNull();
  });
  it("drops with bounces and spam complaints", () => {
    const s = deliverabilityScore({ recipients: 1000, delivered: 970, bounced: 30, spam: 3, unsubscribes: 15, opens: 200 })!;
    expect(s.score).toBeLessThan(65);
  });
});
