import { describe, expect, it } from "vitest";
import { fitsClientMarket, keywords, marketForTalk, mentionNote, pickedMarket, type FitAd } from "@/lib/market-fit";

// Talk it through brings up live ads from the client's own market only: never a shoe brand for a coffee client.

const coffee = { id: "c1", verticalId: "v-coffee", industry: "food" };
const ad = (o: Partial<FitAd> & { brand: string }): FitAd => ({ verticalId: null, industry: null, competitorOf: [], ...o });

describe("fitsClientMarket", () => {
  it("takes their competitors and their own sub-vertical", () => {
    expect(fitsClientMarket(ad({ brand: "Bean Co", verticalId: "v-coffee" }), coffee)).toBe(true);
    expect(fitsClientMarket(ad({ brand: "Rival", verticalId: "v-bakery", competitorOf: ["c1"] }), coffee)).toBe(true);
  });
  it("never another sub-vertical, even in the same industry", () => {
    expect(fitsClientMarket(ad({ brand: "Sneakers", verticalId: "v-shoes", industry: "retail" }), coffee)).toBe(false);
    expect(fitsClientMarket(ad({ brand: "Bakery", verticalId: "v-bakery", industry: "food" }), coffee)).toBe(false);
    expect(fitsClientMarket(ad({ brand: "Unplaced", verticalId: null, industry: "food" }), coffee)).toBe(false);
  });
  it("a client not placed yet falls back to its industry, never 'other'", () => {
    expect(fitsClientMarket(ad({ brand: "Food Brand", industry: "Food" }), { id: "c2", verticalId: null, industry: "food" })).toBe(true);
    expect(fitsClientMarket(ad({ brand: "Any", industry: "other" }), { id: "c3", verticalId: null, industry: "other" })).toBe(false);
  });
});

describe("marketForTalk", () => {
  const pool = [
    ad({ brand: "Sneakers", verticalId: "v-shoes", hook: "Cold brew energy for your run", proven: true, daysActive: 200 }),
    ad({ brand: "Bean Co", verticalId: "v-coffee", hook: "Cold brew in 60 seconds", angle: "convenience", daysActive: 40 }),
    ad({ brand: "Bean Co", verticalId: "v-coffee", hook: "Another Bean Co ad about cold brew" }),
    ad({ brand: "Roast House", verticalId: "v-coffee", hook: "Our espresso blend", proven: true, daysActive: 90 }),
  ];
  it("ranks the client's market by what's being said, one per brand, never off-market", () => {
    const out = marketForTalk(pool, coffee, "A UGC video about our cold brew", 5);
    expect(out.map((a) => a.brand)).toEqual(["Bean Co", "Roast House"]);
  });
  it("keeps the words that matter", () => {
    expect(keywords("A video about the new cold brew https://x.com/a")).toEqual(["cold", "brew"]);
  });
});

describe("pickedMarket", () => {
  it("reads the ads the strategist brought up, at most three, and takes the ids out of its reply", () => {
    const out = pickedMarket("Two worth a look: the Bean Co ad [M2]: the 60-second demo. Roast House [M1] for the voice. And [M9] isn't one.", ["a", "b", "c"]);
    expect(out.picked).toEqual(["b", "a"]);
    expect(out.reply).toBe("Two worth a look: the Bean Co ad: the 60-second demo. Roast House for the voice. And isn't one.");
    expect(pickedMarket("No ads here.", undefined)).toEqual({ reply: "No ads here.", picked: [], notes: [] });
  });
});

describe("why the strategist brought an ad up", () => {
  const reply = "Two worth a look: the Bean Co ad [M2]: the 60-second demo structure. Roast House [M1] for the warm founder voice. And [M9] isn't one.";
  it("takes what it said after the ad's id", () => {
    expect(mentionNote(reply, 2)).toBe("The 60-second demo structure");
    expect(mentionNote(reply, 1)).toBe("For the warm founder voice");
  });
  it("comes back with the notes in the order the ads were picked", () => {
    expect(pickedMarket(reply, ["a", "b", "c"]).notes).toEqual(["The 60-second demo structure", "For the warm founder voice"]);
  });
  it("falls back to the whole sentence when nothing follows the id", () => {
    expect(mentionNote("Look at how Roast House [M1].", 1)).toBe("Look at how Roast House");
    expect(mentionNote("Nothing here.", 3)).toBe("");
  });
});
