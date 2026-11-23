"use server";

import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cleanSocialCustom, isSocialPlatform, isSocialTier, type SocialCustom, type SocialTierKey } from "@/lib/social-allotment-core";

// No revalidatePath here: it re-rendered the whole client page inside the save, so a two-row update took the page's
// full load to answer. The panel shows the new tier at once and refreshes the page in the background.
//
// Every service's tier, set in one place: the Services panel on Team & setup (owner, Nov 19 2026).
//   Email: the 3-Month Initial Setup (by its start date, then the ongoing tier), Basic, Silver, Gold, Custom (the
//          client's own numbers per pool), or Strategy only.
//   Creative: a creative package, Custom (images and videos a month), a sprint until a day, or Strategy only.
//   Social: Basic, Silver, Gold, Platinum (plus added video/reels), Custom numbers, a Sprint until a day, or Strategy
//           only; and the platforms the client posts on (the tier's own unless picked).
//   Any service: Strategy only, no deliverables (no allotment, no pace or idle alerts, no gaps, never listed for
//   requests or briefs).

type Result = { ok: true } | { ok: false; error: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });

async function guard(clientId: string, execOnly = false) {
  const me = await requireStaff();
  if (execOnly ? !me.isExec : !isExecOrLead(me)) throw new Error(execOnly ? "Only an executive changes a creative package." : "Only executives and leads set a tier.");
  if (!adminConfigured()) throw new Error("Not set up.");
  const db = await createClient();
  const { data } = await db.from("clients").select("id, strategy_only").eq("id", clientId).maybeSingle();
  if (!data) throw new Error("That client isn't one you work on.");
  return { me, db, admin: createAdminClient(), strategy: ((data.strategy_only ?? []) as string[]).filter(Boolean) };
}

const without = (list: string[], s: string) => list.filter((x) => x !== s);
const whole = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

