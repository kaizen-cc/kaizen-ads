import { describe, expect, it } from "vitest";
import { reportMetrics, type CampaignLine, type ReportMetrics } from "@/lib/reports/metrics";
import { leaveOutCampaigns, picturesKept } from "@/lib/reports/campaign-scope";
import { campaignTable } from "@/lib/reports/campaign-table";
import { autoTakeaways } from "@/lib/reports/weekly-core";
import { applyManual } from "@/lib/reports/manual";
import { oceanboxMeta } from "./fixtures/report-weekly";

// Leaving a campaign out of ONE report (a campaign that isn't ours) works every number out again from the campaigns that
// remain: spend, CPC, CTR, CPM, results, cost per result, ROAS, the totals row, the comparison and the five weeks.
// Two ways are checked against each other: the server reading the ad account's rows without the campaign (reportMetrics
// with `leave`), and the plain function the PDF and the studio's preview use (leaveOutCampaigns).

const A = "Kaizen | Leads";
const B = "Client Run | Brand";
const C = "Kaizen | Retargeting";

type Row = { date: string; campaign_id: string; campaign_name: string; spend: number; impressions: number; clicks: number; link_clicks: number; actions: Record<string, number>; action_values: Record<string, number> };
const row = (date: string, id: string, name: string, spend: number, impressions: number, clicks: number, leads: number): Row => ({ date, campaign_id: id, campaign_name: name, spend, impressions, clicks, link_clicks: clicks, actions: leads ? { lead: leads } : {}, action_values: {} });

// The week (Nov 2 to 8) against the week before (Oct 26 to Nov 1), each campaign over two days
const ROWS: Row[] = [
  row("2026-11-03", "1", A, 60, 6000, 120, 3),
  row("2026-11-05", "1", A, 40, 4000, 80, 2),
  row("2026-11-03", "2", B, 200, 12000, 400, 20),
  row("2026-11-06", "2", B, 100, 8000, 200, 10),
  row("2026-11-04", "3", C, 30, 3000, 30, 1),
  row("2026-11-07", "3", C, 20, 2000, 20, 0),
  row("2026-10-28", "1", A, 80, 8000, 160, 4),
  row("2026-10-29", "2", B, 100, 5000, 100, 10),
  row("2026-10-30", "3", C, 20, 2000, 20, 0),
];

/** A stand-in for the database: every query chain answers with the table's rows (the filters aren't needed here) */
function fakeAdmin(tables: Record<string, unknown[]>) {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lte", "order", "limit", "range", "in"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: null, error: null });
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
    return c;
  };
  return { from: (table: string) => chain(table) } as never;
}

const target = { id: "t1", client_id: "c1", platform: "meta", ad_account_id: "act_9", conversion: "website_lead", custom_action: null, campaign_match: null, target: 20, monthly_budget: null, excluded_campaigns: [] as string[] };
const range = { start: "2026-11-02", end: "2026-11-08" };
const drawn = (leave?: string[]) => reportMetrics(fakeAdmin({ meta_campaign_daily: ROWS }), target, "weekly", "2026-11-10", range, { lite: true, ...(leave ? { leave } : {}) });

describe("a campaign left out of the report is counted out of the ad account's rows", () => {
  it("the report with every campaign adds up to the account", async () => {
    const m = await drawn();
    expect(m.main).toMatchObject({ spend: 450, impressions: 35000, clicks: 850, results: 36, ctr: 2.43, cpc: 0.53, cpm: 12.86, costPerResult: 12.5 });
    expect(m.campaigns.map((c) => c.name)).toEqual([B, A, C]);
    expect(m.leftOut ?? []).toEqual([]);
  });

  it("without a campaign, spend, CPC, CTR, CPM, results and cost per result all follow, not just the campaign's line", async () => {
    const m = await drawn([B]);
    expect(m.main).toMatchObject({ spend: 150, impressions: 15000, clicks: 250, results: 6, ctr: 1.67, cpc: 0.6, cpm: 10, costPerResult: 25 });
    expect(m.campaigns.map((c) => c.name)).toEqual([A, C]);
    // The comparison is counted without it too, so the change shown is like for like
    expect(m.compare).toMatchObject({ spend: 100, results: 4, costPerResult: 25 });
    // And the five weeks: the report's own week and the week before
    expect(m.weeks?.at(-1)).toMatchObject({ spend: 150, results: 6 });
    expect(m.weeks?.at(-2)).toMatchObject({ spend: 100, results: 4 });
    // It is named as left out of this report, to be brought back
    expect(m.leftOut).toEqual([{ id: "2", name: B, spend: 300, why: "report" }]);
  });

  it("a campaign left out by id counts out the same way, and an unknown name changes nothing", async () => {
    expect((await drawn(["2"])).main.spend).toBe(150);
    expect((await drawn(["No such campaign"])).main.spend).toBe(450);
  });

  it("the totals row of the campaign table is the report's own totals, with and without the campaign", async () => {
    for (const leave of [undefined, [B]]) {
      const m = await drawn(leave);
      const t = campaignTable(m)!;
      expect(t.total.spend.value).toBe(m.main.spend);
      expect(t.total.impressions.value).toBe(m.main.impressions);
      expect(t.total.clicks.value).toBe(m.main.clicks);
      expect(t.total.results.value).toBe(m.main.results);
      expect(t.total.ctr.value).toBe(m.main.ctr);
      expect(t.total.cpc.value).toBe(m.main.cpc);
      expect(t.total.cost_per_result.value).toBe(m.main.costPerResult);
    }
  });

  it("the plain function the PDF uses gives the same numbers as reading the account without the campaign", async () => {
    const all = await drawn();
    const read = await drawn([B]);
    const plain = leaveOutCampaigns(all, [B]);
    expect(plain.main).toMatchObject({ spend: read.main.spend, impressions: read.main.impressions, clicks: read.main.clicks, results: read.main.results, ctr: read.main.ctr, cpc: read.main.cpc, cpm: read.main.cpm, costPerResult: read.main.costPerResult });
    expect(plain.compare).toMatchObject({ spend: read.compare.spend, results: read.compare.results, costPerResult: read.compare.costPerResult });
    expect(plain.campaigns.map((c) => c.name)).toEqual(read.campaigns.map((c) => c.name));
    expect(plain.weeks?.at(-1)).toMatchObject({ spend: read.weeks?.at(-1)?.spend, results: read.weeks?.at(-1)?.results });
    expect(plain.weeks?.at(-2)).toMatchObject({ spend: read.weeks?.at(-2)?.spend, results: read.weeks?.at(-2)?.results });
    expect(plain.leftOut?.map((l) => [l.name, l.why])).toEqual([[B, "report"]]);
  });
});

