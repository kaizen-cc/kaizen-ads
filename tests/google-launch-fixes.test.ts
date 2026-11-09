import { describe, expect, it } from "vitest";
import { campaignPlaces, placesLabel, resolvePlaces } from "@/lib/google-launch/places";
import { campaignChoice, campaignRefusal, checkGooglePlan, followCampaign, googleItems, googleOperations, googleQuestions, type AccountAdGroup, type AccountCampaign, type GooglePlan } from "@/lib/google-launch/core";
import { compareReadBack, missingPlan, type Found } from "@/lib/google-launch/readback";
import { acceptAll, buildGooglePlan, launchStateText, pausedOnce, proposalFrom, withPreset } from "@/lib/google-launch/runs";
import { appliedIntent, frustrated, wantsEverything } from "@/lib/launch-intent";
import { justLaunched } from "@/lib/launch-sheet/runs";
import type { LaunchQuestion } from "@/lib/launch-sheet/types";

const US = "geoTargetConstants/2840";
const AK = "geoTargetConstants/21132";
const HI = "geoTargetConstants/21144";

describe("locations the buyer agreed to", () => {
  it("US excluding Hawaii and Alaska: the US in, the two states out", () => {
    const r = resolvePlaces("United States, excluding Hawaii and Alaska.");
    expect(r.include.map((p) => p.geo)).toEqual([US]);
    expect(r.exclude.map((p) => p.geo).sort()).toEqual([AK, HI].sort());
    expect(r.unresolved).toEqual([]);
  });
  it("reads the short ways buyers say it", () => {
    for (const t of ["US minus HI and AK", "U.S. except Alaska & Hawaii", "USA, not including Hawaii or Alaska"]) {
      const r = resolvePlaces(t);
      expect(r.include.map((p) => p.geo)).toEqual([US]);
      expect(r.exclude.map((p) => p.geo).sort()).toEqual([AK, HI].sort());
    }
  });
  it("the lower 48 (plus DC) is the US without Alaska and Hawaii", () => {
    for (const t of ["lower 48 states plus DC", "the contiguous US", "Lower 48"]) {
      const r = resolvePlaces(t);
      expect(r.include.map((p) => p.geo)).toEqual([US]);
      expect(r.exclude.map((p) => p.geo).sort()).toEqual([AK, HI].sort());
      expect(r.unresolved).toEqual([]);
    }
  });
  it("leaves what it doesn't know unresolved (never everywhere by accident)", () => {
    const r = resolvePlaces("Narnia");
    expect(r.include).toEqual([]);
    expect(r.unresolved).toEqual(["Narnia"]);
  });
  it("the buyer's words win over the plan's list, and a failed ask blocks the deploy", () => {
    const ok = campaignPlaces("United States excluding Hawaii and Alaska", ["lower 48 states plus DC"]);
    expect(ok.locations.map((p) => p.geo)).toEqual([US]);
    expect(ok.excluded).toHaveLength(2);
    const bad = campaignPlaces("somewhere nice", []);
    expect(bad.locations).toEqual([]);
    expect(bad.unresolved.length).toBeGreaterThan(0);
    const plan = planWith({ locations: [], locationAsk: "somewhere nice", unresolvedPlaces: bad.unresolved });
    const issue = checkGooglePlan(plan).find((i) => i.key === "targeting:c1");
    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("Couldn't resolve \"somewhere nice\"");
  });
  it("the batch has the places in it, the excluded ones as negative criteria", () => {
    const plan = planWith({ locations: [{ geo: US, name: "United States" }], excludedLocations: [{ geo: AK, name: "Alaska, United States" }, { geo: HI, name: "Hawaii, United States" }] });
    const { ops, keys } = googleOperations(plan, "990-754-8733");
    const loc = ops.filter((o, i) => keys[i] === "targeting:c1").map((o) => (o.campaignCriterionOperation as { create: { negative?: boolean; location?: { geoTargetConstant: string } } }).create).filter((c) => c.location);
    expect(loc.filter((c) => !c.negative).map((c) => c.location!.geoTargetConstant)).toEqual([US]);
    expect(loc.filter((c) => c.negative).map((c) => c.location!.geoTargetConstant).sort()).toEqual([AK, HI].sort());
    expect(googleItems(plan).find((i) => i.key === "targeting:c1")?.label).toBe("United States, excluding Alaska and Hawaii · English");
    expect(placesLabel([{ geo: US, name: "United States" }])).toBe("United States");
  });
});

