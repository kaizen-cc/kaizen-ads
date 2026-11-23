import { describe, expect, it } from "vitest";
import { emptyStats, klaviyoCostMs, parseSeriesReport, rollupDays, type SeriesRow } from "@/lib/klaviyo/core";
import { autoRank } from "@/lib/klaviyo/sources";

// E11EVEN Miami's email report said $1,215 for Nov 16–22 where Klaviyo said $1,302: each campaign's whole 90 days of
// revenue was put on its send day, while Klaviyo totals a date range by the day each order came in. And its second
// order system (the Speakeasy integration's Placed Order, $10,661 credited to email in 30 days) was found but never read.

const stats = (revenue: number, conversions = 1, recipients = 0) => ({ ...emptyStats(), revenue, conversions, recipients });

describe("campaign revenue on the day it came in", () => {
  const campaigns = [
    { sendTime: "2026-11-12T15:00:00Z", stats: stats(500, 5, 1000), channel: "email" }, // sent the week before, still earning
    { sendTime: "2026-11-18T15:00:00Z", stats: stats(900, 9, 2000), channel: "email" },
  ];
  const series: SeriesRow[] = [
    { id: "old", days: [{ date: "2026-11-12", stats: stats(300, 3) }, { date: "2026-11-17", stats: stats(200, 2) }] },
    { id: "new", days: [{ date: "2026-11-18", stats: stats(700, 7) }, { date: "2026-11-24", stats: stats(200, 2) }] },
  ];
  const week = (rows: ReturnType<typeof rollupDays>) => rows.filter((d) => d.date >= "2026-11-16" && d.date <= "2026-11-22");
  const sum = (rows: ReturnType<typeof rollupDays>, k: "campaignRevenue" | "campaignRecipients" | "campaignsSent" | "conversions") => rows.reduce((t, d) => t + d[k], 0);

  it("counts what came in during the week, from older campaigns too, and not what comes in after it", () => {
    const byDay = week(rollupDays({ campaigns, flows: [], campaignSeries: series, tz: "America/New_York", from: "2026-11-10", to: "2026-11-25" }));
    expect(sum(byDay, "campaignRevenue")).toBe(900); // 200 (older campaign) + 700
    expect(sum(byDay, "conversions")).toBe(9);
  });

  it("still counts recipients and campaigns sent on the send day", () => {
    const byDay = week(rollupDays({ campaigns, flows: [], campaignSeries: series, tz: "America/New_York", from: "2026-11-10", to: "2026-11-25" }));
    expect(sum(byDay, "campaignRecipients")).toBe(2000);
    expect(sum(byDay, "campaignsSent")).toBe(1);
  });

  it("without the series (an older read, or refused), the send day as before", () => {
    const byDay = week(rollupDays({ campaigns, flows: [], tz: "America/New_York", from: "2026-11-10", to: "2026-11-25" }));
    expect(sum(byDay, "campaignRevenue")).toBe(900);
    expect(sum(rollupDays({ campaigns, flows: [], tz: "America/New_York", from: "2026-11-10", to: "2026-11-11" }), "campaignRevenue")).toBe(0);
  });

  it("reads a campaign-series answer by campaign", () => {
    const json = { data: { attributes: { date_times: ["2026-11-17T00:00:00+00:00", "2026-11-18T00:00:00+00:00"], results: [{ groupings: { campaign_id: "c1", send_channel: "sms" }, statistics: { conversions: [1, 2], conversion_value: [10, 20], recipients: [0, 0] } }] } } };
    const rows = parseSeriesReport(json, "campaign_id");
    expect(rows[0].id).toBe("c1");
    expect(rows[0].days.map((d) => [d.date, d.stats.revenue, d.sms])).toEqual([["2026-11-17", 10, 10], ["2026-11-18", 20, 20]]);
  });

  it("budgets the read for the extra series", () => {
    expect(klaviyoCostMs("full")).toBe(210_000);
    expect(klaviyoCostMs("recent", 1)).toBeGreaterThan(klaviyoCostMs("recent"));
  });
});

