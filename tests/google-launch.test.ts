import { describe, expect, it } from "vitest";
import {
  campaignChoice,
  checkGooglePlan,
  deployBlocked,
  draftSummary,
  editPlan,
  errorsByLine,
  googleItems,
  googleOperations,
  googleQuestions,
  kwKey,
  matchOf,
  parseGoogleErrors,
  parseKeyword,
  parsePinned,
  splitKeywords,
  tidyPlan,
  type AccountCampaign,
  type GooglePlan,
} from "@/lib/google-launch/core";
import { applyMatchAnswer, looksLikeGoogleSheet, tabsToDraft } from "@/lib/google-launch/sheet";
import type { Cell, Grid } from "@/lib/launch-sheet/types";

// Launching Google Ads from the chat: a buyer's sheet read whatever its layout (match type notation, pins, tabs), the
// plan checked against Google's limits before Google is asked, the batch Google gets (everything paused, in order,
// with temporary names), Google's errors pinned to their lines, and no deploy while the client's switch is off.

const cell = (text: string, links: string[] = []): Cell => ({ text, links, color: null });
const grid = (rows: string[][]): Grid => ({ rows: rows.map((r) => r.map((t) => cell(t))), source: "gsheet" });

describe("keywords as buyers write them", () => {
  it("reads [exact], \"phrase\", +broad and plain", () => {
    expect(parseKeyword("[Emergency Plumber]")).toMatchObject({ text: "emergency plumber", match: "EXACT", from: "notation" });
    expect(parseKeyword('"plumber near me"')).toMatchObject({ text: "plumber near me", match: "PHRASE", from: "notation" });
    expect(parseKeyword("“curly quotes”")).toMatchObject({ text: "curly quotes", match: "PHRASE" });
    expect(parseKeyword("+drain +cleaning")).toMatchObject({ text: "drain cleaning", match: "BROAD" });
    expect(parseKeyword("water heater")).toMatchObject({ text: "water heater", match: "PHRASE", from: "default" });
    expect(parseKeyword("water heater", "EXACT")).toMatchObject({ match: "EXACT", from: "column" });
    expect(parseKeyword("-free")).toMatchObject({ text: "free", negative: true });
    expect(parseKeyword("   ")).toBeNull();
  });
  it("reads match type columns", () => {
    expect(matchOf("Exact")).toBe("EXACT");
    expect(matchOf("P")).toBe("PHRASE");
    expect(matchOf("Broad match")).toBe("BROAD");
    expect(matchOf("[ ]")).toBe("EXACT");
    expect(matchOf("")).toBeNull();
  });
  it("splits a cell of several keywords, commas inside brackets kept", () => {
    const ks = splitKeywords('[a, b], "c d"\nplain; +e');
    expect(ks.map((k) => [k.text, k.match])).toEqual([
      ["a, b", "EXACT"],
      ["c d", "PHRASE"],
      ["plain", "PHRASE"],
      ["e", "BROAD"],
    ]);
  });
  it("reads pins written into the copy", () => {
    expect(parsePinned("Call Today (pin 1)")).toEqual({ text: "Call Today", pin: 1 });
    expect(parsePinned("[P2] Free Estimates")).toEqual({ text: "Free Estimates", pin: 2 });
    expect(parsePinned("Licensed & Insured")).toEqual({ text: "Licensed & Insured", pin: 0 });
    expect(parsePinned("Desc text pinned 3", 2)).toEqual({ text: "Desc text", pin: 0 });
  });
});

