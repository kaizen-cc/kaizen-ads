import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pdfLayout } from "@/lib/launch-sheet/pdf-layout";
import { pdfToGrid } from "@/lib/launch-sheet/grid";
import { gridToSheet } from "@/lib/launch-sheet/sheet";
import { blockedBy, buildPlan, budgetOptions, copyOf, metaScopeIssues, planItems, plannedSpend, runnable, runOutcome, unanswered, type Proposal } from "@/lib/launch-sheet/plan";
import { adParams, adsetParams, campaignParams, creativeSpec, ENHANCEMENTS_OFF, formFields, metaTime, scheduleParams } from "@/lib/launch-sheet/payloads";
import { applyAnswers, mergeQuestions, requiredQuestions } from "@/lib/launch-sheet/questions";
import { explainMetaError } from "@/lib/launch-sheet/errors";
import { aspectOf, matchPage, pickSizes } from "@/lib/launch-sheet/resolve";
import type { LaunchItem, LaunchSheet, PlanAd, Resolution, ResolvedFile } from "@/lib/launch-sheet/types";

// From the sheet to what Meta is sent: the plan the Media Buyer proposes, filled in with the exact copy, files and
// posts; Kaizen's launch rules in the creative (stacked text, 4:5 feeds and 9:16 Stories/Reels, enhancements off,
// existing posts as they are); created paused; and resuming a launch line by line without creating anything twice.
// No real Meta or Drive: the resolution is a fixture.

let sheet: LaunchSheet;
beforeAll(async () => {
  sheet = gridToSheet(pdfToGrid(await pdfLayout(readFileSync("tests/fixtures/launch-sheet-bar-fest.pdf"))), "2026-09-01");
}, 60_000);

const file = (id: string, aspect: ResolvedFile["aspect"], kind: "image" | "video" = "image"): ResolvedFile => ({ id, name: `${id}.${kind === "video" ? "mp4" : "png"}`, mime: kind === "video" ? "video/mp4" : "image/png", aspect, kind, width: null, height: null, thumb: `https://thumb/${id}`, bytes: 1000 });

function resolution(s: LaunchSheet): Resolution {
  const collage = s.rows.find((r) => r.creative.name.startsWith("Collage Flyers"))!;
  const post = s.rows.find((r) => r.existingPost)!;
  const video = s.rows.find((r) => r.creative.name === "On Sale Ad Video 1")!;
  return {
    account: "111",
    pages: [
      { name: "Mad City Bar Fest", pageId: "p1", pageName: "Mad City Bar Fest", igId: "ig1", igName: "madcitybarfest", canAdvertise: true, how: "in the ad account's Pages", rows: [] },
      { name: "Firehouse", pageId: null, pageName: null, igId: null, igName: null, canAdvertise: false, how: null, rows: [] },
    ],
    creatives: [
      { row: collage.index, name: collage.creative.name, files: [file("f45", "4x5"), file("f916", "9x16"), file("f11", "1x1")], picked: { feed: "f45", vertical: "f916" }, missing: [], error: null },
      { row: video.index, name: video.creative.name, files: [file("v916", "9x16", "video")], picked: { feed: null, vertical: "v916" }, missing: ["4x5"], error: null },
    ],
    posts: [{ row: post.index, url: post.existingPost!, platform: "instagram", shortcode: "DdUoEsTGIRy", mediaId: "m1", igId: "ig1", pageId: "p1", storyId: null, error: null }],
    geos: [{ text: "San Diego", key: "2421836", name: "San Diego", type: "city", region: "California", country: "US", rows: [] }],
    pixel: { id: "px1", name: "Main", lastFired: "2026-09-01", purchaseRecent: true, domainSeen: true },
    existing: [],
    spend: { matched: null, sheet: 1464.53 },
    checks: [{ key: "policy_alcohol", label: "Alcohol policy", level: "info", detail: "" }],
    at: "2026-09-01T00:00:00Z",
  };
}

