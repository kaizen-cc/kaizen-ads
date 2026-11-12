import { describe, expect, it } from "vitest";
import { SCORE_ACT, SCORE_HEALTHY, deliverabilityScore, rateScore, rprSeries, scoreWeeks } from "@/lib/klaviyo/charts";
import { BENCHMARKS } from "@/lib/klaviyo/insights";

describe("deliverability score", () => {
  it("scores a rate 100 inside its healthy line, 50 on the bad line, 0 at twice it", () => {
    const b = BENCHMARKS.bounce;
    expect(rateScore(0, b)).toBe(100);
    expect(rateScore(b.warn, b)).toBe(100);
    expect(rateScore(b.bad, b)).toBeCloseTo(50);
    expect(rateScore((b.warn + b.bad) / 2, b)).toBeCloseTo(75);
    expect(rateScore(b.bad * 2, b)).toBe(0);
    expect(rateScore(b.bad * 5, b)).toBe(0);
  });

  it("is 100 when every rate is healthy", () => {
    expect(deliverabilityScore({ bounce: 0.002, spam: 0.0002, unsubscribe: 0.002 })).toBe(100);
  });

  it("weights spam most", () => {
    const spamBad = deliverabilityScore({ bounce: 0, spam: BENCHMARKS.spam.bad, unsubscribe: 0 })!;
    const unsubBad = deliverabilityScore({ bounce: 0, spam: 0, unsubscribe: BENCHMARKS.unsubscribe.bad })!;
    expect(spamBad).toBe(80);
    expect(unsubBad).toBe(85);
    expect(spamBad).toBeLessThan(unsubBad);
    expect(spamBad).toBeLessThan(SCORE_HEALTHY);
  });

  it("falls under the act line when all three are past the bad line", () => {
    const s = deliverabilityScore({ bounce: 0.03, spam: 0.0015, unsubscribe: 0.0075 })!;
    expect(s).toBeLessThan(SCORE_ACT);
  });

  it("leaves an unmeasured rate out and returns null with none", () => {
    expect(deliverabilityScore({ bounce: null, spam: 0, unsubscribe: null })).toBe(100);
    expect(deliverabilityScore({ bounce: null, spam: null, unsubscribe: null })).toBeNull();
  });

  it("scores weeks oldest first and drops unmeasured ones", () => {
    const weeks = scoreWeeks([
      { week: "2026-10-05", delivered: 100, campaigns: 1, bounceRate: 0.001, spamRate: 0, unsubscribeRate: 0.001 },
      { week: "2026-10-12", delivered: 0, campaigns: 0, bounceRate: null, spamRate: null, unsubscribeRate: null },
      { week: "2026-10-19", delivered: 100, campaigns: 2, bounceRate: 0.02, spamRate: 0.001, unsubscribeRate: 0.005 },
    ]);
    expect(weeks.map((w) => w.week)).toEqual(["2026-10-05", "2026-10-19"]);
    expect(weeks[0].score).toBe(100);
    expect(weeks[1].score).toBe(50);
  });
});

describe("revenue per recipient series", () => {
  it("smooths over 7 days and reads null while nothing was sent", () => {
    const days = [
      { date: "2026-11-01", revenue: 0, recipients: 0 },
      { date: "2026-11-02", revenue: 100, recipients: 1000 },
      { date: "2026-11-03", revenue: 0, recipients: 0 },
      { date: "2026-11-04", revenue: 300, recipients: 1000 },
    ];
    const s = rprSeries(days);
    expect(s[0].rpr).toBeNull();
    expect(s[1].rpr).toBeCloseTo(0.1);
    expect(s[2].rpr).toBeCloseTo(0.1);
    expect(s[3].rpr).toBeCloseTo(0.2);
    expect(s[3].revenue).toBe(400);
    expect(s[3].recipients).toBe(2000);
  });

  it("drops days older than the window", () => {
    const s = rprSeries([
      { date: "2026-11-01", revenue: 1000, recipients: 100 },
      { date: "2026-11-09", revenue: 10, recipients: 100 },
    ]);
    expect(s[1].revenue).toBe(10);
  });
});