describe("a Google buyer's sheet", () => {
  it("reads one row per keyword with Campaign, Ad group, Keyword, Match type", () => {
    const { draft, recognized } = tabsToDraft([
      {
        title: "Sheet1",
        grid: grid([
          ["Campaign", "Ad group", "Keyword", "Match type", "Final URL"],
          ["Search | Plumbing", "Emergency", "emergency plumber", "Exact", "https://x.com/emergency"],
          ["", "", "24 hour plumber", "Phrase", ""],
          ["", "", "[burst pipe]", "Phrase", ""],
          ["", "Water heaters", "water heater repair", "Phrase", "https://x.com/wh"],
          ["", "", "emergency plumber", "Exact", ""],
        ]),
      },
    ]);
    expect(recognized).toBe(true);
    expect(draft.adGroups.map((g) => [g.campaign, g.name, g.keywords.length, g.finalUrl])).toEqual([
      ["Search | Plumbing", "Emergency", 3, "https://x.com/emergency"],
      ["Search | Plumbing", "Water heaters", 2, "https://x.com/wh"],
    ]);
    // The notation wins over the column
    expect(draft.adGroups[0].keywords.find((k) => k.text === "burst pipe")?.match).toBe("EXACT");
    expect(draft.notes.join(" ")).toMatch(/more than one ad group/);
  });

  it("reads a wide row per ad group with Headline 1..15, Description 1..4, paths and keywords in one cell", () => {
    const head = ["Ad group", "Keywords", ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`), "Description 1", "Description 2", "Description 3", "Description 4", "Path 1", "Path 2", "Final URL"];
    const row = ["Brand", '[acme]\n"acme plumbing"', ...Array.from({ length: 15 }, (_, i) => (i === 0 ? "Acme Plumbing (pin 1)" : `Headline number ${i + 1}`)), "D1 text", "D2 text", "", "", "plumbing", "emergency", "https://acme.com"];
    const { draft } = tabsToDraft([{ title: "RSAs", grid: grid([head, row]) }]);
    const g = draft.adGroups[0];
    expect(g.keywords.map((k) => k.match)).toEqual(["EXACT", "PHRASE"]);
    expect(g.rsas).toHaveLength(1);
    expect(g.rsas[0].headlines).toHaveLength(15);
    expect(g.rsas[0].headlines[0]).toEqual({ text: "Acme Plumbing", pin: 1 });
    expect(g.rsas[0].descriptions.map((d) => d.text)).toEqual(["D1 text", "D2 text"]);
    expect([g.rsas[0].path1, g.rsas[0].path2, g.rsas[0].finalUrl]).toEqual(["plumbing", "emergency", "https://acme.com"]);
    expect(draftSummary(draft)).toBe("I read 1 ad group, 2 keywords (1 phrase, 1 exact), 1 RSA with 15 headlines each");
  });

  it("reads one tab per ad group with loose lists, and a negatives tab", () => {
    const { draft } = tabsToDraft([
      { title: "Drain Cleaning", grid: grid([["Keywords", "Headlines", "Descriptions"], ["drain cleaning", "Fast Drain Cleaning", "We clear any drain."], ["clogged drain", "Same Day Service", "Licensed plumbers."], ["", "Call Now", ""]]) },
      { title: "Sewer", grid: grid([["Keywords", "Headlines", "Descriptions"], ["[sewer repair]", "Sewer Experts", "Camera inspections."]]) },
      { title: "Negatives", grid: grid([["Negative keywords"], ["free"], ["[diy]"], ["jobs"]]) },
    ]);
    expect(draft.adGroups.map((g) => g.name)).toEqual(["Drain Cleaning", "Sewer"]);
    expect(draft.adGroups[0].rsas[0].headlines.map((h) => h.text)).toEqual(["Fast Drain Cleaning", "Same Day Service", "Call Now"]);
    expect(draft.adGroups[0].keywords.every((k) => k.from === "default")).toBe(true);
    expect(draft.campaignNegatives[0].keywords.map((k) => [k.text, k.match])).toEqual([
      ["free", "PHRASE"],
      ["diy", "EXACT"],
      ["jobs", "PHRASE"],
    ]);
    // Unwritten match types are asked, then applied
    const both = applyMatchAnswer(draft, "Exact and phrase, both");
    expect(both.adGroups[0].keywords.map((k) => `${k.match}:${k.text}`)).toEqual(["EXACT:drain cleaning", "PHRASE:drain cleaning", "EXACT:clogged drain", "PHRASE:clogged drain"]);
    expect(both.adGroups[1].keywords[0].match).toBe("EXACT");
  });

  it("tells a Google sheet from a Meta launch sheet", () => {
    expect(looksLikeGoogleSheet(grid([["Ad group", "Keyword", "Match type"], ["a", "b", "Exact"]]))).toBe(true);
    expect(looksLikeGoogleSheet(grid([["Date", "Page", "Creative", "Headline", "Primary text"], ["Oct 1", "Venue", "img", "h", "p"]]))).toBe(false);
    expect(tabsToDraft([{ title: "x", grid: grid([["Date", "Page"], ["1", "2"]]) }]).recognized).toBe(false);
  });
});

const camp = (over: Partial<GooglePlan["campaigns"][number]> = {}): GooglePlan["campaigns"][number] => ({
  key: "c1",
  mode: "new",
  existingId: null,
  name: "Search | Plumbing",
  type: "SEARCH",
  budget: 50,
  bidding: "MAXIMIZE_CONVERSIONS",
  targetCpa: null,
  targetRoas: null,
  locations: [{ geo: "geoTargetConstants/1026339", name: "Houston" }],
  negatives: [{ text: "free", match: "PHRASE" }],
  sitelinks: [],
  callouts: ["24/7 Service"],
  snippets: [],
  ...over,
});
const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Headline ${i + 1}`, pin: 0 as const }));
const plan = (over: Partial<GooglePlan> = {}): GooglePlan => ({
  account: "1234567890",
  campaigns: [camp()],
  adGroups: [
    {
      key: "g1",
      campaignKey: "c1",
      mode: "new",
      existingId: null,
      name: "Emergency",
      keywords: [
        { text: "emergency plumber", match: "EXACT" },
        { text: "emergency plumber", match: "PHRASE" },
      ],
      negatives: [],
      rsas: [{ key: "r1", headlines: heads(15), descriptions: [{ text: "Fast, licensed plumbers.", pin: 0 }, { text: "Call for a free quote.", pin: 0 }], path1: "plumbing", path2: "", finalUrl: "https://acme.com" }],
    },
  ],
  assetGroups: [],
  note: "",
  ...over,
});

describe("checking the plan before Google", () => {
  it("passes a clean plan", () => {
    expect(checkGooglePlan(plan()).filter((i) => i.level === "error")).toEqual([]);
  });
  it("catches limits, counts, duplicates and risky wording", () => {
    const p = plan();
    const r = p.adGroups[0].rsas[0];
    r.headlines = [...heads(15), { text: "One too many", pin: 0 }];
    r.headlines[1] = { text: "This headline is far too long for Google", pin: 0 };
    r.headlines[2] = { text: "Headline 1", pin: 0 };
    r.headlines[3] = { text: "Call Now!", pin: 0 };
    r.descriptions = [{ text: "x".repeat(91), pin: 0 }];
    r.path1 = "a-very-long-display-path";
    r.finalUrl = "acme.com";
    p.adGroups[0].keywords.push({ text: "emergency plumber", match: "EXACT" }, { text: "cheap!!", match: "PHRASE" });
    const msgs = checkGooglePlan(p, new Set([kwKey({ text: "emergency plumber", match: "PHRASE" })])).map((i) => `${i.level}:${i.message}`);
    const has = (re: RegExp) => expect(msgs.some((m) => re.test(m)), `${re} in\n${msgs.join("\n")}`).toBe(true);
    has(/^error:16 headlines/);
    has(/^error:Headline 2 .* is 40 of 30 characters/);
    has(/^error:Headline "Headline 1" is there twice/);
    has(/^error:Headline 4 "Call Now!": Google doesn't allow an exclamation mark/);
    has(/^error:1 description: Google needs at least 2/);
    has(/^error:Description 1 is 91 of 90 characters/);
    has(/^error:A display path is over 15/);
    has(/^error:The final URL "acme.com" isn't a full link/);
    has(/^warn:\[emergency plumber\] is in "Emergency" twice/);
    has(/^warn:"emergency plumber" already runs in the account/);
    has(/^error:"cheap!!" has characters Google doesn't allow/);
  });
  it("flags keywords across ad groups, keywords a negative blocks, and a new campaign without budget", () => {
    const p = plan({ campaigns: [camp({ budget: null, negatives: [{ text: "emergency plumber", match: "PHRASE" }] })] });
    p.adGroups.push({ ...p.adGroups[0], key: "g2", name: "Other", rsas: [] });
    const msgs = checkGooglePlan(p).map((i) => i.message);
    expect(msgs).toContain("A new campaign needs a daily budget.");
    expect(msgs.some((m) => /also in "Emergency": the two ad groups would compete/.test(m))).toBe(true);
    expect(msgs.some((m) => /also a negative here, so it would never show/.test(m))).toBe(true);
  });
  it("tidies what can be fixed without a rewrite", () => {
    const p = plan();
    p.adGroups[0].rsas[0].headlines[0] = { text: "Call Now!!", pin: 1 };
    p.adGroups[0].rsas[0].headlines[1] = { text: "HVAC Experts", pin: 0 };
    p.adGroups[0].rsas[0].headlines[2] = { text: "headline 4", pin: 0 };
    const t = tidyPlan(p).adGroups[0].rsas[0];
    expect(t.headlines[0]).toEqual({ text: "Call Now", pin: 1 });
    // Caps can be a brand or an acronym: left for the buyer
    expect(t.headlines[1].text).toBe("HVAC Experts");
    expect(t.headlines).toHaveLength(14);
  });
});

describe("the batch Google gets", () => {
  it("creates everything paused, in order, with temporary names", () => {
    const { ops, keys, byHand } = googleOperations(plan(), "123-456-7890");
    expect(byHand).toEqual([]);
    const kinds = ops.map((o) => Object.keys(o)[0]);
    expect(kinds.slice(0, 2)).toEqual(["campaignBudgetOperation", "campaignOperation"]);
    const c = (ops[1].campaignOperation as { create: Record<string, unknown> }).create;
    expect(c.status).toBe("PAUSED");
    expect(c.campaignBudget).toBe("customers/1234567890/campaignBudgets/-1");
    expect(c.resourceName).toBe("customers/1234567890/campaigns/-2");
    const creates = ops.map((o) => (Object.values(o)[0] as { create: Record<string, unknown> }).create);
    // Every campaign, ad group, keyword, ad and asset link is paused
    for (const [i, cr] of creates.entries()) if (["campaignOperation", "adGroupOperation", "adGroupAdOperation", "campaignAssetOperation"].includes(kinds[i]) || (kinds[i] === "adGroupCriterionOperation" && !cr.negative)) expect(cr.status, kinds[i]).toBe("PAUSED");
    const ag = creates[kinds.indexOf("adGroupOperation")];
    expect(ag.campaign).toBe("customers/1234567890/campaigns/-2");
    expect(keys[kinds.indexOf("adGroupAdOperation")]).toBe("rsa:g1:r1");
    expect(keys.filter((k) => k.startsWith("kw:g1:"))).toEqual(["kw:g1:0", "kw:g1:1"]);
    expect(keys.filter((k) => k === "callout:c1:0")).toHaveLength(2);
  });
  it("adds into existing campaigns and ad groups by their ids, and leaves new PMax to be built by hand", () => {
    const p = plan({ campaigns: [camp({ mode: "existing", existingId: "555", negatives: [], callouts: [] }), camp({ key: "c2", type: "PERFORMANCE_MAX", name: "PMax" })] });
    p.adGroups[0] = { ...p.adGroups[0], mode: "existing", existingId: "777" };
    const { ops, byHand } = googleOperations(p, "1234567890");
    expect(ops.some((o) => "campaignOperation" in o)).toBe(false);
    expect(((ops[0].adGroupCriterionOperation as { create: { adGroup: string } }).create.adGroup)).toBe("customers/1234567890/adGroups/777");
    expect(byHand.map((b) => b.key)).toEqual(["campaign:c2"]);
  });
  it("pins Google's errors to their lines", () => {
    const raw = JSON.stringify({
      error: {
        message: "Request contains an invalid argument.",
        details: [
          {
            errors: [
              { errorCode: { stringLengthError: "TOO_LONG" }, message: "Too long.", trigger: { stringValue: "This headline is too long" }, location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 5 }, { fieldName: "ad_group_ad_operation" }] } },
              { errorCode: { policyFindingError: "POLICY_FINDING" }, message: "Policy", details: { policyFindingDetails: { policyTopicEntries: [{ topic: "HEALTH_IN_PERSONALIZED_ADS" }] } }, location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 3 }] } },
              { errorCode: { requestError: "UNKNOWN" }, message: "Something" },
            ],
          },
        ],
      },
    });
    const errs = parseGoogleErrors(raw);
    expect(errs.map((e) => [e.index, e.code])).toEqual([
      [5, "stringLengthError.TOO_LONG"],
      [3, "policyFindingError.POLICY_FINDING"],
      [null, "requestError.UNKNOWN"],
    ]);
    const { by, loose } = errorsByLine(errs, ["budget:c1", "campaign:c1", "targeting:c1", "kw:g1:0", "kw:g1:1", "rsa:g1:r1"]);
    expect([...by.keys()]).toEqual(["rsa:g1:r1", "kw:g1:0"]);
    expect(loose).toHaveLength(1);
  });
});

