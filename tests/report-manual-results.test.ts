import { describe, expect, it } from "vitest";
import { applyManual, cleanLines, manualCaption, manualText, platformConversion, withoutManual, type ManualLine } from "@/lib/reports/manual";
import { conversionTiles, manualTiles } from "@/lib/reports/format";
import { metricsText, type Period, type ReportMetrics } from "@/lib/reports/metrics";

const period = (o: Partial<Period>): Period => ({ label: "Oct", start: "2026-10-01", end: "2026-10-31", days: 31, spend: 1000, impressions: 50000, clicks: 900, ctr: 1.8, cpc: 1.11, cpm: 20, results: 10, costPerResult: 100, revenue: 0, roas: null, ...o });
const metrics = (): ReportMetrics => ({
  platform: "meta",
  kind: "monthly",
  conversion: "Leads",
  roasKpi: false,
  target: null,
  monthlyBudget: null,
  main: period({}),
  compare: period({ label: "Sep", spend: 800, results: 8, costPerResult: 100 }),
  mtd: null,
  mtdCompare: null,
  campaigns: [{ name: "Prospecting", spend: 1000, results: 10, costPerResult: 100, roas: null, ctr: 1.8 }],
  topAds: [],
  dataThrough: "2026-10-31",
  gaps: [],
});
const line = (o: Partial<ManualLine>): ManualLine => ({ id: "a", label: "Bookings", count: 2, revenue: null, priorCount: null, priorRevenue: null, source: "CRM (GoHighLevel)", note: null, main: false, ...o });
const who = { by: "u1", byName: "Sam", at: "2026-11-12T10:00:00Z" };

describe("cleanLines", () => {
  it("keeps numbers, defaults the source, drops empty lines and allows one main result", () => {
    const out = cleanLines([
      { label: " Bookings ", count: "2", revenue: "$1,500", source: "", main: true },
      { label: "Sales", count: 2, main: true },
      { label: "", count: 3 },
      { label: "Calls", count: "" },
      { label: "Leads", count: -1 },
    ]);
    expect(out.map((l) => l.label)).toEqual(["Bookings", "Sales"]);
    expect(out[0]).toMatchObject({ count: 2, revenue: 1500, source: "CRM (GoHighLevel)", main: true, priorCount: null });
    expect(out[1].main).toBe(false);
  });
});

describe("applyManual", () => {
  it("adds lines alongside without touching the platform's numbers", () => {
    const m = applyManual(metrics(), { lines: [line({}), line({ id: "b", label: "Sales", count: 1, revenue: 3000 })], ...who });
    expect(m.conversion).toBe("Leads");
    expect(m.main.results).toBe(10);
    expect(m.manual?.lines).toHaveLength(2);
    expect(m.manual?.base).toBeUndefined();
    expect(manualTiles(m).map((t) => t.label)).toEqual(["Bookings", "Sales"]);
  });

  it("as the main result: cost per result is spend over the count, ROAS uses the manual revenue", () => {
    const m = applyManual(metrics(), { lines: [line({ count: 4, revenue: 6000, main: true })], ...who });
    expect(m.conversion).toBe("Bookings");
    expect(m.main.results).toBe(4);
    expect(m.main.costPerResult).toBe(250);
    expect(m.main.revenue).toBe(6000);
    expect(m.main.roas).toBe(6);
    expect(platformConversion(m)).toBe("Leads");
    // The campaigns keep the platform's counts, named for what they counted
    expect(m.campaigns[0].results).toBe(10);
    expect(m.campaigns[0].result).toBe("Leads");
    // The main line is the headline, not a second tile
    expect(manualTiles(m)).toHaveLength(0);
  });

  it("shows no comparison for a main result without a prior number (never a made-up change)", () => {
    const m = applyManual(metrics(), { lines: [line({ main: true })], ...who });
    const tile = conversionTiles(m)[0];
    expect(tile.delta).toBeNull();
    expect(tile.before).toBeNull();
    expect(conversionTiles(m)[1].delta).toBeNull();
  });

  it("compares with the prior numbers when entered", () => {
    const m = applyManual(metrics(), { lines: [line({ count: 4, priorCount: 2, priorRevenue: 1000, revenue: 2000, main: true })], ...who });
    expect(m.compare.results).toBe(2);
    expect(m.compare.costPerResult).toBe(400);
    expect(conversionTiles(m)[0].delta).toEqual({ text: "+100%", tone: "good" });
    const alongside = applyManual(metrics(), { lines: [line({ count: 3, priorCount: 2 }), line({ id: "b", label: "Sales", count: 1 })], ...who });
    const [a, b] = manualTiles(alongside);
    expect(a.delta?.text).toBe("+50%");
    expect(b.delta).toBeNull();
  });

  it("is safe to apply again, and removing the lines restores the platform's numbers", () => {
    const base = metrics();
    const once = applyManual(base, { lines: [line({ count: 4, main: true })], ...who });
    const twice = applyManual(once, { lines: [line({ count: 5, main: true })], ...who });
    expect(twice.main.results).toBe(5);
    expect(twice.main.costPerResult).toBe(200);
    expect(twice.manual?.base?.main.results).toBe(10);
    const gone = applyManual(twice, { lines: [], ...who });
    expect(gone.manual).toBeUndefined();
    expect(gone.conversion).toBe("Leads");
    expect(gone.main).toEqual(base.main);
    expect(gone.compare).toEqual(base.compare);
    expect(gone.campaigns[0].result ?? null).toBeNull();
    expect(withoutManual(once).main.results).toBe(10);
  });

  it("drops the platform's month-to-date and weekly chart when a manual result is the headline", () => {
    const base = { ...metrics(), mtd: period({ label: "MTD" }), mtdCompare: period({ label: "MTD before" }), weeks: [{ label: "w", start: "a", end: "b", spend: 1, results: 1, costPerResult: 1, revenue: 0, roas: null, clicks: 1, impressions: 1 }] };
    const m = applyManual(base, { lines: [line({ main: true })], ...who });
    expect(m.mtd).toBeNull();
    expect(m.weeks).toBeUndefined();
    expect(applyManual(m, null).weeks).toHaveLength(1);
    expect(applyManual(m, null).mtd?.label).toBe("MTD");
  });
});

describe("what the writer is told", () => {
  it("says the counts came from the client's CRM, entered by the team, and never per campaign", () => {
    const m = applyManual(metrics(), { lines: [line({ count: 2, revenue: 4000, note: "Both from Oct ads", main: true })], ...who });
    const text = metricsText(m);
    expect(text).toContain("results_from_the_clients_crm");
    expect(text).toContain("entered by the team (Sam)");
    expect(text).toContain("THIS IS THE MAIN RESULT");
    expect(text).toContain("$500.00 of ad spend per bookings");
    expect(text).toContain("no prior-period number");
    expect(text).toContain("not from the ad platform");
    expect(manualText(m)).toContain("Account level only");
  });

  it("says nothing when there are no manual results", () => {
    expect(manualText(metrics())).toBe("");
    expect(metricsText(metrics())).not.toContain("results_from_the_clients_crm");
  });

  it("captions the report with where the numbers came from", () => {
    const m = applyManual(metrics(), { lines: [line({}), line({ id: "b", label: "Sales", source: "Their spreadsheet" })], ...who });
    const cap = manualCaption(m.manual);
    expect(cap).toContain("Bookings, Sales");
    expect(cap).toContain("CRM (GoHighLevel) and Their spreadsheet");
    expect(cap).toContain("entered by the team");
    expect(manualCaption(undefined)).toBeNull();
  });
});
