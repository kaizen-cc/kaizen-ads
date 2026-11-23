import { describe, expect, it } from "vitest";
import { formatMetric, metricLabel, metricNumber } from "@/lib/reports/format";
import { adsMetricOptions, searchOptions } from "@/lib/reports/metric-options";
import { kpiMismatch, type Period, type ReportMetrics } from "@/lib/reports/metrics";
import { lastSentBlock } from "@/lib/reports/style-core";
import { weeklyValue } from "@/lib/reports/weekly-core";

// A report counts what the campaigns are after (a Subscribe campaign under a Purchases KPI), offers every metric Meta
// gives (reach, frequency, clicks all) and every event the account knows (even at none this week), and next week's draft
// follows the last one as it was sent.

const week = { start: "2026-11-16", end: "2026-11-22" };
const goals = new Map([["sub", ["subscribe_total", "subscribe_website", "offsite_conversion.fb_pixel_subscribe"]], ["lpv", ["landing_page_view"]]]);
const PURCHASES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

describe("a KPI no campaign goes after", () => {
  const rows = [{ date: "2026-11-18", campaign_id: "sub", actions: { link_click: 424, video_view: 30 } }];
  it("counts the campaigns' own goal when nothing running is after the KPI's event and none came in", () => {
    expect(kpiMismatch(goals, new Set(["sub"]), rows, week, PURCHASES)).toBe(true);
  });
  it("keeps the KPI when a running campaign is after it, or it was counted, or it isn't one event", () => {
    const withPurchase = new Map([...goals, ["buy", ["omni_purchase", "purchase"]]]);
    expect(kpiMismatch(withPurchase, new Set(["sub", "buy"]), rows, week, PURCHASES)).toBe(false);
    expect(kpiMismatch(goals, new Set(["sub"]), [...rows, { date: "2026-11-20", campaign_id: "sub", actions: { purchase: 1 } }], week, PURCHASES)).toBe(false);
    expect(kpiMismatch(goals, new Set(["sub"]), rows, week, [])).toBe(false);
    expect(kpiMismatch(goals, new Set(), rows, week, PURCHASES)).toBe(false);
  });
});

const per = (o: Partial<Period>): Period => ({ label: "P", start: week.start, end: week.end, days: 7, spend: 313.97, impressions: 8872, clicks: 424, ctr: 4.78, cpc: 0.74, cpm: 35.39, results: 0, costPerResult: null, revenue: 0, roas: null, actions: { link_click: 424 }, ...o });
const m = {
  conversion: "Website subscriptions",
  roasKpi: false,
  main: per({ reach: 5495, frequency: 1.61, clicksAll: 555 }),
  compare: per({ reach: 5000, frequency: 1.5, clicksAll: 500, spend: 300 }),
  knownEvents: ["subscribe_total", "link_click", "video_view"],
  eventLabels: { subscribe_total: "Subscriptions (all)", link_click: "Link clicks" },
} as unknown as ReportMetrics;

describe("everything Meta gives, as a metric", () => {
  it("reach, frequency and clicks (all), with CTR and CPC on them, as Ads Manager shows them", () => {
    expect(metricNumber(m.main, "reach")).toBe(5495);
    expect(formatMetric("frequency", metricNumber(m.main, "frequency"))).toBe("1.61");
    expect(weeklyValue("frequency", 1.61)).toBe("1.61");
    expect(metricNumber(m.main, "clicks_all")).toBe(555);
    expect(metricNumber(m.main, "ctr_all")).toBe(6.26);
    expect(metricNumber(m.main, "cpc_all")).toBe(0.57);
    expect(metricLabel(m, "ctr_all")).toBe("Click-through rate (all)");
  });
  it("offers them where the report read them, never in the scorecard's columns", () => {
    const tiles = adsMetricOptions(m, "meta", "tiles").map((o) => o.key);
    expect(tiles).toEqual(expect.arrayContaining(["reach", "frequency", "clicks_all", "ctr_all", "cpc_all"]));
    expect(adsMetricOptions(m, "meta", "columns").map((o) => o.key)).not.toContain("reach");
    const old = { ...m, main: per({}), compare: per({}) } as unknown as ReportMetrics;
    expect(adsMetricOptions(old, "meta", "tiles").map((o) => o.key)).not.toContain("reach");
  });
  it("offers what the campaigns are after even at none this week, found by its name in the account too", () => {
    const o = adsMetricOptions(m, "meta", "tiles");
    expect(o.find((x) => x.key === "n:subscribe_total")).toMatchObject({ label: "Subscriptions (all)", hint: "None this period" });
    expect(metricNumber(m.main, "n:subscribe_total")).toBe(0);
    expect(searchOptions(o, "SUBSCRIBE").map((x) => x.key)).toEqual(expect.arrayContaining(["n:subscribe_total", "c:subscribe_total"]));
  });
});

describe("next week's draft follows the last one as sent", () => {
  it("carries its message, its sections' shape, its charts and the buyer's asks, never as numbers to reuse", () => {
    const b = lastSentBlock({
      period_start: "2026-11-09",
      message: "<!here> Hi team! Quick recap…",
      sections: { headline: "Subscriptions up", did: ["Launched the new hook", "Cut the weak ad set"], doing: [], stories: [{ title: "Cost per subscription, 5 weeks" }] },
      chat: [
        { role: "user", text: "Remove the CPM tile and add reach" },
        { role: "assistant", text: "Done." },
        { role: "user", text: "Keep the message to 4 bullets" },
      ],
    });
    expect(b).toContain('<last_report_as_sent period_start="2026-11-09">');
    expect(b).toContain("Quick recap");
    expect(b).toContain("did: 2 points");
    expect(b).not.toContain("doing:");
    expect(b).toContain("Trend charts: Cost per subscription, 5 weeks");
    expect(b).toContain("- Remove the CPM tile and add reach\n- Keep the message to 4 bullets");
    expect(b).not.toContain("Done.");
    expect(b).toContain("Never reuse its numbers");
  });
  it("says nothing when there's no sent report", () => {
    expect(lastSentBlock(null)).toBe("");
    expect(lastSentBlock({ message: "", sections: null })).toBe("");
  });
});
