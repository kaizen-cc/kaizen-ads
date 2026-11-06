"use server";

import { after } from "next/server";
import { METRIC_KEYS, reportBasis, type MetricKey, type ReportLayout } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { draftQueued, postWeekly, submitMonthly } from "@/lib/reports/run";
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
  if (patch.message !== undefined) {
    update.message = patch.message.slice(0, 12000);
    // Written by the buyer for the report as it stands
    const { data: cur } = await createAdminClient().from("reports").select("sections, extras").eq("id", id).single();
    update.message_basis = reportBasis(patch.sections ?? cur?.sections, patch.extras ?? cur?.extras);
  }
  if (patch.extras !== undefined) update.extras = patch.extras.slice(0, 6000);
  if (patch.sections !== undefined) update.sections = patch.sections;
  await createAdminClient().from("reports").update(update).eq("id", id);
  done(id);
  return { ok: true };
}

/**
 * The metrics the buyer chose (tiles, key metrics rows, campaign columns and lines): kept on the report, and on its KPI
 * as this client's layout, so the next report starts the way the buyer left this one.
 */
export async function saveLayout(id: string, layout: ReportLayout): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out." };
  const keys = new Set<string>(METRIC_KEYS);
  const clean = (l?: string[]) => (l ? [...new Set(l.filter((k) => keys.has(k)))].slice(0, 12) as MetricKey[] : undefined);
  const names = (l?: string[]) => (l ? [...new Set(l.map((x) => String(x).slice(0, 300)))].slice(0, 60) : undefined);
  const results = layout.campaigns?.results ? Object.fromEntries(Object.entries(layout.campaigns.results).slice(0, 60).map(([k, v]) => [String(k).slice(0, 300), String(v).slice(0, 200)])) : undefined;
  const tidy: ReportLayout = { tiles: clean(layout.tiles), table: clean(layout.table), columns: clean(layout.columns), campaigns: layout.campaigns ? { hide: names(layout.campaigns.hide), add: names(layout.campaigns.add), results } : undefined };
  const admin = createAdminClient();
  await admin.from("reports").update({ layout: tidy, updated_at: new Date().toISOString() }).eq("id", id);
  const t = ok.r.kpi_targets as unknown as { id: string } | null;
  if (t) await admin.from("kpi_targets").update({ report_layout: tidy }).eq("id", t.id);
  done(id);
  return { ok: true };
}

/**
 * Leaves a campaign out of this client's KPI, or counts it again (undo): the same exclusions as the KPI board's
 * Campaigns list, so the KPI, audits and every report follow (a campaign the client runs themselves, like their own
 * brand's ads). The KPI is worked out again straight away; the report shows it once it's regenerated, which reads the
 * KPI fresh.
 */
export async function setReportCampaignExcluded(id: string, campaign: { id?: string | null; name: string }, exclude: boolean): Promise<Result<{ campaignId: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const t = ok.r.kpi_targets as unknown as { id: string; client_id: string; platform: string } | null;
  if (!t) return { ok: false, error: "This report has no KPI to change." };
  const admin = createAdminClient();
  const { data: cur } = await admin.from("kpi_targets").select("ad_account_id, excluded_campaigns").eq("id", t.id).single();
  if (!cur) return { ok: false, error: "Couldn't read the KPI." };
  // Older reports kept only the campaign's name: its id is read from the account's rows
  let campaignId = String(campaign.id ?? "").trim().slice(0, 64);
  if (!campaignId && campaign.name && cur.ad_account_id) {
    const google = t.platform === "google";
    const { data: row } = await admin
      .from(google ? "google_campaign_daily" : "meta_campaign_daily")
      .select("campaign_id")
      .eq("ad_account_id", google ? String(cur.ad_account_id).replace(/\D/g, "") : String(cur.ad_account_id))
      .eq("campaign_name", campaign.name.slice(0, 300))
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    campaignId = String(row?.campaign_id ?? "");
  }
  if (!campaignId) return { ok: false, error: "Couldn't find that campaign in the ad account." };
  const left = new Set(((cur.excluded_campaigns ?? []) as string[]).map(String));
  if (exclude) left.add(campaignId);
  else left.delete(campaignId);
  const { error } = await admin.from("kpi_targets").update({ excluded_campaigns: [...left] }).eq("id", t.id);
  if (error) return { ok: false, error: error.message };
  after(async () => {
    const { refreshClientKpis } = await import("@/lib/kpi/sync");
    await refreshClientKpis(admin, t.client_id).catch(() => null);
  });
  revalidatePath("/kpis", "layout");
  done(id);
  return { ok: true, campaignId };
}

/**
 * "Plan the change" on one of the report's next steps: the buyer agent turns it into the exact changes in this
 * report's ad account (the same planned-change card as the client chat: each object before → after, the platform's
 * dry run, confirm). Nothing is written until someone allowed confirms, and only while live changes are on.
 */
