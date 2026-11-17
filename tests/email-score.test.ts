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
    expect(s.unmeasured).toEqual(["pace", "campaignOpen", "campaignClick"]);
  });
  it("revenue pace: strong rates far behind on revenue can't sit at 100", () => {
    // 38% of pace (the Aldecoa case): nothing from the quarter pace is worth, so the account drops to watch
    const behind = emailScore({ ...healthy, pace: 0.38 });
    expect(behind.score).toBe(75);
    expect(behind.band).toBe("watch");
    expect(behind.weighingDown[0].key).toBe("pace");
    // Partial credit in a straight line from half the pace (0) to on pace (all 25)
    expect(emailScore({ ...healthy, pace: 0.85 }).score).toBe(93);
    expect(emailScore({ ...healthy, pace: 1.2 }).score).toBe(100);
    // Without a target (or early in the month) it's left out and the rest score exactly as before
    expect(emailScore({ ...healthy, campaignClick: 0.005 }).score).toBe(emailScore({ ...healthy, campaignClick: 0.005, pace: null }).score);
    expect(emailScore({ ...healthy, campaignClick: 0.005 }).score).toBe(95);
  });
  it("bands at 80 and 60", () => {
    expect(emailBand(80)).toBe("good");
    expect(emailBand(79)).toBe("watch");
    expect(emailBand(60)).toBe("watch");
    expect(emailBand(59)).toBe("bad");
  });
});

describe("deliverabilityScore", () => {
  it("matches Klaviyo's 80 for OceanBox (open and bounce excellent, click and unsubscribe good, spam fair)", () => {
    // Klaviyo, last 30 days: open 60.4%, click 1.47%, bounce 0.16%, unsubscribe 0.29%, spam 0.02%
    const s = deliverabilityScore({ recipients: 10_000, delivered: 9_984, bounced: 16, opens: 6_030, clicks: 147, unsubscribes: 29, spam: 2 })!;
    expect(s.parts.map((p) => p.grade)).toEqual(["excellent", "good", "excellent", "good", "fair"]);
    expect(s.score).toBe(80);
  });
  it("is 100 for a clean list and null with nothing sent", () => {
    expect(deliverabilityScore({ recipients: 1000, delivered: 998, bounced: 2, spam: 0, unsubscribes: 1, opens: 500, clicks: 30 })?.score).toBe(100);
    expect(deliverabilityScore({ recipients: 0, delivered: 0, bounced: 0, spam: 0, unsubscribes: 0, opens: 0 })).toBeNull();
  });
  it("drops with bounces and spam complaints", () => {
    const s = deliverabilityScore({ recipients: 1000, delivered: 970, bounced: 30, spam: 3, unsubscribes: 15, opens: 200, clicks: 5 })!;
    expect(s.score).toBeLessThan(65);
  });
});

describe("paceInput", () => {
  it("projects the month against its target, not judged in the first three days unless the target is met", async () => {
    const { paceInput } = await import("@/lib/email-score-calc");
    // Day 15 of 30, $280 so far, target $1,107: lands at $580, 52% of the target
    expect(paceInput(280, 1107, { dayOfMonth: 15, daysInMonth: 30 })).toBeCloseTo(0.524, 2);
    expect(paceInput(100, 1000, { dayOfMonth: 2, daysInMonth: 30 })).toBeNull();
    expect(paceInput(1200, 1000, { dayOfMonth: 2, daysInMonth: 30 })).toBeGreaterThanOrEqual(1);
    expect(paceInput(500, null, { dayOfMonth: 15, daysInMonth: 30 })).toBeNull();
  });
});