describe("leaveOutCampaigns", () => {
  const line = (c: Partial<CampaignLine> & { name: string }): CampaignLine => ({ spend: 0, results: 0, costPerResult: null, roas: null, ctr: null, ...c });
  const ecommerce: ReportMetrics = {
    ...oceanboxMeta,
    roasKpi: true,
    main: { ...oceanboxMeta.main, spend: 1000, impressions: 50000, clicks: 1000, results: 10, revenue: 3000, ctr: 2, cpc: 1, cpm: 20, costPerResult: 100, roas: 3 },
    compare: { ...oceanboxMeta.compare, spend: 900, impressions: 40000, clicks: 800, results: 8, revenue: 2000, ctr: 2, cpc: 1.13, cpm: 22.5, costPerResult: 112.5, roas: 2.22 },
    campaigns: [
      line({ id: "1", name: "Sales", spend: 700, results: 9, counted: 9, impressions: 30000, clicks: 700, revenue: 2800, prev: { spend: 600, impressions: 25000, clicks: 500, results: 7, revenue: 1900 } }),
      line({ id: "2", name: "Not ours", spend: 300, results: 1, counted: 1, impressions: 20000, clicks: 300, revenue: 200, prev: { spend: 300, impressions: 15000, clicks: 300, results: 1, revenue: 100 } }),
    ],
    topAds: [
      { id: "a1", name: "Ours", campaign: "Sales", spend: 700, results: 9, costPerResult: 77.78, ctr: 2.3, clicks: 700, link: null, image: null },
      { id: "a2", name: "Theirs", campaign: "Not ours", spend: 300, results: 1, costPerResult: 300, ctr: 1.5, clicks: 300, link: null, image: null },
    ],
    weeks: [
      { label: "Oct 26–Nov 1", start: "2026-10-26", end: "2026-11-01", spend: 900, results: 8, costPerResult: 112.5, revenue: 2000, roas: 2.22, clicks: 800, impressions: 40000 },
      { label: "Nov 2–8", start: "2026-11-02", end: "2026-11-08", spend: 1000, results: 10, costPerResult: 100, revenue: 3000, roas: 3, clicks: 1000, impressions: 50000 },
    ],
  };

  it("works spend, CPC, CTR, CPM, results, cost per result and ROAS out again", () => {
    const m = leaveOutCampaigns(ecommerce, ["Not ours"]);
    expect(m.main).toMatchObject({ spend: 700, impressions: 30000, clicks: 700, results: 9, revenue: 2800, ctr: 2.33, cpc: 1, cpm: 23.33, costPerResult: 77.78, roas: 4 });
    expect(m.compare).toMatchObject({ spend: 600, impressions: 25000, clicks: 500, results: 7, revenue: 1900, cpc: 1.2, costPerResult: 85.71, roas: 3.17 });
  });

  it("takes the left-out campaign's ads out of the scorecard and top ads, and its line out of the table", () => {
    const m = leaveOutCampaigns(ecommerce, ["Not ours"]);
    expect(m.topAds.map((a) => a.name)).toEqual(["Ours"]);
    expect(m.campaigns.map((c) => c.name)).toEqual(["Sales"]);
    expect(campaignTable(m)!.rows).toHaveLength(1);
    expect(picturesKept(ecommerce, ["Not ours"])).toEqual([true, false]);
  });

  it("redraws the current week of the five-week chart", () => {
    const m = leaveOutCampaigns(ecommerce, ["Not ours"]);
    expect(m.weeks?.at(-1)).toMatchObject({ spend: 700, results: 9, roas: 4 });
    expect(m.weeks?.at(-2)).toMatchObject({ spend: 600, results: 7 });
  });

  it("changes the takeaways that are worked out from the numbers", () => {
    const before = autoTakeaways(ecommerce).map((t) => t.text).join(" ");
    const after = autoTakeaways(leaveOutCampaigns(ecommerce, ["Not ours"])).map((t) => t.text).join(" ");
    expect(before).not.toBe(after);
    expect(after).toContain("4.00x");
  });

  it("is a no-op for a campaign it can't find, and for no names", () => {
    expect(leaveOutCampaigns(ecommerce, ["Nope"])).toBe(ecommerce);
    expect(leaveOutCampaigns(ecommerce, [])).toBe(ecommerce);
    expect(leaveOutCampaigns(ecommerce, null)).toBe(ecommerce);
  });

  it("is safe to run again (a report drawn after the campaign was left out already has it out)", () => {
    const once = leaveOutCampaigns(ecommerce, ["Not ours"]);
    expect(leaveOutCampaigns(once, ["Not ours"]).main).toEqual(once.main);
  });

  it("keeps the CRM results the team entered, and works their cost out from the new spend", () => {
    const withCrm = applyManual(ecommerce, { lines: [{ id: "l1", label: "Bookings", count: 20, revenue: null, priorCount: null, priorRevenue: null, source: "CRM", note: null, main: true }], by: null, byName: null, at: null });
    const m = leaveOutCampaigns(withCrm, ["Not ours"]);
    expect(m.main.results).toBe(20);
    expect(m.main.costPerResult).toBe(35);
    expect(m.conversion).toBe("Bookings");
  });

  it("older reports (no per-campaign comparison) keep their comparison as drawn", () => {
    const old: ReportMetrics = { ...ecommerce, campaigns: ecommerce.campaigns.map((c) => ({ ...c, prev: undefined })) };
    const m = leaveOutCampaigns(old, ["Not ours"]);
    expect(m.compare).toEqual(old.compare);
    expect(m.main.spend).toBe(700);
  });
});

