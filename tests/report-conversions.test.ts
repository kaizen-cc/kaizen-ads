import { describe, expect, it } from "vitest";
import { toDays } from "@/lib/kpi/calc";
import { conversionFor, foldConversions, goalOf, MAIN_RESULTS } from "@/lib/kpi/conversions";
import { hasRevenue, kpiRows, columnKeys, tableKeys, tileKeys } from "@/lib/reports/format";
import { period, pluralOf, revenueType, type ReportMetrics } from "@/lib/reports/metrics";

// A boudoir studio's week (Nov 2 to 8, 2026): its campaigns run for Meta's Schedule event, which Meta reports only in
// the insights' `conversions` field (schedule_total, schedule_website), never in `actions`. One campaign also tracked
// a registration with a $150 value, and two tracked a purchase (one purchase, reported under all its aliases).

describe("standard events from Meta's conversions field", () => {
  it("folds conversions into actions, keeping actions as they are and never counting a type twice", () => {
    const row = {
      date_start: "2026-11-03",
      actions: [
        { action_type: "link_click", value: "40" },
        { action_type: "lead", value: "2" },
      ],
      action_values: [{ action_type: "omni_purchase", value: "1050" }],
      conversions: [
        { action_type: "schedule_total", value: "3" },
        { action_type: "schedule_website", value: "3" },
        { action_type: "lead", value: "99" },
      ],
      conversion_values: [{ action_type: "schedule_total", value: "0" }],
    };
    const out = foldConversions(row) as Record<string, unknown>;
    expect(out.conversions).toBeUndefined();
    expect(out.conversion_values).toBeUndefined();
    expect(out.actions).toEqual([
      { action_type: "link_click", value: "40" },
      { action_type: "lead", value: "2" },
      { action_type: "schedule_total", value: "3" },
      { action_type: "schedule_website", value: "3" },
    ]);
    expect(out.action_values).toEqual([
      { action_type: "omni_purchase", value: "1050" },
      { action_type: "schedule_total", value: "0" },
    ]);
  });

  it("leaves a row without conversions as it was", () => {
    const row = { date_start: "2026-11-03", actions: [{ action_type: "lead", value: "1" }] };
    expect(foldConversions(row)).toEqual(row);
  });

  it("names each event as Ads Manager does and counts its _total / _website types", () => {
    expect(goalOf("OFFSITE_CONVERSIONS", "SCHEDULE", null)).toEqual({ label: "Website schedules", actions: ["schedule_total", "schedule_website", "offsite_conversion.fb_pixel_schedule", "onsite_web_schedule"] });
    for (const [event, type] of [
      ["CONTACT", "contact_total"],
      ["SUBMIT_APPLICATION", "submit_application_total"],
      ["START_TRIAL", "start_trial_total"],
      ["SUBSCRIBE", "subscribe_total"],
      ["FIND_LOCATION", "find_location_total"],
      ["CUSTOMIZE_PRODUCT", "customize_product_total"],
      ["DONATE", "donate_total"],
    ]) {
      const g = goalOf("OFFSITE_CONVERSIONS", event, null);
      expect(g?.actions[0]).toBe(type);
      expect(g?.label.startsWith("Website ")).toBe(true);
    }
    expect(goalOf("OFFSITE_CONVERSIONS", "COMPLETE_REGISTRATION", null)?.actions).toContain("complete_registration");
    expect(goalOf("OFFSITE_CONVERSIONS", "LEAD", null)?.actions).toEqual(["offsite_conversion.fb_pixel_lead", "lead", "onsite_web_lead"]);
    expect(goalOf("LEAD_GENERATION", null, null)?.label).toBe("Instant form leads");
    // A standard event added later still counts by its usual names
    expect(goalOf("OFFSITE_CONVERSIONS", "ADD_TO_WISHLIST", null)?.actions).toContain("add_to_wishlist");
    expect(MAIN_RESULTS).toContain("contact_website");
  });

  it("the report says bookings for schedule campaigns", () => {
    expect(pluralOf("Website schedules")).toBe("Bookings");
    expect(pluralOf("Website applications submitted")).toBe("Applications");
    expect(pluralOf("Website registrations completed")).toBe("Registrations");
    expect(pluralOf("Website adds to cart")).toBe("Website adds to cart");
  });
});

