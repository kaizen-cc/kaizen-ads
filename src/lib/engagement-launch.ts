import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { metaConfigured, metaGraph } from "@/lib/context/meta";
import { ENHANCEMENTS, trackingSpecs } from "@/lib/launcher";
import { metaWrite } from "@/lib/meta-write";

// A new client's first ads, live within 48 hours (when they chose it reviewing their presentation): their own Facebook
// and Instagram posts, run as ads with the post's own copy, so nothing has to be made first. The last 30 posts on each
// are read, the ones that can't or shouldn't run are dropped (shares, text-only, expired promotions and events, hiring
// and closed-today notices, anything against the Brand Bible's rules), the rest ranked by how they did against the
// account's own typical post, format (video and reels first) and fit with the Bible, newest as the tiebreak. The client
// confirms the picks in their portal; the campaign is built paused with the launch checklist checked; the buyer turns
// it on and the client hears it's live. If there's nothing worth running, it says so and the first round comes first.

export type Post = {
  id: string; // Facebook: the post id (page_post); Instagram: the media id
  platform: "facebook" | "instagram";
  caption: string;
  image: string | null;
  permalink: string | null;
  at: string;
  format: "video" | "image" | "carousel" | "text";
  engagement: number;
  score: number; // engagement against the account's typical post (1 = typical)
  why?: string;
};
export type Check = { item: string; status: "ok" | "warn" | "manual"; note: string };
export type EngagementPlan = { dailyBudget: number; ageMin: number; geo: { label: string; spec: Record<string, unknown> }; pageName: string | null; igName: string | null; campaignName: string };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] || 1 : 1;
};
const fmtWeight = { video: 1.3, carousel: 1.1, image: 1, text: 0 };

/** The client's Page and Instagram account, from what their ad account can promote */
async function pageOf(account: string, clientName: string) {
  type P<T> = { data: T[] };
  const pages = await metaGraph<P<{ id: string; name: string }>>(`act_${account}/promote_pages`, { fields: "name", limit: "50" }).catch(() => ({ data: [] }));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const page = pages.data.find((p) => norm(p.name).includes(norm(clientName)) || norm(clientName).includes(norm(p.name))) ?? (pages.data.length === 1 ? pages.data[0] : null);
  if (!page) return { page: null, ig: null };
  const ig = await metaGraph<{ instagram_business_account?: { id: string; username?: string } }>(page.id, { fields: "instagram_business_account{id,username}" }).catch(() => null);
  return { page, ig: ig?.instagram_business_account ? { id: ig.instagram_business_account.id, name: ig.instagram_business_account.username ?? null } : null };
}

async function readPosts(pageId: string, igId: string | null): Promise<Post[]> {
  type FB = { id: string; message?: string; created_time: string; full_picture?: string; permalink_url?: string; status_type?: string; is_eligible_for_promotion?: boolean; attachments?: { data?: { media_type?: string }[] }; shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } };
  type IG = { id: string; caption?: string; media_type?: string; media_product_type?: string; like_count?: number; comments_count?: number; timestamp: string; permalink?: string; thumbnail_url?: string; media_url?: string };
  const [fb, ig] = await Promise.all([
    metaGraph<{ data: FB[] }>(`${pageId}/published_posts`, { fields: "message,created_time,full_picture,permalink_url,status_type,is_eligible_for_promotion,attachments{media_type},shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", limit: "30" }).catch(() => ({ data: [] as FB[] })),
    igId ? metaGraph<{ data: IG[] }>(`${igId}/media`, { fields: "caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink,thumbnail_url,media_url", limit: "30" }).catch(() => ({ data: [] as IG[] })) : Promise.resolve({ data: [] as IG[] }),
  ]);
  const face: Post[] = fb.data
    // Meta has to allow it as an ad, and a share of someone else's post isn't theirs
    .filter((p) => p.is_eligible_for_promotion !== false && p.status_type !== "shared_story")
    .map((p) => {
      const kind = p.attachments?.data?.[0]?.media_type ?? "";
      const format: Post["format"] = /video/i.test(kind) ? "video" : /album/i.test(kind) ? "carousel" : p.full_picture ? "image" : "text";
      return { id: p.id, platform: "facebook" as const, caption: (p.message ?? "").slice(0, 1200), image: p.full_picture ?? null, permalink: p.permalink_url ?? null, at: p.created_time, format, engagement: (p.reactions?.summary?.total_count ?? 0) + (p.comments?.summary?.total_count ?? 0) * 2 + (p.shares?.count ?? 0) * 3, score: 0 };
    });
  const insta: Post[] = ig.data.map((p) => {
    const format: Post["format"] = p.media_type === "VIDEO" || p.media_product_type === "REELS" ? "video" : p.media_type === "CAROUSEL_ALBUM" ? "carousel" : "image";
    return { id: p.id, platform: "instagram" as const, caption: (p.caption ?? "").slice(0, 1200), image: p.thumbnail_url ?? p.media_url ?? null, permalink: p.permalink ?? null, at: p.timestamp, format, engagement: (p.like_count ?? 0) + (p.comments_count ?? 0) * 2, score: 0 };
  });
  // Each against its own account's typical post, so a small page isn't punished
  for (const list of [face, insta]) {
    const typical = median(list.map((p) => p.engagement));
    for (const p of list) p.score = Math.round((p.engagement / typical) * fmtWeight[p.format] * 100) / 100;
  }
  return [...face, ...insta].filter((p) => p.format !== "text" && p.image);
}

