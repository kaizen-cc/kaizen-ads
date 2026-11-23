import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmailRevenueChart, RevenuePace } from "@/components/email-revenue-chart";
import { monthOf } from "@/lib/channel-kpis/calc";
import { blendByRank, conversionMetricsOf, effectiveWeights, monthRevenue, paceHealth, rankWeights, revenueTarget } from "@/lib/email-metrics";
import { aggregateEmailScore } from "@/lib/email-score-calc";
import { klaviyoFlowUrl } from "@/lib/email-breakdown";
import { klaviyoCostMs } from "@/lib/klaviyo/core";

// Several conversion metrics ranked, the monthly revenue target (last month + 10%, a higher manual one wins) and the
// month's running revenue the Email cards chart.

describe("ranked conversion metrics", () => {
  it("weighs ranks 65/35, 55/30/15 and 50/25/15/10", () => {
    expect(rankWeights(1)).toEqual([100]);
    expect(rankWeights(2)).toEqual([65, 35]);
    expect(rankWeights(3)).toEqual([55, 30, 15]);
    expect(rankWeights(4)).toEqual([50, 25, 15, 10]);
  });

  it("blends by rank and leaves out a metric with no data, scaling the rest", () => {
    expect(blendByRank([0.4])).toBeCloseTo(0.4);
    expect(blendByRank([0.4, 0.2])).toBeCloseTo(0.4 * 0.65 + 0.2 * 0.35);
    // The tertiary has no data: primary and secondary share 55 and 30 over 85
    expect(blendByRank([1, 0.5, null])).toBeCloseTo((55 + 15) / 85);
    expect(blendByRank([null, null])).toBeNull();
    expect(effectiveWeights([true, false, true]).map((x) => Math.round(x * 100))).toEqual([79, 0, 21]);
  });

  it("keeps the primary first, drops duplicates and blanks, four at most", () => {
    const list = conversionMetricsOf(
      [
        { id: "res", name: "Reservation", integration: "OpenTable" },
        { id: "ord", name: "Placed Order", integration: "Toast" },
        { id: "res" },
        { id: "" },
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      { id: "ord", name: "Placed Order" },
    );
    expect(list.map((m) => m.id)).toEqual(["ord", "res", "a", "b"]);
    expect(list[0].integration).toBe("Toast");
    expect(conversionMetricsOf(null, { id: "po", name: null })).toEqual([{ id: "po", name: "Placed Order", integration: null }]);
    expect(conversionMetricsOf([], { id: null, name: null })).toEqual([]);
  });

  it("blends the score's money checks across the ranked metrics", () => {
    const days = [{ revenue: 300, storeRevenue: 1000, campaignRecipients: 1000, flowRecipients: 0 }];
    const one = aggregateEmailScore({ days, campaigns: [], flows: [] });
    expect(one.inputs.attributed).toBeCloseTo(0.3);
    expect(one.inputs.rpr).toBeCloseTo(0.3);
    expect(one.byMetric).toHaveLength(1);
    // Reservations: 100 of 500 attributed
    const two = aggregateEmailScore({ days, campaigns: [], flows: [], extra: [[{ revenue: 100, storeRevenue: 500 }]] });
    expect(two.inputs.attributed).toBeCloseTo(0.3 * 0.65 + 0.2 * 0.35);
    expect(two.inputs.rpr).toBeCloseTo(0.3 * 0.65 + 0.1 * 0.35);
    expect(two.byMetric.map((m) => Math.round(m.weight * 100))).toEqual([65, 35]);
  });

  it("never lets a metric with no money (or not read yet) drag the money checks", () => {
    const days = [{ revenue: 300, storeRevenue: 1000, campaignRecipients: 1000, flowRecipients: 0 }];
    const r = aggregateEmailScore({ days, campaigns: [], flows: [], extra: [[{ revenue: 0, storeRevenue: 0 }], []] });
    expect(r.inputs.attributed).toBeCloseTo(0.3);
    expect(r.inputs.rpr).toBeCloseTo(0.3);
    expect(r.byMetric.map((m) => m.weight)).toEqual([1, 0, 0]);
  });

  it("budgets the sync longer per extra metric", () => {
    expect(klaviyoCostMs("full")).toBe(275_000);
    expect(klaviyoCostMs("full", 2)).toBeGreaterThan(klaviyoCostMs("full", 1));
    expect(klaviyoCostMs("recent", 1)).toBeGreaterThan(klaviyoCostMs("recent"));
  });

  it("links a flow to its editor in Klaviyo", () => {
    expect(klaviyoFlowUrl("XyZ123")).toBe("https://www.klaviyo.com/flow/XyZ123/edit");
  });
});

describe("the monthly revenue target", () => {
  it("is last month + 10% by itself", () => {
    expect(revenueTarget(20_000, null)).toMatchObject({ lastMonth: 20_000, floor: 22_000, target: 22_000, source: "floor" });
  });
  it("takes a manual target only when it's higher than the floor", () => {
    expect(revenueTarget(20_000, 25_000)).toMatchObject({ floor: 22_000, target: 25_000, source: "manual" });
    expect(revenueTarget(20_000, 21_000)).toMatchObject({ floor: 22_000, manual: 21_000, target: 22_000, source: "floor" });
  });
  it("falls back to the manual one, or none, without a last month", () => {
    expect(revenueTarget(null, 5_000)).toMatchObject({ floor: null, target: 5_000, source: "manual" });
    expect(revenueTarget(0, null)).toMatchObject({ floor: null, target: null, source: null });
  });
});

// Nov 16 2026: half way through a 30-day month
const month = monthOf("2026-11-16");
const days = Array.from({ length: 16 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, value: 1000 }));
const prevDays = Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, value: 900 }));

