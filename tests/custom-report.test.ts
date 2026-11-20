import { describe, expect, it } from "vitest";
import { aggregate, asksInStyle, byOffer, changeWindows, compareSides, dateInText, fromInsight, groupOf, nameMatches, offersFromText, rankCreatives, resultTypeOf, type AdRow } from "@/lib/reports/custom-core";

const ad = (id: string, campaign: string, spend: number, purchases: number, extra: Partial<AdRow> = {}): AdRow => ({
  month: null,
  ad_id: id,
  ad_name: `Ad ${id}`,
  adset_name: "Broad",
  campaign_name: campaign,
  spend,
  impressions: spend * 50,
  clicks: spend,
  actions: { purchase: purchases, landing_page_view: spend * 0.8, initiate_checkout: purchases * 3 },
  values: { purchase: purchases * 60 },
  ...extra,
});

describe("offersFromText", () => {
  it("reads the price points a client named", () => {
    expect(offersFromText("compare cost per purchase across the $99, $89, $49 and $7 offers")).toEqual([
      { label: "$99", match: ["99"] },
      { label: "$89", match: ["89"] },
      { label: "$49", match: ["49"] },
      { label: "$7", match: ["7"] },
    ]);
    expect(offersFromText("Offers 99/49/7 side by side").map((g) => g.label)).toEqual(["$99", "$49", "$7"]);
  });
  it("needs at least two", () => {
    expect(offersFromText("Show ROAS")).toEqual([]);
    expect(offersFromText("The $99 offer")).toEqual([]);
  });
});

describe("nameMatches", () => {
  it("matches a price as a whole number only", () => {
    expect(nameMatches("FCS | $99 Offer | Broad", ["99"])).toBe(true);
    expect(nameMatches("FCS | 99 offer", ["$99"])).toBe(true);
    expect(nameMatches("FCS | $199 Offer", ["99"])).toBe(false);
    expect(nameMatches("FCS | $9.99 trial", ["99"])).toBe(false);
    expect(nameMatches("FCS | $7 Trial", ["7"])).toBe(true);
    expect(nameMatches("FCS | Hook V7", ["7"])).toBe(false);
    expect(nameMatches("Unlimited Live Classes | Zoom Image | Oct 7", ["7"])).toBe(false);
    expect(nameMatches("Kaizen | ABO | Testing Purchase | US | $7 Offer", ["7"])).toBe(true);
    expect(nameMatches("Stage 3 | $7 Offer | Best winners", ["$7"])).toBe(true);
    expect(nameMatches("FCS | 99.00 offer", ["99"])).toBe(true);
  });
  it("matches words anywhere, ignoring case", () => {
    expect(nameMatches("FCS | LIFETIME deal", ["lifetime"])).toBe(true);
  });
});

describe("groupOf", () => {
  const groups = [{ label: "$99", match: ["99"] }, { label: "$49", match: ["49"] }];
  it("uses the ad's own name first, then the ad set, then the campaign", () => {
    expect(groupOf({ ad_name: "Hook A $49", adset_name: "x", campaign_name: "$99 offer" }, groups)).toBe("$49");
    expect(groupOf({ ad_name: "Hook A", adset_name: "x", campaign_name: "$99 offer" }, groups)).toBe("$99");
    expect(groupOf({ ad_name: "Hook A", adset_name: "x", campaign_name: "Prospecting" }, groups)).toBeNull();
  });
  it("files campaigns named the way the team names them, dates and versions never mistaken for a price", () => {
    const offers = offersFromText("$99, $89, $49 and $7");
    const g = (campaign: string, adset = "Broad", ad = "Hook | IMG 4 | Oct 7") => groupOf({ ad_name: ad, adset_name: adset, campaign_name: campaign }, offers);
    expect(g("Kaizen | Conversions | Purchase | $99 Offer")).toBe("$99");
    expect(g("Kaizen | Conversions | Purchase | $89 Offer")).toBe("$89");
    expect(g("Kaizen | ABO | Testing | Purchase | $49 Test | May 3")).toBe("$49");
    expect(g("Kaizen | ABO | Testing Purchase | US | $7 Offer")).toBe("$7");
    expect(g("Kaizen | CBO | Purchase | $47 Offer | Cost Cap")).toBeNull();
    expect(g("Kaizen | CBO | Testing | Best Performers | Nov 12", "Stage 3 | Flex Ad | Nov 17", "Unlimited Live Classes | V2 | Oct 9")).toBeNull();
  });
  it("can match one level only", () => {
    expect(groupOf({ ad_name: "Hook A $49", adset_name: "x", campaign_name: "$99 offer" }, groups, "campaign")).toBe("$99");
  });
});

