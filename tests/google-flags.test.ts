import { describe, expect, it } from "vitest";
import { businessModel, googleHealth, isBrandCampaign } from "@/lib/google-flags";
import { successOf } from "@/lib/kpi/success";

const row = (campaign_name: string, spend: number, impressions: number, clicks: number, conversions: number, is?: { share: number }) => ({
  campaign_name,
  spend,
  impressions,
  clicks,
  actions: { conversions, ...(is ? { "_is:impressions": impressions, "_is:eligible": impressions / is.share, "_is:lost_budget": (impressions / is.share) * 0.5, "_is:lost_rank": 0 } : {}) },
});

describe("Google health checks", () => {
  it("finds brand campaigns by name", () => {
    expect(isBrandCampaign("Nectar | Brand | Exact")).toBe(true);
    expect(isBrandCampaign("Branded search")).toBe(true);
    expect(isBrandCampaign("Brandon Plumbing - Generic")).toBe(false);
  });

  it("tells ecommerce from lead gen", () => {
    expect(businessModel("purchase")).toBe("ecommerce");
    expect(businessModel("lead", true)).toBe("ecommerce");
    expect(businessModel("lead")).toBe("lead_gen");
  });

  it("flags brand over 10%, impression share under 10%, a weak conversion rate and a low CTR", () => {
    const h = googleHealth([row("Brand", 300, 1000, 200, 40), row("Generic search", 1700, 20000, 400, 8, { share: 0.08 })], "lead_gen");
    expect(h.brandShare).toBe(15);
    expect(h.impressionShare?.share).toBe(8);
    // Non-brand only: 8 / 400 = 2%, under lead gen's 5%; CTR 400 / 20000 = 2%
    expect(h.conversionRate).toBe(2);
    expect(h.ctr).toBe(2);
    expect(h.flags.map((f) => f.key).sort()).toEqual(["brand_share", "conversion_rate", "ctr", "impression_share"]);
  });

  it("stays quiet on a healthy account", () => {
    const h = googleHealth([row("Brand", 50, 500, 100, 20), row("Generic", 1950, 5000, 400, 30, { share: 0.4 })], "lead_gen");
    expect(h.flags).toEqual([]);
  });
});

describe("Trending toward the target", () => {
  it("reads the gap and the direction together", () => {
    expect(successOf("good", "steady", 0)).toBe("on_track");
    expect(successOf("good", "slipping", 0.2)).toBe("close");
    expect(successOf("close", "improving", null)).toBe("on_track");
    expect(successOf("off", "improving", -0.2)).toBe("close");
    expect(successOf("off", "steady", 0.05)).toBe("off_track");
    expect(successOf("setup", null, null)).toBe(null);
  });
});
