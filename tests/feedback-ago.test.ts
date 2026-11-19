import { describe, expect, it } from "vitest";
import { agoLabel } from "@/lib/feedback-logic";

// The /feedback page draws these on the server and again in the browser; the two must print the same words
describe("agoLabel", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");

  it("counts minutes, hours and days from the time it is given", () => {
    expect(agoLabel(null, now)).toBe("");
    expect(agoLabel("2026-11-19T11:59:45Z", now)).toBe("just now");
    expect(agoLabel("2026-11-19T11:55:00Z", now)).toBe("5m ago");
    expect(agoLabel("2026-11-19T09:00:00Z", now)).toBe("3h ago");
    expect(agoLabel("2026-11-17T12:00:00Z", now)).toBe("2d ago");
  });

  it("shows older ones as a date on New York's clock, whatever the machine's time zone", () => {
    // 02:00 UTC on Oct 1 is still Sep 30 in New York; a UTC server alone would say Oct 1
    expect(agoLabel("2026-10-01T02:00:00Z", now)).toBe("Sep 30");
  });
});
