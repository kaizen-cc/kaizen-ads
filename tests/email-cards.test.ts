import { describe, expect, it } from "vitest";
import { cardCampaigns, cardStats, heat, klaviyoCampaignUrl, locationNamer, locationViews, shareText, tint } from "@/lib/channel-reports/email-cards";
import { locationBreakdown } from "@/lib/klaviyo/locations";

// The email report's campaign cards and location visuals: the brand stripped from location names, the cards picked,
// each number graded against Kaizen's bars, and the shading.

describe("location names", () => {
  it("drops the brand every location starts with, written either way", () => {
    const name = locationNamer(["Crust Pizza Co - Summerwood", "Crust Pizza Co. - Rayford", "Crust Pizza Co. - College Station, TX", "Unknown location"]);
    expect(name("Crust Pizza Co - Summerwood")).toBe("Summerwood");
    expect(name("Crust Pizza Co. - College Station, TX")).toBe("College Station, TX");
    expect(name("Unknown location")).toBe("Unknown location");
  });
  it("keeps names that share nothing", () => {
    const name = locationNamer(["Heights", "Magnolia - North", "Katy"]);
    expect(name("Magnolia - North")).toBe("Magnolia - North");
  });
});

describe("campaign cards", () => {
  const row = (id: string, revenue: number, date: string) => ({ id, revenue, date });
  it("cards every campaign when there are a few, else the best by revenue in send order", () => {
    expect(cardCampaigns([row("a", 1, "2026-11-01"), row("b", 2, "2026-11-02")]).map((r) => r.id)).toEqual(["a", "b"]);
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) => row(id, [5, 80, 1, 60, 2, 70, 90, 3][i], `2026-11-0${i + 1}`));
    expect(cardCampaigns(many, 3).map((r) => r.id)).toEqual(["b", "f", "g"]);
  });
  it("grades open and click against the bars and leaves revenue per recipient ungraded", () => {
    const stats = cardStats({ channel: "email", recipients: 1000, openRate: 0.42, clickRate: 0.008, orders: 10, orderRate: 0.01, revenue: 100 }, "USD");
    const by = Object.fromEntries(stats.map((x) => [x.key, x]));
    expect(by.open.grade).toBe("good");
    expect(by.click.grade).toBe("fair");
    expect(by.rpr.value).toBe("$0.10");
    expect(by.rpr.grade ?? null).toBeNull();
    expect(by.rpr.gauge ?? null).toBeNull();
    expect(by.rpr.sub ?? "").not.toMatch(/bar|0\.15/i);
    expect(by.open.gauge?.mark).toBeCloseTo(0.625);
  });
  it("leaves revenue out when the provider reports none", () => {
    expect(cardStats({ channel: "sms", recipients: 10, openRate: null, clickRate: 0.1, orders: 0, orderRate: null, revenue: 0 }, "USD", false).map((x) => x.key)).toEqual(["recipients", "click"]);
  });
  it("links to the campaign's report in Klaviyo", () => {
    expect(klaviyoCampaignUrl("01ABC")).toBe("https://www.klaviyo.com/campaign/01ABC/reports");
  });
});

describe("location visuals", () => {
  it("ranks, shares and names what earned each location the most", () => {
    const b = locationBreakdown({
      metrics: [{ id: "po", name: "Placed Order" }],
      campaigns: [{ id: "c1", name: "Launch", sendDay: "2026-11-09" }],
      rows: [
        { metricId: "po", date: "2026-11-09", location: "Crust Pizza Co - A", messageId: "c1", campaignId: "c1", flowId: null, conversions: 2, revenue: 100 },
        { metricId: "po", date: "2026-11-09", location: "Crust Pizza Co. - B", messageId: "f", campaignId: null, flowId: "f1", conversions: 1, revenue: 300 },
        { metricId: "po", date: "2026-11-09", location: "Crust Pizza Co. - C", messageId: "c1", campaignId: "c1", flowId: null, conversions: 1, revenue: 50 },
      ],
    })!;
    const v = locationViews(b.metrics[0], 2);
    expect(v.leader?.name).toBe("B");
    expect(v.leader?.best?.id).toBe("flows");
    expect(v.shown).toHaveLength(2);
    expect(v.rest).toEqual({ count: 1, revenue: 50, share: 50 / 450 });
    expect(shareText(v.leader!.share)).toBe("67%");
    expect(v.maxCell).toBe(300);
  });
  it("shades nothing as zero and the biggest cell darkest", () => {
    expect(heat(null, 100)).toBe(0);
    expect(heat(100, 100)).toBeCloseTo(0.9);
    expect(heat(1, 100)).toBeGreaterThan(0.08);
    expect(tint("#000000", 0)).toBe("#ffffff");
    expect(tint("#1f6f8b", 1)).toBe("#1f6f8b");
  });
});