export async function planReportStep(id: string, step: string): Promise<Result<{ changeId: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const t = ok.r.kpi_targets as unknown as { id: string; client_id: string; platform: string } | null;
  if (!t || (t.platform !== "meta" && t.platform !== "google")) return { ok: false, error: "This report has no ad account to change." };
  const text = step.replace(/\s+/g, " ").trim().slice(0, 1500);
  if (text.length < 4) return { ok: false, error: "That step is empty." };
  const admin = createAdminClient();
  const { startChatChange, planChatChange } = await import("@/lib/chat-changes");
  const r = await startChatChange(admin, t.client_id, ok.me.id, t.platform, `A next step from the client report: ${text}`, t.id);
  if ("error" in r) return { ok: false, error: r.error };
  after(() => planChatChange(admin, r.id));
  return { ok: true, changeId: r.id };
}

/** An older report's campaigns get what each counted in the period, so a campaign's result can be picked by hand */
export async function loadCampaignEvents(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const { data: r } = await admin.from("reports").select("metrics, platform, kpi_targets(ad_account_id)").eq("id", id).single();
  const account = (r?.kpi_targets as unknown as { ad_account_id: string | null } | null)?.ad_account_id;
  if (!r?.metrics || !account) return { ok: false, error: "This report has no campaigns to read." };
  const { withCampaignEvents } = await import("@/lib/reports/metrics");
  const metrics = await withCampaignEvents(admin, r.metrics as ReportMetrics, account, r.platform === "google" ? "google" : "meta");
  await admin.from("reports").update({ metrics }).eq("id", id);
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

/**
 * Regenerate: written again from scratch with the account's freshest numbers (pulled from Meta or Google first) and
 * the latest report logic, in the background; the page follows it. The draft it replaces can be undone for a day.
 */
export async function regenerate(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone to the client, so it can't be regenerated." };
  if (ok.r.status === "drafting" || ok.r.status === "queued") return { ok: false, error: "It's already being written." };
  const admin = createAdminClient();
  const { markForRegenerate, regenerateNow } = await import("@/lib/reports/regenerate");
  const marked = await markForRegenerate(admin, [id], ok.me.fullName, "drafting");
  if (!marked.length) return { ok: false, error: "It's already gone to the client, so it can't be regenerated." };
  after(() => regenerateNow(admin, id));
  done(id);
  return { ok: true };
}

/**
 * Regenerate every report shown (a section of the Reports page, with its platform and person filters, or a built
 * report's parts). An exec or lead regenerates any they can report on; a buyer only their own. Approved parts are kept
 * unless `approvedToo` (a buyer's own part of a built report). Sent ones and ones being written are skipped. Two or
 * fewer are written now; more are queued and written a couple at a time, so nothing spikes.
 */
export async function regenerateMany(ids: string[], approvedToo = false): Promise<Result<{ ids: string[] }>> {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("reports").select("id, status, owner_id, kpi_targets(id, client_id, platform, owner_id)").in("id", [...new Set(ids)].slice(0, 200));
  const allowed: string[] = [];
  for (const r of data ?? []) {
    const t = r.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
    const own = r.owner_id === me.id;
    if (!own && !(isExecOrLead(me) && t && (await canReportOn(db, me, t)))) continue;
    if (r.status === "draft" || r.status === "failed" || (approvedToo && own && r.status === "submitted")) allowed.push(r.id);
  }
  if (!allowed.length) return { ok: false, error: "Nothing here to regenerate (sent and approved reports are kept)." };
  const admin = createAdminClient();
  const { markForRegenerate, regenerateNow } = await import("@/lib/reports/regenerate");
  const few = allowed.length <= 2;
  const marked = await markForRegenerate(admin, allowed, me.fullName, few ? "drafting" : "queued");
  if (few)
    after(async () => {
      for (const id of marked) await regenerateNow(admin, id);
    });
  // The queue: started now, picked up by the 15-minute schedule if this run ends first
  else after(() => draftQueued(admin, 200_000, { regenerated: true }));
  revalidatePath("/reports");
  return { ok: true, ids: marked };
}

/** Back to the draft a regenerate replaced (within a day). */
export async function undoRegenerate(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  try {
    const { undoRegenerate: undo } = await import("@/lib/reports/regenerate");
    await undo(createAdminClient(), id);
    done(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't undo it." };
  }
}

/** Where regenerated reports stand, for the page's progress and the toast when they're done. */
export async function regenProgress(ids: string[]): Promise<{ id: string; status: string; client: string }[]> {
  await requireStaff();
  if (!ids.length) return [];
  const db = await createClient();
  const { data } = await db.from("reports").select("id, status, clients(name)").in("id", ids.slice(0, 200));
  return (data ?? []).map((r) => ({ id: r.id as string, status: r.status as string, client: (r.clients as unknown as { name: string } | null)?.name ?? "" }));
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
    return { ok: true, note: out.sent ? "It went to the client in Slack and by email." : `Submitted. It goes to the client as soon as ${out.waitingOn.join(" and ")} submit${out.waitingOn.length === 1 ? "s" : ""}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

/** Monthly: send my part to the client now instead of waiting on the other buyer (theirs follows on its own) */
export async function sendMyPartNow(id: string): Promise<Result<{ note: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.kind !== "monthly") return { ok: false, error: "Only a monthly recap has parts to wait on." };
  try {
    const { sendPartNow } = await import("@/lib/reports/run");
    await sendPartNow(createAdminClient(), id, ok.me);
    done(id);
    return { ok: true, note: "Sent to the client in Slack and by email. The other part goes out on its own when its buyer approves it." };
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
export async function buildReportAction(clientId: string, ranges: { key: string; start?: string; end?: string }[], platforms: string[], replace: string[] = []): Promise<Result<{ id: string }>> {
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
    // Built in place of a Monday draft that was waiting: that draft steps aside (skipped and off the page; it stays in
    // the client's history). Only the person's own drafts
    if (replace.length) await admin.from("reports").update({ status: "skipped", hidden_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", replace.slice(0, 10)).eq("owner_id", me.id).eq("client_id", clientId).neq("status", "posted");
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

/** The report was edited by hand since its Slack message was written: the message, brought up to date */
export async function refreshSlackMessage(id: string): Promise<Result<{ message: string; basis: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  try {
    const { refreshMessage } = await import("@/lib/reports/write");
    const out = await refreshMessage(createAdminClient(), id);
    done(id);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't update the message." };
  }
}

/** Approved by mistake (or something to change): back to editing, as long as nothing has gone to the client */
export async function reopenReport(id: string): Promise<Result> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const { data: r } = await admin.from("reports").select("status, bundle_id, report_bundles(status)").eq("id", id).single();
  if (!r) return { ok: false, error: "Not found." };
  if (r.status === "posted" || (r.report_bundles as unknown as { status: string } | null)?.status === "sent") return { ok: false, error: "It's already gone to the client." };
  if (r.status !== "submitted") return { ok: true };
  await admin.from("reports").update({ status: "draft", submitted_at: null, updated_at: new Date().toISOString() }).eq("id", id);
  // A message already approved would send the moment the last part is in: it waits for a fresh approval instead
  if (r.bundle_id) await admin.from("report_bundles").update({ message_approved_at: null, message_approved_by: null }).eq("id", r.bundle_id).neq("status", "sent");
  done(id);
  return { ok: true };
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

/**
 * Takes a report off "Reports generated". Not sent yet: it's deleted (every part of a built report). Sent: it stays
 * in the client's history and is only hidden from the list.
 */
export async function removeGenerated(kind: "bundle" | "report", id: string): Promise<Result<{ deleted: boolean }>> {
  const me = await requireStaff();
  const db = await createClient();
  const admin = createAdminClient();
  if (kind === "bundle") {
    const { data: b } = await db.from("report_bundles").select("id, status, created_by").eq("id", id).eq("kind", "built").maybeSingle();
    if (!b) return { ok: false, error: "Not found." };
    if (b.created_by !== me.id && !me.isExec) return { ok: false, error: "Only whoever built it can remove it." };
    if (b.status === "sent") {
      await admin.from("report_bundles").update({ hidden_at: new Date().toISOString() }).eq("id", id);
      revalidatePath("/reports");
      return { ok: true, deleted: false };
    }
    await admin.from("reports").delete().eq("bundle_id", id).neq("status", "posted");
    await admin.from("report_bundles").delete().eq("id", id);
    revalidatePath("/reports");
    return { ok: true, deleted: true };
  }
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") await admin.from("reports").update({ hidden_at: new Date().toISOString() }).eq("id", id);
  else await admin.from("reports").delete().eq("id", id);
  revalidatePath("/reports");
  return { ok: true, deleted: ok.r.status !== "posted" };
}

/**
 * Fill our PowerPoint template with this monthly recap: a copy in the client's Drive (Monthly recaps), filled with the
 * report's numbers, story, charts and top ads. Returns the Slides link and the PPTX download.
 */
export async function fillTemplateDeck(id: string, remap = false): Promise<Result<{ url: string; pptx: string; notes: string[] }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.kind !== "monthly") return { ok: false, error: "Only a monthly recap fills the template." };
  const { fillRecapDeck } = await import("@/lib/ai-tools/recap-deck");
  const r = await fillRecapDeck(createAdminClient(), id, ok.me.id, { remap });
  if (!r.ok) return r;
  return { ok: true, url: r.url, pptx: r.pptx, notes: r.notes };
}

/** The filled template for this recap, if there is one */
export async function deckForReport(id: string): Promise<{ url: string; pptx: string; notes: string[]; at: string | null } | null> {
  const ok = await mine(id);
  if (!ok) return null;
  const { data } = await createAdminClient().from("recap_decks").select("url, status, notes, updated_at").eq("report_id", id).maybeSingle();
  if (!data?.url || data.status !== "done") return null;
  return { url: data.url as string, pptx: `/api/reports/${id}/deck`, notes: (data.notes ?? []) as string[], at: (data.updated_at as string) ?? null };
}
