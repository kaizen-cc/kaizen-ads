import { describe, expect, it } from "vitest";
import { lastFullWeek, matchPreset, nextPeriod, parseDates, periodMismatch, previousPeriod, resolvePeriod, restOfAsk, todayIn } from "@/lib/reports/period";
import { periodsFor } from "@/lib/reports/metrics";

// A report's period is the one source of truth for every page. The bug this guards: a buyer on Monday Nov 9, 2026
// asked the AI for Nov 2 to 8 and got Oct 19 to 25 (the last weekly queued, since the month's first Monday makes the
// monthly recap instead), and only the first slide moved: every other page kept reading the numbers drawn for the old
// dates. Now the dates are parsed against today in the client's time zone, the report's period moves, and anything
// not drawn for it is flagged until it's redrawn.

const MON = "2026-11-09"; // a Monday
const SUN = "2026-11-08";

describe("period presets", () => {
  it("last week is the last full Monday to Sunday", () => {
    expect(lastFullWeek(MON)).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    // On a Sunday the week isn't over: the one before
    expect(lastFullWeek(SUN)).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    // Mid-week: still the last full week, never a rolling seven days
    expect(lastFullWeek("2026-11-12")).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });

  it("resolves every preset as of today, data through yesterday", () => {
    const r = (k: Parameters<typeof resolvePeriod>[0]) => {
      const p = resolvePeriod(k, MON)!;
      return [p.start, p.end];
    };
    expect(r("lastWeek")).toEqual(["2026-11-02", "2026-11-08"]);
    expect(r("last7")).toEqual(["2026-11-02", "2026-11-08"]);
    expect(r("last14")).toEqual(["2026-10-26", "2026-11-08"]);
    expect(r("last30")).toEqual(["2026-10-10", "2026-11-08"]);
    expect(r("thisMonth")).toEqual(["2026-11-01", "2026-11-08"]);
    expect(r("lastMonth")).toEqual(["2026-10-01", "2026-10-31"]);
    // On the 1st, this month is the month that just ended
    const first = resolvePeriod("thisMonth", "2026-12-01")!;
    expect([first.start, first.end]).toEqual(["2026-11-01", "2026-11-30"]);
  });

  it("takes custom dates that are over, clipped to yesterday", () => {
    expect(resolvePeriod("custom", MON, { start: "2026-11-02", end: "2026-11-08" })).toMatchObject({ start: "2026-11-02", end: "2026-11-08", key: "custom" });
    expect(resolvePeriod("custom", MON, { start: "2026-11-05", end: "2026-11-20" })).toMatchObject({ start: "2026-11-05", end: "2026-11-08" });
    expect(resolvePeriod("custom", MON, { start: "2026-11-09", end: "2026-11-10" })).toBeNull(); // not over
    expect(resolvePeriod("custom", MON, { start: "2026-11-08", end: "2026-11-02" })).toBeNull(); // backwards
    expect(resolvePeriod("custom", MON, { start: "2026-02-30", end: "2026-03-02" })).toBeNull(); // no such day
  });

  it("knows which preset a range is, for the picker", () => {
    expect(matchPreset({ start: "2026-11-02", end: "2026-11-08" }, MON)).toBe("lastWeek");
    expect(matchPreset({ start: "2026-10-26", end: "2026-11-08" }, MON)).toBe("last14");
    expect(matchPreset({ start: "2026-10-19", end: "2026-10-25" }, MON)).toBe("custom");
  });

  it("compares with the same number of days just before, and duplicates forward", () => {
    expect(previousPeriod({ start: "2026-11-02", end: "2026-11-08" })).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(previousPeriod({ start: "2026-10-26", end: "2026-11-08" })).toEqual({ start: "2026-10-12", end: "2026-10-25" });
    expect(nextPeriod({ start: "2026-10-26", end: "2026-11-01" }, MON)).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(nextPeriod({ start: "2026-11-02", end: "2026-11-08" }, MON)).toBeNull(); // next week isn't over
  });

  it("reads today in the client's time zone (New York unless they have their own)", () => {
    const late = new Date("2026-11-10T03:30:00Z"); // 10:30pm Monday in New York
    expect(todayIn("America/New_York", late)).toBe(MON);
    expect(todayIn("UTC", late)).toBe("2026-11-10");
    expect(todayIn("Not/AZone", late)).toBe(MON);
  });
});

