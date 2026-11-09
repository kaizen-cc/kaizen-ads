import { describe, expect, it } from "vitest";
import { hookRate } from "@/lib/tiktok/core";
import { activeAds, fameWinners, hookOf, judge, liveWinners, resultLine, sixSecondRate, yardstickFor, type TikTokAdDay, type Yardstick } from "@/lib/tiktok/winners";
import { ideasHref, ideasLine, ideasTab } from "@/lib/ideas-nav";

const DAY = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);

/** An ad's run: one row a day from start for n days, each with these numbers */
function run(ad: string, start: string, n: number, per: Partial<TikTokAdDay> = {}): TikTokAdDay[] {
  return Array.from({ length: n }, (_, i) => ({
    ad_id: ad,
    date: shift(start, i),
    ad_name: `Ad ${ad}`,
    campaign_name: "Prospecting",
    spend: 20,
    impressions: 1000,
    clicks: 10,
    conversions: 1,
    conversion_value: 0,
    purchases: 0,
    video_2s: 300,
    video_6s: 150,
    ...per,
  }));
}

const cpa25: Yardstick = { kind: "cpa", counts: "conversions", target: 25, source: "kpi", label: "Conversions", match: null };
const TODAY = "2026-11-09";

describe("6s view rate (hook rate)", () => {
  it("is 6-second views over impressions, as a percent, matching the client page's hook rate", () => {
    expect(sixSecondRate(150, 1000)).toBe(15);
    expect(sixSecondRate(1, 3)).toBe(33.33);
    expect(sixSecondRate(1, 3)).toBe(hookRate(1, 3));
    expect(sixSecondRate(5, 0)).toBeNull();
  });
  it("is added up over the run, not averaged per day", () => {
    const days = [...run("a", "2026-10-01", 1, { impressions: 1000, video_6s: 500 }), ...run("a", "2026-10-02", 1, { impressions: 9000, video_6s: 0 })];
    expect(judge("a", days, cpa25)?.sixSecRate).toBe(5);
  });
});

describe("the yardstick", () => {
  it("takes the client's TikTok KPI target first", () => {
    expect(yardstickFor({ conversion: "tiktok_conversions", target: "30", campaign_match: "" }, null)).toMatchObject({ kind: "cpa", counts: "conversions", target: 30, source: "kpi", match: null });
    expect(yardstickFor({ conversion: "tiktok_purchases", target: 40 }, null)).toMatchObject({ kind: "cpa", counts: "purchases" });
    expect(yardstickFor({ conversion: "tiktok_roas", target: 2.5, campaign_match: "US" }, null)).toMatchObject({ kind: "roas", counts: "purchases", target: 2.5, match: "US" });
  });
  it("falls back to the sub-vertical's good cost per result when the target is clicks or missing", () => {
    const sub = { conversion: "Booked appointments", benchmarks: [{ metric: "cost_per_result", good: 45 }] };
    expect(yardstickFor({ conversion: "tiktok_clicks", target: 1 }, sub)).toMatchObject({ kind: "cpa", counts: "conversions", target: 45, source: "benchmark" });
    expect(yardstickFor(null, { conversion: "Online purchases", benchmarks: [{ metric: "cost_per_result", good: 30 }] })).toMatchObject({ counts: "purchases", target: 30 });
  });
  it("is null with nothing to judge against", () => {
    expect(yardstickFor(null, null)).toBeNull();
    expect(yardstickFor({ conversion: "tiktok_conversions", target: null }, { conversion: "Leads", benchmarks: [] })).toBeNull();
  });
});

describe("TikTok Hall of Fame", () => {
  it("takes an ad that ran 30+ days, spent $300+, got 5+ results and beat its target", () => {
    // 35 days at $20 and 1 conversion a day: $20 per conversion vs a $25 target, 20% better
    const w = fameWinners(run("a", "2026-09-01", 35), cpa25, TODAY);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ adId: "a", daysLive: 35, spend: 700, results: 35, value: 20, beatBy: 0.2, sixSecRate: 15 });
  });
  it("leaves out ads that ran under 30 days, spent under $300, got under 5 results or missed the target", () => {
    const days = [
      ...run("short", "2026-10-01", 29),
      ...run("cheap", "2026-09-01", 31, { spend: 5 }),
      ...run("few", "2026-09-01", 31, { conversions: 0 }).map((d, i) => (i < 4 ? { ...d, conversions: 1 } : d)),
      ...run("missed", "2026-09-01", 31, { spend: 30 }),
    ];
    expect(fameWinners(days, cpa25, TODAY)).toEqual([]);
  });
  it("counts the run from the first to the last day with spend", () => {
    const days = [...run("a", "2026-09-01", 1), ...run("a", "2026-10-05", 1, { spend: 0 }), ...run("a", "2026-09-30", 1, { spend: 300, conversions: 20 })];
    expect(judge("a", days, cpa25)?.daysLive).toBe(30);
  });
  it("keeps a winner six months after it last ran, then drops it", () => {
    const old = run("a", "2026-03-01", 40);
    expect(fameWinners(old, cpa25, "2026-10-01")).toHaveLength(1);
    expect(fameWinners(old, cpa25, "2026-10-15")).toHaveLength(0);
  });
  it("judges a ROAS target on purchase value, at or above it, without a result minimum", () => {
    const roas: Yardstick = { kind: "roas", counts: "purchases", target: 2, source: "kpi", label: "Purchases", match: null };
    const days = [...run("good", "2026-09-01", 31, { conversion_value: 50 }), ...run("weak", "2026-09-01", 31, { conversion_value: 30 })];
    const w = fameWinners(days, roas, TODAY);
    expect(w.map((x) => x.adId)).toEqual(["good"]);
    expect(w[0]).toMatchObject({ value: 2.5, beatBy: 0.25 });
  });
  it("only reads the campaigns the KPI card covers", () => {
    const days = run("a", "2026-09-01", 35, { campaign_name: "Retargeting" });
    expect(fameWinners(days, { ...cpa25, match: "prospect" }, TODAY)).toEqual([]);
    expect(fameWinners(days, { ...cpa25, match: "retarget" }, TODAY)).toHaveLength(1);
  });
  it("puts the ones that beat their target most first", () => {
    const days = [...run("ok", "2026-09-01", 31, { spend: 24 }), ...run("best", "2026-09-01", 31, { spend: 10 })];
    expect(fameWinners(days, cpa25, TODAY).map((w) => w.adId)).toEqual(["best", "ok"]);
  });
});