function planWith(c: Partial<GooglePlan["campaigns"][number]> = {}): GooglePlan {
  return {
    account: "9907548733",
    note: "",
    assetGroups: [],
    campaigns: [{ key: "c1", mode: "new", existingId: null, name: "Kaizen | Search | MOF | Box Themes | [TEST]", type: "SEARCH", budget: 20, bidding: "MAXIMIZE_CONVERSIONS", targetCpa: null, targetRoas: null, locations: [{ geo: US, name: "United States" }], negatives: [{ text: "recipe", match: "PHRASE" }], sitelinks: [], callouts: [], snippets: [], ...c }],
    adGroups: [
      {
        key: "g1",
        campaignKey: "c1",
        mode: "new",
        existingId: null,
        name: "Salmon Lovers Box",
        keywords: [
          { text: "salmon box", match: "PHRASE" },
          { text: "salmon lovers box", match: "PHRASE" },
        ],
        negatives: [],
        rsas: [{ key: "r1", headlines: ["Salmon Lovers Box", "Order Salmon Online", "Hand-Cut Salmon"].map((text) => ({ text, pin: 0 as const })), descriptions: ["Hand-cut salmon shipped to your door.", "Order one time or by subscription."].map((text) => ({ text, pin: 0 as const })), path1: "", path2: "", finalUrl: "https://oceanbox.com/products/salmon-lovers-box" }],
      },
    ],
  };
}

