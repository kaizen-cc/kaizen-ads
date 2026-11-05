import { describe, expect, it } from "vitest";
import { businessModelOf, playbookPlatforms, playbookText, rankPlaybook, tierOf, type PlaybookItem, type VerticalNode } from "@/lib/buyer-playbook";

// The senior buyer's playbook for one account: only his points for that platform (or both), closest kind of business
// first (sub-vertical, then the vertical and its other sub-verticals, then the same business model), nothing from
// businesses unlike it.

const V: VerticalNode[] = [
  { id: "food", name: "Food and drink", parent_id: null },
  { id: "pizza", name: "Pizza restaurants", parent_id: "food" },
  { id: "bars", name: "Bars and lounges", parent_id: "food" },
  { id: "shop", name: "Ecommerce", parent_id: null },
  { id: "apparel", name: "Apparel", parent_id: "shop" },
];

const item = (o: Partial<PlaybookItem> & { body: string }): PlaybookItem => ({
  layer: "rule",
  platform: "meta",
  vertical_id: null,
  business_model: null,
  scope: "industry",
  confidence: 1,
  at_seconds: 75,
  tags: null,
  ...o,
});

const items: PlaybookItem[] = [
  item({ body: "Pizza Google rule", platform: "google", vertical_id: "pizza", confidence: 5 }),
  item({ body: "Pizza Meta rule", vertical_id: "pizza", confidence: 2 }),
  item({ body: "Bar Meta rule", vertical_id: "bars", confidence: 9 }),
  item({ body: "Food vertical rule", vertical_id: "food", confidence: 3 }),
  item({ body: "Local business rule", business_model: "local", confidence: 8 }),
  item({ body: "Apparel Meta rule", vertical_id: "apparel", business_model: "ecommerce", confidence: 20 }),
  item({ body: "Both platforms pizza check", layer: "diagnostic", platform: "both", vertical_id: "pizza", confidence: 1 }),
  item({ body: "General pizza point", vertical_id: "pizza", scope: "general", confidence: 4 }),
  item({ body: "Voice note", layer: "voice", vertical_id: "pizza" }),
];

describe("buyer playbook selection", () => {
  const meta = { platform: "meta" as const, verticalId: "pizza", businessModel: "local" as const };

  it("keeps only the account's platform (or both)", () => {
    const bodies = rankPlaybook(items, meta, V).map((x) => x.i.body);
    expect(bodies).not.toContain("Pizza Google rule");
    expect(bodies).toContain("Both platforms pizza check");
    const google = rankPlaybook(items, { ...meta, platform: "google" }, V).map((x) => x.i.body);
    expect(google).toContain("Pizza Google rule");
    expect(google).not.toContain("Pizza Meta rule");
  });

  it("orders sub-vertical, then vertical (siblings too), then business model, and leaves out other businesses", () => {
    const ranked = rankPlaybook(items, meta, V);
    expect(ranked.map((x) => x.i.body)).toEqual([
      // sub-vertical: industry-only before general, then by support
      "Pizza Meta rule",
      "Both platforms pizza check",
      "General pizza point",
      // vertical and sibling sub-verticals
      "Bar Meta rule",
      "Food vertical rule",
      // same business model
      "Local business rule",
    ]);
    expect(ranked.map((x) => x.i.body)).not.toContain("Apparel Meta rule");
    expect(ranked.map((x) => x.i.body)).not.toContain("Voice note");
  });

  it("tiers", () => {
    expect(tierOf(items[1], meta, V)).toBe(1);
    expect(tierOf(items[2], meta, V)).toBe(2);
    expect(tierOf(items[4], meta, V)).toBe(3);
    expect(tierOf(items[5], meta, V)).toBe(0);
    // A client placed only in the vertical still gets every sub-vertical under it
    expect(tierOf(items[1], { ...meta, verticalId: "food" }, V)).toBe(2);
    // No vertical: business model only
    expect(rankPlaybook(items, { platform: "meta", verticalId: null, businessModel: "ecommerce" }, V).map((x) => x.i.body)).toEqual(["Apparel Meta rule"]);
  });

  it("writes a compact block with its Loom moments and cases", () => {
    const withCases = [
      ...items,
      item({ layer: "case", body: "Situation: x", vertical_id: "pizza", confidence: 1, at_seconds: 192, tags: { situation: "Pizza shop at $3k a month, CPA rising", read: "frequency over 4", action: "new hooks", outcome: "CPA back under target" } }),
      ...Array.from({ length: 80 }, (_, n) => item({ body: `Filler rule ${n} ${"x".repeat(200)}`, vertical_id: "pizza" })),
    ];
    const text = playbookText(withCases, meta, V, "Food and drink > Pizza restaurants");
    expect(text.startsWith('<senior_buyer_playbook platform="meta" industry="Food and drink > Pizza restaurants">')).toBe(true);
    expect(text.endsWith("</senior_buyer_playbook>")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toContain("[Loom 1:15]");
    expect(text).toContain("Pizza shop at $3k a month, CPA rising → read: frequency over 4 → did: new hooks → outcome: CPA back under target [Loom 3:12]");
    expect(text).not.toContain("Pizza Google rule");
    expect(text).not.toContain("—");
    expect(playbookText(items, { platform: "google", verticalId: "apparel", businessModel: "ecommerce" }, V, "Apparel")).toBe("");
  });
});

describe("which calls get it", () => {
  it("maps buyer agents to their platform, business audits to both, and leaves utilities alone", () => {
    expect(playbookPlatforms("auditor", "audit Acme")).toEqual(["meta"]);
    expect(playbookPlatforms("reporter", "weekly report")).toEqual(["meta"]);
    expect(playbookPlatforms("google_launcher", "place a launch")).toEqual(["google"]);
    expect(playbookPlatforms("auditor", "business audit Acme")).toEqual(["meta", "google"]);
    expect(playbookPlatforms("auditor", "loom distill")).toEqual([]);
    expect(playbookPlatforms("auditor", "insight scope")).toEqual([]);
    expect(playbookPlatforms("copy", "copy Acme")).toEqual([]);
  });

  it("reads business models from free text", () => {
    expect(businessModelOf("ecommerce")).toBe("ecommerce");
    expect(businessModelOf("local service with online reservations")).toBe("local");
    expect(businessModelOf("lead gen, local service")).toBe("lead_gen");
    expect(businessModelOf("event ticket sales")).toBe("events");
    expect(businessModelOf("app")).toBe("app");
    expect(businessModelOf("unknown")).toBe(null);
  });
});
