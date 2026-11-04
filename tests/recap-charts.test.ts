import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { recapCharts, chartPng } = await import("@/lib/ai-tools/recap-deck");

describe("recap deck charts", () => {
  it("draws every chart as a PNG", async () => {
    const period = { label: "October 2026", start: "2026-10-01", end: "2026-10-03", days: 3, spend: 300, impressions: 5000, clicks: 90, ctr: 1.8, cpc: 3.3, cpm: 60, results: 6, costPerResult: 50, revenue: 0, roas: null };
    const m = {
      platform: "google" as const,
      kind: "monthly" as const,
      conversion: "Leads & calls",
      roasKpi: false,
      target: 40,
      monthlyBudget: 900,
      main: period,
      compare: { ...period, label: "September 2026" },
      mtd: null,
      mtdCompare: null,
      campaigns: [{ name: "Search <brand>", spend: 200, results: 4, costPerResult: 50, roas: null, ctr: 2 }],
      topAds: [],
      dataThrough: null,
      gaps: [],
      daily: ["01", "02", "03"].map((d, i) => ({ date: `2026-10-${d}`, spend: 100, results: i, revenue: 0, clicks: 30, impressions: 1600 })),
    };
    const charts = recapCharts(m);
    expect(Object.keys(charts).sort()).toEqual(["chart_campaigns", "chart_compare", "chart_daily"]);
    for (const svg of Object.values(charts)) {
      const png = await chartPng(svg);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
  });
});
