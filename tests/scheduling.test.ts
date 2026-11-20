import { describe, expect, it } from "vitest";
import { busyOf, calendarScopeMissing, defaultWindow, findSlots, freeStarts, inWorkingHours, localParts, parseClock, pickOptions, rfc3339, sameDomain, slotLabel, tzOffset, zonedTime } from "@/lib/assistant/scheduling-core";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const LON = "Europe/London";
const at = (iso: string) => Date.parse(iso);
// Tuesday Nov 24, 2026 (EST, UTC-5); Mon Nov 23 is the day before
const MON_8AM_NY = at("2026-11-23T13:00:00Z");

describe("timezones", () => {
  it("knows New York's offset across daylight saving", () => {
    expect(tzOffset(NY, at("2026-11-24T12:00:00Z"))).toBe(-300);
    expect(tzOffset(NY, at("2026-07-01T12:00:00Z"))).toBe(-240);
    expect(tzOffset("Asia/Kolkata", at("2026-11-24T12:00:00Z"))).toBe(330);
  });

  it("turns a wall-clock time into the right instant", () => {
    expect(new Date(zonedTime("2026-11-24", 14 * 60, NY)).toISOString()).toBe("2026-11-24T19:00:00.000Z");
    expect(new Date(zonedTime("2026-07-01", 9 * 60, NY)).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(new Date(zonedTime("2026-11-24", 9 * 60, LA)).toISOString()).toBe("2026-11-24T17:00:00.000Z");
    // The morning daylight saving ends (Nov 1, 2026): 9 AM is already EST
    expect(new Date(zonedTime("2026-11-01", 9 * 60, NY)).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("reads an instant back as a local day, weekday and minute", () => {
    expect(localParts(at("2026-11-25T03:30:00Z"), NY)).toEqual({ day: "2026-11-24", weekday: 2, minute: 22 * 60 + 30 });
  });

  it("writes times the way Google takes them", () => {
    expect(rfc3339(at("2026-11-24T19:00:00Z"), NY)).toBe("2026-11-24T14:00:00-05:00");
    expect(rfc3339(at("2026-11-24T19:00:00Z"), "Asia/Kolkata")).toBe("2026-11-25T00:30:00+05:30");
  });

  it("labels a slot in the asker's timezone", () => {
    expect(slotLabel(at("2026-11-24T19:00:00Z"), NY)).toBe("Tue, Nov 24, 2:00 PM");
    expect(slotLabel(at("2026-11-24T19:00:00Z"), LA, true)).toMatch(/11:00 AM PST/);
  });
});

describe("working hours", () => {
  it("defaults to Mon–Fri 9–6 local", () => {
    expect(inWorkingHours(at("2026-11-24T14:00:00Z"), at("2026-11-24T14:30:00Z"), { tz: NY })).toBe(true); // 9:00
    expect(inWorkingHours(at("2026-11-24T13:30:00Z"), at("2026-11-24T14:00:00Z"), { tz: NY })).toBe(false); // 8:30
    expect(inWorkingHours(at("2026-11-24T22:30:00Z"), at("2026-11-24T23:00:00Z"), { tz: NY })).toBe(true); // ends 6:00
    expect(inWorkingHours(at("2026-11-24T22:45:00Z"), at("2026-11-24T23:15:00Z"), { tz: NY })).toBe(false); // runs past 6
    expect(inWorkingHours(at("2026-11-28T15:00:00Z"), at("2026-11-28T15:30:00Z"), { tz: NY })).toBe(false); // Saturday
  });

  it("reads each person's hours in their own timezone", () => {
    // 9:00 New York is 6:00 Los Angeles: too early there
    expect(inWorkingHours(at("2026-11-24T14:00:00Z"), at("2026-11-24T14:30:00Z"), { tz: LA })).toBe(false);
    expect(inWorkingHours(at("2026-11-24T17:00:00Z"), at("2026-11-24T17:30:00Z"), { tz: LA })).toBe(true);
  });

  it("respects custom hours and days", () => {
    const hours = { start: 10 * 60, end: 14 * 60, days: [2, 4] };
    expect(inWorkingHours(at("2026-11-24T15:00:00Z"), at("2026-11-24T15:30:00Z"), { tz: NY, hours })).toBe(true);
    expect(inWorkingHours(at("2026-11-25T15:00:00Z"), at("2026-11-25T15:30:00Z"), { tz: NY, hours })).toBe(false);
  });
});

describe("finding free times", () => {
  const base = { tz: NY, fromDay: "2026-11-24", toDay: "2026-11-24", notBefore: MON_8AM_NY };

  it("finds the first half hour everyone is free, inside everyone's hours", () => {
    const starts = freeStarts({ ...base, people: [{ tz: NY, busy: [] }, { tz: LA, busy: [] }] });
    // Los Angeles starts at 9 there: noon in New York
    expect(new Date(starts[0]).toISOString()).toBe("2026-11-24T17:00:00.000Z");
    // New York ends at 6 PM: the last 30-minute start is 5:30 PM New York
    expect(new Date(starts.at(-1)!).toISOString()).toBe("2026-11-24T22:30:00.000Z");
  });

  it("skips anything overlapping a busy block, edges included", () => {
    const busy = busyOf([{ start: "2026-11-24T14:00:00Z", end: "2026-11-24T15:00:00Z" }]);
    const starts = freeStarts({ ...base, people: [{ tz: NY, busy }, { tz: NY, busy: busyOf([{ start: "2026-11-24T15:00:00Z", end: "2026-11-24T15:30:00Z" }]) }] });
    // 9:00 and 9:30 busy for one, 10:00 for the other: 10:30 is first; a call ending right as a meeting starts is fine
    expect(new Date(starts[0]).toISOString()).toBe("2026-11-24T15:30:00.000Z");
  });

  it("a longer call needs the whole stretch free", () => {
    const busy = busyOf([{ start: "2026-11-24T15:00:00Z", end: "2026-11-24T15:30:00Z" }]);
    const starts = freeStarts({ ...base, minutes: 60, people: [{ tz: NY, busy }] });
    expect(starts.map((t) => new Date(t).toISOString()).slice(0, 2)).toEqual(["2026-11-24T14:00:00.000Z", "2026-11-24T15:30:00.000Z"]);
  });

  it("'after 2pm' and 'before 4pm' are read in the asker's timezone", () => {
    const starts = freeStarts({ ...base, earliest: parseClock("2pm"), latest: parseClock("16:00"), people: [{ tz: NY, busy: [] }] });
    expect(starts.map((t) => slotLabel(t, NY).split(", ").at(-1))).toEqual(["2:00 PM", "2:30 PM", "3:00 PM", "3:30 PM"]);
  });

  it("never offers a time already past", () => {
    const starts = freeStarts({ ...base, notBefore: at("2026-11-24T18:10:00Z"), people: [{ tz: NY, busy: [] }] });
    expect(new Date(starts[0]).toISOString()).toBe("2026-11-24T18:30:00.000Z");
  });

  it("offers two or three spread-out choices across days", () => {
    const slots = findSlots({ ...base, toDay: "2026-11-27", people: [{ tz: NY, busy: [] }] });
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => localParts(s.start, NY).day)).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
    expect(slots[0].end - slots[0].start).toBe(30 * 60_000);
  });

  it("on a single day, choices are a couple of hours apart", () => {
    const starts = freeStarts({ ...base, people: [{ tz: NY, busy: [] }] });
    const picked = pickOptions(starts, NY);
    expect(picked.map((t) => slotLabel(t, NY).split(", ").at(-1))).toEqual(["9:00 AM", "11:00 AM", "1:00 PM"]);
  });

  it("nothing fits: no options", () => {
    const busy = busyOf([{ start: "2026-11-24T00:00:00Z", end: "2026-11-25T05:00:00Z" }]);
    expect(findSlots({ ...base, people: [{ tz: NY, busy }] })).toEqual([]);
  });

  it("a London teammate and a New York one only overlap in New York's morning", () => {
    const starts = freeStarts({ ...base, people: [{ tz: NY, busy: [] }, { tz: LON, busy: [] }] });
    // London 9–6 is 4 AM–1 PM New York; New York starts at 9: 9:00 to 12:30 starts
    expect(starts.map((t) => slotLabel(t, NY).split(", ").at(-1))).toEqual(["9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30 PM"]);
  });
});

describe("the small parts", () => {
  it("reads clock times", () => {
    expect(parseClock("2pm")).toBe(14 * 60);
    expect(parseClock("2:30 PM")).toBe(14 * 60 + 30);
    expect(parseClock("12am")).toBe(0);
    expect(parseClock("09:15")).toBe(9 * 60 + 15);
    expect(parseClock("soon")).toBeNull();
  });

  it("the default window is today and the next working days", () => {
    expect(defaultWindow("2026-11-27")).toEqual({ fromDay: "2026-11-27", toDay: "2026-12-03" });
  });

  it("only teammates on the same domain", () => {
    expect(sameDomain("a@kaizen.test", "B@Kaizen.test")).toBe(true);
    expect(sameDomain("a@kaizen.test", "client@acme.test")).toBe(false);
  });

  it("knows Google's scope refusal", () => {
    expect(calendarScopeMissing("unauthorized_client: Client is unauthorized to retrieve access tokens")).toBe(true);
    expect(calendarScopeMissing("Google /calendar/v3/freeBusy: 500 backend error")).toBe(false);
  });
});