/** Strategy only for one service (on) or back to deliverables (off) */
export async function setStrategyOnly(clientId: string, slug: string, service: string, on: boolean): Promise<Result> {
  try {
    const { admin, strategy } = await guard(clientId, service === "creative");
    await admin.from("clients").update({ strategy_only: on ? [...new Set([...strategy, service])] : without(strategy, service) }).eq("id", clientId);
    if (on && service === "creative") {
      const db = await createClient();
      await db.rpc("end_creative_package", { p_client: clientId });
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export type EmailCustom = { campaigns: number; campaigns_min: number; sms: number; sms_min: number; flows: number | null; flow_emails: number; flow_emails_min: number; /** A sprint: its numbers hold until this day, then the client moves to `after` (or holds none) */ sprint_until?: string; after?: "basic" | "silver" | "gold" | null };

/** The client's email tier */
export async function setEmailTier(clientId: string, slug: string, t: { tier: "setup" | "basic" | "silver" | "gold" | "custom" | "sprint"; start?: string | null; until?: string | null; custom?: Partial<EmailCustom> | null; after?: string | null }): Promise<Result> {
  try {
    const { me, admin, strategy } = await guard(clientId);
    const now = new Date().toISOString();
    const base = { strategy_only: without(strategy, "email-marketing"), email_package_set_by: me.id, email_package_set_at: now };
    if (t.tier === "setup") {
      if (!t.start || !/^\d{4}-\d{2}/.test(t.start)) return { ok: false, error: "Pick the month the setup starts." };
      const after = ["basic", "silver", "gold"].includes(String(t.after)) ? t.after : "basic";
      await admin.from("clients").update({ ...base, email_setup_start: `${t.start.slice(0, 7)}-01`, email_package_key: after }).eq("id", clientId);
    } else if (t.tier === "custom" || t.tier === "sprint") {
      const sprint = t.tier === "sprint";
      if (sprint && (!t.until || !/^\d{4}-\d{2}-\d{2}$/.test(t.until))) return { ok: false, error: "Pick the day the sprint ends." };
      if (sprint && t.until! < new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })) return { ok: false, error: "The sprint has to end today or later." };
      const c = t.custom ?? {};
      const pair = (max: unknown, min: unknown, cap: number) => {
        const hi = whole(max, cap);
        return [Math.min(hi, whole(min ?? hi, cap)), hi] as const;
      };
      const [cMin, cMax] = pair(c.campaigns, c.campaigns_min, 60);
      const [sMin, sMax] = pair(c.sms, c.sms_min, 40);
      const [fMin, fMax] = pair(c.flow_emails, c.flow_emails_min, 60);
      const after = sprint && ["basic", "silver", "gold"].includes(String(t.after)) ? (t.after as "basic" | "silver" | "gold") : null;
      // The allotment reads a sprint the way it reads Custom (these numbers); the daily step ends it on its day
      const custom: EmailCustom = { campaigns: cMax, campaigns_min: cMin, sms: sMax, sms_min: sMin, flows: c.flows == null ? null : whole(c.flows, 20), flow_emails: fMax, flow_emails_min: fMin, ...(sprint ? { sprint_until: t.until!, after } : {}) };
      await admin.from("clients").update({ ...base, email_package_key: "custom", email_custom: custom, email_setup_start: null }).eq("id", clientId);
    } else {
      await admin.from("clients").update({ ...base, email_package_key: t.tier, email_setup_start: null }).eq("id", clientId);
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The client's social tier: Basic, Silver, Gold or Platinum (with any added video/reels), Custom numbers (each pool, one
 * number or a range), or a Sprint (its numbers until a day, then a tier or nothing). Strategy only is setStrategyOnly.
 */
export async function setSocialTier(
  clientId: string,
  slug: string,
  t: { tier: SocialTierKey; extraVideos?: number | null } | { tier: "custom"; custom: Partial<SocialCustom> } | { tier: "sprint"; until: string; custom: Partial<SocialCustom>; after?: string | null },
): Promise<Result> {
  try {
    const { me, admin, strategy } = await guard(clientId);
    const base = { strategy_only: without(strategy, "social-media"), social_package_set_by: me.id, social_package_set_at: new Date().toISOString() };
    if (t.tier === "custom" || t.tier === "sprint") {
      const sprint = t.tier === "sprint";
      if (sprint && !/^\d{4}-\d{2}-\d{2}$/.test(t.until)) return { ok: false, error: "Pick the day the sprint ends." };
      if (sprint && t.until < new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })) return { ok: false, error: "The sprint has to end today or later." };
      const after = sprint && isSocialTier(t.after) ? t.after : null;
      const custom: SocialCustom = { ...cleanSocialCustom(t.custom ?? {}), ...(sprint ? { sprint_until: t.until, after } : {}) };
      await admin.from("clients").update({ ...base, social_package_key: "custom", social_custom: custom }).eq("id", clientId);
    } else {
      if (!isSocialTier(t.tier)) return { ok: false, error: "Pick a tier." };
      await admin.from("clients").update({ ...base, social_package_key: t.tier, ...(t.extraVideos != null ? { social_extra_videos: whole(t.extraVideos, 60) } : {}) }).eq("id", clientId);
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** The platforms the client posts on (null: the tier's own). Only these are read and scored. */
export async function setSocialPlatforms(clientId: string, slug: string, platforms: string[] | null): Promise<Result> {
  try {
    const { admin } = await guard(clientId);
    const list = platforms == null ? null : [...new Set(platforms.filter(isSocialPlatform))];
    if (list && !list.length) return { ok: false, error: "Pick at least one platform." };
    await admin.from("clients").update({ social_platforms: list }).eq("id", clientId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Added video/reels a month on top of the social tier ($150 each) */
export async function setSocialExtraVideos(clientId: string, slug: string, n: number): Promise<Result> {
  try {
    const { admin } = await guard(clientId);
    await admin.from("clients").update({ social_extra_videos: whole(n, 60) }).eq("id", clientId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** The client's creative tier: a package, Custom (images and videos a month), or a sprint until a day */
export async function setCreativeTier(clientId: string, slug: string, t: { tier: "package"; key: string } | { tier: "custom"; images: number; videos: number } | { tier: "sprint"; until: string; key: string | null; images: number; videos: number; note?: string | null }): Promise<Result> {
  try {
    const { me, db, admin, strategy } = await guard(clientId, true);
    await admin.from("clients").update({ strategy_only: without(strategy, "creative") }).eq("id", clientId);
    if (t.tier === "package") {
      const { error } = await db.rpc("set_ongoing_package", { p_client: clientId, p_package: t.key });
      if (error) return { ok: false, error: error.message };
    } else if (t.tier === "custom") {
      const now = new Date().toISOString();
      await admin.from("clients").update({ creative_package: true, creative_package_key: null, creative_package_until: null, creative_package_note: "Custom", creative_package_set_by: me.id, creative_package_set_at: now }).eq("id", clientId);
      await admin.from("client_allotments").upsert({ client_id: clientId, images_per_month: whole(t.images, 999), videos_per_month: whole(t.videos, 999), updated_by: me.id, updated_at: now });
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.until)) return { ok: false, error: "Pick the day the sprint ends." };
      const { error } = await db.rpc("set_sprint_package", { p_client: clientId, p_until: t.until, p_package: t.key, p_images: t.key ? null : whole(t.images, 999), p_videos: t.key ? null : whole(t.videos, 999), p_note: t.note ?? null });
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * A location that draws from another client's creative allotment (its parent's): it shares that pool, both show the
 * pool's cap and every member's use counts against it, in the pool owner's billing cycle. Null: its own allotment again.
 */
export async function setAllotmentPool(clientId: string, slug: string, poolClientId: string | null): Promise<Result> {
  try {
    const { admin } = await guard(clientId, true);
    if (poolClientId) {
      if (poolClientId === clientId) return { ok: false, error: "A client can't draw from itself." };
      const { data: p } = await admin.from("clients").select("id, allotment_pool_id, creative_package").eq("id", poolClientId).maybeSingle();
      if (!p) return { ok: false, error: "That client isn't there." };
      if (p.allotment_pool_id) return { ok: false, error: "That client draws from another one's allotment itself: pick the one that holds it." };
    }
    // Keep the creative package on, so its work keeps counting (against the pool)
    await admin.from("clients").update({ allotment_pool_id: poolClientId, ...(poolClientId ? { creative_package: true } : {}) }).eq("id", clientId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
