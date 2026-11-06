import { describe, expect, it } from "vitest";
import { aggregateCopy, aggregateGoogleCopy, badgeOf, buildCopyContext, filterCopy, limitOf, lineKey, linesOf, wantsCopy, wantsGoogle, type GoogleAssetRow, type LedgerAd } from "@/lib/copy-library-core";
import { analyzeGoogleCopy } from "@/lib/google-creative-core";
import { gapsOf, rankCreatives, type AdInput } from "@/lib/creative-analysis-core";
import { inScope, scopeRows } from "@/lib/kpi/scope";

const ad = (key: string, detail: LedgerAd["detail"], n: Partial<LedgerAd> = {}): LedgerAd => ({ key, clientId: "c1", detail, spend: 100, results: 5, revenue: 0, impressions: 10_000, clicks: 100, first_seen: "2026-09-01", last_seen: "2026-10-01", live: false, ...n });
const cpaKpi = { roas: false, target: 20, label: "purchases" };

describe("the Copy library", () => {
  it("counts every line an ad ran once, including a dynamic ad's versions", () => {
    const lines = linesOf({ text: "Fresh never frozen", texts: ["Fresh never frozen", "Dinner in 10"], headline: "Order now", headlines: ["order  NOW"], description: "Free delivery" });
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["primary:Fresh never frozen", "primary:Dinner in 10", "headline:Order now", "description:Free delivery"]);
  });

  it("adds a line up across the ads that used it, whatever its spacing or case", () => {
    const out = aggregateCopy([ad("1", { headline: "Order Now" }, { spend: 60, results: 3, clicks: 30, impressions: 3000 }), ad("2", { headline: "order   now" }, { spend: 40, results: 2, clicks: 20, impressions: 2000 })], cpaKpi);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "headline", ads: 2, spend: 100, results: 5, cpa: 20, ctr: 1, days: 31 });
    expect(out[0].adIds).toEqual(["1", "2"]);
    expect(lineKey("headline", "Order Now")).toBe(lineKey("headline", " order now "));
  });

  it("badges against the target: winner, solid, not proven, and tired when its ads wear out", () => {
    const lines = aggregateCopy(
      [
        ad("w", { text: "Winner line" }, { spend: 150, results: 10 }), // $15 vs $20
        ad("s", { text: "Solid line" }, { spend: 110, results: 5 }), // $22: within 20%
        ad("l", { text: "Losing line" }, { spend: 200, results: 4 }), // $50
        ad("u", { text: "New line" }, { spend: 20, results: 1 }), // too little to judge
        ad("t", { text: "Tired line" }, { spend: 120, results: 8 }), // $15 but wearing out
      ],
      cpaKpi,
      new Set(["t"]),
    );
    const by = Object.fromEntries(lines.map((l) => [l.text, l.badge]));
    expect(by).toEqual({ "Winner line": "winner", "Solid line": "solid", "Losing line": "unproven", "New line": "unproven", "Tired line": "tired" });
    // Ranked: winners, then solid, then tired, then the rest
    expect(lines.map((l) => l.badge)).toEqual(["winner", "solid", "tired", "unproven", "unproven"]);
  });

  it("judges ROAS clients on ROAS and clients without a target on their own average", () => {
    expect(badgeOf({ spend: 200, results: 4, vsKpi: 1.2, cpa: 50, roas: 3.6 }, { roas: true, target: 3, label: "purchases" }, false).badge).toBe("winner");
    expect(badgeOf({ spend: 50, results: 4, vsKpi: 2, cpa: 12, roas: 6 }, { roas: true, target: 3, label: "purchases" }, false).badge).toBe("unproven");
    const out = aggregateCopy([ad("a", { text: "Cheap" }, { spend: 100, results: 10 }), ad("b", { text: "Dear" }, { spend: 300, results: 5 })], { roas: false, target: null, label: "leads" });
    expect(out[0].reference).toBeCloseTo(400 / 15, 1);
    expect(out.find((l) => l.text === "Cheap")?.badge).toBe("winner");
  });

  it("only counts the KPI's campaigns", () => {
    const ads = [ad("in", { text: "Ours", campaign: "KZ | Prospecting", campaignId: "1" }), ad("out", { text: "Theirs", campaign: "KZ | Client boost", campaignId: "2" }), ad("other", { text: "Other", campaign: "Brand", campaignId: "3" })];
    const out = aggregateCopy(ads, { ...cpaKpi, scope: { campaign_match: "kz", excluded_campaigns: ["2"] } });
    expect(out.map((l) => l.text)).toEqual(["Ours"]);
  });

  it("filters by type, badge, angle, words and when it last ran", () => {
    const lines = aggregateCopy([ad("1", { text: "Date night made easy", headline: "Book tonight", angle: "Date night" }, { last_seen: "2026-11-01" }), ad("2", { text: "Old news", angle: "Price" }, { last_seen: "2026-01-01" })], cpaKpi);
    expect(filterCopy(lines, { kind: "headline" }).map((l) => l.text)).toEqual(["Book tonight"]);
    expect(filterCopy(lines, { angle: "date night", kind: "primary" }).map((l) => l.text)).toEqual(["Date night made easy"]);
    expect(filterCopy(lines, { search: "NEWS" }).map((l) => l.text)).toEqual(["Old news"]);
    expect(filterCopy(lines, { sinceDays: 30, today: "2026-11-06" }).map((l) => l.text).sort()).toEqual(["Book tonight", "Date night made easy"]);
  });
});

