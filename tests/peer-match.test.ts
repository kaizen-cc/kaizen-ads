import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchPeers, productWords, winnerRelevant } from "@/lib/peer-match";

// The real shape that went wrong: Sierra Dreams (bedding, Home & Fragrance) was shown Nectr's winners (nootropic
// pouches) because every DTC e-commerce client counted as "similar".
const V = [
  { id: "dtc", name: "DTC E-commerce", parent_id: null },
  { id: "home", name: "Home & Fragrance", parent_id: "dtc" },
  { id: "supp", name: "Supplements & Functional Products", parent_id: "dtc" },
  { id: "outdoor", name: "Sporting & Outdoor Gear", parent_id: "dtc" },
  { id: "rest", name: "Restaurants", parent_id: null },
  { id: "pizza", name: "Pizza & Wings", parent_id: "rest" },
];
const sierra = { id: "sierra", industry: "ecommerce", industry_detail: "Bedding DTC brand", vertical_id: "home" };

describe("productWords", () => {
  it("keeps what's sold and drops how it's sold", () => {
    expect([...productWords("Bedding DTC brand")]).toEqual(["bedding and sleep"]);
    expect([...productWords("Premium sheets and bedding sold online")]).toEqual(["bedding and sleep"]);
    expect(productWords("Nootropic pouch brand").has("bedding and sleep")).toBe(false);
  });
});

describe("matchPeers", () => {
  it("puts a seller of the same thing first, the same niche next, and never the broad industry alone", () => {
    const m = matchPeers(
      sierra,
      [
        { id: "nectr", industry: "ecommerce", industry_detail: "Nootropic pouch brand", vertical_id: "supp" },
        { id: "lajetee", industry: "ecommerce", industry_detail: "Niche perfume boutique", vertical_id: "home" },
        { id: "sheets", industry: "cpg", industry_detail: "Organic cotton sheets", vertical_id: null },
        { id: "pizza", industry: "restaurant", industry_detail: "Pizza restaurant", vertical_id: "pizza" },
      ],
      V,
    );
    expect(m.get("sheets")?.tier).toBe(1);
    expect(m.get("sheets")?.why).toMatch(/bedding/);
    expect(m.get("lajetee")?.tier).toBe(2);
    expect(m.get("lajetee")?.why).toMatch(/Home & Fragrance/);
    // The owner's rule (Nov 2026): no broad-industry fallback. A nootropic pouch is never a bedding brand's peer
    expect(m.has("nectr")).toBe(false);
    expect(m.has("pizza")).toBe(false);
    expect(m.has("sierra")).toBe(false);
  });

  it("matches across sub-verticals when the product is the same (camping sleep gear and bedding)", () => {
    const m = matchPeers(sierra, [{ id: "camp", industry: "ecommerce", industry_detail: "Camping sleeping bags", vertical_id: "outdoor" }], V);
    expect(m.get("camp")?.tier).toBe(1);
  });

  it("never matches on the same broad industry or parent vertical alone, even when nothing closer exists", () => {
    const m = matchPeers(sierra, [
      { id: "nectr", industry: "ecommerce", industry_detail: "Nootropic pouch brand", vertical_id: "supp" },
      { id: "kayak", industry: "ecommerce", industry_detail: "Inflatable kayaks", vertical_id: "outdoor" },
    ], V);
    expect(m.size).toBe(0);
  });
});

describe("winnerRelevant", () => {
  const nectr = { id: "nectr", industry: "ecommerce", industry_detail: "Nootropic pouch brand", vertical_id: "supp" };
  it("allows the client's own winners and its peers, nothing else", () => {
    expect(winnerRelevant(sierra, sierra, V)).toBe("own");
    expect(winnerRelevant(sierra, { id: "lajetee", industry: "ecommerce", industry_detail: "Niche perfume boutique", vertical_id: "home" }, V)).toMatchObject({ tier: 2 });
    expect(winnerRelevant(sierra, nectr, V)).toBeNull();
    expect(winnerRelevant(sierra, null, V)).toBeNull();
  });
});

describe("every place winners feed reads peers without a fallback", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("has no broad-industry fallback left", () => {
    const industry = read("src/lib/industry.ts");
    expect(industry).not.toMatch(/tier === 3/);
    expect(industry).not.toMatch(/broad = all/);
    expect(read("src/lib/peer-match.ts")).not.toMatch(/tier: 3/);
    expect(read("src/app/(team)/requests/new/start-flow.tsx")).not.toMatch(/winnersTier === 3/);
    expect(read("src/lib/ledger.ts")).not.toMatch(/\.eq\("industry", industry\)\.neq\("id", clientId\)/);
    expect(read("src/lib/onboarding-guide.ts")).not.toMatch(/\.eq\("industry", c\.industry\)\.neq\("id", clientId\)/);
  });
  it("checks a picked winner before any brief is written from it", () => {
    expect(read("src/lib/suggestions.ts")).toMatch(/assertRelevantWinner\(admin, clientId, w\)/);
    expect(read("src/app/(team)/quick-brief-actions.ts")).toMatch(/assertRelevantWinner/);
    expect(read("src/app/(team)/brief-job-actions.ts")).toMatch(/assertRelevantWinner/);
  });
});

describe("generic words never make a peer", () => {
  it("an event ticket reseller is no peer of a paintball park that also runs events", () => {
    const verticals = [
      { id: "exp", name: "Experiences & Events", parent_id: null },
      { id: "tix", name: "Ticketed Events & Social Clubs", parent_id: "exp" },
      { id: "pb", name: "Paintball & Airsoft Parks", parent_id: "exp" },
    ];
    const me = { id: "bt", industry: "entertainment", industry_detail: "Event ticket reseller", vertical_id: "tix" };
    const peers = [
      { id: "bk", industry: "entertainment", industry_detail: "Paintball parks and events", vertical_id: "pb" },
      { id: "ww", industry: "entertainment", industry_detail: "Paintball park and parties", vertical_id: "pb" },
    ];
    expect(matchPeers(me, peers, verticals).size).toBe(0);
  });
});
