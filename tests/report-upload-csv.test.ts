import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { covers, fileRows, mergeRows, normHeader, parseAdsCsv, pickUpload, readDate, readNumber, resultTypeOf, splitCsv, uploadSummary, type UploadedFile } from "@/lib/reports/upload-csv";
import { metricsText, reportMetrics } from "@/lib/reports/metrics";
import { tilesFor } from "@/lib/reports/format";

// A buyer's export from Meta Ads Manager for an account Kaizen Ads can't read (Meta answering "(#200) Ad account owner
// has NOT grant ads_management or ads_read permission"): a purchases campaign and an Instant Form lead campaign, the
// week of Nov 9 to 15, 2026, with the summary line Ads Manager puts first and a BOM.
const WEEK = [
  "﻿\"Reporting starts\",\"Reporting ends\",\"Campaign name\",\"Campaign delivery\",\"Results\",\"Result indicator\",\"Cost per result\",\"Amount spent (USD)\",\"Impressions\",\"Reach\",\"Link clicks\",\"CTR (link click-through rate)\",\"CPC (cost per link click)\",\"Purchases\",\"Purchases conversion value\",\"On-Facebook leads\",\"Leads\"",
  "\"2026-11-09\",\"2026-11-15\",\"\",\"\",\"\",\"\",\"\",\"$2,431.40\",\"185,220\",\"90,112\",\"2,904\",\"1.57%\",\"$0.84\",\"81\",\"$9,876.50\",\"106\",\"106\"",
  "\"2026-11-09\",\"2026-11-15\",\"Sales | Advantage+ | Nov\",\"active\",\"81\",\"actions:offsite_conversion.fb_pixel_purchase\",\"$19.84\",\"$1,607.00\",\"120,500\",\"60,000\",\"2,100\",\"1.74%\",\"$0.77\",\"81\",\"$9,876.50\",\"\",\"\"",
  "\"2026-11-09\",\"2026-11-15\",\"Leads | Instant Form, \"\"Free quote\"\"\",\"active\",\"106\",\"actions:onsite_conversion.lead_grouped\",\"$7.78\",\"$824.40\",\"64,720\",\"30,112\",\"804\",\"1.24%\",\"$1.03\",\"\",\"\",\"106\",\"106\"",
].join("\r\n");

const MAIN = { start: "2026-11-09", end: "2026-11-15" };
const asUpload = (text: string, over: Partial<UploadedFile> = {}): UploadedFile => {
  const { needsMapping: _n, skipped: _s, ...p } = parseAdsCsv(text);
  void _n;
  void _s;
  return { ...p, id: "u1", name: "export.csv", datesAssumed: false, mappedByAi: false, by: "p1", byName: "A buyer", at: "2026-11-16T15:00:00Z", ...over };
};

