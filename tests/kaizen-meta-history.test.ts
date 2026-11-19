import { describe, expect, it } from "vitest";
import { historyRange, historyResultType, monthChanges, monthRows } from "@/lib/kaizen-ai/meta-history";

describe("historyRange", () => {
  it("reads from the first of the month and stops at yesterday", () => {
    expect(historyRange("2026-04-15", "2026-10-31", "2026-11-19")).toEqual({ since: "2026-04-01", until: "2026-10-31" });
    expect(historyRange("2026-04-01", undefined, "2026-11-19")).toEqual({ since: "2026-04-01", until: "2026-11-18" });
    expect(historyRange("2026-04-01", "2026-12-31", "2026-11-19")).toEqual({ since: "2026-04-01", until: "2026-11-18" });
  });
  it("refuses bad dates, a backwards range and more than Meta keeps", () => {
    expect(historyRange("April", "2026-10-31", "2026-11-19")).toHaveProperty("error");
    expect(historyRange("2026-11-01", "2026-10-31", "2026-11-19")).toHaveProperty("error");
    expect(historyRange("2023-01-01", "2026-10-31", "2026-11-19")).toHaveProperty("error");
  });
});

const row = (month: string, spend: number, leads: number, extra: Record<string, unknown> = {}) => ({
  date_start: `${month}-01`,
  date_stop: `${month}-28`,
  spend: String(spend),
  impressions: "10000",
  inline_link_clicks: "100",
  reach: "4000",
  frequency: "2.5",
  actions: [{ action_type: "lead", value: String(leads) }],
  ...extra,
});

describe("monthRows", () => {
  it("one row per month, oldest first, with cost per result and rates", () => {
    const out = monthRows([row("2026-05", 1000, 20), row("2026-04", 500, 25)], "lead", false);
    expect(out.map((r) => r.month)).toEqual(["2026-04", "2026-05"]);
    expect(out[1]).toMatchObject({ spend: 1000, results: 20, cpr: 50, ctr: 1, cpm: 100, freq: 2.5, reach: 4000, roas: null, revenue: null });
  });
  it("names campaign rows by month and campaign", () => {
    const out = monthRows([row("2026-04", 100, 1, { campaign_name: "Leads" })], "lead", false);
    expect(out[0].name).toBe("2026-04 · Leads");
  });
  it("counts ROAS from the purchase value", () => {
    const out = monthRows([row("2026-04", 100, 0, { actions: [{ action_type: "purchase", value: "2" }], action_values: [{ action_type: "purchase", value: "300" }] })], "purchase", true);
    expect(out[0]).toMatchObject({ results: 2, revenue: 300, roas: 3 });
  });
});

describe("historyResultType", () => {
  it("prefers the KPI's conversion and falls back to what the account reports", () => {
    const rows = [row("2026-04", 100, 3)];
    expect(historyResultType(rows, ["purchase"])).toBe("lead");
    expect(historyResultType(rows, ["lead"])).toBe("lead");
    expect(historyResultType([{ actions: [] }], [])).toBeNull();
  });
});

describe("monthChanges", () => {
  it("gives the percent change from the month before", () => {
    const out = monthChanges(monthRows([row("2026-04", 500, 25), row("2026-05", 1000, 20)], "lead", false));
    expect(out).toEqual([expect.objectContaining({ month: "2026-05", spend_pct: 100, results_pct: -20, cpr_pct: 150 })]);
  });
});
