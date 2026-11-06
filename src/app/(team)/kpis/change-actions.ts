"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { applyChange, planChange, type PlannedOp } from "@/lib/ad-changes";
import { can } from "@/lib/chat-permissions";
import { canOn, seatsOn } from "@/lib/chat-permissions-server";
import { googleAdsConfigured } from "@/lib/context/google-ads";
import { metaConfigured } from "@/lib/context/meta";
import type { AuditResult } from "@/lib/audit";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { writeStatus, type WriteStatus } from "@/lib/write-status";

// Turning an audit action or a sprint move into changes in the ad account (Google Ads or Meta), then applying them on
// confirm. Meta writes also pass the sandbox switch (src/lib/meta-write.ts).

export type ChangeView = {
  id: string;
  status: "planning" | "ready" | "nothing" | "applying" | "applied" | "partial" | "failed" | "discarded";
  ops: PlannedOp[];
  note: string | null;
  error: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  canApply: boolean;
  /** Why not (who can), when canApply is false */
  applyWhy: string | null;
  /** The ad account (digits), for links straight to each object */
  account: string;
  /** Whether applying would actually write to the account (live changes on for the client), read before pressing */
  write: WriteStatus;
  /** Execs can switch live changes on right from the card */
  canSwitch: boolean;
};

type From = { source: "audit"; auditId: string; index: number } | { source: "sprint"; actionId: string };

/** The action and its account, read with the viewer's own access (so only someone who can see it can plan from it). */
async function resolve(from: From) {
  const db = await createClient();
  if (from.source === "audit") {
    const { data: a } = await db.from("account_audits").select("id, target_id, client_id, result").eq("id", from.auditId).maybeSingle();
    const x = (a?.result as AuditResult | null)?.actions?.[from.index];
    if (!a || !x) return null;
    return { targetId: a.target_id as string, source: { title: x.title, steps: x.steps, why: x.why } };
  }
  const { data: s } = await db.from("sprint_actions").select("id, title, steps, why, optimization_sprints(target_id)").eq("id", from.actionId).maybeSingle();
  const targetId = (s?.optimization_sprints as unknown as { target_id: string } | null)?.target_id;
  if (!s || !targetId) return null;
  return { targetId, source: { title: s.title as string, steps: (s.steps ?? []) as string[], why: (s.why as string | null) ?? "" } };
}

async function view(id: string): Promise<ChangeView | null> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: c } = await db.from("ad_changes").select("id, client_id, platform, account, status, ops, note, error, applied_at, applier:profiles!ad_changes_applied_by_fkey(full_name), kpi_targets(owner_id)").eq("id", id).maybeSingle();
  if (!c) return null;
  const admin = createAdminClient();
  const platform = c.platform === "meta" ? "meta" : "google";
  const write = await writeStatus(admin, { clientId: c.client_id as string | null, account: String(c.account ?? "") }, platform);
  // The client's buyer seats, or the KPI card being theirs, make a buyer the account's own
  const owner = (c.kpi_targets as unknown as { owner_id: string | null } | null)?.owner_id ?? null;
  const seats = [...(await seatsOn(admin, me.id, c.client_id as string | null)), ...(owner === me.id ? [platform as "meta" | "google"] : [])];
  const allowed = can(me, "ads.change", { platform, seats });
  return {
    id: c.id,
    status: c.status as ChangeView["status"],
    ops: (c.ops ?? []) as PlannedOp[],
    note: c.note,
    error: c.error,
    appliedBy: (c.applier as unknown as { full_name: string } | null)?.full_name ?? null,
    appliedAt: c.applied_at,
    account: String(c.account ?? ""),
    canApply: allowed.ok,
    applyWhy: allowed.reason,
    write,
    canSwitch: me.isExec,
  };
}

/**
 * Whether a change planned from this action could be written to its account right now, for the button before it's
 * pressed (canSwitch: execs can switch live changes on right there).
 */
export async function writeFor(from: From): Promise<{ write: WriteStatus; canSwitch: boolean; why: string | null } | null> {
  const me = await requireStaff();
  if (!adminConfigured()) return null;
  const r = await resolve(from);
  if (!r) return null;
  const admin = createAdminClient();
  const { data: t } = await admin.from("kpi_targets").select("client_id, platform, ad_account_id").eq("id", r.targetId).maybeSingle();
  if (!t || !["google", "meta"].includes(t.platform as string)) return null;
  // why: who can, when this person can't change this account (the button becomes one calm line)
  const allowed = await canOn(admin, me, "ads.change", { platform: t.platform as "meta" | "google", clientId: t.client_id as string });
  return { write: await writeStatus(admin, { clientId: t.client_id as string, account: (t.ad_account_id as string | null) ?? null }, t.platform as "meta" | "google"), canSwitch: me.isExec, why: allowed.reason };
}