describe("every order system email earns through is read, the biggest first", () => {
  const shopify = { id: "TiNzwR", name: "Placed Order", integration: "Shopify" };
  const speakeasy = { id: "TvLwnd", name: "Placed Order", integration: "Speakeasy", revenue: 10661.48, orders: 632 };

  it("a second order system joins the ranking under a bigger primary, as a revenue source", () => {
    const next = autoRank([shopify], [speakeasy], 16422.53);
    expect(next?.map((m) => [m.id, m.integration])).toEqual([["TiNzwR", "Shopify"], ["TvLwnd", "Speakeasy"]]);
    expect(next?.[1].revenueSource).toBe(true);
  });

  it("the one with the most attributed revenue becomes the primary, the old one kept as a source", () => {
    const next = autoRank([shopify], [{ ...speakeasy, revenue: 20000 }], 16422.53);
    expect(next?.map((m) => m.id)).toEqual(["TvLwnd", "TiNzwR"]);
    expect(next?.[1].revenueSource).toBe(true);
  });

  it("nothing changes without a new source that earned something", () => {
    expect(autoRank([shopify], [], 100)).toBeNull();
    expect(autoRank([shopify], [{ ...speakeasy, revenue: 0, orders: 0 }], 100)).toBeNull();
    expect(autoRank([shopify, { id: "TvLwnd", name: "Placed Order", integration: "Speakeasy" }], [speakeasy], 100)).toBeNull();
  });
});

describe("two order systems with the same name", () => {
  it("are told apart by their integration in the report", async () => {
    const { revenueSources } = await import("@/lib/channel-reports/email-sources");
    const pair = (now: number, before = 0) => ({ now, before });
    const out = revenueSources({
      metrics: [
        { id: "TvLwnd", name: "Placed Order", integration: "Speakeasy", revenueSource: true },
        { id: "TiNzwR", name: "Placed Order", integration: "Shopify", revenueSource: true },
      ],
      sides: [
        { id: "TvLwnd", name: "Placed Order", revenue: pair(2000, 1500), conversions: pair(120, 90), store: pair(9000, 8000) },
        { id: "TiNzwR", name: "Placed Order", revenue: pair(1302, 1100), conversions: pair(12, 10), store: pair(6000, 5000) },
      ],
    });
    expect(out?.sources.map((s) => [s.name, s.primary])).toEqual([["Placed Order (Speakeasy)", true], ["Placed Order (Shopify)", false]]);
  });
});

describe("Crust Pizza Co.: Toast and a POS's API add up; Toast's two metrics don't", () => {
  const toastPlaced = { id: "SMvxJW", name: "Placed Order", integration: null };
  const found = [
    { id: "WPD55w", name: "Prepared Order", integration: "Toast", revenue: 52929.01, orders: 1296 },
    { id: "Ycwy2j", name: "Placed Order", integration: "API", revenue: 17134.24, orders: 486 },
  ];
  it("adds the other system and leaves the same system's second metric out", () => {
    const next = autoRank([toastPlaced], found, 30000, new Map([["SMvxJW", "Toast"], ["WPD55w", "Toast"], ["Ycwy2j", "API"]]));
    expect(next?.map((m) => m.id)).toEqual(["SMvxJW", "Ycwy2j"]);
    expect(next?.[0].integration).toBe("Toast");
  });
  it("two unranked metrics of one new system: only the bigger is added", () => {
    const next = autoRank([toastPlaced], [{ id: "a", name: "Placed Order", integration: "Square", revenue: 900, orders: 9 }, { id: "b", name: "Completed Order", integration: "Square", revenue: 800, orders: 8 }], 5000, new Map([["SMvxJW", "Toast"]]));
    expect(next?.map((m) => m.id)).toEqual(["SMvxJW", "a"]);
  });
});