function proposal(s: LaunchSheet): Proposal {
  const collage = s.rows.find((r) => r.creative.name.startsWith("Collage Flyers"))!;
  const post = s.rows.find((r) => r.existingPost)!;
  const video = s.rows.find((r) => r.creative.name === "On Sale Ad Video 1")!;
  const none = { type: "none" as const, amount: 0, schedules: [] };
  return {
    note: "One campaign, the budget on it.",
    goLive: "paused",
    campaigns: [{ key: "c1", mode: "new", existingId: "", name: "PB Halloween | Sales", objective: "OUTCOME_SALES", budget: { type: "daily", amount: 50, schedules: [{ start: "2026-09-28", end: "2026-10-04", amount: 57.14 }] }, start: "2026-09-21", end: "2026-10-31" }],
    adsets: [{ key: "s1", campaignKey: "c1", mode: "new", existingId: "", name: "PB | San Diego 15mi | 21+", budget: none, start: "2026-09-21", end: "2026-10-31", geos: [{ text: "San Diego", radius: 15 }], countries: [], zips: [], ageMin: 21, ageMax: 65, advantageAudience: false, event: "PURCHASE" }],
    ads: [
      { key: "a1", adsetKey: "s1", rows: [collage.index], name: "Collage Flyers | Stacked", identity: "page", page: "Mad City Bar Fest", partner: "", cta: "BUY_TICKETS", link: "" },
      { key: "a2", adsetKey: "s1", rows: [post.index], name: "IG post 1", identity: "page", page: "Mad City Bar Fest", partner: "", cta: "BUY_TICKETS", link: "" },
      { key: "a3", adsetKey: "s1", rows: [video.index], name: "On Sale Video 1", identity: "page", page: "Mad City Bar Fest", partner: "", cta: "", link: "" },
      { key: "a4", adsetKey: "s1", rows: [s.rows.find((r) => r.page === "Firehouse")!.index], name: "Firehouse flyer", identity: "page", page: "Firehouse", partner: "", cta: "", link: "" },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a creative spec is deep JSON
type Spec = Record<string, any>;

const ctx = (s: LaunchSheet) => ({ sheet: s, resolution: resolution(s), account: "111", urlTags: "utm_source=facebook", today: "2026-09-01", specialAdCategories: [] });

describe("the plan from the Media Buyer's proposal", () => {
  it("fills in the exact copy, files, posts, pixel and geo keys", () => {
    const { plan, warnings } = buildPlan(proposal(sheet), ctx(sheet));
    expect(plan.ads.map((a) => a.key)).toEqual(["a1", "a2", "a3"]);
    const a1 = plan.ads[0];
    expect(a1.copy.titles).toEqual(["Pacific Beach Halloween Bar Fest", "7+ Bars. One Wristband.", "Halloween in Pacific Beach"]);
    expect(a1.copy.bodies).toHaveLength(3);
    expect(a1.source).toMatchObject({ kind: "files", feed: { fileId: "f45", aspect: "4x5" }, vertical: { fileId: "f916", aspect: "9x16" } });
    expect(a1.identity).toMatchObject({ mode: "page", pageId: "p1", igId: "ig1" });
    expect(a1.link).toBe("https://www.madcitybarfest.com/pacific-beach");
    expect(plan.ads[1].source).toMatchObject({ kind: "existing_post", platform: "instagram", mediaId: "m1" });
    expect(plan.adsets[0]).toMatchObject({ pixelId: "px1", event: "PURCHASE", targeting: { cities: [{ key: "2421836", radius: 15, unit: "mile" }], ageMin: 21 } });
    // The venue Page Kaizen can't advertise as is left out, and said
    expect(warnings.join(" ")).toMatch(/Firehouse/);
  });

  it("dedupes copy across rows an ad runs", () => {
    const rows = sheet.rows.filter((r) => r.creative.name.startsWith("presale")).map((r) => r.index);
    expect(copyOf(sheet, rows).titles).toEqual(["Pacific Beach Halloween Bar Fest", "$5. 7+ Bars. One Wristband.", "$5 Presale Ends Soon"]);
  });

  it("counts what the plan spends against the sheet", () => {
    const { plan } = buildPlan(proposal(sheet), ctx(sheet));
    // $50/day for 41 days, plus $57.14/day for the 7 days of the second period
    expect(plannedSpend(plan)).toBeCloseTo(50 * 41 + 57.14 * 7, 2);
  });

  it("works out the budget options from the sheet's periods", () => {
    const o = budgetOptions(sheet, "2026-10-10")!;
    expect(o.platform).toBe("Meta");
    const daily = o.options.find((x) => x.mode === "per_period_daily")!;
    expect(daily.map.lines[0]).toMatchObject({ start: "2026-10-10", end: "2026-10-11", days: 2 });
    expect(daily.map.skipped).toHaveLength(2);
  });
});

describe("what Meta is sent", () => {
  const ad = (over: Partial<PlanAd> = {}): PlanAd => ({
    key: "a1",
    adsetKey: "s1",
    name: "Flyer",
    rows: [0],
    identity: { mode: "page", pageId: "p1", pageName: "Brand", igId: "ig1", partnerPageId: null, partnerIgId: null, partnerName: null },
    source: { kind: "files", feed: { fileId: "f45", name: "f", aspect: "4x5", kind: "image", thumb: null }, vertical: { fileId: "f916", name: "v", aspect: "9x16", kind: "image", thumb: null } },
    copy: { bodies: ["Body 1", "Body 2", "Body 3"], titles: ["Head 1", "Head 2"], descriptions: [] },
    cta: "BUY_TICKETS",
    link: "https://example.com/e",
    urlTags: "utm_source=facebook",
    ...over,
  });

  it("stacks every text option with 4:5 in feeds and 9:16 in Stories and Reels", () => {
    const spec = creativeSpec(ad(), { feed: { hash: "h45" }, vertical: { hash: "h916" } }) as Spec;
    expect(spec.object_story_spec).toEqual({ page_id: "p1", instagram_user_id: "ig1" });
    const feed = spec.asset_feed_spec;
    expect(feed.optimization_type).toBe("PLACEMENT");
    expect(feed.bodies).toEqual([{ text: "Body 1" }, { text: "Body 2" }, { text: "Body 3" }]);
    expect(feed.titles).toEqual([{ text: "Head 1" }, { text: "Head 2" }]);
    expect(feed.images).toEqual([
      { hash: "h45", adlabels: [{ name: "kz_feed" }] },
      { hash: "h916", adlabels: [{ name: "kz_vertical" }] },
    ]);
    expect(feed.asset_customization_rules[0].customization_spec.instagram_positions).toContain("stream");
    expect(feed.asset_customization_rules[1].customization_spec.instagram_positions).toEqual(["story", "reels"]);
    expect(feed.call_to_action_types).toEqual(["BUY_TICKETS"]);
    // Advantage+ creative enhancements off, Kaizen's UTMs, never in a multi-advertiser unit
    expect(Object.keys(spec.degrees_of_freedom_spec.creative_features_spec)).toEqual(ENHANCEMENTS_OFF);
    expect(spec.degrees_of_freedom_spec.creative_features_spec.text_optimizations).toEqual({ enroll_status: "OPT_OUT" });
    expect(spec.url_tags).toBe("utm_source=facebook");
    expect(spec.contextual_multi_ads).toEqual({ enroll_status: "OPT_OUT" });
    // As Meta's form fields, objects are JSON
    expect(JSON.parse(formFields(spec).asset_feed_spec).images).toHaveLength(2);
  });

  it("runs a single size as one ad with the other texts as text options", () => {
    const spec = creativeSpec(ad({ source: { kind: "files", feed: null, vertical: { fileId: "v", name: "v", aspect: "9x16", kind: "video", thumb: null } } }), { feed: null, vertical: { videoId: "vid1", thumb: "https://t" } }) as Spec;
    expect(spec.object_story_spec.video_data).toMatchObject({ video_id: "vid1", image_url: "https://t", message: "Body 1", title: "Head 1", call_to_action: { type: "BUY_TICKETS", value: { link: "https://example.com/e" } } });
    expect(spec.asset_feed_spec).toEqual({ bodies: [{ text: "Body 1" }, { text: "Body 2" }, { text: "Body 3" }], titles: [{ text: "Head 1" }, { text: "Head 2" }], optimization_type: "DEGREES_OF_FREEDOM" });
  });

  it("runs an existing Instagram post as it is", () => {
    const spec = creativeSpec(ad({ source: { kind: "existing_post", platform: "instagram", url: "https://instagram.com/p/x", mediaId: "m1", storyId: null } }), { feed: null, vertical: null }) as Spec;
    expect(spec).toMatchObject({ object_id: "p1", instagram_user_id: "ig1", source_instagram_media_id: "m1", call_to_action: { type: "BUY_TICKETS", value: { link: "https://example.com/e" } } });
    expect(spec.asset_feed_spec).toBeUndefined();
    expect(spec.object_story_spec).toBeUndefined();
    const fb = creativeSpec(ad({ source: { kind: "existing_post", platform: "facebook", url: "u", mediaId: null, storyId: "p1_9" } }), { feed: null, vertical: null }) as Spec;
    expect(fb.object_story_id).toBe("p1_9");
  });

  it("creates paused, and active only for a scheduled start", () => {
    const { plan } = buildPlan(proposal(sheet), ctx(sheet));
    const c = campaignParams(plan.campaigns[0], "paused", -7);
    expect(c).toMatchObject({ status: "PAUSED", objective: "OUTCOME_SALES", daily_budget: "5000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", special_ad_categories: "[]" });
    const s = adsetParams(plan.adsets[0], "cmp1", true, "paused", -7);
    expect(s).toMatchObject({ status: "PAUSED", campaign_id: "cmp1", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", start_time: "2026-09-21T00:00:00-0700", end_time: "2026-10-31T23:59:59-0700" });
    expect(s.daily_budget).toBeUndefined();
    expect(JSON.parse(s.promoted_object)).toEqual({ pixel_id: "px1", custom_event_type: "PURCHASE" });
    expect(JSON.parse(s.targeting)).toMatchObject({ geo_locations: { cities: [{ key: "2421836", radius: 15, distance_unit: "mile" }] }, age_min: 21, targeting_automation: { advantage_audience: 0 } });
    expect(adsetParams(plan.adsets[0], "cmp1", true, "scheduled", -7).status).toBe("ACTIVE");
    const a = adParams(plan.ads[0], "as1", "cr1", "paused", "px1");
    expect(a).toMatchObject({ status: "PAUSED", adset_id: "as1", creative: JSON.stringify({ creative_id: "cr1" }) });
    expect(JSON.parse(a.tracking_specs)[0].fb_pixel).toEqual(["px1"]);
  });

  it("schedules a raised budget for a period", () => {
    expect(metaTime("2026-09-28", 5.5)).toBe("2026-09-28T00:00:00+0530");
    const p = scheduleParams({ start: "2026-09-28", end: "2026-10-04", amount: 57.14 }, -7);
    expect(p).toMatchObject({ budget_value: "5714", budget_value_type: "ABSOLUTE" });
    expect(Number(p.time_start)).toBe(Date.parse("2026-09-28T07:00:00Z") / 1000);
  });
});

describe("creating it line by line, resumable", () => {
  const lines = () => {
    const { plan } = buildPlan(proposal(sheet), ctx(sheet));
    return { plan, items: planItems(plan) };
  };
  const set = (items: LaunchItem[], key: string, status: LaunchItem["status"]) => items.map((i) => (i.key === key ? { ...i, status, metaId: status === "created" ? `id-${key}` : i.metaId } : i));

  it("orders the lines: campaign, ad set, media, creatives, ads", () => {
    const { items } = lines();
    expect(items.map((i) => i.kind)).toEqual(["campaign", "adset", "media", "media", "media", "creative", "creative", "creative", "ad", "ad", "ad"]);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("runs only what its parents are ready for, and never a line that's created", () => {
    const { plan, items } = lines();
    expect(runnable(items, plan).map((i) => i.key)).toEqual(["campaign:c1", "media:f45", "media:f916", "media:v916"]);
    let it2 = set(items, "campaign:c1", "created");
    it2 = set(it2, "media:f45", "created");
    expect(runnable(it2, plan).map((i) => i.key)).toEqual(["adset:s1", "media:f916", "media:v916"]);
    it2 = set(set(set(it2, "adset:s1", "created"), "media:f916", "created"), "media:v916", "created");
    // The existing post needs no media; the files creative needs both of its sizes
    expect(runnable(it2, plan).map((i) => i.key)).toEqual(["creative:a1", "creative:a2", "creative:a3"]);
  });

  it("retries a failed line only when asked, and says what a blocked line waits on", () => {
    const { plan, items } = lines();
    let it2 = set(set(items, "campaign:c1", "created"), "adset:s1", "failed");
    expect(runnable(it2, plan).some((i) => i.key === "adset:s1")).toBe(false);
    expect(runnable(it2, plan, true).some((i) => i.key === "adset:s1")).toBe(true);
    expect(blockedBy(it2, plan, "ad:a1")).toBe("PB | San Diego 15mi | 21+");
    it2 = it2.map((i) => ({ ...i, status: i.key === "adset:s1" ? "failed" : "created" }));
    expect(runOutcome(it2)).toBe("partial");
    expect(runOutcome(it2.map((i) => ({ ...i, status: "created" as const })))).toBe("applied");
  });

  it("adds to existing campaigns and ad sets without creating them", () => {
    const p = proposal(sheet);
    p.campaigns[0] = { ...p.campaigns[0], mode: "existing", existingId: "999" };
    const { plan } = buildPlan(p, ctx(sheet));
    const items = planItems(plan);
    expect(items[0]).toMatchObject({ key: "campaign:c1", status: "existing", metaId: "999" });
    expect(runnable(items, plan)[0].key).toBe("adset:s1");
  });
});

describe("questions before any plan", () => {
  it("always asks what decides the writes, and the plan waits for the answers", () => {
    const must = requiredQuestions(sheet, resolution(sheet), "2026-09-01");
    expect(must.map((q) => q.key)).toEqual(["rows", "budget", "structure", "targeting", "pages", "posts"]);
    expect(must.find((q) => q.key === "rows")!.question).toMatch(/red and green/);
    expect(must.find((q) => q.key === "targeting")!.proposal).toMatch(/ages 21/);
    // The model rewrote one and added one: required ones stay required
    const merged = mergeQuestions([{ key: "budget", question: "Budget?", why: "", proposal: "Daily per period", options: [], required: false, answer: null }, { key: "cta", question: "Which button?", why: "", proposal: "Buy tickets", options: [], required: false, answer: null }], must);
    expect(merged.find((q) => q.key === "budget")).toMatchObject({ question: "Budget?", required: true });
    expect(unanswered(merged)).toHaveLength(6);
    const answered = applyAnswers(merged, must.map((q) => ({ key: q.key, answer: q.proposal })));
    expect(unanswered(answered)).toHaveLength(0);
    expect(applyAnswers(merged, [{ key: "nope", answer: "x" }, { key: "rows", answer: "  " }]).find((q) => q.key === "rows")!.answer).toBeNull();
  });

  it("asks whether to add to a campaign or ad set that's running, or copy one, naming the relevant ones", () => {
    const res = resolution(sheet);
    res.existing = [
      { level: "campaign", id: "c9", name: "Evergreen | Sales | Kaizen", status: "ACTIVE", dailyBudget: 80, lifetimeBudget: null, spend: null, related: true },
      { level: "adset", id: "s9", name: "Evergreen | San Diego 21+ | Kaizen", status: "ACTIVE", campaignId: "c9", dailyBudget: null, lifetimeBudget: null, spend: 410, related: true },
    ];
    const q = requiredQuestions(sheet, res, "2026-09-01").find((x) => x.key === "structure")!;
    expect(q.options).toEqual(['Add to the campaign "Evergreen | Sales | Kaizen", a new ad set per Page', 'Into the ad set "Evergreen | San Diego 21+ | Kaizen" as it is', 'A new ad set copied from "Evergreen | San Diego 21+ | Kaizen" (same targeting, pixel and optimization)', "A new Kaizen campaign, one ad set per Page"]);
    expect(q.proposal).toMatch(/copied from "Evergreen/);
    expect(q.why).toMatch(/live and spending/);
  });
});

describe("a new ad set copied from an existing one", () => {
  it("keeps the source's targeting, pixel and optimization", () => {
    const p = proposal(sheet);
    p.adsets[0] = { ...p.adsets[0], geos: [], cloneFrom: "s9" };
    const { plan, warnings } = buildPlan(p, ctx(sheet));
    expect(plan.adsets[0].cloneFrom).toBe("s9");
    expect(warnings.some((w) => /no location/.test(w))).toBe(false);
    const s = { ...plan.adsets[0], cloned: { targeting: { geo_locations: { countries: ["US"] }, age_min: 25 }, promotedObject: { pixel_id: "px9", custom_event_type: "LEAD" }, optimizationGoal: "OFFSITE_CONVERSIONS", billingEvent: "IMPRESSIONS", name: "Evergreen" } };
    const params = adsetParams(s, "c9", true, "paused", -5);
    expect(JSON.parse(params.targeting)).toEqual({ geo_locations: { countries: ["US"] }, age_min: 25 });
    expect(JSON.parse(params.promoted_object)).toEqual({ pixel_id: "px9", custom_event_type: "LEAD" });
    expect(params.status).toBe("PAUSED");
  });
});

describe("resolution helpers", () => {
  it("knows sizes from pixels or names and picks 4:5 and 9:16", () => {
    expect(aspectOf(1080, 1350, "x")).toBe("4x5");
    expect(aspectOf(1080, 1920, "x")).toBe("9x16");
    expect(aspectOf(null, null, "Flyer_9x16.png")).toBe("9x16");
    expect(aspectOf(null, null, "Flyer 1080x1080.png")).toBe("1x1");
    expect(pickSizes([file("a", "1x1"), file("b", "9x16")])).toEqual({ picked: { feed: null, vertical: "b" }, missing: ["4x5"] });
  });

  it("matches Page names loosely, never a wrong one", () => {
    const pages = [{ name: "Mad City Bar Fest" }, { name: "Firehouse American Eatery & Bar" }, { name: "The Local PB" }];
    expect(matchPage("Mad City Bar Fest", pages)?.name).toBe("Mad City Bar Fest");
    expect(matchPage("Firehouse", pages)?.name).toBe("Firehouse American Eatery & Bar");
    expect(matchPage("Sandbox", pages)).toBeNull();
  });
});

describe("Meta's errors in plain words", () => {
  it("says what to fix", () => {
    expect(explainMetaError("Meta (adcreatives): (#200) The user does not have permission to post as Page 12345678").fix).toMatch(/Create ads/);
    expect(explainMetaError("Meta (adsets): Invalid parameter · Budget Too Low: Your budget must be at least $1.00").plain).toMatch(/minimum \(\$1\.00\)/);
    expect(explainMetaError("Meta (adsets): Invalid parameter · Start time is in the past").fix).toMatch(/today/);
    expect(explainMetaError("Meta (x): Something new · Odd thing: here").plain).toBe("Odd thing: here");
  });
});

describe("Kaizen's scope on Meta", () => {
  const scope = {
    campaigns: [
      { id: "k1", name: "Evergreen | Sales | Kaizen", effective: "ACTIVE" },
      { id: "k2", name: "Fest | Sales | Kaizen", effective: "PAUSED" },
      { id: "o1", name: "Client Boosts", effective: "ACTIVE" },
    ],
    adsets: [
      { id: "ks1", name: "SD 21+ | Kaizen", campaignId: "k1", campaign: "Evergreen | Sales | Kaizen" },
      { id: "ks2", name: "LA 21+ | Kaizen", campaignId: "k1", campaign: "Evergreen | Sales | Kaizen" },
      { id: "os1", name: "Boost audience", campaignId: "o1", campaign: "Client Boosts" },
    ],
  };
  it("plans a campaign Kaizen didn't set up as a new Kaizen one, never copies its ad sets, and names new ones the Kaizen way", () => {
    const p = proposal(sheet);
    p.campaigns[0] = { ...p.campaigns[0], mode: "existing", existingId: "o1", name: "Client Boosts" };
    p.adsets[0] = { ...p.adsets[0], cloneFrom: "os1" };
    const { plan, warnings } = buildPlan(p, { ...ctx(sheet), scope });
    expect(plan.campaigns[0]).toMatchObject({ mode: "new", existingId: null, name: "Client Boosts | Kaizen" });
    expect(plan.adsets[0].cloneFrom).toBeNull();
    expect(plan.adsets[0].name).toBe("PB | San Diego 15mi | 21+ | Kaizen");
    expect(warnings.filter((w) => /wasn't set up by Kaizen/.test(w))).toHaveLength(2);
    expect(metaScopeIssues(plan, scope)).toEqual([]);
  });
  it("adds into a Kaizen ad set as it is, and brings a paused Kaizen campaign back last", () => {
    const p = proposal(sheet);
    p.campaigns[0] = { ...p.campaigns[0], mode: "existing", existingId: "k2", name: "x" };
    const { plan } = buildPlan(p, { ...ctx(sheet), scope, revive: "k2" });
    expect(plan.campaigns[0]).toMatchObject({ mode: "existing", existingId: "k2", name: "Fest | Sales | Kaizen", revive: true });
    const items = planItems(plan);
    expect(items.at(-1)).toMatchObject({ key: "revive:c1", label: 'Turn "Fest | Sales | Kaizen" back on' });
    // It waits for every other line
    expect(runnable(items, plan).some((i) => i.key === "revive:c1")).toBe(false);
    const done = items.map((i) => (i.key === "revive:c1" ? i : { ...i, status: "created" as const }));
    expect(runnable(done, plan).map((i) => i.key)).toEqual(["revive:c1"]);
    const p2 = proposal(sheet);
    p2.campaigns[0] = { ...p2.campaigns[0], mode: "existing", existingId: "k1", name: "x" };
    p2.adsets[0] = { ...p2.adsets[0], mode: "existing", existingId: "ks1" };
    const b = buildPlan(p2, { ...ctx(sheet), scope }).plan;
    expect(b.adsets[0]).toMatchObject({ mode: "existing", existingId: "ks1", name: "SD 21+ | Kaizen" });
    expect(b.campaigns[0].revive).toBeUndefined();
  });
  it("refuses at create time anything aimed outside Kaizen's scope", () => {
    const { plan } = buildPlan(proposal(sheet), { ...ctx(sheet), scope });
    const bad = { ...plan, campaigns: [{ ...plan.campaigns[0], mode: "existing" as const, existingId: "o1" }], adsets: [{ ...plan.adsets[0], cloneFrom: "os1" }] };
    expect(metaScopeIssues(bad, scope)).toEqual(['"Client Boosts" wasn\'t set up by Kaizen, so nothing is added to it.', 'The ad set "Boost audience" wasn\'t set up by Kaizen, so it isn\'t copied.']);
    expect(metaScopeIssues({ ...plan, campaigns: [{ ...plan.campaigns[0], name: "PB Halloween" }] }, scope)).toEqual(['The new campaign "PB Halloween" needs Kaizen in its name.']);
  });
});