describe("the plan's lines and edits on the card", () => {
  it("lists every object once", () => {
    const keys = googleItems(plan()).map((i) => i.key);
    expect(keys).toEqual(["budget:c1", "campaign:c1", "targeting:c1", "cneg:c1:0", "callout:c1:0", "adgroup:g1", "kw:g1:0", "kw:g1:1", "rsa:g1:r1"]);
  });
  it("removes a line, fixes copy inline, changes a keyword and a budget", () => {
    let p = editPlan(plan(), { type: "remove", key: "kw:g1:0" });
    expect(p.adGroups[0].keywords.map((k) => k.match)).toEqual(["PHRASE"]);
    p = editPlan(p, { type: "line", key: "rsa:g1:r1", field: "headline", index: 0, text: "Acme Plumbing" });
    expect(p.adGroups[0].rsas[0].headlines[0].text).toBe("Acme Plumbing");
    p = editPlan(p, { type: "line", key: "rsa:g1:r1", field: "headline", index: 1, text: "" });
    expect(p.adGroups[0].rsas[0].headlines).toHaveLength(14);
    p = editPlan(p, { type: "keyword", key: "kw:g1:0", text: "[burst pipe]", match: "PHRASE" });
    expect(p.adGroups[0].keywords[0]).toMatchObject({ text: "burst pipe", match: "EXACT" });
    p = editPlan(p, { type: "budget", campaignKey: "c1", amount: 75 });
    expect(p.campaigns[0].budget).toBe(75);
    p = editPlan(p, { type: "remove", key: "campaign:c1" });
    expect([p.campaigns.length, p.adGroups.length]).toEqual([0, 0]);
  });
});

