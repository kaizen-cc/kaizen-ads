import { describe, expect, it } from "vitest";
import { asRange, daysSince, fatigueWhy, filterAds, freqBand, googleStatus, metaFormat, metaStatus, vsTarget, windowNumbers, DEFAULT_FILTERS, type AdRow } from "@/lib/ad-library/core";

const ad = (o: Partial<AdRow>): AdRow => ({ id: "1", platform: "meta", name: "Ad", campaignId: "c1", campaign: "Leads", adsetId: "s1", adset: "Broad", status: "active", format: "image", thumbnail: null, headline: null, spend: 0, results: 0, cpr: null, ctr: null, cpm: null, frequency: null, impressions: 0, clicks: 0, daysRunning: null, ranInWindow: false, fatigue: null, ...o });

describe("status", () => {
  it("Meta: delivery first, then the ad set's learning", () => {
    expect(metaStatus({ effective_status: "ACTIVE" })).toBe("active");
    expect(metaStatus({ effective_status: "ACTIVE", learning: "LEARNING" })).toBe("learning");
    expect(metaStatus({ effective_status: "ACTIVE", learning: "FAIL" })).toBe("limited");
    expect(metaStatus({ effective_status: "ADSET_PAUSED" })).toBe("paused");
    expect(metaStatus({ effective_status: "DISAPPROVED" })).toBe("rejected");
    expect(metaStatus({ effective_status: "ARCHIVED" })).toBe("ended");
  });
  it("Google", () => {
    expect(googleStatus({ ad: "ENABLED", campaign: "ENABLED" })).toBe("active");
    expect(googleStatus({ ad: "ENABLED", campaign: "PAUSED" })).toBe("paused");
    expect(googleStatus({ ad: "ENABLED", approval: "DISAPPROVED" })).toBe("rejected");
  });
});

describe("numbers", () => {
  it("adds the window up", () => {
    const w = windowNumbers(
      [
        { spend: 50, results: 2, value: 0, impressions: 5000, clicks: 50, reach: 4000 },
        { spend: 50, results: 3, value: 0, impressions: 5000, clicks: 70, reach: 4000 },
      ],
      false,
    );
    expect(w).toMatchObject({ spend: 100, results: 5, cpr: 20, ctr: 1.2, cpm: 10, frequency: 1.25 });
  });
  it("against the KPI target, cost and ROAS", () => {
    expect(vsTarget(20, 25, false)).toEqual({ pct: 0.25, good: true });
    expect(vsTarget(50, 25, false)?.good).toBe(false);
    expect(vsTarget(3, 2, true)).toEqual({ pct: 0.5, good: true });
    expect(vsTarget(null, 25, false)).toBeNull();
  });
  it("frequency bands", () => {
    expect(freqBand(1.1)?.band).toBe("tof");
    expect(freqBand(1.7)).toMatchObject({ band: "mof", tone: "warn" });
    expect(freqBand(2.4)).toMatchObject({ band: "bof", tone: "bad" });
    expect(freqBand(null)).toBeNull();
  });
  it("fatigue reason", () => {
    expect(fatigueWhy({ ctrChange: -0.3, cprChange: 0.4, freqNow: 2.6 })).toBe("CTR down 30%, cost per result up 40%, frequency 2.6");
  });
  it("days, ranges, formats", () => {
    expect(daysSince("2026-11-01T12:00:00Z", new Date("2026-11-24T12:00:00Z"))).toBe(23);
    expect(asRange("14")).toBe(14);
    expect(asRange("9")).toBe(7);
    expect(metaFormat("VIDEO")).toBe("video");
    expect(metaFormat("SHARE", 4)).toBe("carousel");
  });
});

describe("the list", () => {
  const ads = [ad({ id: "a", spend: 10 }), ad({ id: "b", spend: 90, status: "paused", ranInWindow: true }), ad({ id: "c", spend: 50, fatigue: { severity: "tiring", why: "CTR down" }, format: "video", name: "Holiday hook" }), ad({ id: "d", status: "paused" })];
  it("active by default, by spend", () => {
    expect(filterAds(ads, DEFAULT_FILTERS).map((a) => a.id)).toEqual(["c", "a"]);
  });
  it("recently paused, all, tiring, format, search", () => {
    expect(filterAds(ads, { ...DEFAULT_FILTERS, status: "recent" }).map((a) => a.id)).toEqual(["b", "c", "a"]);
    expect(filterAds(ads, { ...DEFAULT_FILTERS, status: "all" })).toHaveLength(4);
    expect(filterAds(ads, { ...DEFAULT_FILTERS, tiring: true }).map((a) => a.id)).toEqual(["c"]);
    expect(filterAds(ads, { ...DEFAULT_FILTERS, format: "video" }).map((a) => a.id)).toEqual(["c"]);
    expect(filterAds(ads, { ...DEFAULT_FILTERS, q: "holíday" }).map((a) => a.id)).toEqual(["c"]);
  });
});