describe("aggregate and byOffer", () => {
  const rows = [ad("1", "$99 offer", 1000, 10), ad("2", "$99 offer", 500, 5), ad("3", "$49 offer", 600, 12), ad("4", "Retargeting", 100, 1)];
  it("adds up an offer with its rates", () => {
    const a = aggregate(rows.slice(0, 2), "purchase", true, "$99");
    expect(a).toMatchObject({ ads: 2, spend: 1500, results: 15, cost_per_result: 100, roas: 0.6, click_to_result: 1, checkout_to_result: 33.33 });
    expect(a.page_to_result).toBe(1.25);
  });
  it("puts the offers side by side, with what matched none", () => {
    const b = byOffer(rows, offersFromText("$99 and $49"), "purchase", true);
    expect(b.groups.map((g) => [g.label, g.cost_per_result])).toEqual([["$99", 100], ["$49", 50]]);
    expect(b.unmatched).toMatchObject({ spend: 100, results: 1 });
    expect(b.months).toEqual([]);
  });
  it("breaks them out month by month when the rows are monthly", () => {
    const monthly = [ad("1", "$99", 100, 2, { month: "2026-09" }), ad("1", "$99", 300, 2, { month: "2026-10" }), ad("2", "$49", 50, 5, { month: "2026-10" })];
    const b = byOffer(monthly, offersFromText("$99, $49"), "purchase", false);
    expect(b.months.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(b.months[1].groups.map((g) => g.cost_per_result)).toEqual([150, 10]);
    expect(b.groups[0].roas).toBeNull();
  });
});

describe("fromInsight and resultTypeOf", () => {
  it("reads a Meta row", () => {
    const r = fromInsight({ date_start: "2026-10-01", ad_id: "9", ad_name: "A", adset_name: "S", campaign_name: "C", spend: "12.5", impressions: "1000", inline_link_clicks: "20", actions: [{ action_type: "omni_purchase", value: "2" }], action_values: [{ action_type: "omni_purchase", value: "120" }] }, true);
    expect(r).toMatchObject({ month: "2026-10", spend: 12.5, clicks: 20, actions: { omni_purchase: 2 }, values: { omni_purchase: 120 } });
    expect(resultTypeOf([r])).toBe("omni_purchase");
    expect(resultTypeOf([r], ["lead"])).toBe("omni_purchase");
  });
});

describe("changeWindows", () => {
  it("compares the same number of days on each side, the change day counting as after", () => {
    expect(changeWindows("2026-10-14", "2026-11-20", 14)).toEqual({ before: { start: "2026-09-30", end: "2026-10-13" }, after: { start: "2026-10-14", end: "2026-10-27" }, days: 14 });
  });
  it("defaults to the days since the change (at most 30) and never runs past yesterday", () => {
    expect(changeWindows("2026-11-10", "2026-11-20")).toMatchObject({ days: 10, after: { start: "2026-11-10", end: "2026-11-19" } });
    expect(changeWindows("2026-11-10", "2026-11-20", 60)).toMatchObject({ days: 10 });
    expect(changeWindows("2026-08-01", "2026-11-20")).toMatchObject({ days: 30 });
  });
  it("refuses a change today or later, or a bad date", () => {
    expect(changeWindows("2026-11-20", "2026-11-20")).toHaveProperty("error");
    expect(changeWindows("Oct 14", "2026-11-20")).toHaveProperty("error");
  });
});

describe("compareSides", () => {
  it("says which way each rate moved and whether that's better", () => {
    const before = aggregate([ad("1", "x", 1000, 10)], "purchase", true, "before");
    const after = aggregate([ad("1", "x", 1000, 20)], "purchase", true, "after");
    const s = compareSides(before, after);
    expect(s.find((x) => x.metric.startsWith("Conversion rate"))).toMatchObject({ before: 1, after: 2, change_pct: 100, better: true });
    expect(s.find((x) => x.metric === "Cost per result")).toMatchObject({ before: 100, after: 50, change_pct: -50, better: true });
    expect(s.find((x) => x.metric === "Spend")).toMatchObject({ better: null });
  });
});

describe("rankCreatives", () => {
  const rows = [ad("good", "x", 400, 20), ad("ok", "x", 400, 8), ad("bad", "x", 400, 2), ad("zero", "x", 300, 0), ad("tiny", "x", 5, 3)];
  it("ranks among the ads that spent enough, nothing-at-all first among the worst", () => {
    const r = rankCreatives(rows, "purchase", false, { top: 2, worst: 2 });
    expect(r.threshold).toBe(50);
    expect(r.top.map((a) => a.ad_id)).toEqual(["good", "ok"]);
    expect(r.worst.map((a) => a.ad_id)).toEqual(["zero", "bad"]);
    expect(r.by).toBe("cost_per_result");
  });
  it("ranks by ROAS when it's purchases with value, never listing an ad on both sides", () => {
    const r = rankCreatives(rows.slice(0, 3), "purchase", true, { top: 2, worst: 5 });
    expect(r.by).toBe("roas");
    expect(r.top.map((a) => a.ad_id)).toEqual(["good", "ok"]);
    expect(r.worst.map((a) => a.ad_id)).toEqual(["bad"]);
  });
  it("takes a spend floor when given", () => {
    expect(rankCreatives(rows, "purchase", false, { minSpend: 0 }).judged).toBe(5);
  });
});

describe("standing asks in a client's style", () => {
  it("finds a date in plain words", () => {
    expect(dateInText("checkout page changed on Oct 14", "2026-11-20")).toBe("2026-10-14");
    expect(dateInText("since 2026-10-14", "2026-11-20")).toBe("2026-10-14");
    expect(dateInText("new checkout Dec 3", "2026-11-20")).toBe("2025-12-03");
    expect(dateInText("no date here", "2026-11-20")).toBeNull();
  });
  it("reads offers, worst creatives and a dated change from the rules", () => {
    const a = asksInStyle(["Compare cost per purchase across the $99, $89, $49 and $7 offers", "Show the top and worst performing creatives", "Show conversion rate before and after the checkout page update on Oct 14"], "2026-11-20");
    expect(a.offers.map((o) => o.label)).toEqual(["$99", "$89", "$49", "$7"]);
    expect(a.worst).toBe(true);
    expect(a.change?.date).toBe("2026-10-14");
    expect(asksInStyle(["Keep it short"], "2026-11-20")).toEqual({ offers: [], worst: false, change: null });
  });
});
