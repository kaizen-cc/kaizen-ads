"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { postWeekly, submitMonthly } from "@/lib/reports/run";
import { draftReport, qaReport, reviseReport, type ChatTurn, type Qa, type Sections } from "@/lib/reports/write";
import { periodsFor } from "@/lib/reports/metrics";
import { nyParts } from "@/lib/kpi/calc";
import { canReportOn } from "@/lib/reports/access";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** The report, if this person may work on it: the account's buyer, the leads of its line, or an exec. */
async function mine(id: string) {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("reports").select("id, owner_id, status, kind, client_id, platform, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  if (!data) return null;
  const t = data.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (data.owner_id !== me.id && !(t && (await canReportOn(db, me, t)))) return null;
  return { me, r: data };
}
const done = (id: string) => {
  revalidatePath(`/reports/${id}`);
  revalidatePath("/reports");
};

export async function saveReport(id: string, patch: { message?: string; extras?: string; sections?: Sections }): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out." };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.message !== undefined) update.message = patch.message.slice(0, 12000);
  if (patch.extras !== undefined) update.extras = patch.extras.slice(0, 6000);
  if (patch.sections !== undefined) update.sections = patch.sections;
  await createAdminClient().from("reports").update(update).eq("id", id);
  done(id);
  return { ok: true };
}

/** Asks the AI to change the report ("add lead quality", "shorter"); what the client always wants is remembered. */
export async function reviseWithAi(id: string, ask: string): Promise<Result<{ chat: ChatTurn[]; message: string; sections: Sections; qa: Qa | null; lesson: string | null }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (!ask.trim()) return { ok: false, error: "Say what to change." };
  try {
    const out = await reviseReport(createAdminClient(), id, ask, ok.me.fullName);
    done(id);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't change it just now." };
  }
}

/** Checks it again (after the buyer's own edits). */
export async function checkAgain(id: string): Promise<Result<{ qa: Qa }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  try {
    const qa = await qaReport(createAdminClient(), id);
    done(id);
    return { ok: true, qa };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't check it just now." };
  }
}

/** Writes it again from the latest numbers (in the background; the page follows it). */
export async function redraft(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  await admin.from("reports").update({ status: "drafting", updated_at: new Date().toISOString() }).eq("id", id);
  after(() => draftReport(admin, id));
  done(id);
  return { ok: true };
}

