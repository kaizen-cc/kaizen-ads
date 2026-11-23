import { describe, expect, it } from "vitest";
import { emailMetrics, socialMetrics } from "@/lib/channel-reports/core";
import { tidyChannelLayout, tileGroup, tileKeys, tileOptions, tileView } from "@/lib/channel-reports/layout";
import { betterOf, isEventMetric, isMetricKey, metricLabel, metricNumber, tilesFor } from "@/lib/reports/format";
import { adsMetricOptions, groupOptions, searchOptions } from "@/lib/reports/metric-options";
import { weeklyTile } from "@/lib/reports/weekly-core";
import type { Period, ReportMetrics } from "@/lib/reports/metrics";

// The "Show in this tile" picker: every metric the report has data for, searchable, and the PDF showing exactly what's picked.

const per = (spend: number, actions: Record<string, number>): Period => ({ label: "P", start: "2026-11-01", end: "2026-11-07", days: 7, spend, impressions: 10000, clicks: 200, ctr: 2, cpc: 2.5, cpm: 50, results: 10, costPerResult: 50, revenue: 0, roas: null, actions });
const m = {
  conversion: "Leads",
  roasKpi: false,
  main: per(500, { lead: 10, "offsite_conversion.fb_pixel_add_to_cart": 40, landing_page_view: 150, video_view: 900 }),
  compare: per(400, { lead: 8, "offsite_conversion.fb_pixel_add_to_cart": 20, landing_page_view: 100, initiate_checkout: 3 }),
  eventLabels: { lead: "Leads", "offsite_conversion.fb_pixel_add_to_cart": "Adds to cart (pixel)", landing_page_view: "Landing page views" },
} as unknown as ReportMetrics;

describe("event metrics on an ads report", () => {
  it("counts any event and its cost, from the period's own counts", () => {
    expect(metricNumber(m.main, "n:offsite_conversion.fb_pixel_add_to_cart")).toBe(40);
    expect(metricNumber(m.main, "c:offsite_conversion.fb_pixel_add_to_cart")).toBe(12.5);
    expect(metricNumber(m.main, "c:initiate_checkout")).toBeNull();
    expect(metricNumber(m.main, "n:initiate_checkout")).toBe(0);
    // A period drawn before events were kept: unknown, never zero
    expect(metricNumber({ ...m.main, actions: undefined }, "n:lead")).toBeNull();
  });
  it("names them, and knows which way is good", () => {
    expect(metricLabel(m, "n:landing_page_view")).toBe("Landing page views");
    expect(metricLabel(m, "c:lead")).toBe("Cost per lead");
    expect(metricLabel(m, "n:video_view")).toBe("Video view");
    expect(betterOf("n:lead")).toBe("up");
    expect(betterOf("c:lead")).toBe("down");
    expect(betterOf("cpm")).toBe("down");
  });
  it("draws them in the PDF's tiles exactly as picked", () => {
    const t = weeklyTile(m, "c:offsite_conversion.fb_pixel_add_to_cart", m.main, m.compare);
    expect(t).toMatchObject({ label: "Cost per add to cart (pixel)", value: "$12.50", before: "$20.00", move: { tone: "good", up: false } });
    const [tile] = tilesFor(m, ["n:landing_page_view"]);
    expect(tile).toMatchObject({ label: "Landing page views", value: "150", now: 150, before: 100 });
  });
  it("keeps only real metric keys in a layout", () => {
    expect(isEventMetric("n:offsite_conversion.fb_pixel_add_to_cart")).toBe(true);
    expect(isEventMetric("x:lead")).toBe(false);
    expect(isEventMetric("n:<script>")).toBe(false);
    expect(isMetricKey("cpm")).toBe(true);
    expect(isMetricKey("frequency")).toBe(false);
  });
});