describe("a weekly's numbers follow its dates", () => {
  it("defaults to last week Monday to Sunday, never an older week", () => {
    const p = periodsFor("weekly", MON);
    expect([p.main.start, p.main.end]).toEqual(["2026-11-02", "2026-11-08"]);
    expect([p.compare.start, p.compare.end]).toEqual(["2026-10-26", "2026-11-01"]);
    expect(p.main.start).not.toBe("2026-10-19");
  });

  it("uses the report's own dates for every number when it has them", () => {
    const p = periodsFor("weekly", "2026-11-10", { start: "2026-10-26", end: "2026-11-08" });
    expect([p.main.start, p.main.end]).toEqual(["2026-10-26", "2026-11-08"]);
    expect([p.compare.start, p.compare.end]).toEqual(["2026-10-12", "2026-10-25"]);
    expect(p.mtd?.start).toBe("2026-11-01");
    const c = periodsFor("custom", MON, { start: "2026-10-01", end: "2026-10-31" });
    expect(c.main.label).toBe("October");
    expect([c.compare.start, c.compare.end]).toEqual(["2026-08-31", "2026-09-30"]);
  });
});

describe("every page follows the report's period", () => {
  const period = { start: "2026-11-02", end: "2026-11-08" };
  const drawn = (start: string, end: string) => {
    const p = periodsFor("weekly", MON, { start, end });
    return { main: { start: p.main.start, end: p.main.end }, compare: { start: p.compare.start, end: p.compare.end } };
  };

  it("is clean when the numbers, the comparison and the charts are all for the period", () => {
    expect(periodMismatch(period, drawn("2026-11-02", "2026-11-08"), { stories: [{ title: "CPL, last 5 weeks", points: [{ end: "2026-10-04" }, { end: "2026-11-08" }] }] })).toEqual([]);
  });

  it("flags the pages still drawn for Oct 19 to 25 after the dates moved", () => {
    const stale = periodMismatch(period, drawn("2026-10-19", "2026-10-25"), { stories: [{ title: "CPL", points: [{ end: "2026-10-25" }] }] });
    expect(stale).toEqual(["numbers", "comparison", "chart 1 (CPL)"]);
  });

  it("flags a report with no numbers at all", () => {
    expect(periodMismatch(period, null)).toEqual(["numbers"]);
  });
});

describe("dates in the chat", () => {
  const p = (text: string, today = MON) => {
    const r = parseDates(text, today);
    return r && r.ok ? [r.period.start, r.period.end, r.period.key] : r;
  };

  it("reads 'Nov 2 to 8' as this year's, not another week", () => {
    expect(p("Can you redo this for Nov 2 to 8?")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("Nov 2 to 8, 2026")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("November 2nd - November 8th")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("use Oct 26 – Nov 1")).toEqual(["2026-10-26", "2026-11-01", "custom"]);
  });

  it("reads numeric, ISO and day-first dates", () => {
    expect(p("10/26 to 11/1")).toEqual(["2026-10-26", "2026-11-01", "custom"]);
    expect(p("11/2/2026 - 11/8/2026")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("2026-11-02 to 2026-11-08")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("2 to 8 Nov")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
    expect(p("the week of Nov 2")).toEqual(["2026-11-02", "2026-11-08", "custom"]);
  });

  it("reads relative dates against today", () => {
    expect(p("make it last week")).toEqual(["2026-11-02", "2026-11-08", "lastWeek"]);
    expect(p("the last 14 days please")).toEqual(["2026-10-26", "2026-11-08", "last14"]);
    expect(p("past 30 days")).toEqual(["2026-10-10", "2026-11-08", "last30"]);
    expect(p("this month")).toEqual(["2026-11-01", "2026-11-08", "thisMonth"]);
    expect(p("last month")).toEqual(["2026-10-01", "2026-10-31", "lastMonth"]);
    expect(p("do it for October")).toEqual(["2026-10-01", "2026-10-31", "custom"]);
  });

  it("puts a date without a year in the latest year that's over, across New Year too", () => {
    expect(p("Dec 28 to Jan 3")).toEqual(["2025-12-28", "2026-01-03", "custom"]);
    expect(p("Dec 1 to 7", "2027-01-10")).toEqual(["2026-12-01", "2026-12-07", "custom"]);
  });

  it("refuses dates that aren't over yet", () => {
    const r = parseDates("Nov 9 to 15", MON);
    expect(r?.ok).toBe(false);
  });

  it("leaves alone what isn't a new period", () => {
    expect(parseDates("Follow last week's report format", MON)).toBeNull();
    expect(parseDates("Make it shorter", MON)).toBeNull();
    expect(parseDates("Explain why results moved", MON)).toBeNull();
    // A comparison, not the report's own dates
    expect(parseDates("compare it with Oct 19 to 25", MON)).toMatchObject({ ok: true, compare: true });
  });

  it("knows when the ask is only about the dates", () => {
    const r = parseDates("Can you change the dates to Nov 2 to 8?", MON)!;
    expect(restOfAsk("Can you change the dates to Nov 2 to 8?", r.matched)).toBe("");
    const s = parseDates("Nov 2 to 8 and make it shorter", MON)!;
    expect(restOfAsk("Nov 2 to 8 and make it shorter", s.matched)).toBe("shorter");
  });
});
