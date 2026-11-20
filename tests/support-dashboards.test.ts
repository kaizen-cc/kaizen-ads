import { describe, expect, it } from "vitest";
import { csRank, medianReplyHours, onboardingState, sentiment, toneOf } from "@/lib/oversight/support-core";

describe("customer success", () => {
  it("median reply time", () => {
    expect(medianReplyHours([{ asked_at: "2026-11-01T10:00:00Z", answered_at: "2026-11-01T12:00:00Z" }, { asked_at: "2026-11-01T10:00:00Z", answered_at: "2026-11-01T20:00:00Z" }, { asked_at: "2026-11-01T10:00:00Z", answered_at: null }])).toBe(6);
    expect(medianReplyHours([])).toBeNull();
  });
  it("tone", () => {
    expect(toneOf("Thank you, love these!")).toBe(1);
    expect(toneOf("Still waiting on this, really disappointed")).toBe(-1);
    expect(toneOf("See attached")).toBe(0);
  });
  it("a sliding client", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const s = sentiment(
      [
        { at: "2026-11-18T12:00:00Z", text: "This is frustrating, still waiting" },
        { at: "2026-11-01T12:00:00Z", text: "Love it, thanks!" },
      ],
      now,
    );
    expect(s.trend).toBe("down");
    expect(s.now).toBe(-1);
  });
  it("low sentiment ranks first", () => {
    const low = csRank({ sentiment: { now: -0.5, before: 0.5, trend: "down", messages: 4 }, replyHours: 2, waiting: 0, quietDays: 1 });
    const slow = csRank({ sentiment: { now: 0.5, before: 0.5, trend: "flat", messages: 4 }, replyHours: 48, waiting: 2, quietDays: 1 });
    expect(low).toBeGreaterThan(slow);
  });
});

describe("onboarding", () => {
  it("no intake, no assets, no access, no check-in is stuck", () => {
    const s = onboardingState({ createdAt: "2026-11-05", today: "2026-11-20", intakeAt: null, assets: false, needsAccess: true, access: false, lastCheckIn: null });
    expect(s.daysIn).toBe(15);
    expect(s.blockers).toHaveLength(4);
    expect(s.blockers[0]).toMatch(/no delivery dates/);
    expect(s.stuck).toBe(true);
  });
  it("all in and checked in this week is moving", () => {
    const s = onboardingState({ createdAt: "2026-11-05", today: "2026-11-20", intakeAt: "2026-11-07", assets: true, needsAccess: true, access: true, lastCheckIn: "2026-11-17" });
    expect(s.blockers).toEqual([]);
    expect(s.stuck).toBe(false);
  });
  it("a brand-new client isn't stuck yet", () => {
    expect(onboardingState({ createdAt: "2026-11-18", today: "2026-11-20", intakeAt: null, assets: false, needsAccess: false, access: false, lastCheckIn: null }).stuck).toBe(false);
  });
});
