import { describe, expect, it } from "vitest";
import {
  READ_ONLY_TEXT,
  adDayRow,
  addUp,
  authorizeUrl,
  campaignDayRow,
  checkState,
  chunkRange,
  cpa,
  hookRate,
  isAuthError,
  isRetryable,
  makeState,
  paymentValue,
  roasOf,
  summarize,
  tiktokConfigured,
  tiktokMissing,
  tiktokRedirect,
} from "@/lib/tiktok/core";
import { aggregate, computeSnapshot, toDays } from "@/lib/kpi/calc";
import { CONVERSIONS, conversionFor } from "@/lib/kpi/conversions";
import { asKpiPlatform, dailyTable, defaultConversion, platformLabel } from "@/lib/kpi/platform";
import { metricKeysFor, platformName, tableKeys, tileKeys, formatMetric } from "@/lib/reports/format";
import { jointMessage, tiktokJoins } from "@/lib/reports/joint-core";
import { buyerRole, platformOf, seatRoleFor } from "@/lib/buyer-seats";
import { can, clientPerms } from "@/lib/chat-permissions";
import type { ReportMetrics } from "@/lib/reports/metrics";

const SECRET = "test-app-secret";

describe("TikTok is dormant until its app keys are set", () => {
  it("needs both TIKTOK_APP_ID and TIKTOK_APP_SECRET", () => {
    expect(tiktokConfigured({})).toBe(false);
    expect(tiktokConfigured({ TIKTOK_APP_ID: "123" })).toBe(false);
    expect(tiktokConfigured({ TIKTOK_APP_ID: " ", TIKTOK_APP_SECRET: "x" })).toBe(false);
    expect(tiktokConfigured({ TIKTOK_APP_ID: "123", TIKTOK_APP_SECRET: "abc" })).toBe(true);
    expect(tiktokMissing({ TIKTOK_APP_ID: "123" })).toEqual(["TIKTOK_APP_SECRET"]);
    expect(tiktokMissing({})).toEqual(["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"]);
  });
  it("the redirect is the registered callback, or the override", () => {
    expect(tiktokRedirect("https://ads.kaizenmarketing.agency", {})).toBe("https://ads.kaizenmarketing.agency/api/tiktok/callback");
    expect(tiktokRedirect("http://localhost:3000", { TIKTOK_REDIRECT_URI: "https://x.test/cb" })).toBe("https://x.test/cb");
    const u = new URL(authorizeUrl("777", "st.ate", "https://ads.kaizenmarketing.agency/api/tiktok/callback"));
    expect(u.origin + u.pathname).toBe("https://business-api.tiktok.com/portal/auth");
    expect(u.searchParams.get("app_id")).toBe("777");
    expect(u.searchParams.get("state")).toBe("st.ate");
  });
});

describe("OAuth state", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("accepts the state this browser started, for the same exec, in time", () => {
    const s = makeState(SECRET, "exec-1", now);
    expect(checkState(SECRET, s, s, "exec-1", now + 60_000)).toEqual({ ok: true });
  });
  it("refuses a missing or different cookie, a forged signature, another exec, an expired state", () => {
    const s = makeState(SECRET, "exec-1", now);
    expect(checkState(SECRET, s, null, "exec-1", now).ok).toBe(false);
    expect(checkState(SECRET, s, makeState(SECRET, "exec-1", now), "exec-1", now).ok).toBe(false);
    const [payload] = s.split(".");
    const forged = `${payload}.AAAA`;
    expect(checkState(SECRET, forged, forged, "exec-1", now).ok).toBe(false);
    expect(checkState("another-secret", s, s, "exec-1", now).ok).toBe(false);
    expect(checkState(SECRET, s, s, "exec-2", now).ok).toBe(false);
    const late = checkState(SECRET, s, s, "exec-1", now + 11 * 60_000);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toMatch(/too long/);
  });
});

