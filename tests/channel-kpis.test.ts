import { describe, expect, it } from "vitest";
import {
  EARLY_DAYS,
  bandOf,
  canSetTarget,
  cumulative,
  daysSince,
  engagement,
  gapWords,
  judgeEmail,
  judgeSocial,
  monthElapsed,
  monthOf,
  moneyShort,
  orderByRisk,
  orderForBoard,
  parseRateTarget,
  parseRevenueTarget,
  projectMonth,
  riskOf,
  rollingRate,
  socialBasis,
  type RiskInput,
} from "@/lib/channel-kpis/calc";

describe("the month", () => {
  it("finds the month, its length and the one before", () => {
    const m = monthOf("2026-11-16");
    expect(m).toMatchObject({ start: "2026-11-01", dayOfMonth: 16, daysInMonth: 30, prevStart: "2026-10-01", prevEnd: "2026-10-31" });
    expect(monthOf("2026-03-02")).toMatchObject({ daysInMonth: 31, prevStart: "2026-02-01", prevEnd: "2026-02-28" });
    expect(monthOf("2028-03-10").prevEnd).toBe("2028-02-29");
    expect(monthOf("2027-01-05").prevStart).toBe("2026-12-01");
  });

  it("projects the month with today as half a day, and says nothing before it starts", () => {
    // 15.5 elapsed days, $7,750 in: $500 a day, $15,000 over 30 days
    expect(projectMonth(7750, monthOf("2026-11-16"))).toBeCloseTo(15_000, 5);
    expect(projectMonth(0, monthOf("2026-11-16"))).toBe(0);
    expect(projectMonth(100, { dayOfMonth: 0, daysInMonth: 30 })).toBeNull();
    expect(monthElapsed(monthOf("2026-11-16"))).toBeCloseTo(15.5 / 30, 5);
  });
});

describe("the bands match the ads board", () => {
  it("20% better is crushing it, at target is on target, up to 15% under is close, then off", () => {
    expect(bandOf(1.2)).toBe("excellent");
    expect(bandOf(1.19)).toBe("good");
    expect(bandOf(1)).toBe("good");
    expect(bandOf(0.99)).toBe("close");
    expect(bandOf(0.85)).toBe("close");
    expect(bandOf(0.849)).toBe("off");
    expect(bandOf(null)).toBeNull();
  });

  it("says the gap in words", () => {
    expect(gapWords(0.88)).toBe("12% below target");
    expect(gapWords(1.08)).toBe("8% above target");
    expect(gapWords(1)).toBe("Right on target");
    expect(gapWords(null)).toBeNull();
  });
});

describe("judging an email client", () => {
  const mid = monthOf("2026-11-16");
  it("needs connecting before anything else", () => {
    expect(judgeEmail({ readable: false, target: 10_000, mtd: 9000, month: mid }).status).toBe("setup");
  });
  it("is neutral with no target, still showing the pace", () => {
    const j = judgeEmail({ readable: true, target: null, mtd: 7750, month: mid });
    expect(j.status).toBe("unset");
    expect(j.projected).toBeCloseTo(15_000, 5);
    expect(judgeEmail({ readable: true, target: 0, mtd: 1, month: mid }).status).toBe("unset");
  });
  it("judges the projected month end against the target", () => {
    // pace lands at $15,000
    expect(judgeEmail({ readable: true, target: 12_000, mtd: 7750, month: mid }).status).toBe("excellent");
    expect(judgeEmail({ readable: true, target: 15_000, mtd: 7750, month: mid }).status).toBe("good");
    expect(judgeEmail({ readable: true, target: 17_000, mtd: 7750, month: mid }).status).toBe("close");
    expect(judgeEmail({ readable: true, target: 25_000, mtd: 7750, month: mid }).status).toBe("off");
  });
  it("holds its verdict through the first days unless the target is already met", () => {
    const early = monthOf("2026-11-02");
    expect(early.dayOfMonth).toBeLessThanOrEqual(EARLY_DAYS);
    expect(judgeEmail({ readable: true, target: 20_000, mtd: 500, month: early }).status).toBe("early");
    expect(judgeEmail({ readable: true, target: 400, mtd: 500, month: early }).status).not.toBe("early");
    expect(judgeEmail({ readable: true, target: 20_000, mtd: 500, month: monthOf("2026-11-04") }).status).toBe("off");
  });
});

