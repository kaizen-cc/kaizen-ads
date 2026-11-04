import { describe, expect, it } from "vitest";
import { matchPeers, productWords } from "@/lib/peer-match";

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
  it("puts a seller of the same thing first, the same niche next, and the broad industry last", () => {
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
    expect(m.get("nectr")?.tier).toBe(3);
    expect(m.get("nectr")?.why).toMatch(/Different product/);
    expect(m.has("pizza")).toBe(false);
    expect(m.has("sierra")).toBe(false);
  });

  it("matches across sub-verticals when the product is the same (camping sleep gear and bedding)", () => {
    const m = matchPeers(sierra, [{ id: "camp", industry: "ecommerce", industry_detail: "Camping sleeping bags", vertical_id: "outdoor" }], V);
    expect(m.get("camp")?.tier).toBe(1);
  });
});
