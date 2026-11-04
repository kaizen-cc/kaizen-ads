import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/live", () => ({ LIVE: ["active"], isLive: () => true }));

import { completeDays, pickType } from "@/lib/kpi/calc";
import { actionMap, conversionFor, countPurchases, countResult, reportedType } from "@/lib/kpi/conversions";
import { withAttribution } from "@/lib/context/meta";
import { detect } from "@/lib/fatigue";
import { videoMetrics, videoTone } from "@/lib/kpi/video";

describe("video metrics", () => {
  it("hook rate is 3-second views per impression; watch time is weighted by plays and shown against the video's length", () => {
    const days = [
      { impressions: "1000", actions: [{ action_type: "video_view", value: "350" }], video_play_actions: [{ action_type: "video_view", value: "800" }], video_avg_time_watched_actions: [{ action_type: "video_view", value: "4" }] },
      { impressions: "1000", actions: [{ action_type: "video_view", value: "250" }], video_play_actions: [{ action_type: "video_view", value: "200" }], video_avg_time_watched_actions: [{ action_type: "video_view", value: "9" }] },
    ];
    const v = videoMetrics(days, 12);
    expect(v.hookRate).toBe(30);
    // (4 x 800 + 9 x 200) / 1000 = 5s of 12s
    expect(v.avgWatchSec).toBe(5);
    expect(v.watchPct).toBe(41.7);
    expect(videoMetrics(days).watchPct).toBeNull();
    expect(videoMetrics([{ impressions: "500" }]).hookRate).toBeNull();
  });

  it("colors against the lines", () => {
    expect(videoTone(30, 30)).toBe("ok");
    expect(videoTone(22, 30)).toBe("warn");
    expect(videoTone(10, 30)).toBe("bad");
    expect(videoTone(null, 30)).toBeNull();
  });
});

// One real purchase as Meta reports it: the same purchase under every alias
const ONE_PURCHASE = [
  { action_type: "purchase", value: "1" },
  { action_type: "omni_purchase", value: "1" },
  { action_type: "onsite_web_purchase", value: "1" },
  { action_type: "web_in_store_purchase", value: "1" },
  { action_type: "onsite_web_app_purchase", value: "1" },
  { action_type: "web_app_in_store_purchase", value: "1" },
  { action_type: "offsite_purchase_add_20_s_calls", value: "1" },
  { action_type: "offsite_conversion.fb_pixel_purchase", value: "1" },
  { action_type: "link_click", value: "20" },
];

describe("the purchase counter", () => {
  it("counts one purchase once, never adding its aliases together", () => {
    expect(countPurchases([actionMap(ONE_PURCHASE)])).toBe(1);
    expect(countResult([actionMap(ONE_PURCHASE), actionMap(ONE_PURCHASE), {}]).count).toBe(2);
  });

  it("picks one type for the whole period, best first", () => {
    const days: Record<string, number>[] = [{ purchase: 2, "offsite_conversion.fb_pixel_purchase": 2 }, { omni_purchase: 1, purchase: 1 }];
    // omni_purchase is reported (on one day), so it's the type for every day: 0 + 1, not 2 + 1
    expect(countResult(days)).toEqual({ type: "omni_purchase", count: 1 });
    // An account that only reports the pixel event is still counted
    expect(countResult([{ "offsite_conversion.fb_pixel_purchase": 3 }])).toEqual({ type: "offsite_conversion.fb_pixel_purchase", count: 3 });
    expect(countResult([{ link_click: 9 }])).toEqual({ type: null, count: 0 });
    expect(reportedType([{ lead: 1 }], ["offsite_conversion.fb_pixel_lead", "lead"])).toBe("lead");
  });

  it("reads Meta's list and a ready map the same", () => {
    expect(actionMap(ONE_PURCHASE).omni_purchase).toBe(1);
    expect(actionMap({ omni_purchase: "2" }).omni_purchase).toBe(2);
    expect(actionMap(null)).toEqual({});
  });

  it("is what the KPI board picks", () => {
    const days = [{ date: "2026-11-01", spend: 10, actions: actionMap(ONE_PURCHASE), values: {} }];
    expect(pickType(days, conversionFor("purchases"))).toBe("omni_purchase");
  });
});

