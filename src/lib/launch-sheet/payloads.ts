import { toMinor } from "./budget";
import type { BudgetSpec, PlanAd, PlanAdset, PlanCampaign, Targeting } from "./types";

// A plan's lines as the exact requests Meta takes (Marketing API form fields). Pure, so the shapes are tested: Kaizen's
// launch rules (stacked text options, 4:5 in feeds and 9:16 in Stories and Reels, Advantage+ creative enhancements
// off, the client's ad never mixed into a multi-advertiser carousel, Kaizen's UTMs) and created PAUSED unless the
// buyer chose a scheduled start in the conversation.

/** Where each size shows: 4:5 in feeds, 9:16 in Stories and Reels (same as the launcher) */
export const FEED_PLACEMENTS = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "marketplace", "video_feeds", "search"], instagram_positions: ["stream", "explore", "explore_home", "profile_feed"] };
export const VERTICAL_PLACEMENTS = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] };

/** Advantage+ creative enhancements switched off (any Meta doesn't know on this API version is dropped and retried) */
export const ENHANCEMENTS_OFF = [
  "image_touchups", "image_brightness_and_contrast", "text_optimizations", "enhance_cta", "image_templates", "image_uncrop", "adapt_to_placement",
  "video_auto_crop", "inline_comment", "description_automation", "add_text_overlay", "image_animation", "music", "text_translation", "site_extensions", "product_extensions",
];

/** Kaizen's attribution standard: 7-day click, 1-day view */
export const ATTRIBUTION_SPEC = [
  { event_type: "CLICK_THROUGH", window_days: 7 },
  { event_type: "VIEW_THROUGH", window_days: 1 },
];

export const CTA_TYPES: Record<string, string> = {
  "shop now": "SHOP_NOW", "learn more": "LEARN_MORE", "sign up": "SIGN_UP", "book now": "BOOK_NOW", "buy tickets": "BUY_TICKETS", "get tickets": "BUY_TICKETS", "get offer": "GET_OFFER",
  "order now": "ORDER_NOW", "subscribe": "SUBSCRIBE", "contact us": "CONTACT_US", "get directions": "GET_DIRECTIONS", "see menu": "SEE_MENU", "download": "DOWNLOAD", "apply now": "APPLY_NOW", "get quote": "GET_QUOTE",
};
export const ctaType = (label: string, fallback = "LEARN_MORE") => {
  const l = label.trim().toLowerCase();
  if (/^[A-Z_]+$/.test(label.trim())) return label.trim();
  return CTA_TYPES[l] ?? fallback;
};

/** A date as Meta's time at the start (or end) of that day in the ad account's time zone (offset in hours) */
export function metaTime(date: string, tzOffsetHours: number, end = false) {
  const sign = tzOffsetHours < 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetHours);
  const off = `${sign}${String(Math.floor(abs)).padStart(2, "0")}${String(Math.round((abs % 1) * 60)).padStart(2, "0")}`;
  return `${date}T${end ? "23:59:59" : "00:00:00"}${off}`;
}

const json = (v: unknown) => JSON.stringify(v);
const status = (goLive: "paused" | "scheduled") => (goLive === "scheduled" ? "ACTIVE" : "PAUSED");

function budgetFields(b: BudgetSpec | null): Record<string, string> {
  if (!b) return {};
  return b.type === "daily" ? { daily_budget: toMinor(b.amount) } : { lifetime_budget: toMinor(b.amount) };
}

/** POST act_<id>/campaigns */
export function campaignParams(c: PlanCampaign, goLive: "paused" | "scheduled", tz: number): Record<string, string> {
  return {
    name: c.name.slice(0, 400),
    objective: c.objective,
    status: status(goLive),
    buying_type: "AUCTION",
    special_ad_categories: json(c.specialAdCategories),
    ...(c.budget
      ? { ...budgetFields(c.budget), bid_strategy: "LOWEST_COST_WITHOUT_CAP", ...(c.budget.type === "lifetime" && c.end ? { stop_time: metaTime(c.end, tz, true) } : {}), ...(c.start && c.budget.type === "lifetime" ? { start_time: metaTime(c.start, tz) } : {}) }
      : { is_adset_budget_sharing_enabled: "false" }),
  };
}

/** POST <campaign_id>/budget_schedules: a raised budget for a window (Meta's budget scheduling) */
export function scheduleParams(s: { start: string; end: string; amount: number }, tz: number): Record<string, string> {
  const unix = (iso: string) => String(Math.round(Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) / 1000));
  return { budget_value: toMinor(s.amount), budget_value_type: "ABSOLUTE", time_start: unix(metaTime(s.start, tz)), time_end: unix(metaTime(s.end, tz, true)) };
}

