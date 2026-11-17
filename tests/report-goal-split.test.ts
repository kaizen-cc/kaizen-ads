import { describe, expect, it } from "vitest";
import { goalCostLabel, goalLines, goalLinesText, goalName, goalParts, googleGoals, metaGoal, type GoalOf } from "@/lib/reports/goal-split";
import { leaveOutCampaigns } from "@/lib/reports/campaign-scope";
import type { Period, ReportMetrics } from "@/lib/reports/metrics";

// A Meta account in November 2026 with a purchase campaign, an Instant Form lead campaign and an engagement campaign,
// and a Google account whose search campaign gets form leads and whose call campaign gets calls.

const main = { start: "2026-11-09", end: "2026-11-15" };
const compare = { start: "2026-11-02", end: "2026-11-08" };
const row = (date: string, id: string, spend: number, actions: Record<string, number>, values: Record<string, number> = {}) => ({ date, campaign_id: id, campaign_name: `Campaign ${id}`, spend, actions, action_values: values });

const metaRows = [
  row("2026-11-10", "p", 300, { omni_purchase: 6, purchase: 6, lead: 1 }, { omni_purchase: 900, purchase: 900 }),
  row("2026-11-11", "p", 200, { omni_purchase: 4, purchase: 4 }, { omni_purchase: 600, purchase: 600 }),
  row("2026-11-10", "l", 150, { "onsite_conversion.lead_grouped": 10, lead: 10 }),
  row("2026-11-12", "l", 150, { "onsite_conversion.lead_grouped": 5, lead: 5 }),
  row("2026-11-10", "e", 100, { post_engagement: 400 }),
  row("2026-11-04", "p", 400, { omni_purchase: 5 }, { omni_purchase: 700 }),
  row("2026-11-05", "l", 200, { "onsite_conversion.lead_grouped": 10 }),
];
const metaGoals = new Map<string, GoalOf>(
  (
    [
      ["p", metaGoal(["omni_purchase", "purchase"], "Website purchases")],
      ["l", metaGoal(["onsite_conversion.lead_grouped", "leadgen_grouped", "lead"], "Instant form leads")],
      ["e", metaGoal(["post_engagement"], "Engagement")],
    ] as [string, GoalOf | null][]
  ).filter((x): x is [string, GoalOf] => x[1] != null),
);
const period = (spend: number): Period => ({ label: "Nov 9 – Nov 15", start: main.start, end: main.end, days: 7, spend, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null, results: 0, costPerResult: null, revenue: 0, roas: null });