describe("the read-back queries what's really there", () => {
  const plan = planWith({ excludedLocations: [{ geo: AK, name: "Alaska" }] });
  const made = new Map([
    ["campaign:c1", "customers/9907548733/campaigns/24454142377"],
    ["adgroup:g1", "customers/9907548733/adGroups/203564795962"],
    ["rsa:g1:r1", "customers/9907548733/adGroupAds/203564795962~1"],
  ]);
  const base: Found = {
    campaigns: [{ id: "24454142377", name: plan.campaigns[0].name, status: "PAUSED", budget: 20 }],
    adGroups: [{ id: "203564795962", campaignId: "24454142377", name: "Salmon Lovers Box", status: "PAUSED" }],
    keywords: [
      { adGroupId: "203564795962", text: "salmon box", match: "PHRASE", negative: false, status: "PAUSED" },
      { adGroupId: "203564795962", text: "salmon lovers box", match: "PHRASE", negative: false, status: "PAUSED" },
    ],
    ads: [{ adGroupId: "203564795962", status: "PAUSED", headlines: ["Salmon Lovers Box", "Order Salmon Online", "Hand-Cut Salmon"], descriptions: ["a", "b"] }],
    criteria: [
      { campaignId: "24454142377", kind: "LOCATION", negative: false, geo: US, text: null, match: null },
      { campaignId: "24454142377", kind: "LOCATION", negative: true, geo: AK, text: null, match: null },
      { campaignId: "24454142377", kind: "KEYWORD", negative: true, geo: null, text: "recipe", match: "PHRASE" },
    ],
    assets: [],
  };
  it("everything found: every line ok", () => {
    const rb = compareReadBack(plan, made, base);
    expect(rb.missing).toEqual([]);
    expect(rb.lines.every((l) => l.ok)).toBe(true);
    expect(rb.summary).toContain("1 of 1 ad group");
  });
  it("Google kept the ad groups but not the ads or locations: said plainly, only those planned again", () => {
    const rb = compareReadBack(plan, made, { ...base, ads: [], criteria: base.criteria.filter((c) => c.kind !== "LOCATION") });
    expect(rb.missing.sort()).toEqual(["rsa:g1:r1", "targeting:c1"].sort());
    expect(rb.summary).toContain("0 of 1 ad");
    expect(rb.summary).toMatch(/Google didn't keep the ads and locations/);
    const extra = missingPlan(plan, rb)!;
    expect(extra.campaigns[0]).toMatchObject({ mode: "existing", existingId: "24454142377" });
    expect(extra.campaigns[0].negatives).toEqual([]);
    expect(extra.adGroups[0]).toMatchObject({ mode: "existing", existingId: "203564795962", keywords: [] });
    expect(extra.adGroups[0].rsas).toHaveLength(1);
    const { ops } = googleOperations(extra, "9907548733");
    // The places and the ad, into the same campaign and ad group: no new campaign, budget or ad group
    expect(ops.some((o) => "campaignOperation" in o || "campaignBudgetOperation" in o || "adGroupOperation" in o)).toBe(false);
    expect(ops.filter((o) => "campaignCriterionOperation" in o)).toHaveLength(2);
    expect(ops.filter((o) => "adGroupAdOperation" in o)).toHaveLength(1);
  });
  it("a returned resource name isn't proof: no ad groups found means every child is missing", () => {
    const rb = compareReadBack(plan, made, { ...base, adGroups: [], keywords: [], ads: [] });
    expect(rb.missing).toEqual(expect.arrayContaining(["adgroup:g1", "kw:g1:0", "kw:g1:1", "rsa:g1:r1"]));
    expect(missingPlan(plan, rb)!.adGroups[0].mode).toBe("new");
  });
});

const camps = [
  { id: "24454142377", name: "Kaizen | Search | MOF | Box Themes | [TEST]", status: "PAUSED", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 20, spend30: 0, conversions30: 0 },
  { id: "2", name: "PMax | Built Your Own Box | Kaizen", status: "ENABLED", type: "PERFORMANCE_MAX", bidding: "MAXIMIZE_CONVERSION_VALUE", budget: 50, spend30: 726, conversions30: 9 },
  { id: "3", name: "Old Search | Kaizen", status: "PAUSED", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 10, spend30: 0, conversions30: 0 },
] as AccountCampaign[];
const groups: AccountAdGroup[] = [{ id: "g9", name: "Salmon Lovers Box", status: "PAUSED", campaignId: "24454142377", campaign: camps[0].name, rsas: 0, strength: null }];
const q = (key: string, answer: string | null, proposal = "", options: string[] = []): LaunchQuestion => ({ key, question: key, why: "", proposal, options, required: true, answer });

describe("a paused campaign Kaizen Ads launched", () => {
  const own = new Set(["24454142377"]);
  it("is taken as it is, never refused, and stays paused", () => {
    expect(campaignRefusal(camps[0].name, camps, null, own)).toBeNull();
    expect(campaignChoice(camps[0].name, camps, own)).toEqual({ mode: "existing", id: "24454142377", revive: false });
    const out = followCampaign([q("campaign", camps[0].name), q("ad_group", null)], camps, groups, null, own);
    expect(out[0].answer).toBe(camps[0].name);
    expect(out[1].options.some((o) => o.startsWith("Salmon Lovers Box"))).toBe(true);
  });
  it("is the proposal when the request names it", () => {
    const qs = googleQuestions({ adGroups: [], campaignNegatives: [], notes: [] }, camps, groups, `Finish building inside ${camps[0].name}`, null, null, own);
    expect(qs.find((x) => x.key === "campaign")!.proposal).toContain(camps[0].name);
  });
  it("the buyer insisting takes another paused Kaizen campaign too; one that isn't Kaizen's is still refused", () => {
    expect(campaignRefusal(`${camps[2].name}, it's paused on purpose, we are testing`, camps)).toBeNull();
    expect(campaignRefusal(camps[2].name, camps)).toMatch(/paused/);
    const outside = [...camps, { ...camps[0], id: "9", name: "Generic Search", status: "PAUSED" }] as AccountCampaign[];
    expect(campaignRefusal("Generic Search, paused on purpose", outside)).toMatch(/wasn't set up by Kaizen/);
  });
  it("says it's paused at most once", () => {
    const earlier = [{ role: "assistant", text: "Adding it into the campaign. It's paused, so nothing runs until you turn it on." }];
    expect(pausedOnce("Done. It's paused, so nothing runs until you turn it on. Plan is on the card.", earlier)).toBe("Done. Plan is on the card.");
    expect(pausedOnce("It's paused, so nothing runs until you turn it on.", [])).toContain("paused");
  });
});

describe("fewer questions", () => {
  it("\"just build it\" and frustration take every proposal", () => {
    for (const m of ["just build it", "build everything", "ya build the full campaign, keywords, ad copy, location everything"]) expect(wantsEverything(m)).toBe(true);
    expect(wantsEverything("don't build it yet")).toBe(false);
    expect(frustrated("no no no fuck man. i want u to complete the campaign that u started")).toBe(true);
    expect(frustrated("why are you talking so long")).toBe(true);
    expect(frustrated("add keywords, ad copy and everything in same campaign", ["i want u to add keywords, ad copy and everything in same campaign"])).toBe(true);
    expect(frustrated("sounds good")).toBe(false);
    const qs = [q("campaign", null, "A new Search campaign", ["A new Search campaign"]), q("ad_group", null, "Pick the campaign first"), q("keywords", null, "Phrase match on each box name"), q("ads", null, "One RSA per group from the winners")];
    const follow = (x: LaunchQuestion[]) => followCampaign(x, camps, groups);
    const out = acceptAll(qs, follow);
    expect(out.every((x) => x.answer)).toBe(true);
    expect(out.find((x) => x.key === "ad_group")!.answer).toBe("A new ad group named for the theme");
  });
  it("a preset campaign is answered before anything is asked", () => {
    const out = withPreset([q("campaign", null, "x"), q("keywords", null)], { campaign: camps[0].name });
    expect(out[0].answer).toBe(camps[0].name);
    expect(out[1].answer).toBeNull();
  });
});

describe("after it's created, the conversation is about it", () => {
  const names = [camps[0].name];
  it("reads where, add and new", () => {
    expect(appliedIntent("where is it?", names)).toBe("where");
    expect(appliedIntent("I can't find the campaign in Google Ads", names)).toBe("where");
    expect(appliedIntent("add keywords, ads and locations to it", names)).toBe("add");
    expect(appliedIntent(`Finish building inside the existing paused campaign ${camps[0].name}: 3 ad groups, keywords, RSAs`, names)).toBe("add");
    expect(appliedIntent("the campaign is paused on purpose, i want u to add keywords, ad copy and everything in same campaign", names)).toBe("add");
    expect(appliedIntent("build a second new campaign for brand", names)).toBe("new");
    expect(appliedIntent("what's the CPA on PMax this week?", names)).toBeNull();
  });
  it("a launch created in the last hours is still the one talked about", () => {
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(justLaunched({ status: "applied", applied_at: at, updated_at: at })).toBe(true);
    expect(justLaunched({ status: "applying", applied_at: null, updated_at: new Date().toISOString() })).toBe(true);
    expect(justLaunched({ status: "applied", applied_at: new Date(Date.now() - 30 * 3_600_000).toISOString(), updated_at: at })).toBe(false);
    expect(justLaunched({ status: "asking", applied_at: null, updated_at: at })).toBe(false);
  });
  it("every reply reads the real state: created means created", () => {
    const s = launchStateText({ status: "applied", plan: planWith(), qa: { at: "", lines: [], summary: "Read back from Google: 1 of 1 ad group found.", ids: { "campaign:c1": "24454142377" } }, account: "9907548733" });
    expect(s).toMatch(/created in Google Ads, paused: never say nothing is created/);
    expect(s).toContain("24454142377");
    expect(launchStateText({ status: "ready", plan: planWith(), account: "1" })).toMatch(/nothing created until Deploy/);
  });
});

describe("the plan card has every field", () => {
  it("name, budget, bidding, places, ad groups, keywords and headlines all come through the flat plan", () => {
    const raw = {
      note: "Built as agreed.",
      campaigns: [{ key: "c1", mode: "new", existingId: "", name: "Kaizen | Search | MOF | Box Themes | [TEST]", type: "SEARCH", budget: 20, bidding: "Maximize conversions", targetCpa: 0, targetRoas: 0, locations: ["United States"], excludedLocations: ["Hawaii", "Alaska"], negatives: ["recipe"], sitelinks: [], callouts: [], snippets: [] }],
      adGroups: [{ key: "g1", campaignKey: "c1", mode: "new", existingId: "", name: "Salmon Lovers Box", fromRead: -1, finalUrl: "https://oceanbox.com/products/salmon-lovers-box", keywords: ['"salmon box"'], negatives: [], rsas: [{ headlines: ["Salmon Lovers Box", "Order Salmon Online", "Hand-Cut Salmon"], descriptions: ["Hand-cut salmon.", "Ships cold."], path1: "", path2: "", finalUrl: "" }] }],
      assetGroups: [],
    };
    const { plan, warnings } = buildGooglePlan(proposalFrom(raw), { account: "9907548733", draft: { adGroups: [], campaignNegatives: [], notes: [] }, res: { campaigns: camps, adGroups: groups, assetGroups: [] }, finalUrl: null, locations: new Map(), locationAsk: "United States, excluding Hawaii and Alaska" });
    const c = plan.campaigns[0];
    expect(c).toMatchObject({ name: "Kaizen | Search | MOF | Box Themes | [TEST]", budget: 20, bidding: "MAXIMIZE_CONVERSIONS" });
    expect(c.locations.map((l) => l.geo)).toEqual([US]);
    expect(c.excludedLocations!.map((l) => l.geo).sort()).toEqual([AK, HI].sort());
    expect(c.unresolvedPlaces).toEqual([]);
    expect(warnings.filter((w) => /resolve/.test(w))).toEqual([]);
    expect(plan.adGroups[0].name).toBe("Salmon Lovers Box");
    expect(plan.adGroups[0].keywords[0]).toMatchObject({ text: "salmon box", match: "PHRASE" });
    expect(plan.adGroups[0].rsas[0].headlines[0].text).toBe("Salmon Lovers Box");
    expect(plan.adGroups[0].rsas[0].finalUrl).toBe("https://oceanbox.com/products/salmon-lovers-box");
    expect(checkGooglePlan(plan).filter((i) => i.key === "targeting:c1")).toEqual([]);
  });
});
