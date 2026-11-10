import { describe, expect, it } from "vitest";
import { adStateText, isRejected, tiktokAuditAgent, tiktokCounts, tiktokDigest, tiktokFatigue, tiktokManagerLink, tiktokSetupChanges, tiktokStats, TIKTOK_FRAMING, type TikTokAuditRow } from "@/lib/tiktok/audit-core";
import { diagnosticsText, isKeyEvent, parseDiagnosis, parsePixels, parsePixelStats, statusWarning, warningKind, withCounts } from "@/lib/tiktok/diagnostics-core";
import { objectLink } from "@/lib/chat-change-core";
import { resolveObjects, tiktokIndex } from "@/lib/audit-objects";
import { inPlatform } from "@/lib/in-platform";
import { isTikTokWinner, tiktokMetricsLine, winnerChip, winnerFoot, winnerMetaAdId, winnerSourceOf } from "@/lib/winner-source";
import { metaAdId, type SavedRef } from "@/lib/saved-references";
import { winningAdBlock } from "@/lib/suggestions";
import { jointNote } from "@/lib/reports/joint-core";
import type { Winner } from "@/lib/industry";

// The TikTok follow-ups: audits (which agent, the numbers, fatigue, the live state, sprint changes, the links to TikTok
// Ads Manager), the pixel and diagnosis parsers, TikTok winners in the request picker, and the joint report notes.

const row = (date: string, ad: string, o: Partial<TikTokAuditRow> = {}): TikTokAuditRow => ({
  date,
  ad_id: ad,
  ad_name: `Ad ${ad}`,
  campaign_id: "c1",
  campaign_name: "Prospecting",
  adgroup_id: "g1",
  adgroup_name: "Broad",
  spend: 50,
  impressions: 10000,
  clicks: 100,
  conversions: 5,
  purchases: 2,
  conversion_value: 200,
  video_2s: 3000,
  video_6s: 2000,
  frequency: 1.2,
  ...o,
});
const day = (n: number) => new Date(Date.parse("2026-11-09T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

describe("TikTok audits: who writes them", () => {
  it("routes to the Meta auditor while the TikTok Ads Buyer is offline, and to tiktok_auditor once it's online", () => {
    expect(tiktokAuditAgent(true)).toBe("auditor");
    expect(tiktokAuditAgent(false)).toBe("tiktok_auditor");
  });
  it("frames the audit for TikTok: hook rate, fatigue, frequency, CPA, structure, read only", () => {
    for (const w of ["hook rate", "fatigue", "frequency", "CPA", "ad groups", "TikTok Ads Manager", "read only"]) expect(TIKTOK_FRAMING).toContain(w);
    expect(TIKTOK_FRAMING).not.toMatch(/—/);
  });
});

describe("TikTok audits: the numbers", () => {
  it("counts the KPI by the card's conversion", () => {
    expect(tiktokCounts("tiktok_roas")).toMatchObject({ roas: true, result: "purchases" });
    expect(tiktokCounts("tiktok_purchases")).toMatchObject({ roas: false, result: "purchases" });
    expect(tiktokCounts(null)).toMatchObject({ roas: false, result: "conversions" });
    const rows = [row(day(1), "a"), row(day(2), "a")];
    expect(tiktokStats(rows, "tiktok_conversions")).toMatchObject({ spend: 100, results: 10, kpi: 10, hook: 20, hold2: 30, ctr: 1, cpm: 5, freq: 1.2 });
    expect(tiktokStats(rows, "tiktok_purchases").kpi).toBe(25);
    expect(tiktokStats(rows, "tiktok_roas").kpi).toBe(4);
    expect(tiktokStats([], "tiktok_conversions")).toMatchObject({ kpi: null, hook: null, ctr: null });
  });

  it("finds tiring creative: the hook rate falling with frequency climbing, not a single bad number", () => {
    const rows: TikTokAuditRow[] = [];
    for (let i = 1; i <= 14; i++) {
      const recent = i <= 7;
      rows.push(row(day(i), "tired", { video_6s: recent ? 1200 : 2000, frequency: recent ? 2.4 : 1.4, conversions: recent ? 3 : 5 }));
      rows.push(row(day(i), "fine"));
      // Hook down but frequency flat and cost steady: not called fatigue on one signal
      rows.push(row(day(i), "dip", { video_6s: recent ? 1500 : 2000 }));
    }
    const f = tiktokFatigue(rows, "tiktok_conversions", day(1));
    expect(f.map((x) => x.adId)).toEqual(["tired"]);
    expect(f[0].why).toMatch(/hook rate 20% → 12%/);
    expect(f[0].why).toMatch(/frequency/);
  });

  it("writes the account for the auditor: windows, weeks, campaigns, ad groups, ads and tiring ads", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(day(i + 1), i % 2 ? "a" : "b"));
    const d = tiktokDigest(rows, "tiktok_conversions", day(1));
    for (const s of ["ACCOUNT (TikTok)", "Last 14 days", "WEEK BY WEEK", "CAMPAIGNS", "AD GROUPS", "Prospecting › Broad", "ADS, last 30 days", "hook rate", "TIRING ADS"]) expect(d.text).toContain(s);
    expect(d).toMatchObject({ ads: 2, campaigns: 1, adgroups: 1, last14: 10, hook: 20 });
    expect(d.text).not.toMatch(/—/);
  });

  it("says which ads are rejected", () => {
    expect(isRejected("AD_STATUS_NOT_PASS")).toBe(true);
    expect(isRejected("AD_STATUS_DELIVERY_OK")).toBe(false);
    const text = adStateText(
      [
        { ad_id: "1", ad_name: "Hook A", campaign_id: "c1", adgroup_id: "g1", status: "ENABLE", secondary_status: "AD_STATUS_DELIVERY_OK" },
        { ad_id: "2", ad_name: "Hook B", campaign_id: "c1", adgroup_id: "g1", status: "ENABLE", secondary_status: "AD_STATUS_NOT_PASS" },
      ],
      () => "Prospecting",
    );
    expect(text).toContain("2 in the account, 2 switched on, 1 rejected");
    expect(text).toContain("Rejected: Hook B (campaign Prospecting)");
  });

  it("sees what changed between two sprint checks", () => {
    const before = { platform: "tiktok" as const, ads: [{ id: "1", name: "A", status: "ENABLE", secondary: null }, { id: "2", name: "B", status: "ENABLE", secondary: null }, { id: "3", name: "C", status: "DISABLE", secondary: null }] };
    const now = { platform: "tiktok" as const, ads: [{ id: "1", name: "A", status: "DISABLE", secondary: null }, { id: "2", name: "B", status: "ENABLE", secondary: "AD_STATUS_NOT_PASS" }, { id: "4", name: "D", status: "ENABLE", secondary: null }] };
    expect(tiktokSetupChanges(before, now)).toEqual(['Ad "A" went from enable to disable', 'Ad "B" was rejected by TikTok', 'New ad "D" (enable)', 'Ad "C" is gone (deleted)']);
    expect(tiktokSetupChanges(null, now)).toEqual([]);
  });
});