describe("the copy context for Kaizen AI and the copy writers", () => {
  const lines = aggregateCopy([ad("w", { text: "Proven winner line", angle: "Fresh" }, { spend: 150, results: 10 }), ad("t", { headline: "Worn out headline" }, { spend: 120, results: 8 })], cpaKpi, new Set(["t"]));
  const parts = {
    client: "Sierra Dreams",
    roas: false,
    lines,
    voice: "Warm, plain, a little playful.",
    rules: [{ rule: "Never say cheap", polarity: "dont" as const }],
    avoid: ["No AI images of the food"],
    overrides: [{ kind: "rebut", rule: "No discounts", reason: "Members' price is fine" }],
    reviews: [{ status: "changes", note: "Too salesy" }],
  };

  it("brings the winners, the lines to avoid repeating, the rules and the limits", () => {
    const c = buildCopyContext(parts);
    expect(c).toContain("Proven winner line");
    expect(c).toContain("Worn out headline");
    expect(c).toMatch(/Tired lines[^\n]*\n- \[Headline · Tired\]/);
    expect(c).toContain("Don't: Never say cheap");
    expect(c).toContain("Avoid: No AI images of the food");
    expect(c).toContain("Headline: 40 characters");
    expect(c).toContain("Warm, plain");
    expect(c).toContain("Members' price is fine");
    expect(c).toContain("Sent back: Too salesy");
    expect(c.startsWith('<copy_context client="Sierra Dreams">')).toBe(true);
    expect(c.endsWith("</copy_context>")).toBe(true);
  });

  it("stays within its budget, keeping the limits and rules first", () => {
    const many = Array.from({ length: 400 }, (_, i) => ad(String(i), { text: `Winning line number ${i} ${"x".repeat(200)}` }, { spend: 150, results: 10 }));
    const c = buildCopyContext({ ...parts, lines: aggregateCopy(many, cpaKpi), voice: "v".repeat(9000) }, 6000);
    expect(c.length).toBeLessThanOrEqual(6000);
    expect(c).toContain("Never say cheap");
    expect(c).toContain("Winning line number");
    expect(c.endsWith("</copy_context>")).toBe(true);
  });

  it("knows when a message asks for copy", () => {
    expect(wantsCopy("write 3 headlines for the brunch promo")).toBe(true);
    expect(wantsCopy("Can you draft new primary text?")).toBe(true);
    expect(wantsCopy("ad copy for Black Friday")).toBe(true);
    expect(wantsCopy("How did CPA do last week?")).toBe(false);
  });
});

