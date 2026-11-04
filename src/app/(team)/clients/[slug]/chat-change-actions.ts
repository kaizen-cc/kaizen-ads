"use server";

import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { applyChange, checkOps, googleWritesOn, type PlannedOp } from "@/lib/ad-changes";
import { editOp, edited, type OpEdit } from "@/lib/chat-change-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The plan card under a chat answer: follow the plan the buyer agent is making, then confirm it (all or some of it,
// with the amounts, names or links edited), save it as a checklist while live changes are off, or drop it.

export type ChatChangeView = {
  id: string;
  platform: "meta" | "google" | "team";
  account: string;
  status: "planning" | "ready" | "nothing" | "applying" | "applied" | "partial" | "failed" | "discarded";
  request: string | null;
  ops: PlannedOp[];
  note: string | null;
  error: string | null;
  /** Live changes for this client: off means confirm isn't possible, only a checklist */
  live: boolean;
  liveNote: string | null;
  canConfirm: boolean;
  savedAt: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
};

const STALE_MS = 6 * 60_000;

/** Who can confirm: execs, leads, the head of the platform, the client's own buyer on it (or the account's KPI owner). A buyer change: execs and leads. */
async function mayConfirm(me: Staff, row: { platform: string; client_id: string; target_id: string | null }) {
  if (row.platform === "team") return isExecOrLead(me);
  if (me.isExec || me.isLead) return true;
  if (me.role === (row.platform === "meta" ? "head_of_meta" : "head_of_google")) return true;
  const admin = createAdminClient();
  const [{ data: seat }, { data: t }] = await Promise.all([
    admin.from("client_assignments").select("profile_id").eq("client_id", row.client_id).eq("role", row.platform === "meta" ? "meta_buyer" : "google_buyer").eq("profile_id", me.id).maybeSingle(),
    row.target_id ? admin.from("kpi_targets").select("owner_id").eq("id", row.target_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return Boolean(seat) || (t as { owner_id?: string | null } | null)?.owner_id === me.id;
}

async function liveFor(platform: string, account: string): Promise<{ live: boolean; note: string | null }> {
  if (platform === "team") return { live: true, note: null };
  const admin = createAdminClient();
  if (platform === "meta") {
    const { writeBlocked } = await import("@/lib/meta-write");
    const blocked = await writeBlocked(admin, account);
    return { live: !blocked, note: blocked };
  }
  const on = await googleWritesOn(admin, account);
  return { live: on, note: on ? null : "Live changes are off for this client's Google Ads: an exec switches them on in the client's Team & setup." };
}

async function view(id: string): Promise<ChatChangeView | null> {
  const me = await requireStaff();
  const db = await createClient();
  const { data: c } = await db.from("ad_changes").select("id, client_id, target_id, platform, account, status, request, ops, note, error, saved_at, applied_at, updated_at, applier:profiles!ad_changes_applied_by_fkey(full_name)").eq("id", id).eq("source", "chat").maybeSingle();
  if (!c) return null;
  let status = c.status as ChatChangeView["status"];
  let error = c.error as string | null;
  // A plan that never came back (the request it ran in was cut short): say so instead of waiting forever
  if (status === "planning" && Date.now() - Date.parse(c.updated_at as string) > STALE_MS && adminConfigured()) {
    status = "failed";
    error = "The plan took too long and stopped. Ask again in the chat.";
    await createAdminClient().from("ad_changes").update({ status, error, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "planning");
  }
  const [{ live, note: liveNote }, canConfirm] = await Promise.all([liveFor(c.platform as string, c.account as string), mayConfirm(me, { platform: c.platform as string, client_id: c.client_id as string, target_id: c.target_id as string | null })]);
  return {
    id: c.id as string,
    platform: c.platform as ChatChangeView["platform"],
    account: c.account as string,
    status,
    request: c.request as string | null,
    ops: (c.ops ?? []) as PlannedOp[],
    note: c.note as string | null,
    error,
    live,
    liveNote,
    canConfirm,
    savedAt: (c.saved_at as string | null) ?? null,
    appliedBy: (c.applier as unknown as { full_name: string } | null)?.full_name ?? null,
    appliedAt: (c.applied_at as string | null) ?? null,
  };
}

export async function loadChatChange(id: string) {
  return view(id);
}

/**
 * Confirms the plan: only the changes ticked, with any edits (an edited change is checked again with the platform
 * first), then applied one by one in the ad account through the same gates as every other write.
 */
export async function confirmChatChange(id: string, picks: number[], edits: Record<number, OpEdit> = {}): Promise<{ ok: true; view: ChatChangeView } | { ok: false; error: string }> {
  const me = await requireStaff();
  const v = await view(id);
  if (!v) return { ok: false, error: "Not found." };
  if (!v.canConfirm) return { ok: false, error: v.platform === "team" ? "Only execs and leads can change a client's buyer." : "Only the client's buyer, the head of the platform, a lead or an exec can confirm changes." };
  if (!["ready", "partial", "failed"].includes(v.status)) return { ok: false, error: "There's nothing to confirm." };
  if (!v.live) return { ok: false, error: v.liveNote ?? "Live changes are off for this client." };
  if (!picks.length) return { ok: false, error: "Tick at least one change." };
  const admin = createAdminClient();
  // The buyer's edits, and a fresh check of anything edited
  let ops = v.ops.map((o, i) => ({ ...editOp(o, edits[i]), selected: picks.includes(i) }) as PlannedOp);
  const changed = ops.map((o, i) => (picks.includes(i) && edited(o, { ...v.ops[i], selected: true }) && !o.result?.ok ? i : -1)).filter((i) => i >= 0);
  if (changed.length && v.platform !== "team") {
    const rechecked = await checkOps(admin, v.platform, v.account, changed.map((i) => ({ ...ops[i], check: null })));
    ops = ops.map((o, i) => (changed.includes(i) ? rechecked[changed.indexOf(i)] : o));
  }
  await admin.from("ad_changes").update({ ops, updated_at: new Date().toISOString() }).eq("id", id);
  try {
    await applyChange(admin, id, me, picks);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't apply it." };
  }
  revalidatePath("/kpis", "layout");
  revalidatePath("/clients", "layout");
  const after = await view(id);
  return after ? { ok: true, view: after } : { ok: false, error: "Not found." };
}

/** Live changes are off: keep the plan as a checklist to apply by hand (or here, once they're on). */
export async function saveChatChecklist(id: string): Promise<ChatChangeView | null> {
  await requireStaff();
  const v = await view(id);
  if (!v || !["ready", "partial", "failed"].includes(v.status)) return v;
  await createAdminClient().from("ad_changes").update({ saved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
  return view(id);
}

/** Drops the plan (nothing was changed). */
export async function discardChatChange(id: string): Promise<ChatChangeView | null> {
  await requireStaff();
  const v = await view(id);
  if (!v || !["ready", "nothing", "failed", "planning"].includes(v.status)) return v;
  await createAdminClient().from("ad_changes").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", id);
  return view(id);
}
