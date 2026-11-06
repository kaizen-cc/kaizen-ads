"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { WriteStatus } from "@/lib/write-status-core";
import { canOn } from "@/lib/chat-permissions-server";
import { runnable, unanswered } from "@/lib/launch-sheet/plan";
import type { CheckItem, LaunchItem, LaunchPlan, LaunchQuestion, LaunchSheet, Resolution, RunStatus } from "@/lib/launch-sheet/types";

// The launch card in a client's chat (and in Kaizen AI): follow a launch from a sheet as it's read, checked and
// planned; take the Media Buyer's proposals, build the plan, confirm it (only the client's buyer, the head of Meta, a
// lead or an exec), continue or retry it. The conversation itself happens in the chat.

export type LaunchView = {
  id: string;
  clientId: string;
  status: RunStatus;
  progress: string | null;
  error: string | null;
  summary: string | null;
  source: string;
  event: { name: string; date: string | null; goal: string };
  rows: { index: number; date: string | null; page: string; geo: string; creative: string; color: string | null; post: boolean }[];
  checks: CheckItem[];
  questions: LaunchQuestion[];
  plan: LaunchPlan | null;
  warnings: string[];
  items: LaunchItem[];
  qa: { at: string; lines: { key: string; ok: boolean; diffs: string[]; link: string | null }[] } | null;
  live: boolean;
  liveNote: string | null;
  /** The full read, for the disabled state in place of Create (and the switch, for execs) */
  write: WriteStatus;
  canSwitch: boolean;
  canConfirm: boolean;
  /** Who can, when this person can't (one calm line in place of the buttons) */
  confirmWhy: string | null;
  resumable: boolean;
  confirmedBy: string | null;
};

const STALE_MS = 8 * 60_000;

/** Who works a Meta launch (answers, plans, confirms): execs, the head of Meta, or the client's own Meta buyer */
async function mayConfirm(me: Staff, clientId: string) {
  return canOn(createAdminClient(), me, "ads.launch", { platform: "meta", clientId });
}

/** The launch, when this person may work it; otherwise why not */
async function workable(id: string): Promise<{ v: LaunchView } | { error: string; v: LaunchView | null }> {
  const v = await view(id);
  if (!v) return { error: "Not found.", v: null };
  if (!v.canConfirm) return { error: v.confirmWhy ?? "This launch isn't yours to work.", v };
  return { v };
}

async function view(id: string): Promise<LaunchView | null> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: r } = await db
    .from("launch_runs")
    .select("id, client_id, account, status, progress, error, summary, source, sheet, resolution, questions, plan, plan_warnings, qa, locked_at, updated_at, confirmer:profiles!launch_runs_confirmed_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!r) return null;
  let status = r.status as RunStatus;
  let error = r.error as string | null;
  // Work that never came back (the request it ran in was cut short): say so instead of waiting forever
  if (["reading", "resolving", "planning", "checking"].includes(status) && Date.now() - Date.parse(r.updated_at as string) > STALE_MS) {
    const back: RunStatus = status === "planning" || status === "checking" ? "asking" : "failed";
    error = status === "planning" || status === "checking" ? "Laying out the plan took too long and stopped. Ask for the plan again." : "Reading the sheet took too long and stopped. Share it again.";
    await createAdminClient().from("launch_runs").update({ status: back, progress: null, error, updated_at: new Date().toISOString() }).eq("id", id).eq("status", status);
    status = back;
  }
  const { data: rows } = await db.from("launch_items").select("key, kind, position, parent_key, label, status, meta_id, error, help, checked_at").eq("run_id", id).order("position");
  const items: LaunchItem[] = (rows ?? []).map((x) => ({ key: x.key, kind: x.kind, position: x.position, parentKey: x.parent_key, label: x.label, status: x.status, metaId: x.meta_id, error: x.error, help: x.help, checked: x.checked_at }));
  const plan = (r.plan as LaunchPlan | null) ?? null;
  const sheet = r.sheet as LaunchSheet | null;
  const res = r.resolution as Resolution | null;
  // Whether creating it would write to the account: the same read as every apply button (src/lib/write-status.ts)
  const { writeStatus } = await import("@/lib/write-status");
  const write = await writeStatus(createAdminClient(), { clientId: r.client_id as string, account: (r.account as string | null) || null }, "meta");
  const live = Boolean(r.account) && write.live;
  const liveNote = r.account ? write.reason : null;
  const lockedRecently = r.locked_at && Date.now() - Date.parse(r.locked_at as string) < 10 * 60_000;
  const src = r.source as { name?: string; url?: string };
  const confirm = await mayConfirm(me, r.client_id as string);
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    status,
    progress: r.progress as string | null,
    error,
    summary: r.summary as string | null,
    source: src.name ?? src.url ?? "Launch sheet",
    event: { name: sheet?.event.name ?? "", date: sheet?.event.date ?? null, goal: sheet?.goal ?? "" },
    rows: (sheet?.rows ?? []).map((x) => ({ index: x.index, date: x.date, page: x.page, geo: x.geo, creative: x.creative.name, color: x.color, post: Boolean(x.existingPost) })),
    checks: res?.checks ?? [],
    questions: (r.questions ?? []) as LaunchQuestion[],
    plan,
    warnings: (r.plan_warnings ?? []) as string[],
    items,
    qa: (r.qa as LaunchView["qa"]) ?? null,
    live,
    liveNote,
    write,
    canSwitch: me.isExec,
    canConfirm: confirm.ok,
    confirmWhy: confirm.reason,
    resumable: status === "applying" && !lockedRecently && Boolean(plan && runnable(items, plan).length),
    confirmedBy: (r.confirmer as unknown as { full_name: string } | null)?.full_name ?? null,
  };
}

