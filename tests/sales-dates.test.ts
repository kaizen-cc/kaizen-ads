import { describe, expect, it } from "vitest";
import { prospectDay, prospectStamp } from "@/lib/sales-dates";

// The prospect page's dates must read the same whatever zone the code runs in (server UTC vs the viewer's browser),
// or React's hydration fails (#418).
describe("prospect page dates", () => {
  it("are written in New York time, not the machine's zone", () => {
    expect(prospectDay("2026-11-25T03:00:00Z")).toBe("Nov 24, 2026");
    expect(prospectStamp("2026-11-25T03:05:00Z")).toBe("Nov 24, 10:05 PM");
  });
  it("don't change with the process time zone", () => {
    const before = process.env.TZ;
    const iso = "2026-06-01T02:30:00Z";
    try {
      process.env.TZ = "UTC";
      const a = [prospectDay(iso), prospectStamp(iso)];
      process.env.TZ = "Asia/Tokyo";
      expect([prospectDay(iso), prospectStamp(iso)]).toEqual(a);
    } finally {
      process.env.TZ = before;
    }
  });
});