describe("what the buyer is asked", () => {
  const campaigns: AccountCampaign[] = [
    { id: "1", name: "Search | Plumbing | Houston", status: "ENABLED", type: "SEARCH", bidding: "MAXIMIZE_CONVERSIONS", budget: 80, spend30: 2100, conversions30: 40 },
    { id: "2", name: "PMax | All", status: "ENABLED", type: "PERFORMANCE_MAX", bidding: "MAXIMIZE_CONVERSION_VALUE", budget: 60, spend30: 1500, conversions30: 20 },
    { id: "3", name: "Brand", status: "PAUSED", type: "SEARCH", bidding: "MANUAL_CPC", budget: 10, spend30: 0, conversions30: 0 },
  ];
  it("asks only what's missing, with the live campaigns that fit first", () => {
    const qs = googleQuestions({ adGroups: [], campaignNegatives: [], notes: [] }, campaigns, [], "new ad group for water heater plumbing");
    expect(qs.map((x) => x.key)).toEqual(["campaign", "ad_group", "final_url", "keywords", "ads", "go_live"]);
    expect(qs[0].options[0]).toBe("Search | Plumbing | Houston (Search, on, $2100 in 30 days)");
    expect(qs[0].options).toContain("A new Search campaign");
  });
  it("doesn't ask what the sheet answered, and asks about unwritten match types", () => {
    const { draft } = tabsToDraft([{ title: "x", grid: grid([["Campaign", "Ad group", "Keyword", "Headline 1", "Headline 2", "Headline 3", "Description 1", "Description 2", "Final URL"], ["Brand", "Brand", "acme", "a", "b", "c", "d", "e", "https://acme.com"]]) }]);
    expect(googleQuestions(draft, campaigns, [], "").map((x) => x.key)).toEqual(["match_types", "go_live"]);
  });
  it("reads the buyer's campaign pick", () => {
    expect(campaignChoice("Add to Search | Plumbing | Houston (Search, on, $2100 in 30 days)", campaigns)).toEqual({ mode: "existing", id: "1" });
    expect(campaignChoice("A new Performance Max campaign", campaigns)).toEqual({ mode: "new", type: "PERFORMANCE_MAX" });
    expect(campaignChoice("a new one please", campaigns)).toEqual({ mode: "new", type: "SEARCH" });
  });
});

describe("the gate", () => {
  const ready = { live: true, liveReason: null, canConfirm: true, status: "ready", items: [{ status: "valid" as const }], errors: 0 };
  it("deploys only when the client's Google switch is on", () => {
    expect(deployBlocked(ready)).toBeNull();
    expect(deployBlocked({ ...ready, live: false, liveReason: "Live changes in Google Ads are off for Acme." })).toBe("Live changes in Google Ads are off for Acme.");
  });
  it("and only for someone allowed, a checked plan, nothing refused", () => {
    expect(deployBlocked({ ...ready, canConfirm: false })).toMatch(/Only the client's Google buyer/);
    expect(deployBlocked({ ...ready, status: "asking" })).toMatch(/no checked plan/);
    expect(deployBlocked({ ...ready, errors: 2 })).toMatch(/2 lines need fixing/);
    expect(deployBlocked({ ...ready, items: [{ status: "invalid" }] })).toMatch(/refused/);
  });
});
