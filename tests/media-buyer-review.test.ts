import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/live", () => ({ LIVE: ["active"], isLive: () => true }));

import { fillObjects, metaIndex, namedIn } from "@/lib/audit-objects";
import { objectLink } from "@/lib/chat-change-core";
import { withAttribution } from "@/lib/context/meta";
import { CONVERSIONS_READ_FROM, META_READ_FROM, REPORT_TIME_READ_FROM } from "@/lib/kpi/conversions";
import { videoMetrics, watchFromQuartiles } from "@/lib/kpi/video";
import { adSortParam, nextAdSort, parseAdSort, sortAds } from "@/lib/kpi/ad-sort";

// The head media buyer's review (Nov 4): links to the exact object, Ads Manager's numbers, video columns.

const rows = [
  { ad_id: "901", ad_name: "UGC Hook v2", adset_id: "801", adset_name: "Broad", campaign_id: "701", campaign_name: "Prospecting | Purchase", metrics: { spend: 300 } },
  { ad_id: "120000902", ad_name: "Static Offer", adset_id: "802", adset_name: "Broad | Purchase", campaign_id: "701", campaign_name: "Prospecting | Purchase", metrics: { spend: 100 } },
  { ad_id: "903", ad_name: "Ad", adset_id: "802", adset_name: "Broad | Purchase", campaign_id: "701", campaign_name: "Prospecting | Purchase", metrics: { spend: 50 } },
];

describe("Open in Ads Manager on moves written before they listed objects", () => {
  const index = metaIndex("act_123", rows);

  it("finds the exact names a move's text mentions, longest first, never a shorter name inside a longer one", () => {
    const found = namedIn(index, 'Pause "UGC Hook v2" and move $50/day into Broad | Purchase.');
    expect(found.map((o) => `${o.type}:${o.id}`)).toEqual(["adset:802", "ad:901"]);
    // "Broad" on its own is the other ad set
    expect(namedIn(index, "Raise Broad to $150/day").map((o) => o.id)).toEqual(["801"]);
    // Too short to trust ("Ad"), and names inside other words don't count
    expect(namedIn(index, "Ad fatigue on Broadway")).toEqual([]);
    // An [id] copied from the numbers counts when it's real
    expect(namedIn(index, "Cut ad [120000902] today").map((o) => o.id)).toEqual(["120000902"]);
  });

  it("links straight to the object in Ads Manager", () => {
    const [o] = namedIn(index, "Pause UGC Hook v2");
    expect(objectLink(o)).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=901");
    const [c] = namedIn(index, "Prospecting | Purchase budget to $300/day");
    expect(objectLink(c)).toBe("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=701");
    const [s] = namedIn(index, "Raise Broad");
    expect(objectLink(s)).toBe("https://adsmanager.facebook.com/adsmanager/manage/adsets?act=123&selected_adset_ids=801");
  });

  it("fills only moves without objects, and says which", () => {
    const kept = [{ type: "ad" as const, platform: "meta" as const, id: "1", name: "x", account: "123" }];
    const { moves, filled } = fillObjects(index, [
      { title: "Pause UGC Hook v2", steps: [], objects: [] },
      { title: "Pause UGC Hook v2", steps: [], objects: kept },
      { title: "Fix the pixel", steps: ["Check the purchase event"], objects: null },
    ]);
    expect(filled).toEqual([0]);
    expect(moves[0].objects?.[0].id).toBe("901");
    expect(moves[1].objects).toBe(kept);
    expect(moves[2].objects).toBeNull();
  });
});

describe("numbers that match Ads Manager", () => {
  it("books each purchase on its impression's day, with 7-day click and 1-day view, unless a caller asks otherwise", () => {
    const p = withAttribution("act_123/insights", { fields: "actions" });
    expect(p.action_report_time).toBe("impression");
    expect(p.action_attribution_windows).toBe('["7d_click","1d_view"]');
    expect(withAttribution("act_123/insights", { action_report_time: "conversion" }).action_report_time).toBe("conversion");
    expect(withAttribution("123/insights", {}).action_report_time).toBeUndefined();
  });

  it("reads every account again in full once after the report-time change", () => {
    expect(META_READ_FROM).toBe(REPORT_TIME_READ_FROM);
    expect(META_READ_FROM > CONVERSIONS_READ_FROM).toBe(true);
  });
});

describe("video columns", () => {
  const day = (o: Record<string, number>) => ({
    impressions: String(o.imp),
    actions: [{ action_type: "video_view", value: String(o.v3) }],
    video_play_actions: [{ action_type: "video_view", value: String(o.plays) }],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: String(o.thru) }],
    video_p25_watched_actions: [{ action_type: "video_view", value: String(o.p25) }],
    video_p50_watched_actions: [{ action_type: "video_view", value: String(o.p50) }],
    video_p75_watched_actions: [{ action_type: "video_view", value: String(o.p75) }],
    video_p100_watched_actions: [{ action_type: "video_view", value: String(o.p100) }],
  });

  it("hold rate is ThruPlays per 3-second view; watched is estimated from completion counts without the video's length", () => {
    const v = videoMetrics([day({ imp: 1000, v3: 300, plays: 800, thru: 90, p25: 400, p50: 200, p75: 100, p100: 40 })]);
    expect(v.hookRate).toBe(30);
    expect(v.holdRate).toBe(30);
    expect(v.watchEstimated).toBe(true);
    // Still watching: 100%, 50%, 25%, 12.5%, 5% at each quarter
    expect(v.watchPct).toBe(watchFromQuartiles(800, [400, 200, 100, 40]));
    expect(v.watchPct).toBeCloseTo(0.25 * ((1 + 0.5) / 2 + (0.5 + 0.25) / 2 + (0.25 + 0.125) / 2 + (0.125 + 0.05) / 2) * 100, 0);
  });

  it("uses the real length when known, and nothing for an ad that isn't video", () => {
    const v = videoMetrics([{ ...day({ imp: 1000, v3: 300, plays: 800, thru: 90, p25: 400, p50: 200, p75: 100, p100: 40 }), video_avg_time_watched_actions: [{ action_type: "video_view", value: "6" }] }], 12);
    expect(v.watchPct).toBe(50);
    expect(v.watchEstimated).toBe(false);
    const still = videoMetrics([{ impressions: "500" }]);
    expect([still.hookRate, still.holdRate, still.watchPct]).toEqual([null, null, null]);
    expect(watchFromQuartiles(0, [0, 0, 0, 0])).toBeNull();
  });
});

describe("sorting Ads this week", () => {
  const ad = (id: string, spend: number, value: number | null, hookRate: number | null) => ({ id, spend, results: 1, value, ctr: 1, hookRate, holdRate: null, watchPct: null });
  const ads = [ad("a", 100, 50, 20), ad("b", 300, 20, null), ad("c", 200, null, 40)];

  it("sorts best first, ads without a value last", () => {
    expect(sortAds(ads, parseAdSort(null, false)).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(sortAds(ads, parseAdSort("cost", false)).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(sortAds(ads, parseAdSort("cost", true)).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(sortAds(ads, parseAdSort("hook", false)).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortAds(ads, parseAdSort("hook.asc", false)).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("keeps the sort short in the address and flips on a second click", () => {
    const hook = nextAdSort(parseAdSort(null, false), "hook", false);
    expect(adSortParam(hook, false)).toBe("hook");
    expect(adSortParam(nextAdSort(hook, "hook", false), false)).toBe("hook.asc");
    expect(adSortParam(parseAdSort("nonsense", false), false)).toBeNull();
    expect(parseAdSort("cost", false).dir).toBe("asc");
  });
});
