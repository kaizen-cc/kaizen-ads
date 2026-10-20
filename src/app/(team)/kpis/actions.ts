"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { CONVERSIONS } from "@/lib/kpi/conversions";
import { refreshClientKpis } from "@/lib/kpi/sync";
import { exploreTarget, type Explore } from "@/lib/kpi/explore";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";

export type ActionResult = { ok: true } | { ok: false; error: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const num = (f: FormData, k: string) => {
  const v = str(f, k)?.replace(/[$,x\s]/gi, "");
  return v && !Number.isNaN(Number(v)) ? Number(v) : null;
};

function fields(form: FormData) {
  const conversion = str(form, "conversion") ?? "purchases";
  return {
    conversion: CONVERSIONS.some((c) => c.key === conversion) ? conversion : "purchases",
    custom_action: str(form, "custom_action"),
    campaign_match: str(form, "campaign_match"),
    label: str(form, "label"),
    target: num(form, "target"),
    monthly_budget: num(form, "monthly_budget"),
    budget_note: str(form, "budget_note"),
    source: str(form, "source") === "client" ? "client" : "strategy",
    ad_account_id: str(form, "ad_account_id")?.replace(/^act_/, "").replace(/-/g, "") ?? null,
    owner_id: str(form, "owner_id"),
  };
}

/** Recompute right away so the row reflects the new target or budget (no new pull from Meta). */
async function recompute(clientId: string) {
  if (adminConfigured()) await refreshClientKpis(createAdminClient(), clientId).catch(() => null);
  revalidatePath("/kpis");
}

/** Anyone on the client can set its KPI: the buyer, from strategy or what the client asked for. RLS checks it. */
export async function saveKpiTarget(id: string, clientId: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase
    .from("kpi_targets")
    .update({ ...fields(form), updated_by: me.id, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await recompute(clientId);
  return { ok: true };
}

export async function addKpiTarget(form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const clientId = str(form, "client_id");
  if (!clientId) return { ok: false, error: "Pick a client." };
  const supabase = await createClient();
  const { error } = await supabase.from("kpi_targets").insert({ client_id: clientId, platform: str(form, "platform") === "google" ? "google" : "meta", ...fields(form), updated_by: me.id });
  if (error) return { ok: false, error: error.message };
  await recompute(clientId);
  return { ok: true };
}

export async function archiveKpiTarget(id: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("kpi_targets").update({ active: false }).eq("id", id);
  revalidatePath("/kpis");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Pull fresh numbers from Meta for one client now, instead of waiting for the next 2-hour run. */
export async function pullClientKpis(clientId: string): Promise<ActionResult> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  await requireStaff();
  const supabase = await createClient();
  const { data: visible } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!visible) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    await refreshClientKpis(createAdminClient(), clientId, true);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach Meta" };
  }
  revalidatePath("/kpis");
  return { ok: true };
}

/** Execs: link an ad account Meta shares with us to a client (the database only lets execs edit clients). */
export async function linkAdAccount(accountId: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only an exec can link ad accounts." };
  const clientId = str(form, "client_id");
  if (!clientId) return { ok: false, error: "Pick a client." };
  const supabase = await createClient();
  const { error } = await supabase.from("clients").update({ meta_ad_account_id: accountId }).eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  const { data: existing } = await supabase.from("kpi_targets").select("id").eq("client_id", clientId).eq("platform", "meta").limit(1);
  if (existing?.length) await supabase.from("kpi_targets").update({ ad_account_id: accountId }).eq("client_id", clientId).eq("platform", "meta").is("ad_account_id", null);
  else await supabase.from("kpi_targets").insert({ client_id: clientId, platform: "meta", ad_account_id: accountId, conversion: "purchases", updated_by: me.id });
  if (adminConfigured()) {
    const admin = createAdminClient();
    const { data: state } = await admin.from("sync_state").select("last_result").eq("source", "meta:accounts").maybeSingle();
    const result = (state?.last_result ?? {}) as { unlinked?: { id: string }[] };
    await admin.from("sync_state").update({ last_result: { ...result, unlinked: (result.unlinked ?? []).filter((a) => a.id !== accountId) } }).eq("source", "meta:accounts");
    await refreshClientKpis(admin, clientId, true).catch(() => null);
  }
  revalidatePath("/kpis");
  return { ok: true };
}

/** The KPI card's explorer: numbers for a "counts as a result" before it's saved, what the account reports, and its extra metric boxes. */
export async function exploreKpi(targetId: string, tryOut: { conversion: string; custom: string | null; campaignMatch: string | null }): Promise<{ ok: true; data: Explore } | { ok: false; error: string }> {
  await requireStaff();
  const supabase = await createClient();
  const { data: t } = await supabase.from("kpi_targets").select("ad_account_id, platform, target, monthly_budget, extra_metrics").eq("id", targetId).maybeSingle();
  if (!t) return { ok: false, error: "You don't work on this client." };
  if (!t.ad_account_id) return { ok: false, error: "Add the ad account first." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const data = await exploreTarget(createAdminClient(), { ...t, ad_account_id: t.ad_account_id, extra_metrics: (t.extra_metrics ?? []) as string[] }, tryOut);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the numbers" };
  }
}

/** The extra metric boxes on this KPI card only. */
export async function setExtraMetrics(targetId: string, keys: string[]): Promise<ActionResult> {
  await requireStaff();
  const clean = [...new Set(keys.filter((k) => /^[a-z_]+$/.test(k) || /^(action|cost):[\w.]+$/.test(k)))].slice(0, 12);
  const supabase = await createClient();
  const { error } = await supabase.from("kpi_targets").update({ extra_metrics: clean }).eq("id", targetId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/kpis");
  return { ok: true };
}
