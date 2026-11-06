import { describe, expect, it } from "vitest";
import {
  askedKey,
  childrenNamedKaizen,
  comebackPick,
  COMEBACK,
  historyOf,
  isKaizenName,
  kaizenStyle,
  NOT_ASKED,
  scrubPaused,
  withKaizen,
  yesOnlyAnswersAsked,
  type CampaignHistory,
} from "@/lib/kaizen-scope";
import { campaignChoice, campaignRefusal, editPlan, followCampaign, googleItems, googleOperations, googleQuestions, kaizenScopeIssues, relevantCampaigns, type AccountCampaign, type GooglePlan } from "@/lib/google-launch/core";
import { buildGooglePlan } from "@/lib/google-launch/runs";
import { followStructure, requiredQuestions, structureRefusal } from "@/lib/launch-sheet/questions";
import type { LaunchQuestion, LaunchSheet, Resolution } from "@/lib/launch-sheet/types";

// Kaizen only touches what Kaizen set up (campaigns with Kaizen in the name), new campaigns carry Kaizen in the
// account's style, a paused Kaizen campaign with a good record is offered back, and a short "yes" answers only the
// question just asked.

describe("Kaizen names", () => {
  it("finds Kaizen as a whole word, whatever wraps it", () => {
    for (const n of ["Search | Non Brand | Kaizen", "CORE | Search | Brand | Kaizen", "Kaizen - Prospecting", "[Kaizen] Retargeting", "kaizen_search", "TOF (KAIZEN)"]) expect(isKaizenName(n)).toBe(true);
    for (const n of ["Traffic - New OceanBox - Generic", "SKAG Trial 499", "Kaizenify promo", "", null]) expect(isKaizenName(n)).toBe(false);
  });
  it("adds Kaizen the way the account writes it, and leaves a Kaizen name as it is", () => {
    expect(withKaizen("Search | Seafood", ["Search | Non Brand | Kaizen", "CORE | Search | Brand | Kaizen"])).toBe("Search | Seafood | Kaizen");
    expect(withKaizen("Prospecting", ["Kaizen - TOF", "Kaizen - BOF"])).toBe("Kaizen - Prospecting");
    expect(withKaizen("Retargeting", ["[Kaizen] TOF"])).toBe("[Kaizen] Retargeting");
    expect(withKaizen("Search Seafood", [])).toBe("Search Seafood | Kaizen");
    expect(withKaizen("Search | Non Brand | Kaizen", ["[Kaizen] TOF"])).toBe("Search | Non Brand | Kaizen");
    expect(kaizenStyle(["Search - Brand - Kaizen", "Search - Generic - Kaizen", "[Kaizen] Other"])).toEqual({ position: "suffix", sep: " - ", bracket: false });
  });
  it("names new ad groups with Kaizen only when most of the account's do", () => {
    expect(childrenNamedKaizen(["Brand | Kaizen", "Generic | Kaizen", "Other"])).toBe(true);
    expect(childrenNamedKaizen(["Brand", "Generic", "Other | Kaizen"])).toBe(false);
    expect(childrenNamedKaizen(["Brand | Kaizen"])).toBe(false);
  });
});

const camps: AccountCampaign[] = [
  { id: "1", name: "CORE | Search | Brand | Kaizen", status: "ENABLED", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 50, spend30: 900, conversions30: 30 },
  { id: "2", name: "Search | Non Brand | Kaizen", status: "PAUSED", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 40, spend30: 0, conversions30: 0 },
  { id: "3", name: "Traffic - New OceanBox - Generic", status: "ENABLED", type: "SEARCH", bidding: "MAXIMIZE_CLICKS", budget: 30, spend30: 400, conversions30: 4 },
  { id: "4", name: "SKAG Trial 499", status: "ENABLED", type: "SEARCH", bidding: "MANUAL_CPC", budget: 5, spend30: 0, conversions30: 0 },
];
const comeback = { id: "2", name: "Search | Non Brand | Kaizen", why: "Search | Non Brand | Kaizen ran at $38 CPA vs the $50 target (12 results on $456) until it was paused Oct 2." };
const q = (key: string, answer: string | null, options: string[] = [], proposal = ""): LaunchQuestion => ({ key, question: key, why: "", proposal, options, required: true, answer });

