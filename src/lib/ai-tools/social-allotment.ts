import "server-only";
import { clientNamed } from "@/lib/client-named";
import { isExecOrLead, type Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { servicesOf } from "@/lib/services";
import {
  addedPlatforms,
  cleanSocialCustom,
  isSocialPlatform,
  isSocialTier,
  SOCIAL_PLATFORM_OPTIONS,
  SOCIAL_TIERS,
  socialAllotmentLine,
  socialAllotmentPace,
  socialPace,
  socialPools,
  tierText,
  type SocialCustom,
} from "@/lib/social-allotment-core";
import { assertMaySee } from "@/lib/ai-access";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { accessFor } from "./access";
import { str, type AiTool } from "./types";

// The social allotment and tier, for the assistant, Kaizen AI and every agent on a call (registered in
// src/lib/kaizen-ai/extensions.ts). The same rules as the Services panel on Team & setup (src/lib/social-allotment-core.ts):
//   social_allotment   a client's posts, statics, video/reels and IG stories this billing cycle (published on the
//                      platforms they post on, plus what's requested) against their tier, with the pace; or every
//                      social client grouped behind pace, on pace, over, or with no tier
//   set_social_tier    put a client on Basic, Silver, Gold, Platinum, Custom numbers, a Sprint or Strategy only, and
//                      pick the platforms they post on (execs and leads; asks first, then confirmed: true)
//   boosted_posts      which organic posts the ads team is boosting and the spend behind each (src/lib/social-boosts.ts)
// The screen: open_screen the client page, Team & setup, Services.

const platformName = (k: string) => SOCIAL_PLATFORM_OPTIONS.find((p) => p.key === k)?.label ?? k;

const socialAllotment: AiTool = {
  name: "social_allotment",
  description:
    "A client's organic social allotment this billing cycle: four pools (posts, static graphics, video/reels, IG stories) each against their tier (Basic $600: 12 posts, 12 statics; Silver $1,000: 16 posts, 10 statics, 2 video/reels, 4 IG stories; Gold $1,500: 22 posts, 10 statics, 4 video/reels, 8 stories, adds TikTok; Platinum $2,250 + ad spend: 30 posts, 12 statics, 6 video/reels, 12 stories, adds LinkedIn), their Custom numbers or a Sprint; strategy-only clients hold none. Used is what was published on the platforms they post on (the most on any one platform) plus posts requested and not yet out. Also the platforms they post on (only those are read and scored) and the pace against the cycle. Without a client: every social client grouped behind pace, on pace, over, or with no tier set.",
  input_schema: { type: "object", properties: { client: { type: "string", description: "A client name; leave out for every social client" } }, additionalProperties: false },
  lines: ["social"],
  run: async (user: Staff, input) => {
    const db = await createClient();
    const { socialAllotments } = await import("@/lib/social-allotment");
    if (str(input.client)) {
      const c = await clientNamed(db, input.client);
      const a = (await socialAllotments(db, [c.id]))[c.id] ?? null;
      if (!a) return { ok: true, client: c.name, allotment: null, say: "No social allotment read for this client." };
      if (a.source === "strategy") return { ok: true, client: c.name, allotment: { line: "Strategy only: no posts made, so no allotment and no requests", from: "strategy" } };
      const pace = socialAllotmentPace(a);
      return {
        ok: true,
        client: c.name,
        allotment: {
          tier: a.label,
          from: a.source,
          line: socialAllotmentLine(a) ?? "No tier set",
          pools: socialPools(a).map((p) => ({ pool: p.label, range: p.range, used: p.used, inProgress: p.progress, published: p.done, over: p.over })),
          sprint: a.sprint,
          addedVideoReels: a.extraVideos,
          platforms: a.platforms.map(platformName),
          platformsBeyondTier: addedPlatforms(a.platforms, a.packageKey),
          cycle: a.cycle,
          pace: socialPace(a).group,
          paceDetail: pace ? `${Math.round(pace.used * 100)}% used with ${Math.round(pace.elapsed * 100)}% of the cycle gone` : "Too early in the cycle to call, or no tier",
        },
        clientPage: `/clients/${c.slug}?tab=team`,
      };
    }
    const all = await socialAllotments(db);
    const { data: rows } = await db.from("clients").select("id, name, services, services_extra, services_removed, strategy_only").in("id", Object.keys(all));
    const groups: Record<string, { client: string; line: string }[]> = { over: [], behind: [], pace: [], none: [] };
    for (const r of rows ?? []) {
      if (!(servicesOf(r) as string[]).includes("social-media")) continue;
      const a = all[r.id as string];
      if (!a || a.source === "strategy") continue;
      groups[socialPace(a).group].push({ client: r.name as string, line: socialAllotmentLine(a) ?? `No tier set (${a.posts.used} posts this cycle)` });
    }
    return { ok: true, ...groups };
  },
};

const setSocialTierTool: AiTool = {
  name: "set_social_tier",
  description:
    "Set a client's social tier in the Services panel: basic, silver, gold, platinum (with added_video_reels on top, $150 each), custom (each pool's numbers: posts, statics, videos, stories, with an optional _min for a range), sprint (custom numbers until a day, then a tier or nothing) or strategy (strategy only, no posts, no allotment). Also the platforms they post on (facebook, instagram, tiktok, linkedin, google_business; only these are read and scored; leave out to keep them, [] for the tier's own). Executives and leads only. First call without confirmed: say what will change and ask; call again with confirmed: true after their yes.",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string" },
      tier: { type: "string", enum: ["basic", "silver", "gold", "platinum", "custom", "sprint", "strategy"] },
      posts: { type: "number" },
      posts_min: { type: "number" },
      statics: { type: "number" },
      statics_min: { type: "number" },
      videos: { type: "number" },
      videos_min: { type: "number" },
      stories: { type: "number" },
      stories_min: { type: "number" },
      until: { type: "string", description: "Sprint: the last day, YYYY-MM-DD" },
      after: { type: "string", enum: ["basic", "silver", "gold", "platinum", "none"], description: "Sprint: the tier it rolls into" },
      added_video_reels: { type: "number" },
      platforms: { type: "array", items: { type: "string", enum: SOCIAL_PLATFORM_OPTIONS.map((p) => p.key) } },
      confirmed: { type: "boolean" },
    },
    required: ["client"],
    additionalProperties: false,
  },
  lines: ["social"],
  run: async (user: Staff, input) => {
    if (!isExecOrLead(user)) return { ok: false, error: "Only executives and leads set a tier." };
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    const { data: row } = await db.from("clients").select("strategy_only").eq("id", c.id).maybeSingle();
    if (!row) return { ok: false, error: "That client isn't one you work on." };
    await assertMaySee(await accessFor(user), c.id);
    const tier = str(input.tier) ?? "";
    const platforms = Array.isArray(input.platforms) ? [...new Set((input.platforms as unknown[]).filter(isSocialPlatform))] : null;
    const strategy = ((row.strategy_only ?? []) as string[]).filter((s) => s !== "social-media");
    const update: Record<string, unknown> = {};
    let what = "";
    if (tier === "strategy") {
      update.strategy_only = [...strategy, "social-media"];
      what = "Strategy only (no posts, no allotment)";
    } else if (tier === "custom" || tier === "sprint") {
      const until = str(input.until) ?? "";
      if (tier === "sprint" && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: "A sprint needs its last day (YYYY-MM-DD)." };
      const nums = cleanSocialCustom(input as Record<string, unknown>);
      const after = tier === "sprint" && isSocialTier(input.after) ? input.after : null;
      const custom: SocialCustom = { ...nums, ...(tier === "sprint" ? { sprint_until: until, after } : {}) };
      Object.assign(update, { strategy_only: strategy, social_package_key: "custom", social_custom: custom });
      what = `${tier === "sprint" ? `Sprint until ${until}` : "Custom"}: ${tierText(nums)}${tier === "sprint" ? `, then ${after ?? "nothing"}` : ""}`;
    } else if (isSocialTier(tier)) {
      const t = SOCIAL_TIERS.find((x) => x.key === tier)!;
      const extra = input.added_video_reels == null ? null : Math.max(0, Math.min(60, Math.round(Number(input.added_video_reels) || 0)));
      Object.assign(update, { strategy_only: strategy, social_package_key: tier, ...(extra != null ? { social_extra_videos: extra } : {}) });
      what = `${t.label} (${t.price}${tier === "platinum" ? "" : "/mo"}): ${tierText(t)}${extra ? ` plus ${extra} added video/reels` : ""}`;
    } else if (!platforms) return { ok: false, error: "Say the tier or the platforms." };
    if (platforms) {
      update.social_platforms = platforms.length ? platforms : null;
      what = `${what ? `${what}; ` : ""}posts on ${platforms.length ? platforms.map(platformName).join(", ") : "the tier's own platforms"}`;
    }
    if (input.confirmed !== true) return { ok: true, proposed: what, ask: "Say this change and ask before applying (call again with confirmed: true)." };
    if (tier && tier !== "strategy") Object.assign(update, { social_package_set_by: user.id, social_package_set_at: new Date().toISOString() });
    const { error } = await createAdminClient().from("clients").update(update).eq("id", c.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, applied: what, page: `/clients/${c.slug}?tab=team` };
  },
};