export function targetingSpec(t: Targeting, placements: PlanAdset["placements"]) {
  const geo: Record<string, unknown> = {};
  if (t.countries.length) geo.countries = t.countries;
  if (t.cities.length) geo.cities = t.cities.map((c) => ({ key: c.key, radius: c.radius, distance_unit: c.unit }));
  if (t.regions.length) geo.regions = t.regions.map((r) => ({ key: r.key }));
  if (t.zips.length) geo.zips = t.zips.map((z) => ({ key: z.includes(":") ? z : `US:${z}` }));
  geo.location_types = ["home", "recent"];
  return {
    geo_locations: geo,
    age_min: t.ageMin,
    age_max: t.ageMax,
    targeting_automation: { advantage_audience: t.advantageAudience ? 1 : 0 },
    ...(placements === "feeds_stories_reels"
      ? { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story", "facebook_reels"], instagram_positions: ["stream", "story", "reels", "explore"] }
      : {}),
  };
}

/** POST act_<id>/adsets. cbo: the campaign holds the budget (the ad set has none of its own) */
export function adsetParams(s: PlanAdset, campaignId: string, cbo: boolean, goLive: "paused" | "scheduled", tz: number): Record<string, string> {
  const lifetime = (cbo ? null : s.budget)?.type === "lifetime";
  return {
    name: s.name.slice(0, 400),
    campaign_id: campaignId,
    status: status(goLive),
    billing_event: "IMPRESSIONS",
    optimization_goal: s.optimizationGoal,
    destination_type: "WEBSITE",
    ...(s.pixelId ? { promoted_object: json({ pixel_id: s.pixelId, ...(s.event ? { custom_event_type: s.event } : {}) }) } : {}),
    ...(cbo ? {} : { ...budgetFields(s.budget), bid_strategy: "LOWEST_COST_WITHOUT_CAP" }),
    ...(s.start ? { start_time: metaTime(s.start, tz) } : {}),
    ...(s.end || lifetime ? { end_time: metaTime(s.end ?? s.start ?? "", tz, true) } : {}),
    targeting: json(targetingSpec(s.targeting, s.placements)),
    attribution_spec: json(ATTRIBUTION_SPEC),
  };
}

/** The ad's media once it's in the ad account's library */
export type Uploaded = { hash?: string | null; videoId?: string | null; thumb?: string | null; url?: string | null };

const optOut = (features: string[]) => (features.length ? { degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(features.map((f) => [f, { enroll_status: "OPT_OUT" }])) } } : {});

/**
 * POST act_<id>/adcreatives: one ad's creative.
 * - new files with both sizes: placement customization (4:5 feeds, 9:16 Stories/Reels) with every text option stacked
 * - new files with one size: a single image or video ad with the other texts as Meta's text options
 * - an existing post: the Instagram post (source_instagram_media_id) or the Facebook post (object_story_id) as it is
 * validate: images by URL instead of the library hash (for a dry run before anything is uploaded)
 */
