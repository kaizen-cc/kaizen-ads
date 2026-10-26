"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { makeSandboxCampaign, planLaunch, runLaunch, type LaunchCheck, type LaunchPlan, type Overrides } from "@/lib/launcher";
import { metaConfigured } from "@/lib/context/meta";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Launch panel on a ticket in Ready to launch: plan (the Media Buyer proposes, Kaizen's checks and Meta's dry run),
// adjust, then create the ads paused. See src/lib/launcher.ts.

export type LaunchView = {
  id: string;
  status: "planning" | "ready" | "blocked" | "launching" | "launched" | "failed" | "discarded";
  progress: string | null;
  sandbox: boolean;
  plan: LaunchPlan | null;
  checks: LaunchCheck[];
  result: { adsetId: string; newAdset: string | null; ads: { designId: string; name: string; adId: string | null; error: string | null }[]; link: string | null } | null;
  error: string | null;
  launchedBy: string | null;
  launchedAt: string | null;
  canLaunch: boolean;
};

/** Who can launch: the client's Meta buyer, the Head of Meta and execs. */
async function canLaunch(me: Staff, clientId: string) {
  if (me.isExec || me.role === "head_of_meta") return true;
  const { data } = await (await createClient()).from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer").eq("profile_id", me.id).maybeSingle();
  return Boolean(data);
}

async function view(id: string): Promise<LaunchView | null> {
  const me = await requireStaff();
  const { data: l } = await (await createClient())
    .from("launches")
    .select("id, client_id, status, progress, sandbox, plan, checks, result, error, launched_at, launcher:profiles!launches_launched_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!l) return null;
  return {
    id: l.id,
    status: l.status as LaunchView["status"],
    progress: l.progress,
    sandbox: l.sandbox,
    plan: l.plan as LaunchPlan | null,
    checks: (l.checks ?? []) as LaunchCheck[],
    result: l.result as LaunchView["result"],
    error: l.error,
    launchedBy: (l.launcher as unknown as { full_name: string } | null)?.full_name ?? null,
    launchedAt: l.launched_at,
    canLaunch: await canLaunch(me, l.client_id),
  };
}

export async function loadLaunch(id: string) {
  return view(id);
}

/** The ticket's latest launch (not discarded), if any. */
export async function launchFor(requestId: string): Promise<LaunchView | null> {
  await requireStaff();
  const { data } = await (await createClient()).from("launches").select("id").eq("request_id", requestId).neq("status", "discarded").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? view(data.id) : null;
}

/** Starts planning a launch for the ticket (in the background). */
export async function startLaunch(requestId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!metaConfigured() || !adminConfigured()) return { ok: false, error: "Meta isn't connected." };
  const { data: r } = await (await createClient()).from("requests").select("id, client_id, stage").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (r.stage !== "ready_for_launch") return { ok: false, error: "Only tickets in Ready to launch can be launched." };
  if (!(await canLaunch(me, r.client_id))) return { ok: false, error: "Only the client's Meta buyer, the Head of Meta or an exec can launch." };
  const admin = createAdminClient();
  const { data: l, error } = await admin.from("launches").insert({ request_id: r.id, client_id: r.client_id, account: "", created_by: me.id }).select("id").single();
  if (error || !l) return { ok: false, error: error?.message ?? "Couldn't start it." };
  after(() => planLaunch(admin, l.id));
  return { ok: true, id: l.id };
}

/** Plans it again with the buyer's changes (ad set, new ad set, names, Page, Instagram, link). */
export async function replanLaunch(id: string, overrides: Overrides): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  if (!v.canLaunch) return { ok: false, error: "Only the client's Meta buyer, the Head of Meta or an exec can launch." };
  if (["launching", "launched"].includes(v.status)) return { ok: false, error: "Already launched." };
  const admin = createAdminClient();
  await admin.from("launches").update({ status: "planning", progress: "Checking again", updated_at: new Date().toISOString() }).eq("id", id);
  after(() => planLaunch(admin, id, overrides));
  void me;
  return { ok: true };
}

/**
 * Creates the ads in Meta, paused. A client launch moves the ticket to Launched with the ad names in its history;
 * a sandbox launch is a test and leaves the ticket where it is.
 */
export async function confirmLaunch(id: string): Promise<{ ok: true; launched: number; total: number; link: string | null; sandbox: boolean } | { ok: false; error: string }> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  if (!v.canLaunch) return { ok: false, error: "Only the client's Meta buyer, the Head of Meta or an exec can launch." };
  if (v.status !== "ready") return { ok: false, error: "Run the checks first; they have to pass." };
  const admin = createAdminClient();
  try {
    const r = await runLaunch(admin, id);
    await admin.from("launches").update({ launched_by: me.id }).eq("id", id);
    if (!r.sandbox && r.ok > 0) {
      const { data: l } = await admin.from("launches").select("request_id").eq("id", id).single();
      const names = r.result.ads.filter((a) => a.adId).map((a) => a.name);
      await (await createClient()).rpc("move_request", { p_request: l!.request_id, p_stage: "launched", p_note: `Launched paused in Meta from Kaizen Ads: ${names.join("; ")}`.slice(0, 1000) });
    }
    revalidatePath("/board");
    return { ok: true, launched: r.ok, total: r.total, link: r.result.link, sandbox: r.sandbox };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't launch." };
  }
}

export async function discardLaunch(id: string) {
  const v = await view(id);
  if (!v || ["launching", "launched"].includes(v.status)) return;
  await createAdminClient().from("launches").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", id);
}

/** Execs, sandbox only: a paused test campaign and ad set in Kaizen's account, then the launch is checked again. */
export async function sandboxCampaign(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only execs can set up the sandbox." };
  try {
    await makeSandboxCampaign(createAdminClient());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return replanLaunch(id, {});
}