const boostedPostsTool: AiTool = {
  name: "boosted_posts",
  description:
    "Which organic Facebook and Instagram posts the ads team is boosting (an ad running the published post), with the ads and the spend behind each over the last 30 days. For one client, or without a client every social client: the ones boosting and the ones with nothing boosted. Use it for \"which posts are being boosted?\", \"how much is behind our posts?\", or before suggesting posts to boost.",
  input_schema: { type: "object", properties: { client: { type: "string", description: "A client name; leave out for every social client" } }, additionalProperties: false },
  lines: ["social", "ads"],
  run: async (user: Staff, input) => {
    const db = await createClient();
    // What is spent behind each post is account numbers: the makers never see them
    if (!seesAccountNumbers(user)) return { ok: false, error: "Account numbers aren't part of your view." };
    const { boostedPosts } = await import("@/lib/social-boosts");
    const { boostLine } = await import("@/lib/social-boosts-core");
    const out = (p: Awaited<ReturnType<typeof boostedPosts>>[string][number]) => ({
      platform: p.platform,
      posted: p.postedAt?.slice(0, 10) ?? null,
      caption: (p.caption ?? "").replace(/\s+/g, " ").slice(0, 160),
      ads: p.ads,
      ad_names: p.adNames.slice(0, 3),
      spend_30d: Math.round(p.spend30d * 100) / 100,
      impressions_30d: p.impressions30d,
      last_spend_day: p.lastSpendDay,
      link: p.permalink,
    });
    if (str(input.client)) {
      const c = await clientNamed(db, input.client);
      const list = (await boostedPosts(db, [c.id]))[c.id] ?? [];
      return { ok: true, client: c.name, summary: boostLine(list), posts: list.map(out), sheet: `/kpis?p=social&open=${c.id}` };
    }
    const [all, { data: rows }] = await Promise.all([boostedPosts(db), db.from("clients").select("id, name, services, services_extra, services_removed, strategy_only").is("archived_at", null)]);
    const social = (rows ?? []).filter((r) => (servicesOf(r) as string[]).includes("social-media"));
    return {
      ok: true,
      boosting: social.filter((r) => all[r.id as string]?.length).map((r) => ({ client: r.name, summary: boostLine(all[r.id as string]), top: all[r.id as string].slice(0, 3).map(out) })),
      nothing_boosted: social.filter((r) => !all[r.id as string]?.length).map((r) => r.name as string),
    };
  },
};