describe("the ads picker's options", () => {
  it("offers the standard metrics, then every event counted (busiest first) and its cost", () => {
    const o = adsMetricOptions(m, "meta", "tiles");
    expect(o.find((x) => x.key === "cpc")).toMatchObject({ label: "CPC", group: "Clicks" });
    expect(o.some((x) => x.key === "views_6s")).toBe(false);
    const events = o.filter((x) => x.group === "Events counted");
    expect(events.map((x) => x.key)).toEqual(["n:video_view", "n:landing_page_view", "n:offsite_conversion.fb_pixel_add_to_cart", "n:lead", "n:initiate_checkout"]);
    expect(events[0].hint).toBe("900 this period");
    expect(events.at(-1)?.hint).toBe("None this period");
    expect(o.filter((x) => x.group === "Cost per event")).toHaveLength(5);
  });
  it("keeps the scorecard's columns to the standard metrics", () => {
    expect(adsMetricOptions(m, "meta", "columns").every((x) => !isEventMetric(x.key))).toBe(true);
    expect(adsMetricOptions(m, "tiktok", "columns").some((x) => x.key === "hook_rate")).toBe(true);
  });
  it("finds a metric by the start of any word in its name or group", () => {
    const o = adsMetricOptions(m, "meta", "tiles");
    // The KPI's own cost (Cost per lead) and the lead event's cost
    expect(searchOptions(o, "cost lead").map((x) => x.key)).toEqual(["cost_per_result", "c:lead"]);
    expect(searchOptions(o, "add")[0].key).toBe("n:offsite_conversion.fb_pixel_add_to_cart");
    expect(searchOptions(o, "clicks").map((x) => x.key)).toEqual(expect.arrayContaining(["clicks", "ctr", "cpc"]));
    expect(searchOptions(o, "zzz")).toEqual([]);
    expect(searchOptions(o, "  ")).toHaveLength(o.length);
  });
  it("groups in order of first appearance", () => {
    expect(groupOptions(adsMetricOptions(m, "meta", "tiles")).map((g) => g.group)).toEqual(["Spend and delivery", "Results", "Clicks", "Events counted", "Cost per event"]);
  });
});

const main = { start: "2026-10-01", end: "2026-10-31", label: "October 2026" };
const compare = { start: "2026-09-01", end: "2026-09-30", label: "September 2026" };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const email = emailMetrics({
  kind: "monthly",
  main,
  compare,
  today: "2026-11-02",
  days: range("2026-08-01", "2026-10-31").map((date) => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2 })),
  campaigns: [{ id: "a", name: "Fall sale", channel: "email", sendTime: "2026-10-10T15:00:00Z", subject: "Last chance", recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, unsubscribes: 2, bounced: 5, spamComplaints: 0, revenue: 900, conversions: 10, openRate: 0.4, clickRate: 0.05 }],
  flows: [],
  keyFlows: [],
  profiles: 5000,
  currency: "USD",
  account: "Acme",
});

describe("more email tiles", () => {
  it("offers deliverability, sends and cadence when the report has them", () => {
    const o = tileOptions(email);
    expect(o).toEqual(expect.arrayContaining(["sends", "campaignsSent", "cadence", "unsubRate", "bounceRate"]));
    expect(tileView(email, "unsubRate")).toMatchObject({ label: "Unsubscribe rate", value: "0.20%" });
    expect(tileView(email, "sends")?.label).toBe("Messages sent");
    expect(tileGroup(email, "bounceRate")).toBe("Deliverability");
    expect(tileGroup(email, "openRate")).toBe("Campaigns");
  });
  it("leaves out tiles the report has no numbers for (no store revenue here)", () => {
    expect(tileOptions(email)).not.toContain("storeRevenue");
  });
  it("keeps the new tiles in a layout and draws them", () => {
    expect(tidyChannelLayout("klaviyo", { tiles: ["revenue", "unsubRate", "bogus"] })).toEqual({ tiles: ["revenue", "unsubRate"] });
    expect(tileKeys(email, { tiles: ["unsubRate", "sends"] })).toEqual(["unsubRate", "sends"]);
  });
});

describe("more social tiles", () => {
  const days = (platform: "instagram" | "facebook", base: number) => range("2026-08-01", "2026-10-31").map((date, i) => ({ platform, date, followers: base + i, gained: 5, lost: 2, reach: 200, views: 400, profileViews: 10, engaged: 20, interactions: 10 }));
  const social = socialMetrics({ kind: "monthly", main, compare, days: [...days("instagram", 1000), ...days("facebook", 3000)], posts: [], names: { instagram: "@acme", facebook: "Acme" } });
  it("offers unfollows, the net change and each platform's own numbers", () => {
    const o = tileOptions(social);
    expect(o).toEqual(expect.arrayContaining(["lost", "followerChange", "instagram:reach", "facebook:followers"]));
    expect(tileView(social, "instagram:followers")?.label).toBe("Instagram followers");
    expect(tileGroup(social, "facebook:reach")).toBe("Facebook");
    expect(tileView(social, "lost")).toMatchObject({ label: "Unfollows" });
  });
  it("keeps a platform's tile in a layout", () => {
    expect(tidyChannelLayout("social", { tiles: ["instagram:reach", "instagram:nonsense", "lost"] })).toEqual({ tiles: ["instagram:reach", "lost"] });
  });
});
