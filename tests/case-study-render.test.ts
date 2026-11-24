import { describe, expect, it } from "vitest";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { cleanCaseStudy, type CaseStudy } from "@/lib/documents/case-study-core";
import { CaseStudyDocument, barGeometry, chartPages, chartScale, fitSize, formatValue, linePath, linePoints } from "@/lib/documents/case-study";

// Mirrors the PDF servers: whole words, never hyphenated
Font.registerHyphenationCallback((word) => [word]);

// A 1x1 PNG stands in for both logos
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const render = (cs: CaseStudy, logos = false) => renderToBuffer(createElement(CaseStudyDocument, { input: { cs, brand: logos ? { logo: PNG, agencyLogo: PNG } : { logo: null, agencyLogo: null } } }) as Parameters<typeof renderToBuffer>[0]);

describe("formatValue", () => {
  it("formats dollars with separators, cents when small, and k/M when big", () => {
    expect(formatValue(1234, "$")).toBe("$1,234");
    expect(formatValue(4.25, "$")).toBe("$4.25");
    expect(formatValue(12, "$")).toBe("$12");
    expect(formatValue(12_340, "$")).toBe("$12.3k");
    expect(formatValue(120_000, "$")).toBe("$120k");
    expect(formatValue(1_460_000, "$")).toBe("$1.5M");
    expect(formatValue(999_999, "$")).toBe("$1M");
    expect(formatValue(-2500, "$")).toBe("-$2,500");
  });
  it("keeps one decimal on percents and multiples", () => {
    expect(formatValue(12.345, "%")).toBe("12.3%");
    expect(formatValue(4, "x")).toBe("4.0x");
    expect(formatValue(1234.56, "%")).toBe("1,234.6%");
  });
  it("formats plain numbers and drops what isn't a number", () => {
    expect(formatValue(842, "")).toBe("842");
    expect(formatValue(25_000, "")).toBe("25k");
    expect(formatValue(3.25, "")).toBe("3.3");
    expect(formatValue(Number.NaN, "$")).toBe("");
  });
});

describe("chartScale", () => {
  const pts = (...v: number[]) => v.map((value, i) => ({ label: `M${i}`, value }));
  it("rounds the top up to a nice number at or above the biggest value", () => {
    expect(chartScale(pts(3.1, 4.2)).max).toBe(5);
    expect(chartScale(pts(1200, 870)).max).toBe(1200);
    expect(chartScale(pts(1201)).max).toBe(1600);
    expect(chartScale(pts(2.3)).max).toBe(3);
    expect(chartScale(pts(42_000, 61_500)).max).toBe(80_000);
    expect(chartScale(pts(0.37)).max).toBe(0.4);
    expect(chartScale(pts(100)).max).toBe(100);
  });
  it("is never 0 and has a mid tick", () => {
    expect(chartScale(pts(0, 0)).max).toBe(1);
    expect(chartScale(pts(-5, -2)).max).toBe(1);
    expect(chartScale([]).max).toBe(1);
    expect(chartScale(pts(4.2)).ticks).toEqual([0, 2.5, 5]);
  });
});

describe("chart geometry", () => {
  const points = [
    { label: "Jun", value: 50 },
    { label: "Jul", value: 100 },
    { label: "Aug", value: -10 },
  ];
  it("draws bars from the baseline, centred in their slots, negatives flat", () => {
    const bars = barGeometry(points, { width: 300, height: 100, max: 100 });
    expect(bars[0]).toMatchObject({ y: 50, h: 50 });
    expect(bars[1]).toMatchObject({ y: 0, h: 100 });
    expect(bars[2].h).toBe(0);
    expect(bars[1].x + bars[1].w / 2).toBe(150);
  });
  it("puts line points on the same slot centres and joins them in a path", () => {
    const pts = linePoints(points, { width: 300, height: 100, max: 100 });
    expect(pts.map((q) => q.x)).toEqual([50, 150, 250]);
    expect(linePath(pts)).toBe("M50.00 50.00 L150.00 0.00 L250.00 100.00");
  });
  it("pages charts two at a time, the first page sharing with the results", () => {
    const c = (t: string) => ({ title: t, kind: "bar" as const, unit: "" as const, points: points.slice(0, 2), note: "" });
    expect(chartPages([c("a"), c("b"), c("c"), c("d")], 1).map((g) => g.map((x) => x.title))).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(chartPages([c("a"), c("b"), c("c")], 0).map((g) => g.length)).toEqual([2, 1]);
    expect(chartPages([], 1)).toEqual([]);
  });
  it("shrinks long numbers to fit", () => {
    expect(fitSize("4.2x", 160, 58)).toBe(58);
    expect(fitSize("$1,234,567", 160, 58)).toBeLessThan(58);
  });
});

