import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { articleFor, fixChecklist, requestReviewFor } = await import("@/lib/ai-tools/policy");
const { recapValues, slotsOf, IMAGE_KEYS } = await import("@/lib/ai-tools/recap-deck");

describe("Google policy checker", () => {
  it("cites the article that governs each topic", () => {
    expect(articleFor("DESTINATION_NOT_WORKING")).toContain("/answer/6368661");
    expect(articleFor("TRADEMARKS_IN_AD_TEXT")).toContain("/answer/6118");
    expect(articleFor("EXCESSIVE_CAPITALIZATION")).toContain("/answer/6021546");
    expect(articleFor("HEALTH_IN_PERSONALIZED_ADS")).toMatch(/answer\/(176031|143465)/);
    expect(articleFor("SOMETHING_NEW")).toContain("/answer/6008942");
  });

  it("turns a reviewed fix into a checklist and a review how-to", () => {
    const issue = {
      key: "ad:1",
      kind: "ad" as const,
      severity: "high" as const,
      status: "DISAPPROVED",
      review: null,
      label: "Ad · Best Botox in NYC",
      campaign: "Search",
      adGroup: "Botox",
      resource: null,
      adGroupResource: null,
      text: { headlines: ["Best Botox in NYC"], descriptions: [], path1: null, path2: null, keyword: null, match: null, asset: null, assetType: null },
      finalUrl: "https://example.com",
      topics: [{ topic: "HEALTH_IN_PERSONALIZED_ADS", type: "LIMITED", evidence: ["Botox"], destination: null }],
      articles: [],
      landing: null,
      ai: { wrong: "x", why: "y", quote: "", article: null, triggers: ["Botox"], fix: { kind: "both" as const, headlines: ["Smooth Lines in NYC", "Book a Consult", "Expert Injectors"], descriptions: ["a", "b"], keyword: null, assetText: null, page: ["Add a privacy policy link"] }, appeal: "Please review.", requestReview: "Hover the status and appeal." },
      applied: null,
    };
    const steps = fixChecklist(issue);
    expect(steps.some((s) => s.includes("Smooth Lines in NYC"))).toBe(true);
    expect(steps.some((s) => s.startsWith("On the landing page"))).toBe(true);
    const r = requestReviewFor(issue, "123-456-7890");
    expect(r.viaApi).toBe(false);
    expect(r.link).toContain("ocid=1234567890");
    expect(r.appeal).toBe("Please review.");
  });
});

describe("recap deck", () => {
  const period = { label: "October 2026", start: "2026-10-01", end: "2026-10-31", days: 31, spend: 1000, impressions: 50000, clicks: 900, ctr: 1.8, cpc: 1.11, cpm: 20, results: 40, costPerResult: 25, revenue: 0, roas: null };
  const m = { platform: "meta" as const, kind: "monthly" as const, conversion: "Leads", roasKpi: false, target: 30, monthlyBudget: 1200, main: period, compare: { ...period, label: "September 2026", spend: 800, results: 20, costPerResult: 40 }, mtd: null, mtdCompare: null, campaigns: [], topAds: [], dataThrough: null, gaps: [] };

  it("has every value a template can ask for", () => {
    const v = recapValues(m, { headline: "Leads doubled", summary: "s", did: ["one"], doing: [], next: ["two"], highlights: [] }, "Acme", "October 2026");
    expect(v.client).toBe("Acme");
    expect(v.results_change).toBe("+100%");
    expect(v.cost_per_result_change).toBe("-38%");
    expect(v.what_we_did).toBe("• one");
    expect(IMAGE_KEYS).toContain("chart_daily");
  });

  it("finds every text, table cell and picture in a template", () => {
    const slots = slotsOf({
      presentationId: "p",
      slides: [
        {
          objectId: "s1",
          pageElements: [
            { objectId: "t1", shape: { text: { textElements: [{ textRun: { content: "{{client}}\n" } }] } } },
            { objectId: "i1", image: {} },
            { objectId: "g1", elementGroup: { children: [{ objectId: "tb", table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: "Spend" } }] } }, {}] }] } }] } },
          ],
        },
      ],
    });
    expect(slots.map((s) => s.id)).toEqual(["s0e0", "s0e1", "s0e2r0c0", "s0e2r0c1"]);
    expect(slots[0].text).toBe("{{client}}");
    expect(slots[1].kind).toBe("image");
  });
});