describe("TikTok audits: read only, linked to TikTok Ads Manager", () => {
  it("links the account (no unverified per-object deep links)", () => {
    expect(tiktokManagerLink("7012345678901234567")).toBe("https://ads.tiktok.com/i18n/perf/campaign?aadvid=7012345678901234567");
    expect(tiktokManagerLink(null)).toBe("https://ads.tiktok.com/i18n/perf/campaign");
    expect(objectLink({ platform: "tiktok", type: "ad_group", id: "g1", name: "Broad", account: "701" })).toBe("https://ads.tiktok.com/i18n/perf/campaign?aadvid=701");
  });

  it("finds the campaigns, ad groups and ads a move names, in the account's own data", () => {
    const idx = tiktokIndex("701", [row(day(1), "a1", { ad_name: "UGC hook 3" })]);
    const found = resolveObjects(idx, [
      { type: "ad_group", name: "Broad" },
      { type: "adset", name: "Prospecting › Broad" },
      { type: "ad", name: "UGC hook 3" },
      { type: "ad", name: "Made up" },
    ]);
    expect(found.map((o) => `${o.platform}:${o.type}:${o.id}`)).toEqual(["tiktok:ad_group:g1", "tiktok:ad:a1"]);
  });

  it("lists the same kinds of moves as Meta for the checklist", () => {
    expect(inPlatform({ title: "Pause the 3 tired ads", owner: "media_buyer" }, "tiktok")).toBe(true);
    expect(inPlatform({ title: "Fix the pixel's purchase event", area: "tracking", owner: "media_buyer" }, "tiktok")).toBe(false);
    expect(inPlatform({ title: "Anything", owner: "media_buyer", inPlatform: true }, "tiktok")).toBe(true);
  });
});