/** Weekly: post it to the client's channel as you. Monthly: submit your part (it goes out when every part is in). */
export async function sendReport(id: string): Promise<Result<{ note: string; needsConnect?: boolean }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  try {
    if (ok.r.kind !== "monthly") {
      const out = await postWeekly(admin, id, ok.me);
      if (!out.ok) return { ok: false, error: out.error, ...("needsConnect" in out && out.needsConnect ? { needsConnect: true } : {}) } as { ok: false; error: string };
      done(id);
      return { ok: true, note: "Posted to the client's channel as you." };
    }
    const out = await submitMonthly(admin, id, ok.me);
    done(id);
    return { ok: true, note: out.sent ? "Every part is in: the recap went to the client in Slack and by email." : `Submitted. It goes to the client as soon as ${out.waitingOn.join(" and ")} submit${out.waitingOn.length === 1 ? "s" : ""}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

/** Not this week (the account was paused, the client asked for no report…). */
export async function skipReport(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  await createAdminClient().from("reports").update({ status: "skipped", updated_at: new Date().toISOString() }).eq("id", id);
  done(id);
  return { ok: true };
}

/**
 * A recap on demand, for any dates (month to date, last month, a custom range): when a client asks where things stand.
 * One per ad account picked; each is drafted in the background and opens for review like any report.
 */
export async function reportForRange(targetIds: string[], start: string, end: string): Promise<Result<{ ids: string[] }>> {
  const me: Staff = await requireStaff();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return { ok: false, error: "Pick a start and an end date." };
  const today = nyParts(new Date()).date;
  if (start >= today) return { ok: false, error: "The dates need to be in the past (data runs through yesterday)." };
  const until = end >= today ? new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : end;
  const db = await createClient();
  const { data: found } = await db.from("kpi_targets").select("id, client_id, platform, owner_id").in("id", targetIds.slice(0, 4));
  // Only accounts this person reports on (their own, or their line's for a lead)
  const targets = [];
  for (const t of found ?? []) if (await canReportOn(db, me, t)) targets.push(t);
  if (!targets.length) return { ok: false, error: found?.length ? "You can only draft reports for the accounts you're on." : "Pick an ad account." };
  const admin = createAdminClient();
  const ids: string[] = [];
  for (const t of targets) {
    const { data: was } = await admin.from("reports").select("id, status, period_end").eq("target_id", t.id).eq("kind", "custom").eq("period_start", start).maybeSingle();
    // The same recap already sent: open that one rather than writing over it
    if (was?.status === "posted" && was.period_end === until) {
      ids.push(was.id);
      continue;
    }
    const { data: row } = await admin
      .from("reports")
      .upsert({ client_id: t.client_id, target_id: t.id, platform: t.platform, kind: "custom", period_start: start, period_end: until, owner_id: t.owner_id ?? me.id, status: "drafting", posted_at: null, slack_ts: null, chat: [] }, { onConflict: "target_id,kind,period_start" })
      .select("id")
      .single();
    if (!row) continue;
    ids.push(row.id);
    after(() => draftReport(admin, row.id));
  }
  revalidatePath("/reports");
  return ids.length ? { ok: true, ids } : { ok: false, error: "Couldn't start it." };
}

/** A report for one account right now (outside the Monday run, or one that didn't get queued). */
export async function draftNow(targetId: string, kind: "weekly" | "monthly"): Promise<Result<{ id: string }>> {
  const me: Staff = await requireStaff();
  const db = await createClient();
  const { data: t } = await db.from("kpi_targets").select("id, client_id, platform, owner_id").eq("id", targetId).maybeSingle();
  if (!t) return { ok: false, error: "Account not found." };
  if (!(await canReportOn(db, me, t))) return { ok: false, error: "Only the account's buyer or a lead can do that." };
  const p = periodsFor(kind, nyParts(new Date()).date).main;
  const admin = createAdminClient();
  let bundle: string | null = null;
  if (kind === "monthly") {
    const { data: b } = await admin.from("report_bundles").upsert({ client_id: t.client_id, kind: "monthly", period_start: p.start, period_end: p.end }, { onConflict: "client_id,kind,period_start" }).select("id").single();
    bundle = b?.id ?? null;
  }
  const { data: row } = await admin
    .from("reports")
    .upsert({ client_id: t.client_id, target_id: t.id, bundle_id: bundle, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id, status: "drafting" }, { onConflict: "target_id,kind,period_start" })
    .select("id")
    .single();
  if (!row) return { ok: false, error: "Couldn't start it." };
  after(() => draftReport(admin, row.id));
  revalidatePath("/reports");
  return { ok: true, id: row.id };
}

// ─── The report builder ─────────────────────────────────────────────────────

/** Builds a report for a client: date ranges (the first is the main one) and services; each part is written now. */
export async function buildReportAction(clientId: string, ranges: { key: string; start?: string; end?: string }[], platforms: string[]): Promise<Result<{ id: string }>> {
  const me = await requireStaff();
  const { resolveRange, buildReport, draftParts } = await import("@/lib/reports/builder");
  const resolved = ranges.map((r) => resolveRange(r.key, undefined, r.start && r.end ? { start: r.start, end: r.end } : undefined)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (!resolved.length) return { ok: false, error: "Pick the dates to report on (custom dates need a start and an end in the past)." };
  // The same range picked twice counts once
  const unique = resolved.filter((r, i) => resolved.findIndex((x) => x.start === r.start && x.end === r.end) === i);
  try {
    const admin = createAdminClient();
    const out = await buildReport(admin, await createClient(), me, clientId, unique, [...new Set(platforms)].filter((p) => p === "meta" || p === "google"));
    after(() => draftParts(admin, out.partIds));
    revalidatePath("/reports");
    return { ok: true, id: out.mineId ?? out.partIds[0] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't build it." };
  }
}

/** A buyer approves their part of a built report. */
export async function approveMyPart(id: string): Promise<Result<{ sent: boolean; waitingOn: string[] }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const { approvePart } = await import("@/lib/reports/builder");
  try {
    const out = await approvePart(createAdminClient(), id, ok.me);
    done(id);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't approve it." };
  }
}

/** The bundle, if this person built it or works on one of its parts. */
async function myBundle(bundleId: string) {
  const me = await requireStaff();
  const db = await createClient();
  const { data: b } = await db.from("report_bundles").select("id, created_by, message, message_approved_at").eq("id", bundleId).maybeSingle();
  if (!b) return null;
  if (b.created_by === me.id || isExecOrLead(me)) return { me, b };
  const { data: parts } = await db.from("reports").select("id").eq("bundle_id", bundleId).eq("owner_id", me.id).limit(1);
  return parts?.length ? { me, b } : null;
}

/** The Slack message for a built report: the saved one, or written now from the approved parts (joint: combined). */
export async function builtMessage(bundleId: string, fresh = false): Promise<Result<{ message: string }>> {
  const ok = await myBundle(bundleId);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.b.message && !fresh) return { ok: true, message: ok.b.message };
  const { composeMessage } = await import("@/lib/reports/builder");
  try {
    const message = await composeMessage(createAdminClient(), bundleId);
    if (message && !ok.b.message_approved_at) await createAdminClient().from("report_bundles").update({ message }).eq("id", bundleId);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't write the message." };
  }
}

/** The builder approves the message: it goes now, or as soon as the last part is approved. */
export async function approveBuiltMessage(bundleId: string, message: string): Promise<Result<{ sent: boolean; waitingOn: string[] }>> {
  const ok = await myBundle(bundleId);
  if (!ok) return { ok: false, error: "Not found." };
  const { approveMessage } = await import("@/lib/reports/builder");
  try {
    const out = await approveMessage(createAdminClient(), bundleId, ok.me, message);
    revalidatePath("/reports");
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}
