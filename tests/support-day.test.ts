import { describe, expect, it } from "vitest";
import { keepForSupport, onboardingBlockers, stuckCreative } from "@/lib/support-day-core";

describe("a support role's day", () => {
  it("never shows anything creative", () => {
    for (const role of ["onboarding_specialist", "customer_success", "tracking_specialist"] as const) {
      expect(keepForSupport(role, { key: "direction:1", title: "Acme changed direction" })).toBe(false);
      expect(keepForSupport(role, { key: "promise:1", title: "Meta ads need a new creative" })).toBe(false);
      expect(keepForSupport(role, { key: "bible:1", title: "Brand Bible to approve" })).toBe(false);
    }
  });
  it("always keeps messages and promises waiting on them", () => {
    expect(keepForSupport("onboarding_specialist", { key: "owed:1", title: "Reply to Dana about the creative brief" })).toBe(true);
    expect(keepForSupport("tracking_specialist", { key: "said2:1", title: "You said you'd check the pixel" })).toBe(true);
  });
  it("keeps the onboarding specialist to blockers and Waiting on you", () => {
    expect(keepForSupport("onboarding_specialist", { key: "callp:1", title: "Call promise" })).toBe(false);
    expect(keepForSupport("customer_success", { key: "callp:1", title: "Call promise" })).toBe(true);
  });
});

describe("onboarding blockers", () => {
  const base = { start: "2026-11-10", today: "2026-11-16", quietDays: 7 };
  it("flags a missing intake, an unbooked call and no assets", () => {
    const b = onboardingBlockers({ ...base, intakeAt: null, callBooked: false, lastAssetAt: null });
    expect(b.map((x) => x.kind)).toEqual(["intake", "call", "assets"]);
    expect(b[0].score).toBeGreaterThanOrEqual(80);
  });
  it("is quiet when everything is in and assets are recent", () => {
    expect(onboardingBlockers({ ...base, intakeAt: "2026-11-11", callBooked: true, lastAssetAt: "2026-11-14" })).toEqual([]);
  });
  it("flags assets gone quiet for 7 days", () => {
    expect(onboardingBlockers({ ...base, today: "2026-11-25", intakeAt: "2026-11-11", callBooked: true, lastAssetAt: "2026-11-15" }).map((x) => x.kind)).toEqual(["assets"]);
  });
});

describe("stuck creatives", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  it("flags Ready for copy over 48 hours, with who holds it", () => {
    const s = stuckCreative({ stage: "copy", moves: [{ to: "Ready for Copy", at: "2026-11-17T12:00:00Z" }], modifiedAt: null, due: null, holder: "the Meta buyer" }, now);
    expect(s?.what).toBe("waiting on copy");
    expect(s?.line).toContain("3 days");
  });
  it("puts a past-due one first", () => {
    const late = stuckCreative({ stage: "client_review", moves: [{ to: "Client review", at: "2026-11-16T12:00:00Z" }], modifiedAt: null, due: "2026-11-18", holder: null }, now);
    expect(late?.score).toBe(86);
  });
  it("leaves anything under 48 hours alone", () => {
    expect(stuckCreative({ stage: "copy", moves: [{ to: "copy", at: "2026-11-19T12:00:00Z" }], modifiedAt: null, due: null, holder: null }, now)).toBeNull();
  });
});