describe("Google: only Kaizen's campaigns", () => {
  it("offers only live Kaizen campaigns, a brand one last for a non-brand keyword", () => {
    expect(relevantCampaigns(camps, "delicious seafood").map((c) => c.id)).toEqual(["1"]);
  });
  it("proposes bringing the paused Kaizen campaign back when no live Kaizen one fits, never the ones Kaizen didn't set up", () => {
    const qs = googleQuestions({ adGroups: [], campaignNegatives: [], notes: [] }, camps, [], "delicious seafood", null, comeback);
    const c = qs.find((x) => x.key === "campaign")!;
    expect(c.proposal).toBe("Bring back Search | Non Brand | Kaizen (paused) with this in it");
    expect(c.why).toMatch(/\$38 CPA vs the \$50 target/);
    expect(c.options.some((o) => /OceanBox|SKAG/.test(o))).toBe(false);
    expect(qs.map((x) => x.key)).not.toContain("go_live");
    expect(qs.map((x) => x.key)).not.toContain("match_types");
    // Without a comeback: a new Kaizen campaign
    expect(googleQuestions({ adGroups: [], campaignNegatives: [], notes: [] }, camps, [], "delicious seafood").find((x) => x.key === "campaign")!.proposal).toBe("A new Search campaign");
  });
  it("won't take a campaign Kaizen didn't set up, and says so", () => {
    const out = followCampaign([q("campaign", "SKAG Trial 499", [], "A new Search campaign")], camps, []);
    expect(out[0].answer).toBeNull();
    expect(out[0].why).toMatch(/"SKAG Trial 499" wasn't set up by Kaizen, so I won't touch it\. I'd use "CORE \| Search \| Brand \| Kaizen" or a new Kaizen campaign\./);
    expect(campaignChoice("SKAG Trial 499", camps)).toBeNull();
  });
  it("takes a paused Kaizen campaign only as the comeback (offered, or asked to bring back)", () => {
    expect(campaignRefusal("Search | Non Brand | Kaizen", camps, null)).toMatch(/is paused/);
    expect(campaignRefusal("Search | Non Brand | Kaizen", camps, comeback)).toBeNull();
    expect(campaignRefusal("bring back Search | Non Brand | Kaizen", camps, null)).toBeNull();
    expect(campaignChoice("Bring back Search | Non Brand | Kaizen (paused) with this in it", camps)).toEqual({ mode: "existing", id: "2", revive: true });
  });
});

const plan = (over: Partial<GooglePlan> = {}): GooglePlan => ({
  account: "1234567890",
  campaigns: [{ key: "c1", mode: "existing", existingId: "2", name: "Search | Non Brand | Kaizen", type: "SEARCH", budget: 40, bidding: "MAXIMIZE_CONVERSIONS", targetCpa: null, targetRoas: null, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [], revive: true }],
  adGroups: [{ key: "g1", campaignKey: "c1", mode: "new", existingId: null, name: "Delicious Seafood", keywords: [{ text: "delicious seafood", match: "PHRASE" }], negatives: [], rsas: [] }],
  assetGroups: [],
  note: "",
  ...over,
});

describe("Google: the plan and the deploy", () => {
  it("turns the comeback back on last, everything new in it paused, with its own line", () => {
    const { ops, keys } = googleOperations(plan(), "1234567890");
    expect(keys.at(-1)).toBe("revive:c1");
    expect(ops.at(-1)).toEqual({ campaignOperation: { update: { resourceName: "customers/1234567890/campaigns/2", status: "ENABLED" }, updateMask: "status" } });
    expect(ops.filter((o) => "adGroupOperation" in o || "adGroupCriterionOperation" in o).every((o) => JSON.stringify(o).includes('"PAUSED"'))).toBe(true);
    expect(googleItems(plan()).find((i) => i.key === "revive:c1")).toMatchObject({ status: "planned", label: 'Turn "Search | Non Brand | Kaizen" back on (when you deploy)' });
  });
  it("refuses lines aimed at a campaign Kaizen didn't set up, and a new campaign without Kaizen in its name", () => {
    const outside = plan({ campaigns: [{ ...plan().campaigns[0], existingId: "4", name: "SKAG Trial 499", revive: false }] });
    expect(kaizenScopeIssues(outside).map((i) => i.key)).toEqual(["adgroup:g1", "kw:g1:0"]);
    expect(googleOperations(outside, "1234567890").keys).not.toContain("revive:c1");
    const fresh = plan({ campaigns: [{ ...plan().campaigns[0], mode: "new", existingId: null, name: "Search | Seafood", revive: false }] });
    expect(kaizenScopeIssues(fresh)[0].message).toMatch(/must have Kaizen/);
    expect(kaizenScopeIssues(plan())).toEqual([]);
  });
  it("keeps Kaizen in a new campaign's name when the buyer renames it", () => {
    const fresh = plan({ campaigns: [{ ...plan().campaigns[0], mode: "new", existingId: null, name: "Search | Seafood | Kaizen", revive: false }] });
    expect(editPlan(fresh, { type: "name", key: "campaign:c1", text: "Search | Shellfish" }).campaigns[0].name).toBe("Search | Shellfish | Kaizen");
  });
  it("lays out the model's plan inside Kaizen's scope: a non-Kaizen campaign becomes a new Kaizen one, names follow the account", () => {
    const res = { campaigns: camps, adGroups: [{ id: "a", name: "Generic", status: "ENABLED", campaignId: "3", campaign: camps[2].name, rsas: 1, strength: null }], assetGroups: [] };
    const proposal = {
      note: "",
      campaigns: [
        { key: "c1", mode: "existing" as const, existingId: "3", name: camps[2].name, type: "SEARCH" as const, budget: 0, bidding: "MAXIMIZE_CONVERSIONS" as const, targetCpa: 0, targetRoas: 0, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [] },
        { key: "c2", mode: "new" as const, existingId: "", name: "Search | Seafood", type: "SEARCH" as const, budget: 30, bidding: "MAXIMIZE_CONVERSIONS" as const, targetCpa: 0, targetRoas: 0, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [] },
        { key: "c3", mode: "existing" as const, existingId: "2", name: "", type: "SEARCH" as const, budget: 0, bidding: "MAXIMIZE_CONVERSIONS" as const, targetCpa: 0, targetRoas: 0, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [] },
      ],
      adGroups: [{ key: "g1", campaignKey: "c1", mode: "existing" as const, existingId: "a", name: "Generic", fromRead: -1, finalUrl: "https://x.com", keywords: ['"delicious seafood"'], negatives: [], rsas: [] }],
      assetGroups: [],
    };
    const { plan: p, warnings } = buildGooglePlan(proposal, { account: "1234567890", draft: { adGroups: [], campaignNegatives: [], notes: [] }, res, finalUrl: null, locations: new Map(), revive: "2" });
    expect(p.campaigns.map((c) => [c.mode, c.name, Boolean(c.revive)])).toEqual([
      ["new", "Traffic - New OceanBox - Generic | Kaizen", false],
      ["new", "Search | Seafood | Kaizen", false],
      ["existing", "Search | Non Brand | Kaizen", true],
    ]);
    expect(p.adGroups[0]).toMatchObject({ mode: "new", existingId: null, campaignKey: "c1" });
    expect(warnings.some((w) => /wasn't set up by Kaizen/.test(w))).toBe(true);
    expect(kaizenScopeIssues(p)).toEqual([]);
  });
});

describe("a paused Kaizen campaign brought back", () => {
  const h = (over: Partial<CampaignHistory>): CampaignHistory => ({ id: "2", name: "Search | Non Brand | Kaizen", status: "PAUSED", type: "SEARCH", spend30: 0, results30: 0, spend90: 300, results90: 8, spend180: 456, results180: 12, revenue180: 0, value180: 38, firstSpent: "2026-06-01", lastSpent: "2026-10-01", pausedAt: "2026-10-02", ...over });
  const o = { today: "2026-11-06", roas: false, target: 50, theme: "non brand seafood" };
  it("is offered when it beat the target (within 20%), with its number and when it was paused", () => {
    const c = comebackPick([h({})], o)!;
    expect(c.id).toBe("2");
    expect(c.why).toBe("Search | Non Brand | Kaizen ran at $38 CPA vs the $50 target (12 results on $456) until it was paused Oct 2.");
    expect(comebackPick([h({ value180: 59 })], o)).not.toBeNull();
  });
  it("isn't when it's too dear, too thin, too old, not Kaizen's, still live, the wrong type, or the audit said to cut it", () => {
    expect(comebackPick([h({ value180: 61 })], o)).toBeNull();
    expect(comebackPick([h({ results180: 2 })], o)).toBeNull();
    expect(comebackPick([h({ spend180: COMEBACK.minSpend - 1 })], o)).toBeNull();
    expect(comebackPick([h({ lastSpent: "2026-04-01" })], o)).toBeNull();
    expect(comebackPick([h({ name: "Search | Non Brand" })], o)).toBeNull();
    expect(comebackPick([h({ status: "ENABLED" })], o)).toBeNull();
    expect(comebackPick([h({ type: "PERFORMANCE_MAX" })], { ...o, types: ["SEARCH"] })).toBeNull();
    expect(comebackPick([h({})], { ...o, flagged: new Set(["2"]) })).toBeNull();
  });
  it("holds a ROAS account to ROAS, and without a target to the account's own 90 days", () => {
    expect(comebackPick([h({ value180: 3.5, revenue180: 1596 })], { ...o, roas: true, target: 4 })).not.toBeNull();
    expect(comebackPick([h({ value180: 3.1, revenue180: 1414 })], { ...o, roas: true, target: 4 })).toBeNull();
    const live = h({ id: "9", name: "Search | Brand | Kaizen", status: "ENABLED", spend90: 900, results90: 30, value180: 30 });
    // Account 90 days: ($300 + $900) / (8 + 30) = $31.58; $38 is 20% over it, past the 10% allowed
    expect(comebackPick([h({}), live], { ...o, target: null })).toBeNull();
    expect(comebackPick([h({ value180: 33 }), live], { ...o, target: null })).not.toBeNull();
  });
  it("reads 30, 90 and 180 days from the daily rows", () => {
    const days = [
      { id: "2", name: "Search | Non Brand | Kaizen", date: "2026-10-01", spend: 100, results: 3, revenue: 0 },
      { id: "2", name: "Search | Non Brand | Kaizen", date: "2026-07-01", spend: 200, results: 4, revenue: 0 },
      { id: "2", name: "Search | Non Brand | Kaizen", date: "2026-03-01", spend: 999, results: 9, revenue: 0 },
    ];
    const [x] = historyOf(days, new Map([["2", { status: "PAUSED", type: "SEARCH" }]]), { today: "2026-11-06", roas: false });
    expect(x).toMatchObject({ spend30: 0, spend90: 100, results90: 3, spend180: 300, results180: 7, value180: 42.86, lastSpent: "2026-10-01", status: "PAUSED" });
  });
});

describe("the conversation", () => {
  const qs = [
    { key: "campaign", question: "Which campaign?", why: "", proposal: "A new Search campaign", options: [], required: true, answer: null },
    { key: "final_url", question: "Which page?", why: "", proposal: "https://x.com/seafood", options: [], required: true, answer: null },
    { key: "ads", question: "Which ads?", why: "", proposal: "I'll write them", options: [], required: true, answer: null },
  ];
  it("a short yes answers only the question just asked", () => {
    const last = { text: "There's no live non-brand Search campaign to put it in, so I'd start a small one with it as phrase match. Sound good?" };
    // The model answered three things; only the campaign was asked
    const model = [
      { key: "campaign", answer: "A new Search campaign" },
      { key: "final_url", answer: "https://x.com" },
      { key: "ads", answer: "write them" },
    ];
    expect(yesOnlyAnswersAsked("yes", model, qs, last)).toEqual([{ key: "campaign", answer: "A new Search campaign" }]);
    // Nothing for it from the model: the question's proposal
    expect(yesOnlyAnswersAsked("Sounds good!", [{ key: "go_live", answer: "Paused" }], qs, { text: "I'd send them to the Seafood box page. OK?", asks: "final_url" })).toEqual([{ key: "final_url", answer: "https://x.com/seafood" }]);
    // More than a yes passes as the model read it
    expect(yesOnlyAnswersAsked("yes, and write the ads too", model, qs, last)).toEqual(model);
  });
  it("knows which question a reply asked", () => {
    expect(askedKey(qs, { text: "Taking the new campaign. Which page should the ads send people to?" })).toBe("final_url");
    expect(askedKey(qs, { text: "Got it.", asks: "ads" })).toBe("ads");
    expect(askedKey(qs, { text: "Got it." })).toBe("campaign");
  });
  it("never asks or says paused creation, or a match type", () => {
    expect(NOT_ASKED.test("go_live Everything is created paused for you to turn on in Google Ads. OK?")).toBe(true);
    expect(NOT_ASKED.test("match_types Which match type should they use?")).toBe(true);
    expect(NOT_ASKED.test("campaign Bring back the paused Non Brand campaign?")).toBe(false);
    expect(scrubPaused("Taking that as paused, with your picks on the rest. Next: the campaign. New campaign, or that one?")).toBe("Next: the campaign. New campaign, or that one?");
  });
});

describe("Meta: only Kaizen's campaigns and ad sets", () => {
  const sheet = { rows: [], budgets: [], event: { name: "Fest", dateText: "", date: null, link: "https://x.com/tickets", location: "" } } as unknown as LaunchSheet;
  const res = (existing: Resolution["existing"], comeback: Resolution["comeback"] = null) => ({ account: "1", pages: [], creatives: [], posts: [], geos: [], pixel: null, existing, spend: { matched: null, sheet: null }, checks: [], at: "", comeback }) as Resolution;
  it("has no paused-creation question, offers the comeback when nothing Kaizen's is live", () => {
    const qs = requiredQuestions(sheet, res([], { id: "c7", name: "Fest | Sales | Kaizen", why: "Fest | Sales | Kaizen ran at $12 CPA vs the $15 target.", value: 12, target: 15, roas: false, pausedAt: null, score: 1 }), "2026-09-01");
    expect(qs.map((x) => x.key)).not.toContain("go_live");
    const s = qs.find((x) => x.key === "structure")!;
    expect(s.proposal).toBe('Bring back the campaign "Fest | Sales | Kaizen" (paused), a new ad set per Page');
    expect(s.why).toMatch(/\$12 CPA/);
  });
  it("won't take a campaign or ad set Kaizen didn't set up", () => {
    const existing = [{ name: "TOF | Prospecting | Kaizen" }];
    const out = followStructure([q("structure", 'Into the ad set "Client Retargeting" as it is', ['Add to the campaign "TOF | Prospecting | Kaizen", a new ad set per Page'])], existing, ["Client Retargeting"]);
    expect(out[0].answer).toBeNull();
    expect(out[0].why).toBe('"Client Retargeting" wasn\'t set up by Kaizen, so I won\'t touch it. I\'d use "TOF | Prospecting | Kaizen" or a new Kaizen ad set.');
    expect(structureRefusal('Add to the campaign "TOF | Prospecting | Kaizen"', existing, ["Client Retargeting"])).toBeNull();
  });
});