describe("TikTok pixels and diagnosis, read defensively", () => {
  it("reads pixels and their events, and the event counts in whichever shape TikTok sends", () => {
    const pixels = parsePixels({
      pixels: [
        { pixel_id: 111, pixel_name: "Site pixel", activity_status: "ACTIVE", events: [{ event_type: "COMPLETE_PAYMENT" }, { name: "SUBMIT_FORM" }, { name: "SUBMIT_FORM" }] },
        { pixel_name: "No id" },
        "junk",
      ],
    });
    expect(pixels).toHaveLength(1);
    expect(pixels[0]).toMatchObject({ id: "111", name: "Site pixel", status: "ACTIVE", events: [{ name: "COMPLETE_PAYMENT", count: null }, { name: "SUBMIT_FORM", count: null }] });

    const listed = parsePixelStats({ stats: [{ pixel_id: "111", events: [{ event: "COMPLETE_PAYMENT", count: "12" }, { event_name: "SUBMIT_FORM", total: 0 }] }] });
    expect(listed.get("111")).toEqual([{ name: "COMPLETE_PAYMENT", count: 12 }, { name: "SUBMIT_FORM", count: 0 }]);
    const mapped = parsePixelStats({ list: [{ pixel_id: "111", statistics: { COMPLETE_PAYMENT: 4, PAGE_VIEW: 900 } }] });
    expect(mapped.get("111")).toEqual([{ name: "COMPLETE_PAYMENT", count: 4 }, { name: "PAGE_VIEW", count: 900 }]);
    expect(parsePixelStats(null).size).toBe(0);
    expect(parsePixelStats({ unexpected: true }).size).toBe(0);

    const merged = withCounts(pixels, listed);
    expect(merged[0].events).toEqual([{ name: "COMPLETE_PAYMENT", count: 12 }, { name: "SUBMIT_FORM", count: 0 }]);
  });

  it("reads TikTok's diagnosis from nested suggestions and classifies each warning", () => {
    const w = parseDiagnosis({
      results: [
        {
          adgroup_id: "g1",
          adgroup_name: "Broad",
          diagnosis: {
            diagnosis_time: "2026-11-09 08:00:00",
            suggestions: {
              creative: [{ issue_category: "CREATIVE", title: "Creative fatigue detected on 3 ads in this ad group" }],
              bid_and_budget: [{ suggestion: "Budget is too low to exit the learning phase" }],
              event_track: [{ description: "The pixel event Complete Payment hasn't been received recently" }],
            },
          },
        },
        { adgroup_id: "g1", adgroup_name: "Broad", diagnosis: { suggestions: { creative: [{ title: "Creative fatigue detected on 3 ads in this ad group" }] } } },
      ],
    });
    expect(w.map((x) => [x.kind, x.id, x.name])).toEqual([
      ["creative", "g1", "Broad"],
      ["learning", "g1", "Broad"],
      ["tracking", "g1", "Broad"],
    ]);
    expect(parseDiagnosis(undefined)).toEqual([]);
    expect(parseDiagnosis("nonsense")).toEqual([]);
    expect(warningKind("Ad rejected for policy")).toBe("rejected");
  });

  it("flags learning-limited and rejected objects from their secondary status", () => {
    expect(statusWarning("adgroup", { id: "g1", name: "Broad", secondary_status: "ADGROUP_STATUS_LEARNING_FAIL" })).toMatchObject({ kind: "learning", text: "Learning limited (learning fail)" });
    expect(statusWarning("ad", { id: "a1", name: "Hook", secondary_status: "AD_STATUS_NOT_PASS" })).toMatchObject({ kind: "rejected" });
    expect(statusWarning("adgroup", { id: "g2", name: "Ok", secondary_status: "ADGROUP_STATUS_DELIVERY_OK" })).toBeNull();
  });

  it("says it for the audit: what fires, key events that went quiet, and the warnings", () => {
    expect(isKeyEvent("COMPLETE_PAYMENT")).toBe(true);
    expect(isKeyEvent("PAGE_VIEW")).toBe(false);
    const text = diagnosticsText({
      pixels: [{ id: "111", name: "Site pixel", status: "ACTIVE", lastActive: null, events: [{ name: "PAGE_VIEW", count: 900 }, { name: "COMPLETE_PAYMENT", count: 0 }] }],
      warnings: [{ kind: "learning", level: "adgroup", id: "g1", name: "Broad", text: "Learning limited" }],
      checkedAt: "2026-11-09T10:00:00.000Z",
      errors: [],
    });
    expect(text).toContain("firing over the last 7 days: PAGE_VIEW 900");
    expect(text).toContain("key events with nothing in 7 days: COMPLETE_PAYMENT");
    expect(text).toContain("learning: ad group Broad: Learning limited");
    expect(diagnosticsText(null)).toBe("");
    expect(diagnosticsText({ pixels: [], warnings: [], checkedAt: "x", errors: [] })).toBe("");
  });
});