export async function loadLaunch(id: string) {
  return view(id);
}

/** Takes the Media Buyer's proposal (or the option the buyer clicked) as the answer to these questions */
export async function takeLaunchProposals(id: string, keys: string[], chosen: Record<string, string> = {}): Promise<LaunchView | null> {
  await requireStaff();
  const { v } = await workable(id);
  if (!v || !v.canConfirm || v.status !== "asking") return v;
  const { acceptProposals } = await import("@/lib/launch-sheet/runs");
  await acceptProposals(createAdminClient(), id, keys, chosen);
  return view(id);
}

/** Lays out the plan from the answers (refused while a required question is open) */
export async function buildLaunchPlan(id: string): Promise<{ ok: true; view: LaunchView } | { ok: false; error: string }> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!["asking", "ready"].includes(v.status)) return { ok: false, error: "It can't be planned right now." };
  const open = unanswered(v.questions);
  if (open.length) return { ok: false, error: `Answer these first: ${open.map((q) => q.question).join(" ")}` };
  const admin = createAdminClient();
  await admin.from("launch_runs").update({ status: "planning", progress: "Laying out the plan", error: null, updated_at: new Date().toISOString() }).eq("id", id);
  const { planRun } = await import("@/lib/launch-sheet/runs");
  after(() => planRun(admin, id));
  return { ok: true, view: (await view(id))! };
}

/** Creates the plan in Meta (paused, or scheduled as agreed). Lines Meta refused in the dry run are left out. */
export async function confirmLaunch(id: string): Promise<{ ok: true; view: LaunchView } | { ok: false; error: string }> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  // The role first, then the client's Meta switch
  if (!v.canConfirm) return { ok: false, error: v.confirmWhy ?? "This launch isn't yours to confirm." };
  if (v.status !== "ready") return { ok: false, error: "There's no checked plan to confirm." };
  if (!v.live) return { ok: false, error: v.liveNote ?? "Live changes are off for this client." };
  const admin = createAdminClient();
  await admin.from("launch_runs").update({ status: "applying", progress: "Starting", confirmed_by: me.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
  const { applyRun } = await import("@/lib/launch-sheet/runs");
  after(() => applyRun(admin, id, { by: me.id }));
  revalidatePath("/clients", "layout");
  return { ok: true, view: (await view(id))! };
}

/** Picks a stopped launch up where it left off (only lines not created yet); retry: the failed lines too */
export async function continueLaunch(id: string, retry = false): Promise<{ ok: true; view: LaunchView } | { ok: false; error: string }> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  if (!v.canConfirm) return { ok: false, error: v.confirmWhy ?? "This launch isn't yours to continue." };
  if (!(retry ? ["partial", "failed", "applying"].includes(v.status) : v.resumable)) return { ok: false, error: "There's nothing to continue." };
  if (!v.plan) return { ok: false, error: "There's no plan." };
  const admin = createAdminClient();
  const { applyRun } = await import("@/lib/launch-sheet/runs");
  after(() => applyRun(admin, id, { retry, by: me.id }));
  return { ok: true, view: (await view(id))! };
}

/** Parks the launch (nothing created stays as it is); the chat answers normally again */
export async function setAsideLaunch(id: string): Promise<LaunchView | null> {
  await requireStaff();
  const { v } = await workable(id);
  if (!v || !v.canConfirm || !["asking", "ready", "failed"].includes(v.status)) return v;
  await createAdminClient().from("launch_runs").update({ status: v.items.some((i) => i.status === "created") ? "partial" : "set_aside", updated_at: new Date().toISOString() }).eq("id", id);
  return view(id);
}

/** A reply about the launch from a surface without the client chat's box (Kaizen AI's card) */
export async function replyToLaunch(id: string, text: string): Promise<{ ok: true; answer: string; view: LaunchView } | { ok: false; error: string }> {
  await requireStaff();
  const w = await workable(id);
  if ("error" in w) return { ok: false, error: w.error };
  const v = w.v;
  if (!["asking", "ready", "failed"].includes(v.status)) return { ok: false, error: "This launch isn't waiting on you." };
  const admin = createAdminClient();
  const { launchReply, planRun } = await import("@/lib/launch-sheet/runs");
  const r = await launchReply(admin, id, text.trim().slice(0, 3000));
  if (r.building) after(() => planRun(admin, id));
  return { ok: true, answer: r.offTopic ? "That isn't about this launch: ask it in the chat." : r.answer, view: (await view(id))! };
}