describe("TikTok's answers", () => {
  it("retries rate limits and server errors, flags auth errors", () => {
    expect(isRetryable(40100)).toBe(true);
    expect(isRetryable(0, 429)).toBe(true);
    expect(isRetryable(0, 503)).toBe(true);
    expect(isRetryable(40002, 200)).toBe(false);
    expect(isAuthError(40105)).toBe(true);
    expect(isAuthError(40100)).toBe(false);
  });
  it("cuts a range into 30-day requests", () => {
    expect(chunkRange("2026-08-12", "2026-11-09", 30)).toEqual([
      { start: "2026-08-12", end: "2026-09-10" },
      { start: "2026-09-11", end: "2026-10-10" },
      { start: "2026-10-11", end: "2026-11-09" },
    ]);
    expect(chunkRange("2026-11-09", "2026-11-01")).toEqual([]);
  });
});

describe("report rows → daily rows", () => {
  const at = "2026-11-09T12:00:00.000Z";
  const metrics = {
    campaign_name: "Prospecting",
    spend: "120.50",
    impressions: "10000",
    clicks: "150",
    conversion: "6",
    complete_payment: "3",
    total_complete_payment_rate: "300.00",
    complete_payment_roas: "2.49",
    video_play_actions: "8000",
    video_watched_2s: "3000",
    video_watched_6s: "1500",
    average_video_play: "3.2",
    reach: "8000",
    frequency: "1.25",
  };
  it("maps a campaign row in the same shape as Meta's and Google's days", () => {
    const r = campaignDayRow("7012", { dimensions: { campaign_id: "1800", stat_time_day: "2026-11-08 00:00:00" }, metrics }, at)!;
    expect(r).toMatchObject({ ad_account_id: "7012", campaign_id: "1800", date: "2026-11-08", campaign_name: "Prospecting", spend: 120.5, impressions: 10000, clicks: 150, link_clicks: 150, conversions: 6, purchases: 3, conversion_value: 300, video_6s: 1500, reach: 8000, frequency: 1.25 });
    expect(r.actions).toMatchObject({ tiktok_conversion: 6, tiktok_complete_payment: 3, tiktok_video_6s: 1500 });
    expect(r.action_values).toEqual({ tiktok_complete_payment: 300 });
  });
  it("skips rows without an id or a day, and reads TikTok's dashes as zero", () => {
    expect(campaignDayRow("7012", { dimensions: { stat_time_day: "2026-11-08 00:00:00" }, metrics }, at)).toBeNull();
    expect(campaignDayRow("7012", { dimensions: { campaign_id: "1", stat_time_day: "" }, metrics }, at)).toBeNull();
    const r = campaignDayRow("7012", { dimensions: { campaign_id: "1", stat_time_day: "2026-11-08 00:00:00" }, metrics: { spend: "-", conversion: "-" } }, at)!;
    expect(r.spend).toBe(0);
    expect(r.conversions).toBe(0);
    expect(r.frequency).toBeNull();
  });
  it("maps an ad row with its campaign and ad group", () => {
    const r = adDayRow("7012", { dimensions: { ad_id: "99", stat_time_day: "2026-11-08 00:00:00" }, metrics: { ...metrics, ad_name: "Hook A", campaign_id: "1800", adgroup_id: "55", adgroup_name: "Broad" } }, at)!;
    expect(r).toMatchObject({ ad_id: "99", ad_name: "Hook A", campaign_id: "1800", adgroup_id: "55", adgroup_name: "Broad", conversions: 6 });
    expect("actions" in r).toBe(false);
  });
  it("purchase value: the total when reported, else ROAS times spend, else value per payment", () => {
    expect(paymentValue({ total_complete_payment_rate: "50", spend: "10" })).toBe(50);
    expect(paymentValue({ complete_payment_roas: "2", spend: "10" })).toBe(20);
    expect(paymentValue({ value_per_complete_payment: "15", complete_payment: "2" })).toBe(30);
    expect(paymentValue({ spend: "10" })).toBe(0);
  });
});

