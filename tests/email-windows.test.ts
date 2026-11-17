import { describe, expect, it } from "vitest";
import { daysInMonth, earliestDay, gapOf, gapTone, momentum, targetFor, trendSeries, windowNumbers, windowRanges, type EmailDay } from "@/lib/email-ops/windows";

const day = (d: string, revenue: number, recipients = 1000, orders = 2): EmailDay => ({ d, revenue, campaignRevenue: revenue / 2, flowRevenue: revenue / 2, recipients, orders, storeRevenue: null });

describe("email windows", () => {
  it("lays out every window as of a day", () => {
    const r = windowRanges("2026-11-17");
    expect(r.d7).toEqual({ from: "2026-11-11", to: "2026-11-17" });
    expect(r.d90.from).toBe("2026-08-20");
    expect(r.mtd).toEqual({ from: "2026-11-01", to: "2026-11-17" });
    expect(r.lastMonth).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.qtd).toEqual({ from: "2026-10-01", to: "2026-11-17" });
    expect(r.lastQuarter).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(earliestDay("2026-11-17")).toBe("2026-07-01");
  });

  it("crosses the year at the start of one", () => {
    const r = windowRanges("2027-01-05");
    expect(r.lastMonth).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(r.lastQuarter).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(daysInMonth("2028-02-10")).toBe(29);
  });

  it("adds up a window and judges it against the target at the same daily pace", () => {
    const days = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2026, 10, 17 - i)).toISOString().slice(0, 10), 100));
    const w = windowNumbers({ today: "2026-11-17", days, campaigns: [{ d: "2026-11-15", recipients: 1000, delivered: 1000, opens: 300, clicks: 12 }], monthTarget: 3000 });
    expect(w.d7.revenue).toBe(700);
    expect(w.d7.target).toBe(700);
    expect(w.d7.rpr).toBeCloseTo(0.1);
    expect(w.d7.openRate).toBeCloseTo(0.3);
    expect(w.d7.sent).toBe(1);
    expect(w.mtd.covered).toBe(17);
    expect(w.lastMonth.covered).toBe(13);
    expect(targetFor(null, "2026-11-17", 7)).toBeNull();
  });

  it("colours a gap like the boards: at or over, close, off", () => {
    expect(gapTone(gapOf(110, 100))).toBe("ok");
    expect(gapTone(gapOf(90, 100))).toBe("warn");
    expect(gapTone(gapOf(80, 100))).toBe("bad");
    expect(gapOf(5, null)).toBeNull();
  });

  it("momentum compares per day, and only against a whole month", () => {
    const days = [
      ...Array.from({ length: 31 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 100)),
      ...Array.from({ length: 17 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`, 150)),
    ];
    const m = momentum(windowNumbers({ today: "2026-11-17", days, campaigns: [], monthTarget: null }));
    expect(m.vsMonth).toBeCloseTo(0.5);
    expect(m.vsQuarter).toBeNull();
  });

  it("the trend's last 30 days with a 7-day average, empty days as zero", () => {
    const pts = trendSeries([day("2026-11-17", 70, 0, 0), day("2026-11-16", 0, 100, 0)], "2026-11-17", "revenue", 30);
    expect(pts).toHaveLength(30);
    expect(pts.at(-1)).toMatchObject({ d: "2026-11-17", value: 70, avg: 10 });
    const rpr = trendSeries([day("2026-11-17", 70, 0, 0), day("2026-11-16", 30, 100, 0)], "2026-11-17", "rpr", 30);
    expect(rpr.at(-1)?.value).toBeNull();
    expect(rpr.at(-1)?.avg).toBeCloseTo(1);
  });
});
