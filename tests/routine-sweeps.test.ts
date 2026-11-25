import { describe, expect, it } from "vitest";
import { addBusinessDays, coverageGaps, dueOf, matchPerson, tagged } from "@/lib/routine-sweeps-core";

describe("the debrief sweep and the delegation tracker (Nov 24 2026)", () => {
  it("business days skip the weekend", () => {
    expect(addBusinessDays("2026-11-27", 1)).toBe("2026-11-30"); // Friday + 1 = Monday
    expect(addBusinessDays("2026-11-24", 3)).toBe("2026-11-27");
  });
  it("due: the date said, else soon for client/revenue/blocked work, else later", () => {
    expect(dueOf("2026-11-24", "2026-12-01", false, 1, 3)).toBe("2026-12-01");
    expect(dueOf("2026-11-24", null, true, 1, 3)).toBe("2026-11-25");
    expect(dueOf("2026-11-24", null, false, 1, 3)).toBe("2026-11-27");
    // A date already past isn't kept
    expect(dueOf("2026-11-24", "2026-11-01", false, 1, 3)).toBe("2026-11-27");
  });
  it("titles say where it came from and when", () => {
    expect(tagged("Slack", "2026-11-24", "Mel · Re-auth Klaviyo")).toBe("[Slack 11/24] Mel · Re-auth Klaviyo");
  });
  it("a teammate by full name, unique first name or prefix; ambiguous or unknown is no one", () => {
    const team = [
      { id: "1", name: "Lucas Moreira" },
      { id: "2", name: "Mel Grant" },
      { id: "3", name: "Mark Diaz" },
      { id: "4", name: "Mark Ortiz" },
    ];
    expect(matchPerson("@Lucas", team)?.id).toBe("1");
    expect(matchPerson("mel grant", team)?.id).toBe("2");
    expect(matchPerson("Mark", team)).toBeNull();
    expect(matchPerson("Mark Ortiz", team)?.id).toBe("4");
    expect(matchPerson("Zed", team)).toBeNull();
  });
  it("coverage gaps: an outside meeting that's over with no notes near its time", () => {
    const now = Date.parse("2026-11-24T20:00:00Z");
    const meetings = [
      { title: "Discovery Call", start: "2026-11-24T15:00:00Z", external: ["ceo@acme.com"] },
      { title: "OceanBox weekly", start: "2026-11-24T16:00:00Z", external: ["jordan@oceanbox.com"] },
      { title: "Team standup", start: "2026-11-24T14:00:00Z", external: [] },
      { title: "Later today", start: "2026-11-24T19:45:00Z", external: ["x@y.com"] },
    ];
    expect(coverageGaps(meetings, [{ at: "2026-11-24T16:05:00Z" }], now).map((g) => g.title)).toEqual(["Discovery Call"]);
  });
  it("coverage gaps: notes carrying the meeting's title the same day count, even far from its start", () => {
    const now = Date.parse("2026-11-25T01:00:00Z");
    const meetings = [{ title: "Kaizen x OceanBox — Weekly Data Review", start: "2026-11-24T18:30:00Z", external: ["hugo@oceanbox.com"] }];
    expect(coverageGaps(meetings, [{ at: "2026-11-24T20:10:00Z", title: "Kaizen x OceanBox - Weekly Data Review" }], now)).toEqual([]);
    expect(coverageGaps(meetings, [{ at: "2026-11-24T20:10:00Z", title: "Acme kickoff" }], now)).toHaveLength(1);
  });
});
