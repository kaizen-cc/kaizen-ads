import { describe, expect, it } from "vitest";
import { CATCH_UP_MIN, dueRuns, hasContent, nyClock, pushLine, routineOf, ROUTINES, runsOn, validTime } from "@/lib/routines-core";

// 2026-11-24 is a Tuesday; New York is UTC-5 in November
const at = (ny: string) => new Date(`2026-11-24T${ny}:00-05:00`);

describe("per-person routines (Nov 24 2026)", () => {
  it("reads New York time", () => {
    expect(nyClock(at("08:45"))).toMatchObject({ date: "2026-11-24", minutes: 8 * 60 + 45, weekday: 2 });
  });
  it("a recap is due once its time has passed, within the catch-up window, keyed once per day and time", () => {
    const r = { profileId: "p", kind: "morning", times: ["08:45"], days: "weekdays" as const, enabled: true };
    expect(dueRuns(r, at("08:40"))).toEqual([]);
    expect(dueRuns(r, at("08:46"))).toEqual(["p|morning|2026-11-24|08:45"]);
    expect(dueRuns(r, new Date(at("08:45").getTime() + (CATCH_UP_MIN + 1) * 60_000))).toEqual([]);
    expect(dueRuns({ ...r, enabled: false }, at("08:46"))).toEqual([]);
  });
  it("the debrief sweep's missed slots catch up as one run", () => {
    const r = { profileId: "p", kind: "debrief", times: ["10:07", "12:07"], days: "weekdays" as const, enabled: true };
    expect(dueRuns(r, at("12:10"))).toEqual(["p|debrief|2026-11-24|12:07"]);
  });
  it("days: weekdays, Fridays, Sundays", () => {
    expect(runsOn("weekdays", 2)).toBe(true);
    expect(runsOn("weekdays", 6)).toBe(false);
    expect(runsOn("fri", 5)).toBe(true);
    expect(runsOn("sun", 0)).toBe(true);
    expect(runsOn("sun", 1)).toBe(false);
  });
  it("Kyle's nine runs are all here with their times", () => {
    expect(routineOf("morning")?.times).toEqual(["08:45"]);
    expect(routineOf("debrief")?.times).toEqual(["10:07", "12:07", "14:07", "16:07", "20:07"]);
    expect(routineOf("clean_sweep")?.times).toEqual(["07:40"]);
    expect(routineOf("delegation")?.times).toEqual(["19:25"]);
    expect(routineOf("nightly")?.times).toEqual(["19:48"]);
    expect(routineOf("week_recap")?.days).toBe("fri");
    expect(routineOf("week_ahead")?.days).toBe("sun");
    expect(ROUTINES.length).toBe(10);
  });
  it("times, and a run with nothing to say is never sent", () => {
    expect(validTime("08:45")).toBe(true);
    expect(validTime("25:00")).toBe(false);
    expect(hasContent({ sections: [] })).toBe(false);
    expect(hasContent({ sections: [{ lines: [] }] })).toBe(false);
    expect(hasContent({ sections: [{ lines: [{}] }] })).toBe(true);
    expect(hasContent({ sections: [], urgent: true })).toBe(true);
  });
  it("runs at the standard times in each person's own time zone", () => {
    const r = { profileId: "p", kind: "morning", times: ["08:45"], days: "weekdays" as const, enabled: true };
    // 08:46 in Los Angeles is 11:46 in New York: due for an LA person, long past the window for New York
    const la = new Date("2026-11-24T08:46:00-08:00");
    expect(dueRuns(r, la, "America/Los_Angeles")).toEqual(["p|morning|2026-11-24|08:45"]);
    expect(dueRuns(r, la, "America/New_York")).toEqual([]);
    // An unknown zone falls back to New York instead of failing
    expect(nyClock(at("08:45"), "Not/AZone").minutes).toBe(8 * 60 + 45);
  });
  it("the bell's line is the report's first sentence", () => {
    expect(pushLine({ headline: "Call Chris before 10am. Then the rest.", sections: [] })).toBe("Call Chris before 10am.");
  });
});
