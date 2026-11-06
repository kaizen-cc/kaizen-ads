"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { WriteStatus } from "@/lib/write-status-core";
import { canOn } from "@/lib/chat-permissions-server";
import { deployBlocked, type GooglePlan, type PlanEdit } from "@/lib/google-launch/core";
import type { Suggestion } from "@/lib/google-launch/runs";
import { unanswered } from "@/lib/launch-sheet/plan";
import type { CheckItem, LaunchItem, LaunchQuestion, RunStatus } from "@/lib/launch-sheet/types";

// The Google launch card in a client's chat (the client page, or a Google card on the KPI board): follow a launch as
// it's read and asked about, take or skip the Google Ads Buyer's suggestions, build the plan, edit it line by line,
// fix what's over Google's limits, and deploy it (only the client's Google buyer, the head of Google, a lead or an
// exec, and only with the client's live changes in Google Ads on). The conversation itself happens in the chat.

export type GoogleLaunchView = {
  id: string;
  clientId: string;
  status: RunStatus;
  progress: string | null;
  error: string | null;
  summary: string | null;
  source: string;
  account: string | null;
  checks: CheckItem[];
  questions: LaunchQuestion[];
  suggestions: Suggestion[];
  plan: GooglePlan | null;
  warnings: string[];
  items: LaunchItem[];
  qa: { at: string; lines: { key: string; ok: boolean; diffs: string[]; link: string | null }[] } | null;
  write: WriteStatus;
  canSwitch: boolean;
  canConfirm: boolean;
  /** Who can, when this person can't (one calm line in place of the buttons) */
  confirmWhy: string | null;
  /** Why Deploy isn't offered right now (null: it is) */
  blocked: string | null;
};

const STALE_MS = 8 * 60_000;

/** Who works and deploys a Google launch: execs, the head of Google, or the client's own Google buyer */
async function mayConfirm(me: Staff, clientId: string) {
  return canOn(createAdminClient(), me, "ads.launch", { platform: "google", clientId });
}

/** The launch, when this person may work it; otherwise why not */
async function workable(id: string): Promise<{ v: GoogleLaunchView } | { error: string; v: GoogleLaunchView | null }> {
  const v = await view(id);
  if (!v) return { error: "Not found.", v: null };
  if (!v.canConfirm) return { error: v.confirmWhy ?? "This launch isn't yours to work.", v };
  return { v };
}

async function view(id: string): Promise<GoogleLaunchView | null> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: r } = await db.from("launch_runs").select("id, client_id, account, status, progress, error, summary, source, resolution, questions, plan, plan_warnings, qa, updated_at").eq("id", id).eq("platform", "google").maybeSingle();
  if (!r) return null;
  let status = r.status as RunStatus;
  let error = r.error as string | null;
  // Work cut short (the request it ran in ended): say so instead of waiting forever
  if (["reading", "resolving", "planning", "checking"].includes(status) && Date.now() - Date.parse(r.updated_at as string) > STALE_MS) {
    const back: RunStatus = status === "planning" || status === "checking" ? "asking" : "failed";
    error = back === "asking" ? "Laying out the plan took too long and stopped. Ask for the plan again." : "Reading took too long and stopped. Ask again in the chat.";
    await createAdminClient().from("launch_runs").update({ status: back, progress: null, error, updated_at: new Date().toISOString() }).eq("id", id).eq("status", status);
    status = back;
  }
  const { data: rows } = await db.from("launch_items").select("key, kind, position, parent_key, label, status, meta_id, error, help, checked_at").eq("run_id", id).order("position");
  const items: LaunchItem[] = (rows ?? []).map((x) => ({ key: x.key, kind: x.kind, position: x.position, parentKey: x.parent_key, label: x.label, status: x.status, metaId: x.meta_id, error: x.error, help: x.help, checked: x.checked_at }));
  const { writeStatus } = await import("@/lib/write-status");
  const write = await writeStatus(createAdminClient(), { clientId: r.client_id as string, account: (r.account as string | null) || null }, "google");
  const confirm = await mayConfirm(me, r.client_id as string);
  const canConfirm = confirm.ok;
  const res = (r.resolution ?? {}) as { checks?: CheckItem[]; suggestions?: Suggestion[] };
  const src = r.source as { kind?: string; name?: string; url?: string; text?: string };
  const plan = (r.plan as GooglePlan | null) ?? null;
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    status,
    progress: r.progress as string | null,
    error,
    summary: r.summary as string | null,
    source: src.kind === "words" ? "From the chat" : (src.name ?? src.url ?? "Sheet"),
    account: (r.account as string | null) ?? null,
    checks: res.checks ?? [],
    questions: (r.questions ?? []) as LaunchQuestion[],
    suggestions: res.suggestions ?? [],
    plan,
    warnings: (r.plan_warnings ?? []) as string[],
    items,
    qa: (r.qa as GoogleLaunchView["qa"]) ?? null,
    write,
    canSwitch: me.isExec,
    canConfirm,
    confirmWhy: confirm.reason,
    // The role first (deployBlocked reads canConfirm before the switch), then the client's Google switch
    blocked: canConfirm ? deployBlocked({ live: write.live, liveReason: write.reason, canConfirm, status, items, errors: 0 }) : confirm.reason,
  };
}