describe("CaseStudyDocument", () => {
  const full = cleanCaseStudy(
    {
      client: "Crust Pizza",
      title: "Crust Pizza: 4.2x return on ad spend in 90 days",
      subtitle: "How a regional pizza chain turned paid social into its busiest ordering channel.",
      period: "Jun to Nov 2026",
      industry: "Restaurants",
      summary: "Crust Pizza runs 14 locations across the Southeast. In six months paid social went from a cost centre to the channel that drives the most online orders.",
      challenge: "Spend was spread across too many audiences, creative was stale and online orders had flattened for three quarters.",
      approach: ["Rebuilt the account around three proven audiences.", "Shipped fresh 4:5 and 9:16 creative every two weeks.", "Moved budget weekly to the locations with the best return."],
      results: [
        { value: "4.2x", label: "Return on ad spend", note: "Up from 1.6x in May" },
        { value: "+182%", label: "Online orders", note: "Month over month at peak" },
        { value: "$18.40", label: "Cost per order", note: "Down 41%" },
        { value: "$1.2M", label: "Attributed revenue", note: "" },
      ],
      charts: [
        {
          title: "Return on ad spend by month",
          kind: "line",
          unit: "x",
          points: [
            { label: "Jun", value: 1.6 },
            { label: "Jul", value: 2.1 },
            { label: "Aug", value: 2.9 },
            { label: "Sep", value: 3.4 },
            { label: "Oct", value: 3.9 },
            { label: "Nov", value: 4.2 },
          ],
          note: "Every month beat the one before.",
        },
        {
          title: "Revenue from ads",
          kind: "bar",
          unit: "$",
          points: [
            { label: "Jun", value: 84_000 },
            { label: "Jul", value: 121_000 },
            { label: "Aug", value: 166_500 },
            { label: "Sep", value: 204_000 },
          ],
          note: "",
        },
        {
          title: "Click-through rate",
          kind: "line",
          unit: "%",
          points: [
            { label: "Jun", value: 0.9 },
            { label: "Nov", value: 2.3 },
          ],
          note: "",
        },
        { title: "Orders per week", kind: "bar", unit: "", points: Array.from({ length: 12 }, (_, i) => ({ label: `W${i + 1}`, value: 400 + i * 85 })), note: "Twelve straight weeks of growth." },
      ],
      highlights: ["Best month in the brand's history in October.", "Creative refresh every two weeks kept frequency under control."],
      quote: { text: "Kaizen made paid social the channel we plan the month around.", by: "Owner, Crust Pizza" },
      accent: "#e11d2e",
    },
    { client: "Crust Pizza" },
  );

  it("renders a full case study to a PDF", async () => {
    expect(full.charts).toHaveLength(4);
    const pdf = await render(full, true);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders a minimal case study: one result, no charts, quote or logos", async () => {
    const min = cleanCaseStudy({ title: "A cleaner account", summary: "Short and sweet.", results: [{ value: "3x", label: "Return on ad spend" }] }, { client: null });
    expect(min.charts).toHaveLength(0);
    expect(min.quote).toBeNull();
    const pdf = await render(min);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders charts without results and a quote without highlights", async () => {
    const pdf = await render({ ...full, results: [], highlights: [], summary: "", challenge: "", approach: [], accent: "nonsense" });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