describe("results by goal", () => {
  it("names goals as the thing counted, Google's conversion actions too", () => {
    expect(goalName("Website purchases")).toBe("Purchases");
    expect(goalName("Instant form leads")).toBe("Leads");
    expect(goalName("Calls from ads")).toBe("Calls");
    expect(goalName("Contact form submit")).toBe("Leads");
    expect(goalName("Website schedules")).toBe("Bookings");
    expect(goalCostLabel("Purchases")).toBe("CPA");
    expect(goalCostLabel("Leads")).toBe("CPL");
    expect(goalCostLabel("Bookings")).toBe("Cost per booking");
  });

  it("leaves reach and engagement goals out (they stay in the campaign table)", () => {
    expect(metaGoal(["post_engagement"], "Engagement")).toBeNull();
    expect(metaGoal(["link_click"], "Link clicks")).toBeNull();
    expect(metaGoal(["omni_purchase"], "")).toBeNull();
    expect(metaGoal(["omni_purchase"], "Website purchases")?.label).toBe("Purchases");
  });

  it("splits purchases and leads with their own cost, spend share, comparison and revenue", () => {
    const parts = goalParts(metaRows, metaGoals, { main, compare });
    const lines = goalLines({ main: period(900), goalParts: parts });
    expect(lines.map((l) => l.label)).toEqual(["Purchases", "Leads"]);
    const [buy, lead] = lines;
    // A purchase reported under its aliases counts once; the purchase campaign's stray lead isn't a lead result
    expect(buy).toMatchObject({ results: 10, spend: 500, costPerResult: 50, revenue: 1500, roas: 3, share: 55.6, value: true, campaigns: 1 });
    expect(buy.before).toMatchObject({ results: 5, spend: 400, costPerResult: 80 });
    expect(lead).toMatchObject({ results: 15, spend: 300, costPerResult: 20, share: 33.3, value: false });
    expect(lead.before).toMatchObject({ results: 10, spend: 200, costPerResult: 20 });
    expect(lead.mtd).toBeUndefined();
  });

  it("shows nothing with one goal, or with none (an older report)", () => {
    const one = goalParts(metaRows.filter((r) => r.campaign_id !== "l"), metaGoals, { main, compare });
    expect(goalLines({ main: period(900), goalParts: one })).toEqual([]);
    expect(goalLines({ main: period(900) })).toEqual([]);
    expect(goalLinesText({ main: period(900), compare: period(0), mtd: null })).toEqual([]);
  });

  it("needs two goals that spent in the period, not one that only ran before", () => {
    const rows = metaRows.filter((r) => !(r.campaign_id === "l" && r.date >= main.start));
    expect(goalLines({ main: period(600), goalParts: goalParts(rows, metaGoals, { main, compare }) })).toEqual([]);
  });

  it("keeps the month so far on a weekly", () => {
    const parts = goalParts(metaRows, metaGoals, { main, compare, mtd: { start: "2026-11-01", end: main.end }, mtdCompare: { start: "2026-10-01", end: "2026-10-15" } });
    const lines = goalLines({ main: period(900), goalParts: parts });
    expect(lines[0].mtd).toMatchObject({ results: 15, spend: 900 });
    expect(lines[1].mtd).toMatchObject({ results: 25, spend: 500 });
  });

  it("reads each Google campaign's goal from its conversion actions", () => {
    const rows = [
      row("2026-11-10", "s", 400, { conversions: 22, "action:Contact form submit": 18, "action:Calls from ads": 4 }, { conversions: 22 }),
      row("2026-11-10", "c", 250, { conversions: 12, "action:Calls from ads": 11, "action:Page view": 30, "action:Contact form submit": 1 }),
      row("2026-11-03", "s", 380, { conversions: 15, "action:Contact form submit": 15 }),
      row("2026-11-03", "c", 240, { conversions: 9, "action:Calls from ads": 9 }),
    ];
    const goals = googleGoals(rows, main);
    expect(goals.get("s")?.label).toBe("Leads");
    expect(goals.get("c")?.label).toBe("Calls");
    const lines = goalLines({ main: period(650), goalParts: goalParts(rows, goals, { main, compare }) });
    expect(lines.map((l) => [l.label, l.results, l.costPerResult, l.before.results])).toEqual([
      ["Leads", 18, 22.22, 15],
      ["Calls", 11, 22.73, 9],
    ]);
  });

  it("tells the writer about each goal on its own", () => {
    const text = goalLinesText({ main: period(900), compare: { ...period(600), label: "Nov 2 – Nov 8" }, mtd: null, goalParts: goalParts(metaRows, metaGoals, { main, compare }) });
    expect(text[0]).toContain("never add them together");
    expect(text[1]).toContain("Purchases (1 campaign, 55.6% of spend)");
    expect(text[1]).toContain("revenue $1,500.00, ROAS 3");
    expect(text[2]).toContain("Leads");
    expect(text[2]).not.toContain("ROAS");
    expect(text.join("\n")).not.toMatch(/\u2014/);
  });

  it("drops a campaign's part when it's left out of the report", () => {
    const parts = goalParts(metaRows, metaGoals, { main, compare });
    const m = { platform: "meta", kind: "weekly", conversion: "Purchases", roasKpi: false, target: null, monthlyBudget: null, main: period(900), compare: { ...period(600), start: compare.start, end: compare.end }, mtd: null, mtdCompare: null, campaigns: [], topAds: [], dataThrough: null, gaps: [], goalParts: parts } as unknown as ReportMetrics;
    expect(goalLines(m)).toHaveLength(2);
    expect(goalLines(leaveOutCampaigns(m, ["Campaign l"]))).toEqual([]);
    expect(goalLines(leaveOutCampaigns(m, ["e"]))).toHaveLength(2);
  });
});
