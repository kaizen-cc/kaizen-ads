import { afterEach, describe, expect, it } from "vitest";
import { clockTime } from "@/lib/reports/format";

// The report page is drawn on the server (UTC) and again in the browser (the viewer's own time zone).
// Times on it must come out the same in both, or React throws the page away (error #418).
describe("clockTime", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });

  it("reads the same whatever time zone the machine is in", () => {
    const at = "2026-11-09T20:05:00Z";
    const seen = ["UTC", "Asia/Karachi", "America/Los_Angeles", "America/New_York"].map((zone) => {
      process.env.TZ = zone;
      return [clockTime(at), clockTime(at, true)];
    });
    for (const s of seen) expect(s).toEqual(["3:05 PM", "Mon 3:05 PM"]);
  });
});
