import { describe, expect, it } from "vitest";
import { VALUE_NOT_TRACKED, actionBreakdown, conversionValue, valueLine, valueLooksReal } from "@/lib/kpi/conversion-value";
import { aggregate, toDays } from "@/lib/kpi/calc";
import { conversionFor } from "@/lib/kpi/conversions";

describe("Google conversion value", () => {
  it("reads real order value as revenue and ROAS", () => {
    const v = conversionValue({ spend: 12823, conversions: 66, value: 17706 });
    expect(v.tracked).toBe(true);
    expect(v.revenue).toBe(17706);
    expect(v.roas).toBe(1.38);
  });
  it("refuses a default value of 1 per conversion", () => {
    const v = conversionValue({ spend: 5000, conversions: 6331, value: 6331 });
    expect(v).toMatchObject({ tracked: false, revenue: null, roas: null, note: VALUE_NOT_TRACKED });
  });
  it("refuses a token value on a lead account", () => {
    expect(conversionValue({ spend: 900, conversions: 617, value: 27 }).roas).toBeNull();
  });
  it("has no value without conversions or without value", () => {
    expect(conversionValue({ spend: 100, conversions: 0, value: 0 }).tracked).toBe(false);
    expect(valueLooksReal(10, 0)).toBe(false);
    expect(valueLooksReal(10, 20)).toBe(true);
    expect(valueLooksReal(10, 19.9)).toBe(false);
  });
  it("has revenue but no ROAS when nothing was spent", () => {
    const v = conversionValue({ spend: 0, conversions: 3, value: 300 });
    expect(v.tracked).toBe(true);
    expect(v.roas).toBeNull();
  });
  it("splits value by conversion action", () => {
    const list = actionBreakdown([
      { actions: { conversions: 5, "action:Purchase": 3, "action:Lead": 2 }, action_values: { conversions: 300, "action:Purchase": 300, "action:Lead": 2 } },
      { actions: { "action:Purchase": 1 }, action_values: { "action:Purchase": 100 } },
    ]);
    expect(list[0]).toMatchObject({ action: "Purchase", conversions: 4, value: 400, valuePerConversion: 100, carriesValue: true });
    expect(list[1]).toMatchObject({ action: "Lead", carriesValue: false });
  });
  it("says nothing for a window read before value was stored", () => {
    expect(valueLine("last 7 days", { spend: 10, results: 2 })).toBeNull();
    expect(valueLine("last 7 days", { spend: 100, results: 2, revenue: 400 })).toContain("4.00x ROAS");
  });
  it("carries revenue through the KPI windows for Google, and leaves Meta alone", () => {
    const rows = [{ date: "2026-11-01", campaign_id: "1", spend: 100, actions: { conversions: 5 }, action_values: { conversions: 500 } }];
    const days = toDays(rows, null, null, undefined, "google");
    expect(aggregate(days, conversionFor("conversions"), "conversions")).toMatchObject({ spend: 100, results: 5, value: 20, revenue: 500 });
    expect(aggregate(days, conversionFor("google_roas"), "conversions").value).toBe(5);
    expect(aggregate(days, conversionFor("purchases"), "purchase")).not.toHaveProperty("revenue");
  });
});