/** The same read for a KPI's own account (its #1 problem's plan, the next step written on the board). */
export async function writeForTarget(targetId: string): Promise<{ write: WriteStatus; canSwitch: boolean; why: string | null } | null> {
  const me = await requireStaff();
  if (!adminConfigured()) return null;
  // Read with the viewer's own access first: only someone who can see the KPI learns about its account
  const { data: t } = await (await createClient()).from("kpi_targets").select("client_id, platform, ad_account_id").eq("id", targetId).maybeSingle();
  if (!t || !["google", "meta"].includes(t.platform as string)) return null;
  const admin = createAdminClient();
  const allowed = await canOn(admin, me, "ads.change", { platform: t.platform as "meta" | "google", clientId: t.client_id as string });
  return { write: await writeStatus(admin, { clientId: t.client_id as string, account: (t.ad_account_id as string | null) ?? null }, t.platform as "meta" | "google"), canSwitch: me.isExec, why: allowed.reason };
}

/**
 * "Plan the change" on a next step written for a KPI (the board's #1 problem and its plan): the buyer agent turns it
 * into the exact changes in that KPI's account, on the same plan card as the client chat. Nothing is written until
 * someone allowed confirms, and only while live changes are on.
 */
export async function planTargetStep(targetId: string, step: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Can't do this here." };
  const { data: t } = await (await createClient()).from("kpi_targets").select("id, client_id, platform, ad_account_id").eq("id", targetId).maybeSingle();
  if (!t || !t.ad_account_id || !["google", "meta"].includes(t.platform as string)) return { ok: false, error: "This account has no ad account to change." };
  const text = step.replace(/\s+/g, " ").trim().slice(0, 1500);
  if (text.length < 4) return { ok: false, error: "That step is empty." };
  const admin = createAdminClient();
  const allowed = await canOn(admin, me, "ads.change", { platform: t.platform as "meta" | "google", clientId: t.client_id as string });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const { startChatChange, planChatChange } = await import("@/lib/chat-changes");
  const r = await startChatChange(admin, t.client_id as string, me.id, t.platform as "meta" | "google", `A next step from the KPI board: ${text}`, t.id as string);
  if ("error" in r) return { ok: false, error: r.error };
  after(() => planChatChange(admin, r.id));
  return { ok: true, id: r.id };
}

/** The latest change planned from this action, if any. */
export async function changeFor(from: From): Promise<ChangeView | null> {
  await requireStaff();
  const db = await createClient();
  let q = db.from("ad_changes").select("id").neq("status", "discarded").order("created_at", { ascending: false }).limit(1);
  q = from.source === "audit" ? q.eq("audit_id", from.auditId).eq("action_index", from.index) : q.eq("sprint_action_id", from.actionId);
  const { data } = await q.maybeSingle();
  return data ? view(data.id) : null;
}

export async function loadChange(id: string) {
  return view(id);
}

/** Has the buyer agent turn the action into changes, checked with the platform (a dry run); nothing is applied. */
export async function planFrom(from: From): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Can't do this here." };
  const r = await resolve(from);
  if (!r) return { ok: false, error: "Couldn't find that action." };
  const admin = createAdminClient();
  const { data: t } = await admin.from("kpi_targets").select("id, client_id, platform, ad_account_id").eq("id", r.targetId).single();
  if (!t || !t.ad_account_id || !["google", "meta"].includes(t.platform)) return { ok: false, error: "This account has no ad account to change." };
  // Planning is a step toward a change: only someone who may change this account starts one
  const allowed = await canOn(admin, me, "ads.change", { platform: t.platform as "meta" | "google", clientId: t.client_id as string });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  if (t.platform === "google" && !googleAdsConfigured()) return { ok: false, error: "Google Ads isn't connected." };
  if (t.platform === "meta" && !metaConfigured()) return { ok: false, error: "Meta isn't connected." };
  const { data: row, error } = await admin
    .from("ad_changes")
    .insert({
      target_id: t.id,
      client_id: t.client_id,
      platform: t.platform,
      account: String(t.ad_account_id).replace(/\D/g, ""),
      source: from.source,
      audit_id: from.source === "audit" ? from.auditId : null,
      action_index: from.source === "audit" ? from.index : null,
      sprint_action_id: from.source === "sprint" ? from.actionId : null,
      title: r.source.title,
      planned_by: me.id,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn't start it." };
  after(() => planChange(admin, row.id, r.source));
  return { ok: true, id: row.id };
}

/** Applies it in the ad account. Only the account's buyer, the head of its platform and execs. pick: only these changes. */
export async function applyPlanned(id: string, pick?: number[]): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  const c = await view(id);
  if (!c) return { ok: false, error: "Not found." };
  if (!c.canApply) return { ok: false, error: c.applyWhy ?? "Only the account's buyer, the head of its platform or an exec can apply changes." };
  if (!c.write.live) return { ok: false, error: c.write.reason ?? "Live changes are off for this client." };
  try {
    const status = await applyChange(createAdminClient(), id, me, pick);
    revalidatePath("/kpis", "layout");
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't apply it." };
  }
}

export async function discardPlanned(id: string) {
  await requireStaff();
  if (!(await view(id))) return;
  await createAdminClient().from("ad_changes").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", id).in("status", ["ready", "nothing", "failed"]);
}
