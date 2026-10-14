import { describe, expect, it } from "vitest";
import { aggregate, computeSnapshot, pacing, statusFor, toDays, worseBy, type Day } from "@/lib/kpi/calc";
import { conversionFor } from "@/lib/kpi/conversions";

// Oct 15, 2026, noon in New York
const NOW = new Date("2026-10-15T16:00:00Z");

const day = (date: string, spend: number, purchases: number, value = 0): Day => ({
  date,
  spend,
  actions: { omni_purchase: purchases },
  values: { omni_purchase: value },
});

describe("KPI math", () => {
  it("cost per result and ROAS from days", () => {
    const days = [day("2026-10-13", 100, 2, 300), day("2026-10-14", 50, 1, 150)];
    expect(aggregate(days, conversionFor("purchases"), "omni_purchase")).toEqual({ spend: 150, results: 3, value: 50 });
    expect(aggregate(days, conversionFor("roas"), "omni_purchase").value).toBe(3);
  });

  it("deviation: positive is worse, for cost and for ROAS", () => {
    expect(worseBy(58.25, 50)).toBe(0.165);
    expect(worseBy(40, 50)).toBe(-0.2);
    expect(worseBy(2.5, 3, true)).toBeCloseTo(0.1667, 3);
  });

  it("status bands", () => {
    const spent = { spend: 100, results: 1, value: 100 };
    expect(statusFor(-0.25, spent, true)).toBe("excellent");
    expect(statusFor(-0.05, spent, true)).toBe("good");
    expect(statusFor(0.1, spent, true)).toBe("close");
    expect(statusFor(0.3, spent, true)).toBe("off");
    expect(statusFor(null, spent, true)).toBe("off"); // spend, no results
    expect(statusFor(null, { spend: 0, results: 0, value: null }, true)).toBe("idle");
    expect(statusFor(0.3, spent, false)).toBe("setup");
  });

  it("budget pacing projects the month from month to date", () => {
    // Oct 15 noon: 14.5 of 31 days gone
    const p = pacing(5000, 10000, NOW)!;
    expect(p.expected).toBeCloseTo(4677.42, 1);
    expect(p.projected).toBeCloseTo(10689.66, 1);
    expect(p.status).toBe("on");
    expect(pacing(7000, 10000, NOW)!.status).toBe("over");
    expect(pacing(3000, 10000, NOW)!.status).toBe("under");
    expect(pacing(10, 10000, new Date("2026-10-01T16:00:00Z"))!.status).toBe("early");
  });

  it("windows end yesterday; month to date includes today", () => {
    const days: Day[] = [];
    for (let i = 1; i <= 15; i++) days.push(day(`2026-10-${String(i).padStart(2, "0")}`, 100, i === 15 ? 0 : 2));
    days.push(day("2026-09-20", 300, 2));
    const s = computeSnapshot(days, { conversion: "purchases", target: 40, budget: 3100, now: NOW });
    expect(s.windows.d3).toEqual({ spend: 300, results: 6, value: 50 });
    expect(s.months.mtd.spend).toBe(1500);
    expect(s.months.lastMonth).toEqual({ spend: 300, results: 2, value: 150 });
    expect(s.deviation).toBe(0.25);
    expect(s.status).toBe("off");
    expect(s.vsMonth).toBeLessThan(0); // better than September
    expect(s.trend).toBe("steady");
  });

  it("campaign filter and summing into days", () => {
    const rows = [
      { date: "2026-10-01", campaign_name: "Bridal Boudoir | Prospecting", spend: 10, actions: { schedule_total: 1 }, action_values: {} },
      { date: "2026-10-01", campaign_name: "Wedding", spend: 20, actions: { schedule_total: 1 }, action_values: {} },
    ];
    expect(toDays(rows, "bridal")[0].spend).toBe(10);
    expect(toDays(rows)[0].actions.schedule_total).toBe(2);
  });
});