const s = { type: "string" };
const PICK_SCHEMA = {
  type: "object",
  properties: {
    picks: { type: "array", items: { type: "object", properties: { id: s, why: s }, required: ["id", "why"], additionalProperties: false } },
    none: s,
    geo: { type: "array", items: { type: "object", properties: { query: s, type: { type: "string", enum: ["city", "region", "zip", "country"] }, radiusMiles: { type: "number" } }, required: ["query", "type", "radiusMiles"], additionalProperties: false } },
    geoLabel: s,
    ageMin: { type: "number" },
  },
  required: ["picks", "none", "geo", "geoLabel", "ageMin"],
  additionalProperties: false,
};

/** Read their posts and pick the ones to run (after the client approves their presentation and chose 48 hours) */
export async function proposeEngagement(admin: SupabaseClient, clientId: string) {
  const save = (patch: Record<string, unknown>) => admin.from("engagement_launches").upsert({ client_id: clientId, ...patch, updated_at: new Date().toISOString() });
  await save({ status: "finding", error: null, note: null });
  try {
    const [{ data: c }, { data: t }, { data: b }, { data: intake }] = await Promise.all([
      admin.from("clients").select("name, industry, industry_detail, website").eq("id", clientId).single(),
      admin.from("kpi_targets").select("ad_account_id, monthly_budget").eq("client_id", clientId).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null).limit(1).maybeSingle(),
      admin.from("client_brand_bibles").select("read_this_first").eq("client_id", clientId).maybeSingle(),
      admin.from("client_intakes").select("summary").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (!c) throw new Error("Client not found");
    if (!metaConfigured()) throw new Error("Meta isn't connected");
    // Their KPI's ad account, else the one their setup guide found shared with us
    const { data: own } = await admin.from("clients").select("meta_ad_account_id").eq("id", clientId).single();
    const raw = t?.ad_account_id ?? own?.meta_ad_account_id ?? null;
    const account = raw ? String(raw).replace(/^act_/, "") : null;
    if (!account) return save({ status: "none", note: "No Meta ad account on their KPI yet: add it, then find their posts again." });
    const { page, ig } = await pageOf(account, c.name as string);
    if (!page) return save({ status: "none", account, note: "Their ad account can't promote a Facebook Page yet (give the business access to their Page), so there are no posts to run." });
    const posts = await readPosts(page.id, ig?.id ?? null);
    if (!posts.length) return save({ status: "none", account, page_id: page.id, ig_id: ig?.id ?? null, note: "No posts we can run as ads (none with a picture or video, or none Meta allows). The first round of creative comes first." });
    const ranked = posts.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at)).slice(0, 40);
    const today = new Date().toISOString().slice(0, 10);
    const out = await askJson<{ picks: { id: string; why: string }[]; none: string; geo: { query: string; type: "city" | "region" | "zip" | "country"; radiusMiles: number }[]; geoLabel: string; ageMin: number }>({
      agent: "launcher",
      label: `engagement launch posts ${c.name}`,
      override: { model: "sonnet", effort: "low" },
      system: `You pick a new client's own social posts to run as their first engagement ads, so they're live within 48 hours. Never boost something random or wrong.
Drop: anything out of date (a promotion, price, event or holiday that's over by ${today}), hiring, "closed today", memes or reposts that aren't about the business, low-quality or off-brand posts, and anything against the Brand Bible's rules. Keep: posts that show what they sell or do, their proof (results, reviews, before and after), their people and place, with a clear reason a stranger would stop.
Rank by the score given (how the post did against their typical post; video already weighted up), then fit with the Bible's audiences and angles; newer wins a tie. Pick 3 to 5. If none is good enough, pick none and say why in none (else none is "").
Targeting: from where they serve (the intake and the Bible), give the places to target (a city with a radius in miles, regions, zip codes, or the country for a brand that ships everywhere; radiusMiles 0 when not a city) and a short label ("Houston + 25 mi"). ageMin: 21 for a restaurant, bar or anything selling alcohol, else 18 unless the Bible says otherwise.`,
      schema: PICK_SCHEMA,
      maxTokens: 4000,
      prompt: [
        `<client>${c.name} · ${c.industry_detail ?? c.industry ?? ""} · ${c.website ?? ""}</client>`,
        b?.read_this_first ? `<brand_bible_read_this_first>\n${String(b.read_this_first).slice(0, 6000)}\n</brand_bible_read_this_first>` : "",
        intake?.summary ? `<intake>\n${JSON.stringify(intake.summary).slice(0, 3000)}\n</intake>` : "",
        `<posts>\n${ranked.map((p) => `<post id="${p.id}" platform="${p.platform}" format="${p.format}" date="${p.at.slice(0, 10)}" score="${p.score}">\n${p.caption || "(no caption)"}\n</post>`).join("\n")}\n</posts>`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const why = new Map(out.picks.map((p) => [p.id, p.why]));
    const picks = ranked.filter((p) => why.has(p.id)).map((p) => ({ ...p, why: why.get(p.id) }));
    const geo = await geoSpec(out.geo);
    const budget = Number(t?.monthly_budget) > 0 ? Math.min(50, Math.max(10, Math.round((Number(t!.monthly_budget) * 0.15) / 30))) : 15;
    const plan: EngagementPlan = { dailyBudget: budget, ageMin: Math.max(18, Math.min(65, Math.round(out.ageMin || 18))), geo: { label: out.geoLabel || geo.label, spec: geo.spec }, pageName: page.name, igName: ig?.name ?? null, campaignName: `Kaizen | Engagement | Launch | ${new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" })}` };
    if (!picks.length) {
      await save({ status: "none", account, page_id: page.id, ig_id: ig?.id ?? null, posts: ranked.slice(0, 12), plan, note: out.none || "None of their recent posts is strong enough to put money behind; the first round of creative comes first." });
      return tell(admin, clientId, "none of their posts is right for the 48-hour launch", out.none || "The first round of creative comes first.", `engagement-none:${clientId}`, "normal");
    }
    await save({ status: "proposed", account, page_id: page.id, ig_id: ig?.id ?? null, posts: picks, chosen: picks.map((p) => p.id), plan });
    return tell(admin, clientId, `${picks.length} of their posts are picked for the 48-hour launch`, "The client is confirming them in their portal. If they haven't by tomorrow (or told you on a call), confirm for them.", `engagement-proposed:${clientId}`, "normal");
  } catch (e) {
    return save({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
}

/** The places as Meta targeting, from Meta's own location search */
async function geoSpec(places: { query: string; type: "city" | "region" | "zip" | "country"; radiusMiles: number }[]) {
  const spec: { cities?: unknown[]; regions?: unknown[]; zips?: unknown[]; countries?: string[] } = {};
  const found: string[] = [];
  for (const p of places.slice(0, 10)) {
    const type = p.type === "zip" ? "zip" : p.type;
    const hit = await metaGraph<{ data: { key: string; name: string; country_code?: string }[] }>("search", { type: "adgeolocation", q: p.query, location_types: JSON.stringify([type]), limit: "1" }).catch(() => ({ data: [] }));
    const h = hit.data[0];
    if (!h) continue;
    if (type === "country") spec.countries = [...(spec.countries ?? []), h.key];
    else if (type === "city") spec.cities = [...(spec.cities ?? []), { key: h.key, ...(p.radiusMiles > 0 ? { radius: Math.min(50, Math.max(10, Math.round(p.radiusMiles))), distance_unit: "mile" } : {}) }];
    else if (type === "region") spec.regions = [...(spec.regions ?? []), { key: h.key }];
    else spec.zips = [...(spec.zips ?? []), { key: h.key }];
    found.push(h.name);
  }
  if (!found.length) return { label: "United States", spec: { countries: ["US"] } };
  return { label: found.join(", "), spec };
}

/** The client confirmed (or the buyer did for them): build it, paused, and check it */
export async function buildEngagement(admin: SupabaseClient, clientId: string) {
  const { data: l } = await admin.from("engagement_launches").select("*").eq("client_id", clientId).single();
  if (!l || !["confirmed", "failed"].includes(l.status as string) || !l.plan) return;
  await admin.from("engagement_launches").update({ status: "building", error: null, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  const plan = l.plan as EngagementPlan;
  const account = l.account as string;
  const act = `act_${account}`;
  const posts = ((l.posts ?? []) as Post[]).filter((p) => (l.chosen as string[]).includes(p.id));
  try {
    if (!posts.length) throw new Error("No posts chosen.");
    const pixels = await metaGraph<{ data: { id: string; name: string; last_fired_time?: string; is_unavailable?: boolean }[] }>(`${act}/adspixels`, { fields: "name,last_fired_time,is_unavailable", limit: "20" }).catch(() => ({ data: [] }));
    const pixel = pixels.data.filter((p) => !p.is_unavailable).sort((a, b) => (b.last_fired_time ?? "").localeCompare(a.last_fired_time ?? ""))[0] ?? null;
    const camp = await metaWrite<{ id: string }>(admin, account, `${act}/campaigns`, { name: plan.campaignName, objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" }, false);
    const adset = await metaWrite<{ id: string }>(
      admin,
      account,
      `${act}/adsets`,
      {
        name: `Engagement | ${plan.geo.label} | ${plan.ageMin}+ | Their posts`,
        campaign_id: camp.id,
        status: "PAUSED",
        daily_budget: String(Math.round(plan.dailyBudget * 100)),
        billing_event: "IMPRESSIONS",
        optimization_goal: "POST_ENGAGEMENT",
        destination_type: "ON_POST",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        // Advantage+ audience off: the targeting is ours
        targeting: JSON.stringify({ geo_locations: plan.geo.spec, age_min: plan.ageMin, age_max: 65, publisher_platforms: ["facebook", "instagram"], targeting_automation: { advantage_audience: 0 } }),
      },
      false,
    );
    const optOut = { degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: Object.fromEntries(ENHANCEMENTS.map((f) => [f, { enroll_status: "OPT_OUT" }])) }) };
    const ads: string[] = [];
    const skipped: string[] = [];
    for (const p of posts) {
      const spec: Record<string, string> = p.platform === "facebook" ? { object_story_id: p.id } : { object_id: l.page_id as string, instagram_user_id: l.ig_id as string, source_instagram_media_id: p.id };
      const name = `${p.platform === "facebook" ? "FB" : "IG"} post | ${p.format} | ${p.at.slice(0, 10)}`;
      try {
        let creative: { id: string };
        try {
          creative = await metaWrite<{ id: string }>(admin, account, `${act}/adcreatives`, { name, ...spec, ...optOut }, false);
        } catch {
          // Some accounts don't take every opt-out: the creative without them, AI upgrades flagged on the checklist
          creative = await metaWrite<{ id: string }>(admin, account, `${act}/adcreatives`, { name, ...spec }, false);
        }
        const ad = await metaWrite<{ id: string }>(admin, account, `${act}/ads`, { name, adset_id: adset.id, creative: JSON.stringify({ creative_id: creative.id }), status: "PAUSED", ...(pixel ? { tracking_specs: trackingSpecs(pixel.id) } : {}) }, false);
        ads.push(ad.id);
      } catch (e) {
        skipped.push(`${name}: ${e instanceof Error ? e.message.slice(0, 120) : "Meta refused it"}`);
      }
    }
    if (!ads.length) throw new Error(`Meta didn't take any of the posts. ${skipped[0] ?? ""}`);
    const checklist = await checkLaunch(admin, clientId, { account, pixel, plan, pageName: plan.pageName, ads: ads.length, skipped });
    await admin.from("engagement_launches").update({ status: "built", campaign_id: camp.id, adset_id: adset.id, ad_ids: ads, checklist, built_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("client_id", clientId);
    await tell(admin, clientId, "their engagement campaign is built, paused, for you to turn on", `${ads.length} of their own posts, ${plan.geo.label}, ${plan.ageMin}+, $${plan.dailyBudget}/day. The launch checklist is checked: ${checklist.filter((c) => c.status !== "ok").length} to look at.`, `engagement-built:${clientId}`, "critical");
  } catch (e) {
    await admin.from("engagement_launches").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300), updated_at: new Date().toISOString() }).eq("client_id", clientId);
    await tell(admin, clientId, "their engagement campaign couldn't be built", e instanceof Error ? e.message.slice(0, 300) : "Meta refused it", `engagement-failed:${clientId}:${new Date().toISOString().slice(0, 13)}`, "critical");
  }
}

/** The campaign launch checklist, checked: what can be read from Meta and the client page, and what a person confirms */
async function checkLaunch(admin: SupabaseClient, clientId: string, x: { account: string; pixel: { id: string; name: string; last_fired_time?: string } | null; plan: EngagementPlan; pageName: string | null; ads: number; skipped: string[] }): Promise<Check[]> {
  const [{ data: c }, { data: t }, { data: intake }] = await Promise.all([
    admin.from("clients").select("name, industry, website").eq("id", clientId).single(),
    admin.from("kpi_targets").select("monthly_budget").eq("client_id", clientId).eq("platform", "meta").eq("active", true).limit(1).maybeSingle(),
    admin.from("client_intakes").select("summary").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const fired = x.pixel?.last_fired_time ? Math.round((Date.now() - Date.parse(x.pixel.last_fired_time)) / 86_400_000) : null;
  const where = (intake?.summary as { locations?: string } | null)?.locations ?? "";
  const restaurant = /restaurant|bar|food|pizza|brew|winery|alcohol/i.test(`${c?.industry ?? ""}`);
  return [
    { item: "Tracking set up in Events Manager", status: x.pixel && fired != null && fired <= 7 ? "ok" : "warn", note: x.pixel ? `${x.pixel.name}${fired != null ? `, last fired ${fired === 0 ? "today" : `${fired} days ago`}` : ", never fired"}` : "No pixel on the account: set it up before the conversion campaigns" },
    { item: "Monthly budget confirmed and on the overview sheet", status: Number(t?.monthly_budget) > 0 ? "ok" : "warn", note: Number(t?.monthly_budget) > 0 ? `$${Number(t!.monthly_budget).toLocaleString("en-US")} a month; this campaign $${x.plan.dailyBudget}/day` : "No monthly budget on their KPI" },
    { item: "Right campaign strategy", status: "ok", note: "Engagement, from their own posts (the client chose the 48-hour launch)" },
    { item: "Pixel matches between Ads Manager and the website", status: x.pixel ? "manual" : "warn", note: x.pixel ? `Check ${x.pixel.name} is the one on ${c?.website ?? "their site"}` : "No pixel" },
    { item: "Geo-targeting", status: where ? "manual" : "warn", note: `${x.plan.geo.label}${where ? ` (the intake says: ${where.slice(0, 120)})` : " (no locations in the intake: confirm with the client)"}` },
    { item: "Age targeting", status: restaurant && x.plan.ageMin < 21 ? "warn" : "ok", note: `${x.plan.ageMin}+${restaurant ? " (restaurant: 21+)" : ""}` },
    { item: "The right Page publishes it", status: x.pageName ? "ok" : "warn", note: x.pageName ?? "Page not found" },
    { item: "Primary text", status: "ok", note: "Each ad runs its post's own caption and link" },
    { item: "Headlines", status: "ok", note: "Post ads carry no separate headline" },
    { item: "Landing page", status: "ok", note: "Engagement ads stay on the post (no landing page)" },
    { item: "AI upgrades off", status: "ok", note: "Advantage+ audience off; creative enhancements opted out where Meta allows" },
    { item: "Right pixel in each ad", status: x.pixel ? "ok" : "warn", note: x.pixel ? `${x.pixel.name} on every ad` : "No pixel to attach" },
    ...(x.skipped.length ? [{ item: "Posts Meta didn't take", status: "warn" as const, note: x.skipped.join("; ").slice(0, 400) }] : []),
  ];
}

/** The buyer turns it on: campaign, ad set and ads active, and the client hears their first campaign is live */
export async function turnOnEngagement(admin: SupabaseClient, clientId: string, by: string) {
  const { data: l } = await admin.from("engagement_launches").select("*").eq("client_id", clientId).single();
  if (!l || l.status !== "built") return { ok: false as const, error: "It isn't built yet." };
  const account = l.account as string;
  for (const id of [...(l.ad_ids as string[]), l.adset_id as string, l.campaign_id as string]) await metaWrite(admin, account, id, { status: "ACTIVE" }, false);
  await admin.from("engagement_launches").update({ status: "live", live_at: new Date().toISOString(), live_by: by, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  await tellClientLive(admin, clientId).catch(() => null);
  return { ok: true as const };
}

async function tell(admin: SupabaseClient, clientId: string, what: string, body: string, key: string, priority: "critical" | "normal") {
  const [{ data: c }, { data: buyers }] = await Promise.all([admin.from("clients").select("name, slug").eq("id", clientId).single(), admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer")]);
  const { data: leads } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true);
  const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((x) => x.id as string)])];
  if (!ids.length || !c) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({ profile_id: id, kind: "onboarding", title: `${c.name}: ${what}`.slice(0, 200), body: body.slice(0, 1000), href: `/clients/${c.slug}/launch`, client_id: clientId, key, priority })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** "Your first campaign is live": email to their contacts and a post in their Slack channel */
async function tellClientLive(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: links }, { data: l }] = await Promise.all([
    admin.from("clients").select("name, slug, slack_channel_id").eq("id", clientId).single(),
    admin.from("contact_clients").select("contacts(email, full_name, is_active)").eq("client_id", clientId),
    admin.from("engagement_launches").select("ad_ids, plan").eq("client_id", clientId).single(),
  ]);
  if (!c || !l) return;
  const n = (l.ad_ids as string[]).length;
  const plan = l.plan as EngagementPlan;
  const lines = [`Your first campaign is live: ${n} of your best posts are now running as ads on Facebook and Instagram, reaching people in ${plan.geo.label}.`, "This builds an audience and traffic for you right away, and it's the warm-up for the conversion campaigns we launch as your new creative lands. We'll keep you posted on how it's going."];
  const { sendEmail } = await import("@/lib/email");
  const { emailHtml, emailText } = await import("@/lib/email-layout");
  for (const x of (links ?? []).map((k) => k.contacts as unknown as { email: string; full_name: string | null; is_active: boolean } | null)) {
    if (!x?.is_active || !x.email) continue;
    const parts = {
      preheader: `${n} of your best posts are running as ads now.`,
      kicker: c.name as string,
      title: "You're live 🎉",
      hello: x.full_name ? `Hi ${x.full_name.split(" ")[0]},` : "Hi there,",
      lines: ["Your first campaign is running:"],
      bullets: [`${n} of your best posts, now ads on Facebook and Instagram`, `Reaching people in ${plan.geo.label}`, "Building your audience and site traffic from today", "The warm-up for the conversion campaigns that follow as your new creative lands"],
      cta: { label: "See it on your dashboard →", url: `${(await import("@/lib/site")).siteUrl()}/c/${c.slug}/dashboard` },
      note: "We'll keep you posted on how it's going.",
    };
    await sendEmail({ to: x.email, subject: `${c.name}: your first campaign is live`, text: emailText(parts), html: emailHtml(parts) }).catch(() => null);
  }
  if (process.env.SLACK_BOT_TOKEN && c.slack_channel_id)
    await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel: c.slack_channel_id, text: `🎉 ${lines.join(" ")}`, unfurl_links: false }) }).catch(() => null);
}

/** Every 10 minutes: a launch whose background run died is picked up (confirmed but never built, stuck finding), or
 * marked failed when it stopped part way through building */
export async function keepLaunches(admin: SupabaseClient) {
  const old = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const { data } = await admin.from("engagement_launches").select("client_id, status, updated_at").or(`and(status.eq.confirmed,updated_at.lt.${old(5)}),and(status.eq.building,updated_at.lt.${old(20)}),and(status.eq.finding,updated_at.lt.${old(20)})`).limit(3);
  for (const l of data ?? []) {
    if (l.status === "finding") await proposeEngagement(admin, l.client_id as string);
    else if (l.status === "confirmed") await buildEngagement(admin, l.client_id as string);
    // Stopped part way through building: never built twice on its own (a paused campaign may be half made)
    else await admin.from("engagement_launches").update({ status: "failed", error: "The build stopped part way. Check Ads Manager for a half-made paused campaign (delete it), then confirm the posts again." }).eq("client_id", l.client_id);
  }
  return (data ?? []).length;
}