// The week as stored once conversions are read: schedule campaigns report their schedules, one campaign a registration
// worth $150, and two a purchase under omni_purchase, purchase and the pixel's name at once
type Row = { date: string; campaign_id: string; campaign_name: string; spend: number; impressions: number; actions: Record<string, number>; action_values: Record<string, number> };
const rows: Row[] = [
  { date: "2026-11-03", campaign_id: "fab40", campaign_name: "Website Schedule | Fab Over 40", spend: 228.98, impressions: 6000, actions: { schedule_total: 2, schedule_website: 2, complete_registration: 6 }, action_values: {} },
  { date: "2026-11-04", campaign_id: "june2", campaign_name: "Wedding | Website Schedule | June 2", spend: 225.01, impressions: 5000, actions: { schedule_total: 1, schedule_website: 1, lead: 3, omni_purchase: 1, purchase: 1, "offsite_conversion.fb_pixel_purchase": 1 }, action_values: { omni_purchase: 6500, purchase: 6500, "offsite_conversion.fb_pixel_purchase": 6500, web_app_in_store_purchase: 0.65 } },
  { date: "2026-11-05", campaign_id: "bf", campaign_name: "Website Schedule | Black Friday", spend: 337.2, impressions: 9000, actions: { omni_purchase: 1, purchase: 1 }, action_values: { omni_purchase: 1050, purchase: 1050 } },
  { date: "2026-11-05", campaign_id: "july21", campaign_name: "Submit Form | Giveaway | July 21", spend: 22.97, impressions: 1000, actions: { submit_application_total: 4, complete_registration: 7 }, action_values: { complete_registration: 150, "offsite_conversion.fb_pixel_complete_registration": 150 } },
];
const goals = new Map([
  ["fab40", goalOf("OFFSITE_CONVERSIONS", "SCHEDULE", null)!.actions],
  ["june2", goalOf("OFFSITE_CONVERSIONS", "SCHEDULE", null)!.actions],
  ["bf", goalOf("OFFSITE_CONVERSIONS", "SCHEDULE", null)!.actions],
  ["july21", goalOf("OFFSITE_CONVERSIONS", "SUBMIT_APPLICATION", null)!.actions],
]);
const week = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – Nov 8" };

describe("a campaign_goal report", () => {
  const days = toDays(rows, null, null, goals);
  const valueType = revenueType(days, "meta");
  const p = period(rows, days, week, conversionFor("campaign_goal"), "campaign_goal", valueType);

  it("counts each campaign's own event: schedules for schedule campaigns, applications for the application one", () => {
    // 2 + 1 + 0 schedules, 4 applications; never the registrations or leads those campaigns also tracked
    expect(p.results).toBe(7);
    expect(p.costPerResult).toBe(Math.round((p.spend / 7) * 100) / 100);
  });

  it("revenue is purchase value only, one purchase type, never a registration's value", () => {
    expect(valueType).toBe("omni_purchase");
    expect(p.revenue).toBe(7550); // $6,500 + $1,050, not + $150 of registrations, not the aliases again
    expect(p.roas).toBe(Math.round((7550 / p.spend) * 100) / 100);
  });

  it("no purchase tracked: no revenue, no ROAS", () => {
    const noBuy = rows.filter((r) => r.campaign_id === "fab40" || r.campaign_id === "july21");
    const d = toDays(noBuy, null, null, goals);
    const q = period(noBuy, d, week, conversionFor("campaign_goal"), "campaign_goal", revenueType(d, "meta"));
    expect(q.revenue).toBe(0);
    expect(q.roas).toBeNull();
  });

  it("Google keeps its conversion value", () => {
    expect(revenueType([{ values: { conversions: 10 } }], "google")).toBe("conversions");
  });
});

const metrics = (roasKpi: boolean): ReportMetrics => {
  const main = { label: "Nov 2 – Nov 8", start: "2026-11-02", end: "2026-11-08", days: 7, spend: 1218.28, impressions: 33151, clicks: 548, ctr: 1.65, cpc: 2.22, cpm: 36.75, results: 7, costPerResult: 174.04, revenue: 7550, roas: 6.2 };
  return { platform: "meta", kind: "weekly", conversion: "Bookings", roasKpi, target: 95, monthlyBudget: null, main, compare: { ...main, label: "Oct 26 – Nov 1" }, mtd: null, mtdCompare: null, campaigns: [{ name: "June 2", spend: 225, results: 1, costPerResult: 225, roas: 28.9, ctr: 1 }], topAds: [], dataThrough: "2026-11-08", gaps: [] };
};

describe("ROAS on a report judged on something else", () => {
  it("stays out of the default tiles, rows and columns of a bookings report", () => {
    const m = metrics(false);
    expect(hasRevenue(m)).toBe(false);
    expect(tileKeys(m, null, false)).not.toContain("roas");
    expect(tileKeys(m, null, true)).not.toContain("roas");
    expect(tableKeys(m, null)).not.toContain("roas");
    expect(columnKeys(m, null)).not.toContain("roas");
    expect(kpiRows(m).map((r) => r.label)).not.toContain("ROAS");
  });

  it("shows when the buyer puts it in the report", () => {
    const m = metrics(false);
    expect(tileKeys(m, { tiles: ["spend", "results", "roas"] }, false)).toContain("roas");
    expect(tableKeys(m, { table: ["spend", "roas"] })).toContain("roas");
    expect(columnKeys(m, { columns: ["spend", "roas"] })).toContain("roas");
  });

  it("shows by default when ROAS is the KPI", () => {
    const m = metrics(true);
    expect(hasRevenue(m)).toBe(true);
    expect(tileKeys(m, null, false)).toContain("roas");
    expect(tableKeys(m, null)).toContain("roas");
    expect(columnKeys(m, null)).toContain("roas");
    expect(kpiRows(m).map((r) => r.label)).toContain("ROAS");
  });
});