describe("the month's running revenue", () => {
  it("runs through today, then carries the pace and the projection", () => {
    const m = monthRevenue({ days, prevDays, month, target: 30_000 });
    expect(m.points).toHaveLength(30);
    expect(m.today).toBe(15);
    expect(m.mtd).toBe(16_000);
    expect(m.points[15]).toMatchObject({ day: 16, cum: 16_000, pace: 16_000, prevCum: 14_400, health: "ok" });
    expect(m.points[16].cum).toBeNull();
    expect(m.points[16].projected).toBeCloseTo((16_000 / 15.5) * 17);
    // Today counts as half a day, as the board's pace does
    expect(m.projected).toBeCloseTo((16_000 / 15.5) * 30);
    expect(m.health).toBe("ok");
  });

  it("colours each day against the even pace, never red in the first days", () => {
    expect(paceHealth(1000, 1000, 10)).toBe("ok");
    expect(paceHealth(900, 1000, 10)).toBe("warn");
    expect(paceHealth(500, 1000, 10)).toBe("bad");
    expect(paceHealth(500, 1000, 2)).toBe("none");
    expect(paceHealth(500, null, 10)).toBe("none");
    const behind = monthRevenue({ days, prevDays, month, target: 50_000 });
    expect(behind.health).toBe("bad");
  });

  it("has no colour without a target", () => {
    const m = monthRevenue({ days, prevDays: [], month, target: null });
    expect(m.health).toBe("none");
    expect(m.points.every((p) => p.pace == null && p.prevCum == null)).toBe(true);
  });
});

describe("the Email card's chart", () => {
  const m = monthRevenue({ days, prevDays, month, target: revenueTarget(27_900, null).target });

  it("draws the running total, the target's pace, last month and today's point", () => {
    const html = renderToStaticMarkup(createElement(EmailRevenueChart, { id: "c1", m, currency: "USD", compact: true }));
    expect(html).toContain("<svg");
    expect(html).toContain("touch-pan-y");
    // One colour stop per day so far, the target's dashed line and last month's ghost
    expect(html.match(/<stop /g)?.length).toBe(16 + 2);
    expect(html).toContain('stroke-dasharray="4 4"');
    expect(html).toContain("var(--fg-faint)");
    // Theme colours only
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("labels the target and the dates on the sheet", () => {
    const html = renderToStaticMarkup(createElement(EmailRevenueChart, { id: "c1", m, currency: "USD" }));
    expect(html).toContain("Target $30.7k");
    expect(html).toContain("Nov 1");
    expect(html).toContain("Nov 30");
  });

  it("paces the month like the Meta budget bar", () => {
    const html = renderToStaticMarkup(createElement(RevenuePace, { m, currency: "USD" }));
    expect(html).toContain("$16.0k");
    expect(html).toContain("of $30.7k");
    expect(html).toContain("Lands at");
  });
});
