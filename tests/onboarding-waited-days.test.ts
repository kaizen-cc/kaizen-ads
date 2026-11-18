import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { businessDaysSince } from "@/lib/waited-days";

// Pipeline's onboarding cards: "N days so far" must count the same on the server (UTC) and in any browser, or the
// page fails to hydrate (issue #31, React error #418).

const at = (iso: string) => Date.parse(iso);

describe("business days waited", () => {
  it("is zero inside the first 24 hours", () => {
    expect(businessDaysSince("2026-11-16T15:00:00Z", at("2026-11-17T14:59:00Z"))).toBe(0);
  });

  it("counts weekdays and skips the weekend", () => {
    // Friday 10am New York to the next Tuesday 10am: Sat and Sun don't count, Mon and Tue do
    expect(businessDaysSince("2026-11-13T15:00:00Z", at("2026-11-17T15:00:00Z"))).toBe(2);
  });

  it("judges the weekend in New York, not UTC", () => {
    // Friday 9pm New York is already Saturday in UTC; 24 hours later is Saturday 9pm New York, which doesn't count
    expect(businessDaysSince("2026-11-14T02:00:00Z", at("2026-11-15T02:00:00Z"))).toBe(0);
    // Sunday 9pm New York (Monday in UTC) + 24 hours = Monday 9pm New York, which does
    expect(businessDaysSince("2026-11-16T02:00:00Z", at("2026-11-17T02:00:00Z"))).toBe(1);
  });

  it("is zero for a bad date", () => {
    expect(businessDaysSince("not a date", at("2026-11-17T02:00:00Z"))).toBe(0);
  });
});

describe("the onboarding card", () => {
  const src = readFileSync(join(__dirname, "../src/app/(team)/pipeline/views/onboarding-callout.tsx"), "utf8");

  it("uses the New York count, not one in the device's time zone", () => {
    expect(src).toContain('from "@/lib/waited-days"');
    expect(src).not.toMatch(/function businessDaysSince/);
    expect(src).not.toMatch(/getDay\(\)/);
  });

  it("only shows waits that run to the clock once in the browser", () => {
    expect(src).toMatch(/const intakeWait = inBrowser \?/);
    expect(src).toMatch(/const roundWait = inBrowser &&/);
  });
});