describe("reading an Ads Manager export", () => {
  it("reads a campaign-level week: quoted fields, a BOM, thousands separators, currency, the summary line skipped", () => {
    const p = parseAdsCsv(WEEK);
    expect(p.platform).toBe("meta");
    expect(p.level).toBe("campaign");
    expect(p.daily).toBe(false);
    expect(p.needsMapping).toBe(false);
    expect(p.skipped).toBe(1);
    expect(p.currency).toBe("USD");
    expect([p.start, p.end]).toEqual(["2026-11-09", "2026-11-15"]);
    expect(p.rows.map((r) => r.campaign)).toEqual(["Sales | Advantage+ | Nov", 'Leads | Instant Form, "Free quote"']);
    expect(p.rows[0].n).toMatchObject({ spend: 1607, impressions: 120500, reach: 60000, linkClicks: 2100, ctr: 1.74, cpc: 0.77, results: 81, purchases: 81, purchaseValue: 9876.5 });
    expect(p.rows[0].resultType).toBe("offsite_conversion.fb_pixel_purchase");
    expect(p.rows[1].n).toMatchObject({ spend: 824.4, fbLeads: 106, leads: 106, results: 106 });
    expect(p.rows[1].n.purchases).toBeUndefined();
    expect(uploadSummary(p)).toBe("2 campaigns · Nov 9–15 · $2,431 spent");
  });

  it("knows Ads Manager's names in any currency, and ignores columns it doesn't use", () => {
    expect(normHeader("Amount spent (EUR)")).toBe("amount spent");
    const p = parseAdsCsv(["Campaign name,Reporting starts,Reporting ends,Amount spent (EUR),Impressions,Frequency,Website purchases,Website purchases conversion value,Adds to cart,ThruPlays,3-second video plays,Clicks (all)", "Prospecting,2026-11-09,2026-11-15,\"1.234,56\",10000,1.8,4,300,12,500,2000,250"].join("\n"));
    expect(p.currency).toBe("EUR");
    expect(p.headers.find((h) => h.header === "Frequency")?.key).toBeNull();
    expect(p.rows[0].n).toEqual({ spend: 1234.56, impressions: 10000, websitePurchases: 4, websitePurchaseValue: 300, addsToCart: 12, thruplays: 500, videoPlays3s: 2000, clicks: 250 });
    expect(uploadSummary(p)).toBe("1 campaign · Nov 9–15 · 1,235 EUR spent");
  });

  it("reads an ad-level file by day, and works out link clicks from the CTR when only the rate was exported", () => {
    const p = parseAdsCsv(["Campaign name,Ad set name,Ad name,Day,Amount spent (USD),Impressions,CTR (link click-through rate),Results,Result type", "Sales,Broad,UGC 01,2026-11-09,50.00,5000,2.00%,2,Website purchases", "Sales,Broad,UGC 02,2026-11-09,30,3000,1%,0,Website purchases", "Sales,Broad,UGC 01,2026-11-10,45,4000,1.5%,1,Website purchases"].join("\n"));
    expect(p.level).toBe("ad");
    expect(p.daily).toBe(true);
    expect([p.start, p.end]).toEqual(["2026-11-09", "2026-11-10"]);
    expect(p.rows[0]).toMatchObject({ date: "2026-11-09", campaign: "Sales", adset: "Broad", ad: "UGC 01", resultType: "offsite_conversion.fb_pixel_purchase" });
    expect(p.rows[0].n.linkClicks).toBe(100);
    expect(uploadSummary(p)).toBe("2 ads · Nov 9–10 by day · $125 spent");
  });

  it("reads a Google Ads export with its title lines and skips its totals rows", () => {
    const p = parseAdsCsv(["Campaign report", "\"November 9, 2026 - November 15, 2026\"", "Campaign,Currency code,Cost,Impr.,Clicks,Conversions,Conv. value", "Search | Brand,USD,\"1,020.10\",\"12,400\",880,40.5,\"3,200.00\"", "Total: Account,USD,\"1,020.10\",\"12,400\",880,40.5,\"3,200.00\"", "Total: Campaigns,USD,\"1,020.10\",\"12,400\",880,40.5,\"3,200.00\""].join("\n"));
    expect(p.platform).toBe("google");
    expect(p.skipped).toBe(2);
    expect([p.start, p.end]).toEqual(["2026-11-09", "2026-11-15"]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].n).toEqual({ spend: 1020.1, impressions: 12400, linkClicks: 880, conversions: 40.5, conversionValue: 3200 });
  });

  it("asks for a mapping when it can't find the spend, and reads the file with the one it's given", () => {
    const text = ["Kampagnenname,Berichtsbeginn,Berichtsende,Ausgegebener Betrag,Impressionen", "Herbst,2026-11-09,2026-11-15,99.50,4000"].join("\n");
    expect(parseAdsCsv(text).needsMapping).toBe(true);
    const p = parseAdsCsv(text, { Kampagnenname: "campaign", Berichtsbeginn: "start", Berichtsende: "end", "Ausgegebener Betrag": "spend", Impressionen: "impressions" });
    expect(p.needsMapping).toBe(false);
    expect(p.rows[0]).toMatchObject({ campaign: "Herbst", start: "2026-11-09", n: { spend: 99.5, impressions: 4000 } });
  });

  it("never takes a campaign named like a total for the totals row", () => {
    const p = parseAdsCsv(["Campaign name,Amount spent (USD)", "Total Body Fitness | Leads,10", "Total,10"].join("\n"));
    expect(p.rows.map((r) => r.campaign)).toEqual(["Total Body Fitness | Leads"]);
  });

  it("reads cells, numbers and dates as exports write them", () => {
    expect(splitCsv('a,"b, c","d ""e"""\n1,2,3')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    expect(splitCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(readNumber("$1,234.56")).toBe(1234.56);
    expect(readNumber("12.5%")).toBe(12.5);
    expect(readNumber("--")).toBeNull();
    expect(readNumber("")).toBeNull();
    expect(readNumber("1.234,5")).toBe(1234.5);
    expect(readDate("2026-11-09")).toBe("2026-11-09");
    expect(readDate("11/09/2026")).toBe("2026-11-09");
    expect(readDate("Nov 9, 2026")).toBe("2026-11-09");
    expect(readDate("Mon, November 9, 2026")).toBe("2026-11-09");
    expect(readDate("2026-02-30")).toBeNull();
    expect(resultTypeOf("actions:offsite_conversion.fb_pixel_purchase", "")).toBe("offsite_conversion.fb_pixel_purchase");
    expect(resultTypeOf("", "Leads (form)")).toBe("onsite_conversion.lead_grouped");
    expect(resultTypeOf("", "Website leads")).toBe("offsite_conversion.fb_pixel_lead");
  });
});

describe("which upload a report uses", () => {
  const totals = asUpload(WEEK);
  it("totals stand in only for exactly their dates; a daily file for any dates inside it", () => {
    expect(covers(totals, MAIN)).toBe(true);
    expect(covers(totals, { start: "2026-11-09", end: "2026-11-14" })).toBe(false);
    expect(covers({ daily: true, start: "2026-11-01", end: "2026-11-15" }, MAIN)).toBe(true);
    expect(covers({ daily: true, start: "2026-11-10", end: "2026-11-15" }, MAIN)).toBe(false);
  });
  it("the newest one for the platform that covers the dates", () => {
    const older = { ...totals, id: "a", at: "2026-11-15T10:00:00Z" };
    const newer = { ...totals, id: "b", at: "2026-11-16T10:00:00Z" };
    expect(pickUpload([older, newer], "meta", MAIN)?.id).toBe("b");
    expect(pickUpload([older, newer], "google", MAIN)).toBeNull();
    expect(pickUpload(null, "meta", MAIN)).toBeNull();
  });
  it("turns rows into the daily campaign rows the reports count, keeping the ids the synced data knows", () => {
    const { rows, goals, labels } = fileRows(totals, [{ campaign_id: "120001", campaign_name: "Sales | Advantage+ | Nov" }]);
    expect(rows.map((r) => [r.date, r.campaign_id])).toEqual([
      ["2026-11-09", "120001"],
      ["2026-11-09", 'file:Leads | Instant Form, "Free quote"'],
    ]);
    expect(rows[0].actions).toMatchObject({ omni_purchase: 81, "offsite_conversion.fb_pixel_purchase": 81, link_click: 2100 });
    expect(rows[0].action_values).toEqual({ omni_purchase: 9876.5 });
    // An Instant Form campaign's leads are leads, never purchases
    expect(rows[1].actions.omni_purchase).toBeUndefined();
    expect(goals.get("120001")).toEqual(["offsite_conversion.fb_pixel_purchase"]);
    expect(labels.get("120001")).toBe("Website purchases");
    expect(mergeRows([{ date: "2026-11-08" }, { date: "2026-11-10" }], totals, [{ date: "2026-11-09" }])).toEqual([{ date: "2026-11-08" }, { date: "2026-11-09" }]);
  });
});

// ─── The report's numbers from the file ─────────────────────────────────

/** A stand-in for the database: every query on a table answers with its rows */
function fakeAdmin(tables: Record<string, unknown[]> = {}) {
  const chain = (rows: unknown[]) => {
    const answer = { data: rows, error: null };
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq", "neq", "gte", "lte", "in", "order", "limit", "not", "or"]) q[k] = () => q;
    q.range = (a: number, b: number) => Promise.resolve({ data: rows.slice(a, b + 1), error: null });
    q.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, bad);
    return q;
  };
  return { from: (t: string) => chain(tables[t] ?? []) } as unknown as SupabaseClient;
}