describe("TikTok live winners", () => {
  const recent = (ad: string, per: Partial<TikTokAdDay> = {}) => run(ad, shift(TODAY, -13), 14, per);
  it("takes active ads beating the target over the last 14 days only", () => {
    // Bad before the window, good inside it
    const days = [...run("a", "2026-09-01", 40, { spend: 100 }), ...recent("a", { spend: 10 })];
    const w = liveWinners(days, cpa25, new Set(["a"]), TODAY);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ spend: 140, results: 14, value: 10 });
  });
  it("leaves out ads that aren't running, spent under $100 or got under 3 results", () => {
    const days = [...recent("paused"), ...recent("cheap", { spend: 5 }), ...recent("few", { conversions: 0 })];
    expect(liveWinners(days, cpa25, new Set(["cheap", "few"]), TODAY)).toEqual([]);
    expect(liveWinners(recent("paused"), cpa25, new Set(), TODAY)).toEqual([]);
  });
  it("counts an ad as running when it's switched on and spent in the last 3 days", () => {
    const days = [...run("on", shift(TODAY, -1), 1), ...run("off", shift(TODAY, -1), 1), ...run("stale", shift(TODAY, -5), 1), ...run("unlisted", TODAY, 1)];
    const ads = [
      { ad_id: "on", status: "ENABLE" },
      { ad_id: "off", status: "DISABLE" },
      { ad_id: "stale", status: "ENABLE" },
    ];
    expect([...activeAds(ads, days, TODAY)].sort()).toEqual(["on", "unlisted"]);
  });
});

describe("cards", () => {
  it("takes the hook from the ad text's first sentence", () => {
    expect(hookOf("Stop scrolling if you hate dishes! We fixed it. Shop now")).toBe("Stop scrolling if you hate dishes!");
    expect(hookOf("  no punctuation here  ")).toBe("no punctuation here");
    expect(hookOf(null)).toBeNull();
    expect(hookOf("x".repeat(200))?.length).toBe(120);
  });
  it("says the result against the target", () => {
    expect(resultLine({ roas: false, value: 18.2, target: 25, targetSource: "kpi", conversion: "Conversions" })).toBe("$18.2 vs $25 target per conversion");
    expect(resultLine({ roas: true, value: 3.1, target: 2.5, targetSource: "benchmark", conversion: "Purchases" })).toBe("3.10x ROAS vs 2.5x benchmark");
  });
});

describe("Ads Lab platform switch in the address", () => {
  it("opens TikTok only while there's TikTok data", () => {
    expect(ideasLine("tiktok", true)).toBe("tiktok");
    expect(ideasLine("tiktok", false)).toBe("meta");
    expect(ideasLine("google", false)).toBe("google");
    expect(ideasLine(undefined, true)).toBe("meta");
    expect(ideasLine(["tiktok"], true)).toBe("meta");
  });
  it("keeps TikTok to Hall of Fame and Live winners", () => {
    expect(ideasTab("winners", "tiktok")).toBe("winners");
    expect(ideasTab("market", "tiktok")).toBe("fame");
    expect(ideasTab("copy", "tiktok")).toBe("fame");
    expect(ideasTab("market", "meta")).toBe("market");
    expect(ideasTab("nonsense", "google")).toBe("fame");
  });
  it("writes the line (not for Meta), the tab and the client", () => {
    expect(ideasHref("winners", "tiktok", "acme")).toBe("/ideas?line=tiktok&tab=winners&client=acme");
    expect(ideasHref("verticals", "tiktok")).toBe("/ideas?line=tiktok&tab=fame");
    expect(ideasHref("copy", "meta")).toBe("/ideas?tab=copy");
    expect(ideasHref("market", "google", ["x"])).toBe("/ideas?line=google&tab=market");
  });
  it("round-trips: the address written reads back as the same view", () => {
    for (const line of ["meta", "google", "tiktok"] as const)
      for (const tab of ["fame", "winners", "market", "verticals", "copy"] as const) {
        const q = new URL(ideasHref(tab, line), "https://x").searchParams;
        const back = ideasLine(q.get("line") ?? undefined, true);
        expect(back).toBe(line);
        expect(ideasTab(q.get("tab"), back)).toBe(ideasTab(tab, line));
      }
  });
});
