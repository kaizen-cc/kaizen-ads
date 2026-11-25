import { describe, expect, it } from "vitest";
import { isSpike, rowCost, summarize, type SpendRow } from "@/lib/spend-core";

const row = (day: string, place: string, input: number, extra: Partial<SpendRow> = {}): SpendRow => ({ day, agent_key: "strategist", place, model: "sonnet", auto: true, runs: 1, input, output: 0, cache_w: 0, cache_r: 0, searches: 0, ...extra });
// Sonnet input is $2 a million: 5M tokens is $10
const tenDollars = (day: string, place = "suggestion summary") => row(day, place, 5_000_000);

describe("daily AI spend", () => {
  it("prices a row like Settings › AI agents", () => {
    expect(rowCost(tenDollars("2026-11-20"))).toBeCloseTo(10);
    expect(rowCost(row("2026-11-20", "x", 0, { model: "opus", output: 1_000_000 }))).toBeCloseTo(20);
  });

  it("averages the 7 full days before today and projects the month from it", () => {
    const rows = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"].map((d) => tenDollars(d));
    const s = summarize(rows, "2026-11-25");
    expect(s.avg7).toBeCloseTo(10);
    expect(s.todayCost).toBeCloseTo(10);
    expect(s.monthToDate).toBeCloseTo(80);
    // 5 days left in November after the 25th
    expect(s.projected).toBeCloseTo(80 + 5 * 10);
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1)).toEqual({ day: "2026-11-25", cost: expect.closeTo(10) });
    expect(s.spike).toBeNull();
  });

  it("flags a day past twice the average, today first, then yesterday", () => {
    const week = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"].map((d) => tenDollars(d));
    const today = summarize([...week, tenDollars("2026-11-24"), ...Array.from({ length: 4 }, () => tenDollars("2026-11-25", "kaizen ai chat"))], "2026-11-25");
    expect(today.spike).toEqual({ day: "2026-11-25", cost: expect.closeTo(40), avg: expect.closeTo(10) });
    expect(today.topToday[0]).toMatchObject({ place: "kaizen ai chat", runs: 4 });
    const yesterday = summarize([...week, ...Array.from({ length: 3 }, () => tenDollars("2026-11-24"))], "2026-11-25");
    expect(yesterday.spike?.day).toBe("2026-11-24");
  });

  it("doesn't flag a few dollars over a tiny average", () => {
    expect(isSpike(5, 1)).toBe(false);
    expect(isSpike(45, 20)).toBe(true);
    expect(isSpike(40, 20)).toBe(false);
    expect(isSpike(100, 0)).toBe(false);
  });

  it("reads the cache share over the last 7 days", () => {
    const s = summarize([row("2026-11-24", "x", 100, { cache_r: 300, cache_w: 100 })], "2026-11-25");
    expect(s.cacheHit7).toBeCloseTo(0.6);
  });
});