const winner = (o: Partial<Winner> = {}): Winner => ({
  id: "7300000000000000001",
  client: "Peer Co",
  clientId: "peer",
  clientSlug: "peer-co",
  industry: "home_services",
  detail: "Roofing",
  name: "UGC roof",
  headline: "Your roof is older than you think.",
  text: "Your roof is older than you think. Free inspection this week.",
  thumbnail: "https://p16.tiktokcdn.com/cover.jpg",
  format: "video",
  live: true,
  result: "conversions",
  results: 40,
  costPerResult: 18.2,
  usual: 25,
  ratio: 1.4,
  spend: 728,
  ctr: 1.1,
  syncedAt: "2026-11-08",
  ...o,
});

describe("TikTok winners in the request's winner picker", () => {
  it("keeps a Meta winner as it was", () => {
    const w = winner({ id: "120000000000001" });
    expect(isTikTokWinner(w)).toBe(false);
    expect(winnerSourceOf(w)).toEqual({ adId: w.id, client: "Peer Co", detail: "Roofing", headline: w.headline, text: w.text, thumbnail: w.thumbnail, ratio: 1.4, result: "conversions", costPerResult: 18.2, usual: 25 });
    expect(winnerChip(w)).toBe("1.4x their usual");
    expect(winnerMetaAdId(w)).toBe(w.id);
  });

  it("labels a TikTok winner, carries its numbers and link, and never loads its picture from Meta", () => {
    const w = winner({ platform: "tiktok", sixSecRate: 31.5, link: "https://peer.example/roof", fame: { basis: "kpi", roas: false, days: 42, beatBy: 0.27 } });
    const src = winnerSourceOf(w);
    expect(src).toMatchObject({ platform: "tiktok", link: "https://peer.example/roof", clientId: "peer", thumbnail: w.thumbnail });
    expect(src.metrics).toBe("$18.2 vs $25 target per conversion, 6s view rate 31.5%, $728 spent over 42 days");
    expect(tiktokMetricsLine(w)).toBe(src.metrics);
    expect(winnerChip(w)).toBe("TikTok · 1.4x their target");
    expect(winnerFoot(w)).toBe(src.metrics);
    expect(winnerMetaAdId(w)).toBeNull();
    // The strategist reads it as a TikTok ad
    const block = winningAdBlock(src);
    expect(block).toContain("A winning TikTok ad");
    expect(block).toContain("6s view rate 31.5%");
    expect(block).toContain("Landing page: https://peer.example/roof");
  });

  it("never asks Meta for a saved TikTok winner's picture", () => {
    const saved = (data: Record<string, unknown>): SavedRef => ({ id: "s", clientId: "c", source: "winner", refId: "7300000000000000001", url: null, thumbnail: null, title: null, subtitle: null, format: "video", data, createdAt: "", savedBy: null, savedById: null, motion: null }) as unknown as SavedRef;
    expect(metaAdId(saved({}))).toBe("7300000000000000001");
    expect(metaAdId(saved({ platform: "tiktok" }))).toBeNull();
    expect(metaAdId(saved({ winner: { platform: "tiktok" } }))).toBeNull();
  });
});

describe("Meta + TikTok weekly report notes", () => {
  it("tells the TikTok part it goes out with the Meta report, and who sends it", () => {
    const n = jointNote({ goesWith: { id: "meta-1", owner: "Meta Buyer", status: "draft" }, riders: [] });
    expect(n).toMatchObject({ tone: "info", title: "Goes out with the Meta report, sent by Meta Buyer", link: { href: "/reports/meta-1" } });
    expect(jointNote({ goesWith: { id: "meta-1", owner: null, status: "posted" }, riders: [] })).toMatchObject({ tone: "ok", title: "Sent with the Meta report" });
  });

  it("tells the Meta report it includes TikTok, and warns while that part is still being written", () => {
    expect(jointNote({ goesWith: null, riders: [{ id: "tt-1", platform: "tiktok", status: "draft" }] })).toMatchObject({ tone: "info", title: "Includes TikTok", link: { href: "/reports/tt-1" } });
    expect(jointNote({ goesWith: null, riders: [{ id: "tt-1", platform: "tiktok", status: "drafting" }] })).toMatchObject({ tone: "warn", title: "Includes TikTok" });
    expect(jointNote({ goesWith: null, riders: [{ id: "tt-1", platform: "tiktok", status: "skipped" }] })).toBeNull();
    expect(jointNote(null)).toBeNull();
  });
});