describe("the creative analysis", () => {
  const base = (id: string, x: Partial<AdInput>): AdInput => ({ id, name: id, headline: null, format: "image", angle: null, avatar: null, hook: null, offer: null, videoSeconds: null, spend: 100, results: 5, revenue: 0, ctr: 1, hookRate: null, holdRate: null, watchPct: null, age: 10, fatigue: null, ...x });

  it("ranks by the KPI, keeps the bottom to what's worse than the account, and finds what the winners share", () => {
    const a = rankCreatives(
      [
        base("a", { results: 10, angle: "Fresh", format: "video", videoSeconds: 12 }), // $10
        base("b", { results: 8, angle: "Fresh", format: "video", videoSeconds: 14 }), // $12.5
        base("c", { results: 2, angle: "Price" }), // $50
        base("d", { results: 0, spend: 300, angle: "Price" }), // nothing back
        base("e", { results: 1, spend: 5 }), // too little spend to judge
      ],
      { roas: false, target: null, label: "purchases", days: 30 },
    );
    expect(a.top.map((x) => x.id)).toEqual(["a", "b"]);
    expect(a.bottom.map((x) => x.id)).toEqual(["d", "c"]);
    expect(a.top[0].thumb).toBe("/api/ad-media/a");
    expect(a.traits.find((t) => t.dimension === "angle" && t.value === "Fresh")?.winners).toBe(2);
    expect(a.traits.find((t) => t.dimension === "length")?.value).toBe("video up to 15s");
  });

  it("names the formats, angles and avatars with nothing running", () => {
    expect(gapsOf([{ format: "image", angle: "Fresh", avatar: null, spend: 10 }], { angles: ["Fresh", "Date night"], avatars: ["Busy parents"] })).toEqual([
      "No video or carousel ads spent in the window.",
      "The client's angles with no ad running: Date night.",
      "Avatars no ad speaks to right now: Busy parents.",
    ]);
  });
});

describe("the KPI's campaigns", () => {
  it("keeps the match and leaves out excluded campaigns", () => {
    const s = { campaign_match: "KZ", excluded_campaigns: ["9"] };
    expect(inScope(s, { id: "1", name: "kz prospecting" })).toBe(true);
    expect(inScope(s, { id: "9", name: "KZ retargeting" })).toBe(false);
    expect(inScope(s, { id: "2", name: "Brand" })).toBe(false);
    expect(scopeRows([{ campaign_id: "1", campaign_name: "KZ a" }, { campaign_id: "9", campaign_name: "KZ b" }], s)).toHaveLength(1);
    expect(scopeRows([{ campaign_id: "1" }], null)).toHaveLength(1);
  });
});

