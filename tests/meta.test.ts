import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { totals } = await import("@/lib/context/meta");

const day = (spend: number, impressions: number, linkClicks: number, purchases: number, value: number, views3s = 0, thruplays = 0) => ({
  date_start: "2026-10-01",
  date_stop: "2026-10-01",
  spend: String(spend),
  impressions: String(impressions),
  reach: String(Math.round(impressions / 2)),
  clicks: String(linkClicks * 2),
  inline_link_clicks: String(linkClicks),
  actions: [
    { action_type: "omni_purchase", value: String(purchases) },
    { action_type: "link_click", value: String(linkClicks) },
    { action_type: "video_view", value: String(views3s) },
  ],
  action_values: [{ action_type: "omni_purchase", value: String(value) }],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: String(thruplays) }],
});

describe("Meta totals", () => {
  it("sums days and works out cost per purchase, ROAS and rates", () => {
    const t = totals([day(100, 10_000, 200, 2, 150, 3000, 900), day(50, 5_000, 100, 1, 60, 1000, 300)]);
    expect(t.spend).toBe(150);
    expect(t.result).toBe("purchase");
    expect(t.results).toBe(3);
    expect(t.costPerResult).toBe(50);
    expect(t.roas).toBe(1.4); // 210 / 150
    expect(t.linkCtr).toBe(2); // 300 / 15,000
    expect(t.cpc).toBe(0.5);
    expect(t.cpm).toBe(10);
    expect(t.hookRate).toBe(26.67); // 4,000 3-second views / 15,000 impressions
    expect(t.holdRate).toBe(30); // 1,200 ThruPlays / 4,000 views
  });
  it("falls back to link clicks when nothing converts", () => {
    const t = totals([{ date_start: "x", date_stop: "x", spend: "20", impressions: "1000", actions: [{ action_type: "link_click", value: "40" }] }]);
    expect(t.result).toBe("link click");
    expect(t.costPerResult).toBe(0.5);
    expect(t.roas).toBeNull();
  });
});
