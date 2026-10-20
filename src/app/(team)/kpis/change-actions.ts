"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { applyChange, canApply, planChange, type PlannedOp } from "@/lib/ad-changes";
import { googleAdsConfigured } from "@/lib/context/google-ads";
import type { AuditResult } from "@/lib/audit";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Turning an audit action or a sprint move into changes in the Google Ads account, then applying them on confirm.

export type ChangeView = {
  id: string;
  status: "planning" | "ready" | "nothing" | "applying" | "applied" | "partial" | "failed" | "discarded";
  ops: PlannedOp[];
  note: string | null;
  error: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  canApply: boolean;
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
  const { data: c } = await db.from("ad_changes").select("id, status, ops, note, error, applied_at, applier:profiles!ad_changes_applied_by_fkey(full_name), kpi_targets(owner_id)").eq("id", id).maybeSingle();
  if (!c) return null;
  return {
    id: c.id,
    status: c.status as ChangeView["status"],
    ops: (c.ops ?? []) as PlannedOp[],
    note: c.note,
    error: c.error,
    appliedBy: (c.applier as unknown as { full_name: string } | null)?.full_name ?? null,
    appliedAt: c.applied_at,
    canApply: canApply(me, (c.kpi_targets as unknown as { owner_id: string | null } | null)?.owner_id ?? null),
  };
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

/** Has the Google Buyer turn the action into changes, checked with Google; nothing is applied. */
export async function planFrom(from: From): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!googleAdsConfigured() || !adminConfigured()) return { ok: false, error: "Google Ads isn't connected." };
  const r = await resolve(from);
  if (!r) return { ok: false, error: "Couldn't find that action." };
  const admin = createAdminClient();
  const { data: t } = await admin.from("kpi_targets").select("id, client_id, platform, ad_account_id").eq("id", r.targetId).single();
  if (!t || t.platform !== "google" || !t.ad_account_id) return { ok: false, error: "Changes can be made on Google Ads accounts only, for now." };
  const { data: row, error } = await admin
    .from("ad_changes")
    .insert({
      target_id: t.id,
      client_id: t.client_id,
      platform: "google",
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

/** Applies it in Google Ads. Only the account's buyer, the Head of Google and execs. pick: only these changes. */
export async function applyPlanned(id: string, pick?: number[]): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  const c = await view(id);
  if (!c) return { ok: false, error: "Not found." };
  if (!c.canApply) return { ok: false, error: "Only the account's buyer, the Head of Google or an exec can apply changes." };
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