export async function loadGoogleLaunch(id: string) {
  return view(id);
}

type Result = { ok: true; view: GoogleLaunchView } | { ok: false; error: string };

/** Takes the proposal (or the option the buyer clicked) as the answer to these questions */
export async function takeGoogleProposals(id: string, keys: string[], chosen: Record<string, string> = {}): Promise<GoogleLaunchView | null> {
  await requireStaff();
  const { v } = await workable(id);
  if (!v || !v.canConfirm || v.status !== "asking") return v;
  const { acceptGoogleProposals } = await import("@/lib/google-launch/runs");
  await acceptGoogleProposals(createAdminClient(), id, keys, chosen);
  return view(id);
}

/** A suggestion from the account taken, skipped, or back to open */
export async function setGoogleLaunchSuggestion(id: string, key: string, accepted: boolean | null): Promise<GoogleLaunchView | null> {
  await requireStaff();
  const { v } = await workable(id);
  if (!v || !v.canConfirm || !["asking", "ready"].includes(v.status)) return v;
  const { setGoogleSuggestion } = await import("@/lib/google-launch/runs");
  await setGoogleSuggestion(createAdminClient(), id, key, accepted);
  return view(id);
}

/** Lays out the plan from the answers and the suggestions taken (refused while a required question is open) */
export async function buildGoogleLaunchPlan(id: string): Promise<Result> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!["asking", "ready"].includes(v.status)) return { ok: false, error: "It can't be planned right now." };
  const open = unanswered(v.questions);
  if (open.length) return { ok: false, error: `Answer these first: ${open.map((q) => q.question).join(" ")}` };
  const admin = createAdminClient();
  await admin.from("launch_runs").update({ status: "planning", progress: "Laying out the plan", error: null, updated_at: new Date().toISOString() }).eq("id", id);
  const { planGoogleRun } = await import("@/lib/google-launch/runs");
  after(() => planGoogleRun(admin, id));
  return { ok: true, view: (await view(id))! };
}

/** One edit on the card (remove a line, fix a headline or description, a keyword, a budget, a name), checked again */
export async function editGoogleLaunch(id: string, edit: PlanEdit): Promise<Result> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!v.plan) return { ok: false, error: "There's no plan to edit." };
  if (!["ready", "failed"].includes(v.status)) return { ok: false, error: "It can't be edited right now." };
  const { editGoogleRun } = await import("@/lib/google-launch/runs");
  await editGoogleRun(createAdminClient(), id, edit);
  return { ok: true, view: (await view(id))! };
}

/** Checks the plan with Google again (after it refused a deploy, or once something changed in the account) */
export async function recheckGoogleLaunch(id: string): Promise<Result> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!v.plan || !["ready", "failed"].includes(v.status)) return { ok: false, error: "There's no plan to check." };
  const { checkGoogleRun } = await import("@/lib/google-launch/runs");
  await checkGoogleRun(createAdminClient(), id);
  return { ok: true, view: (await view(id))! };
}

/** Fixes what's over Google's limits or would be refused (punctuation, duplicates, long lines shortened) */
export async function fixGoogleLaunch(id: string): Promise<Result> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!v.plan || !["ready", "failed"].includes(v.status)) return { ok: false, error: "There's no plan to fix." };
  const admin = createAdminClient();
  await admin.from("launch_runs").update({ status: "checking", progress: "Fixing the lines and checking them with Google", updated_at: new Date().toISOString() }).eq("id", id);
  const { fixGoogleRun } = await import("@/lib/google-launch/runs");
  after(() => fixGoogleRun(admin, id));
  return { ok: true, view: (await view(id))! };
}

/** Creates the plan in Google Ads, everything paused, in one batch. Refused with the client's Google switch off. */
export async function deployGoogleLaunch(id: string): Promise<Result> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  if (!v.canConfirm) return { ok: false, error: v.confirmWhy ?? "This launch isn't yours to deploy." };
  // The same gate the card shows (the client's Google switch, who's asking, a checked plan); googleBulkMutate checks
  // the switch again before anything reaches Google
  if (v.blocked) return { ok: false, error: v.blocked };
  const admin = createAdminClient();
  await admin.from("launch_runs").update({ status: "applying", progress: "Starting", updated_at: new Date().toISOString() }).eq("id", id);
  const { applyGoogleRun } = await import("@/lib/google-launch/runs");
  after(() => applyGoogleRun(admin, id, me.id));
  revalidatePath("/clients", "layout");
  return { ok: true, view: (await view(id))! };
}

/** Parks the launch (nothing is created); the chat answers normally again */
export async function setAsideGoogleLaunch(id: string): Promise<GoogleLaunchView | null> {
  await requireStaff();
  const { v } = await workable(id);
  if (!v || !v.canConfirm || !["asking", "ready", "failed"].includes(v.status)) return v;
  await createAdminClient().from("launch_runs").update({ status: v.items.some((i) => i.status === "created") ? "partial" : "set_aside", updated_at: new Date().toISOString() }).eq("id", id);
  return view(id);
}
