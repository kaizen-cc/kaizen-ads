import { describe, expect, it } from "vitest";
import { campaignIncluded, inScope, toDays } from "@/lib/kpi/calc";
import { aboutLeftOut, leftOutText } from "@/lib/reports/format";

// Reports follow the KPI board's campaign selection: only names containing campaign_match, never excluded_campaigns
// (a campaign the client runs themselves, like Giant Party Sports' own "Cosmic Paintball" ads).

const rows = [
  { date: "2026-11-01", campaign_id: "1", campaign_name: "GPS | Birthday Parties | Leads", spend: 100, actions: { lead: 5 }, action_values: {} },
  { date: "2026-11-01", campaign_id: "2", campaign_name: "Cosmic Paintball | Brand", spend: 300, actions: { lead: 30 }, action_values: {} },
  { date: "2026-11-01", campaign_id: "3", campaign_name: "GPS | Field Trips", spend: 50, actions: { lead: 1 }, action_values: {} },
];

describe("campaignIncluded", () => {
  it("keeps everything when the KPI has no selection", () => {
    expect(campaignIncluded(null, { id: "2", name: "Cosmic Paintball" })).toBe(true);
    expect(campaignIncluded({ campaign_match: "  ", excluded_campaigns: [] }, { id: "2", name: "x" })).toBe(true);
  });

  it("leaves out excluded campaigns by id", () => {
    const scope = { excluded_campaigns: ["2"] };
    expect(campaignIncluded(scope, { id: "2", name: "Cosmic Paintball | Brand" })).toBe(false);
    expect(campaignIncluded(scope, { id: 2, name: "Cosmic Paintball | Brand" })).toBe(false);
    expect(campaignIncluded(scope, { id: "1", name: "GPS | Birthday Parties" })).toBe(true);
  });

  it("keeps only names containing the campaign match, case and spaces aside", () => {
    const scope = { campaign_match: " gps " };
    expect(campaignIncluded(scope, { id: "1", name: "GPS | Birthday Parties" })).toBe(true);
    expect(campaignIncluded(scope, { id: "2", name: "Cosmic Paintball | Brand" })).toBe(false);
    expect(campaignIncluded(scope, { id: "9", name: null })).toBe(false);
  });

  it("applies both rules together", () => {
    const scope = { campaign_match: "GPS", excluded_campaigns: ["3"] };
    expect(inScope(rows, scope).map((r) => r.campaign_id)).toEqual(["1"]);
  });
});

describe("inScope and toDays agree", () => {
  it("returns the same rows when there's nothing to filter", () => {
    expect(inScope(rows, {})).toBe(rows);
  });

  it("counts only the KPI's campaigns, the same as the KPI board", () => {
    const scope = { excluded_campaigns: ["2"] };
    const board = toDays(rows, null, scope.excluded_campaigns);
    const report = toDays(inScope(rows, scope));
    expect(board[0].spend).toBe(150);
    expect(report[0].spend).toBe(150);
    expect(report[0].actions.lead).toBe(6);
  });

  it("keeps a campaign match the same way", () => {
    expect(toDays(rows, "paintball")[0].spend).toBe(300);
    expect(toDays(inScope(rows, { campaign_match: "paintball" }))[0].spend).toBe(300);
  });
});

describe("the AI's report context", () => {
  it("names the left-out campaigns with the rule never to discuss them", () => {
    const text = leftOutText({ leftOut: [{ id: "2", name: "Cosmic Paintball | Brand", spend: 300, why: "excluded" }] });
    expect(text).toContain("<campaigns_not_in_this_report");
    expect(text).toContain("- Cosmic Paintball | Brand");
    expect(text).toMatch(/Never mention them/);
  });

  it("adds names read fresh from the KPI and drops duplicates", () => {
    const text = leftOutText({ leftOut: [{ id: "2", name: "Cosmic Paintball | Brand", spend: 300, why: "excluded" }] }, ["Cosmic Paintball | Brand", "Other client ads"]);
    expect(text.match(/Cosmic Paintball/g)).toHaveLength(1);
    expect(text).toContain("- Other client ads");
  });

  it("says nothing when every campaign is in", () => {
    expect(leftOutText({ leftOut: [] })).toBe("");
    expect(leftOutText(null)).toBe("");
  });

  it("spots work-log lines about a left-out campaign", () => {
    const names = ["Cosmic Paintball | Brand"];
    expect(aboutLeftOut("Budget changed on cosmic paintball | brand", names)).toBe(true);
    expect(aboutLeftOut("Budget changed on GPS | Birthday Parties", names)).toBe(false);
    expect(aboutLeftOut(null, names)).toBe(false);
    expect(aboutLeftOut("anything", ["ab"])).toBe(false);
  });
});

describe("Google reports follow the Google KPI's campaign selection", () => {
  // Google rows: numeric campaign ids, conversions as the result, the client's own brand search campaign excluded
  const g = [
    { date: "2026-11-01", campaign_id: "2045551001", campaign_name: "GPS | Search | Birthday Parties", spend: 120, actions: { conversions: 6 }, action_values: {} },
    { date: "2026-11-01", campaign_id: "2045551002", campaign_name: "Cosmic Paintball | Brand Search", spend: 80, actions: { conversions: 20 }, action_values: {} },
    { date: "2026-11-01", campaign_id: "2045551003", campaign_name: "GPS | PMax", spend: 60, actions: { conversions: 2 }, action_values: {} },
  ];

  it("leaves out an excluded Google campaign by its id, the same as the KPI board", () => {
    const scope = { excluded_campaigns: ["2045551002"] };
    expect(inScope(g, scope).map((r) => r.campaign_name)).toEqual(["GPS | Search | Birthday Parties", "GPS | PMax"]);
    const report = toDays(inScope(g, scope), null, null, undefined, "google");
    const board = toDays(g, null, scope.excluded_campaigns, undefined, "google");
    expect(report[0].spend).toBe(180);
    expect(board[0].spend).toBe(180);
  });

  it("a GAQL lookup row (nested campaign) is matched on campaign.id and campaign.name", () => {
    const scope = { campaign_match: "gps", excluded_campaigns: ["2045551003"] };
    const lookup = [
      { campaign: { id: "2045551001", name: "GPS | Search | Birthday Parties" } },
      { campaign: { id: "2045551002", name: "Cosmic Paintball | Brand Search" } },
      { campaign: { id: "2045551003", name: "GPS | PMax" } },
    ];
    expect(lookup.filter((x) => campaignIncluded(scope, x.campaign)).map((x) => x.campaign.id)).toEqual(["2045551001"]);
  });

  it("names a left-out Google campaign in the AI's context", () => {
    expect(leftOutText({ leftOut: [{ id: "2045551002", name: "Cosmic Paintball | Brand Search", spend: 80, why: "excluded" }] })).toContain("- Cosmic Paintball | Brand Search");
  });
});