describe("the campaign performance table", () => {
  const line = (c: Partial<CampaignLine> & { name: string }): CampaignLine => ({ spend: 0, results: 0, costPerResult: null, roas: null, ctr: null, ...c });
  const shop: ReportMetrics = {
    ...oceanboxMeta,
    campaigns: [
      line({ id: "1", name: "Sales | A very long campaign name that has to wrap onto a second line | Oct 7", spend: 500, impressions: 20000, clicks: 400, results: 5, counted: 5, revenue: 1500, events: [{ type: "omni_add_to_cart", label: "Adds to cart", count: 40 }, { type: "omni_initiate_checkout", label: "Checkouts", count: 12 }] }),
      line({ id: "2", name: "Reach", spend: 100, impressions: 30000, clicks: 100, results: 30000, counted: 0 }),
    ],
  };

  it("lists every campaign that spent, biggest first, with a total", () => {
    const t = campaignTable(shop)!;
    expect(t.rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(t.total.spend.text).toBe("$600.00");
    expect(t.total.impressions.text).toBe("50,000");
    expect(t.total.clicks.text).toBe("500");
    expect(t.total.add_to_cart.text).toBe("40");
    expect(t.total.initiate_checkout.text).toBe("12");
    expect(t.total.roas.text).toBe("2.50x");
  });

  it("shows add to cart, checkout, conversion value and ROAS on a Meta shop, and counts only the client's result", () => {
    const t = campaignTable(shop)!;
    expect(t.columns.map((c) => c.key)).toEqual(["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "results", "cost_per_result", "revenue", "add_to_cart", "initiate_checkout", "roas"]);
    // A reach campaign isn't run for a result: a dash, never a zero or its reach counted as results
    expect(t.rows[1].cells.results.text).toBe("–");
    expect(t.rows[1].cells.cost_per_result.text).toBe("–");
    expect(t.total.results.value).toBe(5);
  });

  it("drops what the account doesn't have: no funnel or revenue columns for a lead account, and none of the funnel on Google", () => {
    const leads: ReportMetrics = { ...shop, campaigns: shop.campaigns.map((c) => ({ ...c, revenue: 0, events: [] })) };
    expect(campaignTable(leads)!.columns.map((c) => c.key)).toEqual(["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "results", "cost_per_result"]);
    const google = campaignTable({ ...shop, platform: "google" })!;
    expect(google.columns.map((c) => c.key)).not.toContain("add_to_cart");
    expect(google.columns.find((c) => c.key === "clicks")!.head).toBe("Clicks");
    expect(campaignTable({ ...shop, campaigns: [] })).toBeNull();
  });
});