describe("Google copy", () => {
  const g = (text: string, x: Partial<GoogleAssetRow> = {}): GoogleAssetRow => ({ clientId: "c1", kind: "headline", text, label: null, pinned: null, campaignId: "1", campaignName: "KZ Search", adGroup: "AG", impressions: 5000, clicks: 250, conversions: 10, value: 0, spend: 200, syncedAt: "2026-11-05T10:00:00Z", ...x });
  const kpi = { roas: false, target: 30, label: "conversions" };

  it("judges Google lines on the KPI, with Google's rating breaking ties and Low never a winner", () => {
    const lines = aggregateGoogleCopy(
      [
        g("24/7 Emergency Plumbers"), // $20 vs $30: winner
        g("24/7 emergency plumbers", { adGroup: "AG2", campaignId: "2" }), // the same line in another ad group adds up
        g("Licensed Since 1998", { label: "LOW" }), // cheap but rated Low
        g("Call Today", { label: "BEST", conversions: 1, spend: 0 }), // thin numbers, rated Best
        g("Brand line", { campaignName: "Brand", campaignId: "9" }), // outside the KPI
      ],
      { ...kpi, scope: { campaign_match: "KZ", excluded_campaigns: [] } },
    );
    const by = Object.fromEntries(lines.map((l) => [l.text, l]));
    expect(by["24/7 Emergency Plumbers"]).toMatchObject({ platform: "google", badge: "winner", ads: 2, spend: 400, results: 20 });
    expect(by["Licensed Since 1998"].badge).toBe("unproven");
    expect(by["Call Today"].badge).toBe("solid");
    expect(by["Brand line"]).toBeUndefined();
    expect(lineKey("headline", "Call Today", "google")).not.toBe(lineKey("headline", "Call Today"));
    expect(filterCopy(lines, { platform: "meta" })).toHaveLength(0);
    expect(limitOf("google", "headline")).toBe(30);
    expect(limitOf("meta", "headline")).toBe(40);
  });

  it("puts Google's limits and lines first for Google copy, with what's proven on Meta after", () => {
    const meta = aggregateCopy([ad("w", { text: "Proven Meta line" }, { spend: 150, results: 10 })], cpaKpi);
    const google = aggregateGoogleCopy([g("Fast Local Plumbers")], kpi);
    const c = buildCopyContext({ client: "X", roas: false, platform: "google", lines: [...meta, ...google] });
    expect(c).toContain("RSA headline: 30 characters");
    expect(c).not.toContain("Primary text: 125");
    expect(c.indexOf("Fast Local Plumbers")).toBeLessThan(c.indexOf("Proven on Meta"));
    expect(c).toContain("Proven Meta line");
    expect(wantsGoogle("write RSA headlines")).toBe(true);
    expect(wantsGoogle("write a Meta primary text")).toBe(false);
  });

  it("ranks headlines and finds the converting search themes no headline answers", () => {
    const a = analyzeGoogleCopy({
      assets: [
        { kind: "headline", text: "Emergency Plumber Now", label: "BEST", pinned: "HEADLINE_1", source: "rsa", campaignId: "1", campaignName: "KZ", impressions: 4000, clicks: 300, conversions: 12, value: 0, spend: 240 },
        { kind: "headline", text: "Quality Service", label: "LOW", pinned: null, source: "rsa", campaignId: "1", campaignName: "KZ", impressions: 9000, clicks: 90, conversions: 0, value: 0, spend: 90 },
        { kind: "headline", text: "Theirs", label: "BEST", pinned: null, source: "rsa", campaignId: "2", campaignName: "Client", impressions: 9000, clicks: 90, conversions: 9, value: 0, spend: 90 },
      ],
      groups: [],
      terms: [
        { term: "emergency plumber near me", campaignId: "1", campaignName: "KZ", spend: 50, clicks: 10, conversions: 4, value: 0 },
        { term: "emergency plumber open now", campaignId: "1", campaignName: "KZ", spend: 30, clicks: 6, conversions: 2, value: 0 },
        { term: "water heater repair", campaignId: "1", campaignName: "KZ", spend: 40, clicks: 8, conversions: 3, value: 0 },
        { term: "water heater install", campaignId: "1", campaignName: "KZ", spend: 20, clicks: 4, conversions: 1, value: 0 },
      ],
      scope: { campaign_match: null, excluded_campaigns: ["2"] },
      roas: false,
      target: 25,
    })!;
    expect(a.headlines.top.map((s) => s.text)).toEqual(["Emergency Plumber Now"]);
    expect(a.headlines.bottom.map((s) => s.text)).toEqual(["Quality Service"]);
    expect(a.low).toBe(1);
    expect(a.themes.find((t) => t.theme === "emergency plumber")?.covered).toBe(true);
    expect(a.themes.find((t) => t.theme.includes("water heater"))?.covered).toBe(false);
  });
});