const target = (conversion: string) => ({ id: "t1", client_id: "c1", platform: "meta", ad_account_id: "act_123", conversion, custom_action: null, campaign_match: null, target: null, monthly_budget: null, excluded_campaigns: [], campaign_results: null });

describe("a report built from an uploaded export", () => {
  it("counts the KPI's conversion only: a purchases client's Instant Form leads are never purchases", async () => {
    const m = await reportMetrics(fakeAdmin(), target("purchases"), "custom", "2026-11-16", MAIN, { lite: true, uploads: [asUpload(WEEK)] });
    expect(m.main).toMatchObject({ spend: 2431.4, results: 81, impressions: 185220, clicks: 2904, revenue: 9876.5, days: 7 });
    expect(m.main.costPerResult).toBe(30.02);
    expect(m.conversion).toBe("Purchases");
    expect(m.gaps).toEqual([]);
    expect(m.dataThrough).toBe("2026-11-15");
    // Each campaign keeps its own result on its line
    expect(m.campaigns.map((c) => [c.name, c.results, c.counted])).toEqual([
      ["Sales | Advantage+ | Nov", 81, 81],
      ['Leads | Instant Form, "Free quote"', 106, 0],
    ]);
  });

  it("counts each campaign's own result when that's the KPI", async () => {
    const m = await reportMetrics(fakeAdmin(), target("campaign_goal"), "custom", "2026-11-16", MAIN, { lite: true, uploads: [asUpload(WEEK)] });
    expect(m.main.results).toBe(187);
    expect(m.goals?.map((g) => [g.label, g.results])).toEqual([
      ["Website purchases", 81],
      ["Instant form leads", 106],
    ]);
  });

  it("with nothing for the period before, the comparison is empty: no change shown, and the AI is told", async () => {
    const m = await reportMetrics(fakeAdmin(), target("purchases"), "custom", "2026-11-16", MAIN, { lite: true, uploads: [asUpload(WEEK)] });
    expect(m.compare).toMatchObject({ days: 0, spend: 0, results: 0 });
    expect(m.upload?.compare).toBe("none");
    expect(tilesFor(m, ["spend", "results", "cost_per_result"]).every((t) => t.delta === null)).toBe(true);
    const text = metricsText(m);
    expect(text).toContain("come from an export of Meta Ads Manager the team uploaded (export.csv, campaign level, totals for the dates)");
    expect(text).toContain("give no change against it");
  });

  it("takes the period before from synced data when the file doesn't have it, and the file's days over synced ones", async () => {
    const synced = [
      { date: "2026-11-04", campaign_id: "120001", campaign_name: "Sales | Advantage+ | Nov", spend: 500, impressions: 40000, clicks: 700, link_clicks: 600, unique_link_clicks: 580, actions: { omni_purchase: 20 }, action_values: { omni_purchase: 2000 }, updated_at: "" },
      // A day of the report's week the sync caught before access was lost: the file replaces it
      { date: "2026-11-10", campaign_id: "120001", campaign_name: "Sales | Advantage+ | Nov", spend: 999, impressions: 1, clicks: 1, link_clicks: 1, unique_link_clicks: 1, actions: { omni_purchase: 50 }, action_values: {}, updated_at: "" },
    ];
    const m = await reportMetrics(fakeAdmin({ meta_campaign_daily: synced }), target("purchases"), "custom", "2026-11-16", MAIN, { lite: true, uploads: [asUpload(WEEK)] });
    expect(m.main.spend).toBe(2431.4);
    expect(m.main.results).toBe(81);
    expect(m.compare).toMatchObject({ spend: 500, results: 20, days: 1 });
    expect(m.upload?.compare).toBe("synced");
    expect(m.campaigns[0].prev).toMatchObject({ spend: 500, results: 20 });
  });

  it("takes the period before from the file when its Day breakdown spans both weeks, with top ads from its ad rows", async () => {
    const lines = ["Campaign name,Ad set name,Ad name,Day,Amount spent (USD),Impressions,Link clicks,Purchases,Purchases conversion value,On-Facebook leads"];
    for (let d = 2; d <= 15; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      const late = d >= 9;
      lines.push(`Sales,Broad,UGC 01,${day},${late ? 60 : 40},4000,80,${late ? 3 : 1},${late ? 300 : 100},`);
      lines.push(`Sales,Broad,Static 02,${day},20,2000,20,0,0,`);
      lines.push(`Leads,Form,Quote form,${day},30,3000,40,,,${late ? 5 : 4}`);
    }
    const daily = asUpload(lines.join("\n"), { name: "daily.csv" });
    expect(daily.daily).toBe(true);
    const m = await reportMetrics(fakeAdmin(), target("purchases"), "weekly", "2026-11-16", MAIN, { uploads: [daily] });
    expect(m.main).toMatchObject({ spend: 770, results: 21, revenue: 2100, days: 7 });
    expect(m.compare).toMatchObject({ spend: 630, results: 7, revenue: 700, days: 7 });
    expect(m.upload?.compare).toBe("file");
    expect(m.topAds.map((a) => [a.name, a.results])).toEqual([
      ["UGC 01", 21],
      ["Quote form", 0],
      ["Static 02", 0],
    ]);
    // The five weeks follow the file for the weeks it covers
    expect(m.weeks?.slice(-2).map((w) => w.spend)).toEqual([630, 770]);
  });

  it("ignores a file for other dates, and one for another platform", async () => {
    const m = await reportMetrics(fakeAdmin(), target("purchases"), "custom", "2026-11-23", { start: "2026-11-16", end: "2026-11-22" }, { lite: true, uploads: [asUpload(WEEK)] });
    expect(m.upload).toBeUndefined();
    expect(m.main.spend).toBe(0);
  });
});