describe("the math", () => {
  it("CPA, ROAS and hook rate never divide by zero", () => {
    expect(cpa(100, 4)).toBe(25);
    expect(cpa(100, 0)).toBeNull();
    expect(roasOf(300, 120)).toBe(2.5);
    expect(roasOf(300, 0)).toBeNull();
    expect(hookRate(1500, 10000)).toBe(15);
    expect(hookRate(10, 0)).toBeNull();
  });
  it("summarizes days", () => {
    const s = summarize(addUp([{ spend: 60, impressions: 5000, clicks: 50, conversions: 2, purchases: 1, conversion_value: 100, video_6s: 500 }, { spend: "40", impressions: "5000", clicks: "50", conversions: "3", purchases: "1", conversion_value: "50", video_6s: "1000" }]));
    expect(s).toMatchObject({ spend: 100, conversions: 5, cpa: 20, purchases: 2, costPerPurchase: 50, value: 150, roas: 1.5, ctr: 1, cpm: 10, views6s: 1500, hookRate: 15 });
  });
  it("the KPI math reads TikTok's days: conversions, purchases and ROAS", () => {
    const at = "2026-11-09T00:00:00Z";
    const rows = ["2026-11-01", "2026-11-02"].map((d, i) => campaignDayRow("7012", { dimensions: { campaign_id: "1", stat_time_day: `${d} 00:00:00` }, metrics: { spend: "100", conversion: String(4 + i * 6), complete_payment: "2", total_complete_payment_rate: "250" } }, at)!);
    const days = toDays(rows, null, null, undefined, "tiktok");
    const conv = conversionFor("tiktok_conversions");
    expect(aggregate(days, conv, "tiktok_conversion")).toEqual({ spend: 200, results: 14, value: 14.29 });
    expect(aggregate(days, conversionFor("tiktok_roas"), "tiktok_complete_payment").value).toBe(2.5);
    // Each campaign's own goal on TikTok is its optimization event
    const goal = toDays(rows, null, null, new Map(), "tiktok");
    expect(goal.reduce((n, d) => n + (d.actions.campaign_goal ?? 0), 0)).toBe(14);
    const snap = computeSnapshot(days, { conversion: "tiktok_conversions", target: 20, budget: null, now: new Date("2026-11-03T15:00:00Z") });
    expect(snap.windows.d3.results).toBe(14);
  });
  it("TikTok has its own conversions on the board", () => {
    const keys = CONVERSIONS.filter((c) => c.platforms.includes("tiktok")).map((c) => c.key);
    expect(keys).toEqual(["tiktok_conversions", "tiktok_purchases", "tiktok_roas", "tiktok_clicks"]);
    expect(defaultConversion("tiktok")).toBe("tiktok_conversions");
    expect(dailyTable("tiktok")).toBe("tiktok_campaign_daily");
    expect(asKpiPlatform("tiktok")).toBe("tiktok");
    expect(asKpiPlatform("other")).toBe("meta");
    expect(platformLabel("tiktok")).toBe("TikTok");
  });
});