describe("judging a social client", () => {
  it("reads the rate against the target, neutral without one, and needs connecting without a rate", () => {
    expect(engagement(350, 10_000)).toBeCloseTo(0.035, 6);
    expect(engagement(10, 0)).toBeNull();
    expect(engagement(null, 100)).toBeNull();
    expect(judgeSocial({ readable: true, target: 0.03, rate: 0.036 }).status).toBe("excellent");
    expect(judgeSocial({ readable: true, target: 0.03, rate: 0.03 }).status).toBe("good");
    expect(judgeSocial({ readable: true, target: 0.03, rate: 0.027 }).status).toBe("close");
    expect(judgeSocial({ readable: true, target: 0.03, rate: 0.02 }).status).toBe("off");
    expect(judgeSocial({ readable: true, target: null, rate: 0.02 }).status).toBe("unset");
    expect(judgeSocial({ readable: true, target: 0.03, rate: null }).status).toBe("setup");
    expect(judgeSocial({ readable: false, target: 0.03, rate: 0.02 }).status).toBe("setup");
  });
  it("reads the last 30 days while the month is too young", () => {
    expect(socialBasis(monthOf("2026-11-05"))).toBe("last30");
    expect(socialBasis(monthOf("2026-11-07"))).toBe("last30");
    expect(socialBasis(monthOf("2026-11-08"))).toBe("month");
  });
});

describe("targets typed by people", () => {
  it("reads a rate as percent and stores a fraction", () => {
    expect(parseRateTarget("3.5")).toBe(0.035);
    expect(parseRateTarget("3.5%")).toBe(0.035);
    expect(parseRateTarget(" 0.8 ")).toBe(0.008);
    expect(parseRateTarget("0")).toBeNull();
    expect(parseRateTarget("abc")).toBeNull();
    expect(parseRateTarget("120")).toBeNull();
  });
  it("reads revenue with symbols, commas and k", () => {
    expect(parseRevenueTarget("$12,000")).toBe(12_000);
    expect(parseRevenueTarget("12k")).toBe(12_000);
    expect(parseRevenueTarget("8.5k")).toBe(8500);
    expect(parseRevenueTarget("-5")).toBeNull();
    expect(parseRevenueTarget("")).toBeNull();
  });
  it("writes money short", () => {
    expect(moneyShort(950)).toBe("$950");
    expect(moneyShort(12_345)).toBe("$12.3k");
    expect(moneyShort(250_000)).toBe("$250k");
    expect(moneyShort(1200, "CAD")).toBe("CAD 1,200");
    expect(moneyShort(null)).toBe("n/a");
  });
});

describe("who may set a target", () => {
  const person = (role: string, o: { isExec?: boolean; isLead?: boolean } = {}) => ({ role, isExec: Boolean(o.isExec), isLead: Boolean(o.isLead) });
  it("allows execs, leads, the line's head and the seated team", () => {
    expect(canSetTarget(person("executive", { isExec: true }), "email", [])).toBe(true);
    expect(canSetTarget(person("head_of_meta", { isLead: true }), "social", [])).toBe(true);
    expect(canSetTarget(person("head_of_email"), "email", [])).toBe(true);
    expect(canSetTarget(person("head_of_social"), "social", [])).toBe(true);
    expect(canSetTarget(person("email_strategist"), "email", ["email_strategist"])).toBe(true);
    expect(canSetTarget(person("social_media_manager"), "social", ["social_manager"])).toBe(true);
  });
  it("refuses everyone else, including the other line's head and an unseated team member", () => {
    expect(canSetTarget(person("head_of_email"), "social", [])).toBe(false);
    expect(canSetTarget(person("head_of_social"), "email", [])).toBe(false);
    expect(canSetTarget(person("email_builder"), "email", [])).toBe(false);
    expect(canSetTarget(person("email_builder"), "email", ["social_manager"])).toBe(false);
    expect(canSetTarget(person("media_buyer"), "email", ["meta_buyer"])).toBe(false);
  });
});

describe("chart series", () => {
  it("runs a total through the month, a missing day adding nothing", () => {
    const out = cumulative(
      [
        { date: "2026-11-01", value: 100 },
        { date: "2026-11-03", value: 50 },
      ],
      "2026-11-01",
      "2026-11-04",
    );
    expect(out).toEqual([100, 100, 150, 150]);
  });
  it("smooths the rate over 7 days and leaves a window with no reach empty", () => {
    const days = [
      { date: "2026-11-01", interactions: 10, reach: 100 },
      { date: "2026-11-02", interactions: 30, reach: 100 },
    ];
    const out = rollingRate(days, "2026-10-30", "2026-11-02");
    expect(out[0]).toBeNull();
    expect(out[2]).toBeCloseTo(0.1, 6);
    expect(out[3]).toBeCloseTo(0.2, 6);
  });
  it("counts whole days since", () => {
    expect(daysSince("2026-11-01T15:00:00Z", "2026-11-16")).toBe(15);
    expect(daysSince(null, "2026-11-16")).toBeNull();
  });
});