export function creativeSpec(ad: PlanAd, media: { feed: Uploaded | null; vertical: Uploaded | null }, opts: { optOut?: string[]; multiOff?: boolean } = {}): Record<string, unknown> {
  const features = opts.optOut ?? ENHANCEMENTS_OFF;
  const tail = {
    ...optOut(features),
    ...(ad.urlTags ? { url_tags: ad.urlTags } : {}),
    ...(opts.multiOff === false ? {} : { contextual_multi_ads: { enroll_status: "OPT_OUT" } }),
  };
  const identity = {
    page_id: ad.identity.pageId,
    ...(ad.identity.igId ? { instagram_user_id: ad.identity.igId } : {}),
  };
  const partnership =
    ad.identity.mode === "partnership"
      ? {
          ...(ad.identity.partnerPageId ? { facebook_branded_content: { sponsor_page_id: ad.identity.partnerPageId } } : {}),
          ...(ad.identity.partnerIgId ? { instagram_branded_content: { sponsor_id: ad.identity.partnerIgId } } : {}),
        }
      : {};
  const cta = { type: ad.cta, value: { link: ad.link } };

  if (ad.source.kind === "existing_post") {
    if (ad.source.platform === "instagram")
      return {
        name: ad.name.slice(0, 100),
        object_id: ad.identity.pageId,
        ...(ad.identity.igId ? { instagram_user_id: ad.identity.igId } : {}),
        source_instagram_media_id: ad.source.mediaId,
        call_to_action: cta,
        ...partnership,
        ...tail,
      };
    return { name: ad.name.slice(0, 100), object_story_id: ad.source.storyId, call_to_action: cta, ...partnership, ...tail };
  }

  const feed = ad.source.feed;
  const vertical = ad.source.vertical;
  const f = media.feed;
  const v = media.vertical;
  const main = feed ?? vertical;
  const m = f ?? v;
  if (!main || !m) throw new Error(`${ad.name}: no media`);
  const video = main.kind === "video";
  const asset = (u: Uploaded, label?: string): Record<string, unknown> => ({
    ...(video ? { video_id: u.videoId, ...(u.thumb ? { thumbnail_url: u.thumb } : {}) } : u.hash ? { hash: u.hash } : { url: u.url }),
    ...(label ? { adlabels: [{ name: label }] } : {}),
  });
  const text = {
    bodies: ad.copy.bodies.map((t) => ({ text: t })),
    titles: ad.copy.titles.map((t) => ({ text: t })),
    ...(ad.copy.descriptions.length ? { descriptions: ad.copy.descriptions.map((t) => ({ text: t })) } : {}),
    link_urls: [{ website_url: ad.link }],
    call_to_action_types: [ad.cta],
    ad_formats: [video ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
  };
  // Both sizes: one ad, the right size in each placement, every text option
  if (feed && vertical && f && v && feed.kind === vertical.kind) {
    const key = video ? "videos" : "images";
    const labelKey = video ? "video_label" : "image_label";
    return {
      name: ad.name.slice(0, 100),
      object_story_spec: identity,
      asset_feed_spec: {
        ...text,
        [key]: [asset(f, "kz_feed"), asset(v, "kz_vertical")],
        asset_customization_rules: [
          { customization_spec: FEED_PLACEMENTS, [labelKey]: { name: "kz_feed" }, priority: 1 },
          { customization_spec: VERTICAL_PLACEMENTS, [labelKey]: { name: "kz_vertical" }, priority: 2 },
        ],
        optimization_type: "PLACEMENT",
      },
      ...partnership,
      ...tail,
    };
  }
  // One size: a single ad with its first texts, the rest stacked as text options
  const story = video
    ? { video_data: { video_id: m.videoId, ...(m.thumb ? { image_url: m.thumb } : {}), message: ad.copy.bodies[0] ?? "", title: ad.copy.titles[0] ?? "", ...(ad.copy.descriptions[0] ? { link_description: ad.copy.descriptions[0] } : {}), call_to_action: cta } }
    : { link_data: { ...(m.hash ? { image_hash: m.hash } : { picture: m.url }), link: ad.link, message: ad.copy.bodies[0] ?? "", name: ad.copy.titles[0] ?? "", ...(ad.copy.descriptions[0] ? { description: ad.copy.descriptions[0] } : {}), call_to_action: cta } };
  const stacked = ad.copy.bodies.length > 1 || ad.copy.titles.length > 1 || ad.copy.descriptions.length > 1;
  return {
    name: ad.name.slice(0, 100),
    object_story_spec: { ...identity, ...story },
    ...(stacked
      ? { asset_feed_spec: { bodies: text.bodies, titles: text.titles, ...(text.descriptions ? { descriptions: text.descriptions } : {}), optimization_type: "DEGREES_OF_FREEDOM" } }
      : {}),
    ...partnership,
    ...tail,
  };
}

/** A creative spec as Meta's form fields (objects as JSON) */
export const formFields = (spec: Record<string, unknown>) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

/** POST act_<id>/ads */
export function adParams(ad: PlanAd, adsetId: string, creativeId: string, goLive: "paused" | "scheduled", pixelId: string | null): Record<string, string> {
  return {
    name: ad.name.slice(0, 400),
    adset_id: adsetId,
    creative: json({ creative_id: creativeId }),
    status: status(goLive),
    ...(pixelId ? { tracking_specs: json([{ "action.type": ["offsite_conversion"], fb_pixel: [pixelId] }]) } : {}),
  };
}

/** Meta's limits on text options and lengths, as warnings (Meta truncates or refuses past them) */
export function copyWarnings(ad: PlanAd): string[] {
  const out: string[] = [];
  if (ad.copy.bodies.length > 5) out.push(`${ad.copy.bodies.length} primary texts: Meta takes 5 options at most.`);
  if (ad.copy.titles.length > 5) out.push(`${ad.copy.titles.length} headlines: Meta takes 5 options at most.`);
  for (const b of ad.copy.bodies) if (b.length > 2200) out.push(`A primary text is ${b.length} characters (Meta's cap is 2,200).`);
  for (const t of ad.copy.titles) if (t.length > 255) out.push(`A headline is ${t.length} characters (Meta's cap is 255).`);
  for (const t of ad.copy.titles) if (t.length > 40 && t.length <= 255) out.push(`"${t.slice(0, 40)}…" is ${t.length} characters: headlines over about 40 get cut off in feeds.`);
  return [...new Set(out)];
}