describe("TikTok in reports", () => {
  const period = { label: "Nov 2 – Nov 8", start: "2026-11-02", end: "2026-11-08", days: 7, spend: 700, impressions: 70000, clicks: 700, ctr: 1, cpc: 1, cpm: 10, results: 35, costPerResult: 20, revenue: 0, roas: null, views6s: 10500, hookRate: 15 };
  const m = { platform: "tiktok", kind: "weekly", conversion: "Conversions", roasKpi: false, target: 25, monthlyBudget: null, main: period, compare: { ...period, hookRate: 12, views6s: 8400 }, mtd: null, mtdCompare: null, campaigns: [], topAds: [], dataThrough: "2026-11-08", gaps: [] } as unknown as ReportMetrics;
  it("names the platform", () => {
    expect(platformName("tiktok")).toBe("TikTok Ads");
    expect(platformName("google")).toBe("Google Ads");
    expect(platformName("meta")).toBe("Meta Ads");
  });
  it("shows spend, conversions, CPA and the hook rate by default", () => {
    expect(tileKeys(m, null, false)).toEqual(["spend", "results", "cost_per_result", "hook_rate"]);
    expect(tableKeys(m, null)).toContain("views_6s");
    expect(tableKeys({ roasKpi: false, platform: "meta" }, null)).not.toContain("hook_rate");
    expect(metricKeysFor("meta")).not.toContain("hook_rate");
    expect(metricKeysFor("tiktok")).toContain("hook_rate");
    expect(formatMetric("hook_rate", 15)).toBe("15.00%");
  });
  it("joins a client's TikTok part to its Meta report unless they asked for separate reports", () => {
    const targets = [
      { id: "m1", client_id: "a", platform: "meta", owner_id: "kyle" },
      { id: "t1", client_id: "a", platform: "tiktok", owner_id: "sam" },
      { id: "t2", client_id: "b", platform: "tiktok", owner_id: "sam" },
      { id: "m3", client_id: "c", platform: "meta", owner_id: "kyle" },
      { id: "t3", client_id: "c", platform: "tiktok", owner_id: "kyle" },
    ];
    const joins = tiktokJoins(targets, new Set(["c"]));
    expect(joins.get("t1")).toEqual({ metaTargetId: "m1", owner: "kyle" });
    expect(joins.has("t2")).toBe(false); // no Meta report to ride with
    expect(joins.has("t3")).toBe(false); // the client's prefs send them separately
    expect(jointMessage("Meta went well.", [{ platform: "tiktok", message: "TikTok too." }])).toBe("Meta went well.\n\n*TikTok Ads*\nTikTok too.");
    expect(jointMessage("Only Meta.", [{ platform: "tiktok", message: " " }])).toBe("Only Meta.");
  });
});

describe("dormant: nothing runs without the app keys", () => {
  it("the scheduled step, the KPI pull, the client page and the AI brief do nothing", async () => {
    const saved = { id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET };
    delete process.env.TIKTOK_APP_ID;
    delete process.env.TIKTOK_APP_SECRET;
    try {
      const { syncAllTikTok, syncTikTokCampaigns, clientTikTok, tiktokBrief, tiktokConnected, adoptTikTokTargets } = await import("@/lib/tiktok/store");
      // Any database call would throw: none is made
      const admin = new Proxy({}, { get: () => { throw new Error("touched the database"); } }) as never;
      expect(await syncAllTikTok(admin)).toMatchObject({ dormant: true });
      expect(await syncTikTokCampaigns(admin, "7012")).toEqual({ from: "", rows: 0 });
      expect(await clientTikTok(admin, "c")).toBeNull();
      expect(await tiktokBrief(admin, "c")).toBe("");
      expect(await tiktokConnected(admin)).toBe(false);
      expect(await adoptTikTokTargets(admin)).toBe(0);
    } finally {
      if (saved.id) process.env.TIKTOK_APP_ID = saved.id;
      if (saved.secret) process.env.TIKTOK_APP_SECRET = saved.secret;
    }
  });
});

describe("the TikTok seat and permissions", () => {
  it("TikTok's seat is its own, falling back to the Meta buyer", () => {
    expect(buyerRole("tiktok")).toBe("tiktok_buyer");
    expect(platformOf("tiktok_buyer")).toBe("tiktok");
    expect(seatRoleFor([{ client_id: "a", profile_id: "p", role: "meta_buyer" }], "tiktok", "a")).toBe("meta_buyer");
    expect(seatRoleFor([{ client_id: "a", profile_id: "q", role: "tiktok_buyer" }], "tiktok", "a")).toBe("tiktok_buyer");
    expect(seatRoleFor([{ client_id: "b", profile_id: "q", role: "tiktok_buyer" }], "tiktok", "a")).toBe("meta_buyer");
    expect(seatRoleFor([], "google")).toBe("google_buyer");
  });
  it("nobody changes TikTok from Kaizen Ads, not even an exec", () => {
    const v = can({ role: "executive", isExec: true }, "ads.change", { platform: "tiktok" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(READ_ONLY_TEXT);
    // A TikTok seat grants no Meta writes
    expect(clientPerms({ role: "media_buyer" }, ["tiktok"]).change.meta).toBe(false);
  });
});