describe("windows", () => {
  it("are complete days ending yesterday in New York, like Ads Manager's last 7 days", () => {
    // Nov 4, 4pm New York: last 7 days = Oct 28 to Nov 3
    expect(completeDays(7, new Date("2026-11-04T21:00:00Z"))).toEqual({ from: "2026-10-28", to: "2026-11-03" });
    // Just past midnight UTC is still Nov 2 in New York: the window doesn't jump a day early
    expect(completeDays(7, new Date("2026-11-03T00:35:00Z"))).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(completeDays(21, new Date("2026-11-04T21:00:00Z"), 7)).toEqual({ from: "2026-10-07", to: "2026-10-27" });
  });

  it("asks Meta for 7-day click, 1-day view on every account insights request", () => {
    expect(withAttribution("act_123/insights", { fields: "actions" }).action_attribution_windows).toBe('["7d_click","1d_view"]');
    expect(withAttribution("123/insights", {}).action_attribution_windows).toBeUndefined();
    expect(withAttribution("act_123/insights", { action_attribution_windows: '["1d_click"]' }).action_attribution_windows).toBe('["1d_click"]');
  });
});

// The Sierra Dreams ad from the plan card: "Post ID: 122145264584900275 | All Align Product Page | Sept 25"
// (meta_ad_daily, ad 120251202900460060). Ads Manager, Oct 28 to Nov 3: 2 purchases at $299.
const SPEND: Record<string, number> = {
  "2026-10-26": 120.41,
  "2026-10-27": 118.46,
  "2026-10-28": 1.58,
  "2026-10-29": 118.32,
  "2026-10-30": 87.36,
  "2026-10-31": 66.4,
  "2026-11-01": 156.07,
  "2026-11-02": 71.48,
  "2026-11-03": 97.88,
};
const BOUGHT = new Set(["2026-10-26", "2026-10-31", "2026-11-02"]);

function row(date: string, spend: number, purchase: boolean) {
  return {
    date,
    ad_id: "120251202900460060",
    ad_name: "Post ID: 122145264584900275  | All Align Product Page | Sept 25",
    campaign_name: "Advantage + | ABO | Purchase | 7/6/26",
    adset_name: "ADV | IG Post  | Sept 25",
    metrics: { date_start: date, date_stop: date, spend: String(spend), impressions: String(Math.round(spend * 10)), reach: String(Math.round(spend * 9)), clicks: "10", inline_link_clicks: String(Math.round(spend / 5)), actions: purchase ? ONE_PURCHASE : [] },
  };
}
// Three weeks before it at a steadier CTR, with purchases
const before = Array.from({ length: 21 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 5 + i, 12)).toISOString().slice(0, 10);
  return { ...row(d, 100, i % 5 === 0), metrics: { ...row(d, 100, i % 5 === 0).metrics, inline_link_clicks: "40" } };
});

describe("the fatigue watcher's last 7 days (where the plan card's number came from)", () => {
  it("matches Ads Manager: Oct 28 to Nov 3 is 2 purchases at $299.55, not $598", () => {
    const rows = [...before, ...Object.entries(SPEND).map(([d, s]) => row(d, s, BOUGHT.has(d))), row("2026-11-04", 51.63, false)];
    const [f] = detect("client", rows, new Date("2026-11-04T21:00:00Z"));
    expect(f.signals.results7).toBe(2);
    expect(f.signals.spend7).toBe(599.09);
    expect(f.signals.cprNow).toBeCloseTo(299.55, 1);
  });

  it("leaves today's part day out (its spend is in, its purchases aren't yet)", () => {
    // The run the audit read, Nov 2: Nov 2 had $50.15 spent so far and its purchase hadn't landed. Counting that part
    // day in "this week" gave $548.19 + $50.15 = $598.34 over 1 purchase.
    const rows = [...before, ...Object.entries(SPEND).filter(([d]) => d < "2026-11-02").map(([d, s]) => row(d, s, BOUGHT.has(d))), row("2026-11-02", 50.15, false)];
    const [f] = detect("client", rows, new Date("2026-11-02T22:20:00Z"));
    // Oct 26 to Nov 1, complete days: $668.60 over 2 purchases
    expect(f.signals.spend7).toBe(668.6);
    expect(f.signals.results7).toBe(2);
    expect(f.signals.cprNow).toBe(334.3);
  });
});