describe("who needs a look first", () => {
  const ok: RiskInput = { status: "good", data: "connected", quietDays: 2, owed: 0, escalated: 0 };
  it("puts off target ahead of everything, then a blind client, then quiet ones", () => {
    const off = riskOf("email", { ...ok, status: "off" });
    const blind = riskOf("email", { ...ok, status: "setup", data: "missing", quietDays: null });
    const quiet = riskOf("email", { ...ok, quietDays: 20 });
    const fine = riskOf("email", ok);
    expect(off.score).toBeGreaterThan(blind.score);
    expect(blind.score).toBeGreaterThan(quiet.score);
    expect(quiet.score).toBeGreaterThan(fine.score);
    expect(fine).toEqual({ score: 0, reasons: [] });
  });
  it("says why, in the line's words", () => {
    expect(riskOf("email", { ...ok, status: "off", quietDays: 16 }).reasons).toEqual(["Off target", "No email sent in 16 days"]);
    expect(riskOf("social", { ...ok, quietDays: 9 }).reasons).toEqual(["No post in 9 days"]);
    expect(riskOf("email", { ...ok, data: "missing", status: "setup", quietDays: null }).reasons).toEqual(["Klaviyo not connected"]);
    expect(riskOf("social", { ...ok, data: "missing", status: "setup", quietDays: null }).reasons).toEqual(["Social not linked"]);
    expect(riskOf("email", { ...ok, data: "failing", status: "setup", quietDays: null }).reasons).toContain("Data connection failing");
  });
  it("weighs owed replies, more when one went past a second notice, and a missing target a little", () => {
    const one = riskOf("social", { ...ok, owed: 1 });
    const escalated = riskOf("social", { ...ok, owed: 1, escalated: 1 });
    expect(escalated.score).toBeGreaterThan(one.score);
    expect(riskOf("social", { ...ok, owed: 2 }).reasons).toEqual(["2 replies owed"]);
    expect(riskOf("email", { ...ok, status: "unset" }).score).toBeGreaterThan(0);
    expect(riskOf("email", { ...ok, status: "unset" }).score).toBeLessThan(riskOf("email", { ...ok, status: "close" }).score);
  });
  it("orders worst first and ties by name", () => {
    const rows = [
      { name: "Zed", risk: { score: 10, reasons: [] } },
      { name: "Alpha", risk: { score: 10, reasons: [] } },
      { name: "Mid", risk: { score: 100, reasons: [] } },
    ];
    expect(orderByRisk(rows).map((r) => r.name)).toEqual(["Mid", "Alpha", "Zed"]);
  });
  it("orders the board off, close, early, then on target, with neutral ones last", () => {
    const rows = [
      { name: "A", status: "excellent" as const, ratio: 1.4 },
      { name: "B", status: "unset" as const, ratio: null },
      { name: "C", status: "off" as const, ratio: 0.5 },
      { name: "D", status: "off" as const, ratio: 0.7 },
      { name: "E", status: "setup" as const, ratio: null },
      { name: "F", status: "close" as const, ratio: 0.9 },
      { name: "G", status: "good" as const, ratio: 1.05 },
    ];
    expect(orderForBoard(rows).map((r) => r.name)).toEqual(["C", "D", "F", "G", "A", "B", "E"]);
  });
});

import { crewOf, crewSeat } from "@/lib/channel-kpis/calc";

describe("crewOf", () => {
  it("orders the seats strategist first and fills from the sheet when nobody is seated", () => {
    const crew = crewOf("email", [{ seat: "Designer", name: "Eunhye" }], [
      { seat: "Strategist", names: ["Mel"] },
      { seat: "Designer", names: ["Eunhye"] },
      { seat: "Builder", names: ["Andres"] },
    ]);
    expect(crew).toEqual([
      { seat: "Strategist", name: "Mel", pending: true },
      { seat: "Designer", name: "Eunhye", pending: false },
      { seat: "Builder", name: "Andres", pending: true },
    ]);
  });
  it("names the social creative's second person the video editor", () => {
    expect(crewSeat("social_creative", false)).toBe("Video editor");
    expect(crewSeat("social_manager", true)).toBe("Strategist");
  });
});