const socialAccountsTool: AiTool = {
  name: "social_accounts",
  description:
    "A client's linked Facebook Pages and Instagram accounts, one per location where they have several (each labeled), and what isn't linked. With find: true, looks among the Pages Kaizen's Meta access can see for the ones clearly theirs (every word of their name in the Page's, no other client fitting as well): first call returns what it would link; call again with confirmed: true to link them. Pages that aren't clearly theirs are listed for a person to pick on the client's Social tab; a Page Kaizen can't see needs the client to share it with Kaizen's Business Manager.",
  input_schema: { type: "object", properties: { client: { type: "string" }, find: { type: "boolean" }, confirmed: { type: "boolean" } }, required: ["client"], additionalProperties: false },
  lines: ["social"],
  run: async (user: Staff, input) => {
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    const { linkedAccounts } = await import("@/lib/social/links");
    const { accountLabel } = await import("@/lib/social/links-core");
    const list = (await linkedAccounts(db, [c.id])).get(c.id) ?? [];
    const linked = { facebook: list.filter((a) => a.platform === "facebook").map(accountLabel), instagram: list.filter((a) => a.platform === "instagram").map(accountLabel) };
    if (input.find !== true) return { ok: true, client: c.name, linked, not_linked: [linked.facebook.length ? null : "Facebook", linked.instagram.length ? null : "Instagram"].filter(Boolean), page: `/clients/${c.slug}?service=social` };
    const { discoverSocialLinks } = await import("@/lib/social/store");
    const r = await discoverSocialLinks(createAdminClient(), c.id, { apply: input.confirmed === true, by: user.id });
    const found = r.added.map((a) => `${a.platform === "instagram" ? "Instagram" : "Facebook"} ${a.name ?? a.accountId}${a.location ? ` (${a.location})` : ""}`);
    if (input.confirmed !== true) return { ok: true, client: c.name, linked, would_link: found, others_to_pick: r.others.slice(0, 20).map((p) => p.name), note: r.error, ask: found.length ? "Say what will be linked and ask before linking (call again with confirmed: true)." : "Nothing is clearly theirs among the Pages Kaizen can see." };
    return { ok: true, client: c.name, linked_now: found, others_to_pick: r.others.slice(0, 20).map((p) => p.name), note: r.error };
  },
};

export const tools: AiTool[] = [socialAllotment, setSocialTierTool, boostedPostsTool, socialAccountsTool];
