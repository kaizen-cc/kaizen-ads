"use server";

import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// No revalidatePath here: it re-rendered the whole client page inside the save, so a two-row update took the page's
// full load to answer. The panel shows the new tier at once and refreshes the page in the background.
//
// Every service's tier, set in one place: the Services panel on Team & setup (owner, Nov 19 2026).
//   Email: the 3-Month Initial Setup (by its start date, then the ongoing tier), Basic, Silver, Gold, Custom (the
//          client's own numbers per pool), or Strategy only.
//   Creative: a creative package, Custom (images and videos a month), a sprint until a day, or Strategy only.
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

export type EmailCustom = { campaigns: number; campaigns_min: number; sms: number; sms_min: number; flows: number | null; flow_emails: number; flow_emails_min: number };

/** The client's email tier */
export async function setEmailTier(clientId: string, slug: string, t: { tier: "setup" | "basic" | "silver" | "gold" | "custom"; start?: string | null; custom?: Partial<EmailCustom> | null; after?: string | null }): Promise<Result> {
  try {
    const { me, admin, strategy } = await guard(clientId);
    const now = new Date().toISOString();
    const base = { strategy_only: without(strategy, "email-marketing"), email_package_set_by: me.id, email_package_set_at: now };
    if (t.tier === "setup") {
      if (!t.start || !/^\d{4}-\d{2}/.test(t.start)) return { ok: false, error: "Pick the month the setup starts." };
      const after = ["basic", "silver", "gold"].includes(String(t.after)) ? t.after : "basic";
      await admin.from("clients").update({ ...base, email_setup_start: `${t.start.slice(0, 7)}-01`, email_package_key: after }).eq("id", clientId);
    } else if (t.tier === "custom") {
      const c = t.custom ?? {};
      const pair = (max: unknown, min: unknown, cap: number) => {
        const hi = whole(max, cap);
        return [Math.min(hi, whole(min ?? hi, cap)), hi] as const;
      };
      const [cMin, cMax] = pair(c.campaigns, c.campaigns_min, 60);
      const [sMin, sMax] = pair(c.sms, c.sms_min, 40);
      const [fMin, fMax] = pair(c.flow_emails, c.flow_emails_min, 60);
      const custom: EmailCustom = { campaigns: cMax, campaigns_min: cMin, sms: sMax, sms_min: sMin, flows: c.flows == null ? null : whole(c.flows, 20), flow_emails: fMax, flow_emails_min: fMin };
      await admin.from("clients").update({ ...base, email_package_key: "custom", email_custom: custom, email_setup_start: null }).eq("id", clientId);
    } else {
      await admin.from("clients").update({ ...base, email_package_key: t.tier, email_setup_start: null }).eq("id", clientId);
    }
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
