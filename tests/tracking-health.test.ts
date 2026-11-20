import { describe, expect, it } from "vitest";
import { flagTier, healthOf, notSetUpTier, worstFirst } from "@/lib/tracking-health-core";

const now = Date.parse("2026-11-30T12:00:00Z");
const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("tracking health tiers", () => {
  it("escalates any flag or request, critical at 2 weeks", () => {
    expect(flagTier(0)).toBe("high");
    expect(flagTier(13)).toBe("high");
    expect(flagTier(14)).toBe("critical");
  });
  it("escalates no tracking after a week, critical at 2 weeks", () => {
    expect(notSetUpTier(7)).toBe("normal");
    expect(notSetUpTier(8)).toBe("high");
    expect(notSetUpTier(14)).toBe("critical");
  });
});

describe("a client's tracking health", () => {
  it("is OK when set up with nothing flagged", () => {
    expect(healthOf({ onboardedAt: ago(30), setUp: true, flags: [], requests: [] }, now)).toMatchObject({ status: "ok", tier: null });
  });
  it("ages not set up from onboarding", () => {
    expect(healthOf({ onboardedAt: ago(10), setUp: false, flags: [], requests: [] }, now)).toMatchObject({ status: "not_set_up", tier: "high", daysOnboarded: 10 });
  });
  it("ages a flag from when it opened, and the worst wins", () => {
    const h = healthOf({ onboardedAt: ago(3), setUp: false, flags: [{ kind: "cvr_drop", title: "Conversion rate halved", openedAt: ago(15) }], requests: [] }, now);
    expect(h).toMatchObject({ status: "issue", tier: "critical", ageDays: 15 });
    expect(h.why[0]).toContain("Conversion rate halved");
  });
  it("sorts worst first", () => {
    const rows = [
      { client: "A", health: healthOf({ onboardedAt: ago(30), setUp: true, flags: [], requests: [] }, now) },
      { client: "B", health: healthOf({ onboardedAt: ago(20), setUp: false, flags: [], requests: [] }, now) },
      { client: "C", health: healthOf({ onboardedAt: ago(30), setUp: true, flags: [], requests: [{ title: "Fix pixel", openedAt: ago(2) }] }, now) },
    ];
    expect(worstFirst(rows).map((r) => r.client)).toEqual(["B", "C", "A"]);
  });
});
