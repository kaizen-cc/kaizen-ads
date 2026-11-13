"use server";

import { after } from "next/server";
import { METRIC_KEYS, reportBasis, type MetricKey, type ReportLayout } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { draftQueued, sendWeekly, submitMonthly, tiktokJoinsFor } from "@/lib/reports/run";
import { draftReport, qaReport, reviseReport, type ChatTurn, type Qa, type Sections } from "@/lib/reports/write";
import { periodsFor } from "@/lib/reports/metrics";
import { nyParts } from "@/lib/kpi/calc";
import { canReportOn } from "@/lib/reports/access";
import { isPeriodKey, nextPeriod, parseDates, previousPeriod, rangeLabel, resolvePeriod, restOfAsk, shiftDay, todayIn, type PeriodKey } from "@/lib/reports/period";
import { channelsPhrase, normalizeDelivery, type Delivery } from "@/lib/reports/delivery-core";
import { applyManual, cleanLines, type ManualLine, type ManualResults } from "@/lib/reports/manual";
import type { DriveSave } from "@/lib/reports/drive-save-core";
import { appendLog, canBringBack, isSkipReason, latestSkip, skipEntry, unskipEntry, type LogEntry } from "@/lib/reports/skip-log";

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
  // "Include our notes in the report" is this report's alone: the next one starts without them again
  await admin.from("reports").update({ layout: layout.notes === true ? { ...tidy, notes: true } : tidy, updated_at: new Date().toISOString() }).eq("id", id);
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
  const metrics = await withCampaignEvents(admin, r.metrics as ReportMetrics, account, r.platform === "google" ? "google" : r.platform === "tiktok" ? "tiktok" : "meta");
  await admin.from("reports").update({ metrics }).eq("id", id);
  done(id);
  return { ok: true };
}

/**
 * The report's dates: a preset (last week, the last 7, 14 or 30 days, this month, last month) or custom dates, as of
 * today where the client is. Every page is redrawn for them with fresh numbers, against the days just before. Another
 * unsent report already on those dates is opened instead (openId).
 */
export async function changePeriod(id: string, key: PeriodKey, custom?: { start: string; end: string }): Promise<Result<{ label: string }> & { openId?: string }> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (!isPeriodKey(key)) return { ok: false, error: "Pick the dates." };
  const today = todayIn();
  const p = resolvePeriod(key, today, custom);
  if (!p) return { ok: false, error: "Pick a start and an end date that are over (the data runs through yesterday)." };
  return movePeriod(id, ok.me, p, today);
}

async function movePeriod(id: string, me: Staff, p: { key: PeriodKey; label: string; start: string; end: string }, today: string, then?: (admin: ReturnType<typeof createAdminClient>) => Promise<unknown>): Promise<Result<{ label: string }> & { openId?: string }> {
  const admin = createAdminClient();
  // A built report's dates are every part's: whoever built it (or an exec) moves them
  const { data: r } = await admin.from("reports").select("kind, report_bundles(created_by)").eq("id", id).maybeSingle();
  const builder = (r?.report_bundles as unknown as { created_by: string | null } | null)?.created_by ?? null;
  if (r?.kind === "built" && builder && builder !== me.id && !me.isExec) return { ok: false, error: "Whoever built the report sets its dates." };
  const { setPeriod, regenerateNow } = await import("@/lib/reports/regenerate");
  const out = await setPeriod(admin, id, p, me.fullName);
  if (!out.ok) return { ok: false, error: out.error, ...(out.openId ? { openId: out.openId } : {}) };
  if (out.ids.length <= 2)
    after(async () => {
      await Promise.all(out.ids.map((x) => regenerateNow(admin, x)));
      await then?.(admin);
    });
  else after(() => draftQueued(admin, 200_000, { regenerated: true }));
  done(id);
  return { ok: true, label: rangeLabel(p, today) };
}

/** Asks the AI to change the report ("add lead quality", "shorter"); what the client always wants is remembered. */
export async function reviseWithAi(id: string, ask: string): Promise<Result<{ chat: ChatTurn[]; message: string; sections: Sections; qa: Qa | null; lesson: string | null; redrawing?: boolean; openId?: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (!ask.trim()) return { ok: false, error: "Say what to change." };
  // New dates for the whole report ("Nov 2 to 8", "last week"): the report's period moves and every page is redrawn
  // with fresh numbers (never just the first one); anything else asked for is done once it's redrawn
  const today = todayIn();
  const dates = ok.r.kind === "monthly" ? null : parseDates(ask, today);
  if (dates && !dates.compare) {
    const admin = createAdminClient();
    const { data: cur } = await admin.from("reports").select("chat, message, sections, qa, period_start, period_end").eq("id", id).single();
    const chat = (cur?.chat ?? []) as ChatTurn[];
    const at = new Date().toISOString();
    if (!dates.ok) return { ok: false, error: dates.error };
    const p = dates.period;
    const label = rangeLabel(p, today);
    const before = rangeLabel(previousPeriod(p), today);
    const rest = restOfAsk(ask, dates.matched).split(" ").filter(Boolean).length >= 1;
    const same = cur?.period_start === p.start && cur?.period_end === p.end;
    const reply = `${same ? "The report already covers" : "Moving the whole report to"} ${label} (against ${before}) and redrawing every page with fresh numbers: the tiles, tables, campaigns, top ads and charts.${rest ? " Then I'll make the rest of your change." : ""}`;
    const next: ChatTurn[] = [...chat, { role: "user" as const, text: ask.trim(), at, by: ok.me.fullName }, { role: "assistant" as const, text: reply, at }].slice(-40);
    await admin.from("reports").update({ chat: next }).eq("id", id);
    const moved = await movePeriod(id, ok.me, p, today, rest ? (a) => reviseReport(a, id, `The report has just been redrawn for ${label}. Now, from the buyer's message, everything except the dates: ${ask.trim().slice(0, 2000)}`, ok.me.fullName, { echo: false }).catch(() => null) : undefined);
    if (!moved.ok) {
      await admin.from("reports").update({ chat }).eq("id", id);
      return { ok: false, error: moved.error, ...(moved.openId ? { openId: moved.openId } : {}) };
    }
    return { ok: true, chat: next, message: (cur?.message as string) ?? "", sections: cur?.sections as Sections, qa: (cur?.qa as Qa | null) ?? null, lesson: null, redrawing: true };
  }
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
    // A buyer's own: the reports they own, and (a secondary buyer) the ones on the account they hold the seat on
    const own = r.owner_id === me.id || (!isExecOrLead(me) && t != null && (await canReportOn(db, me, t)));
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

/**
 * Weekly (or on demand): send it where the buyer picked, Slack as them, email to the people chosen (with the PDF), or
 * both, and remember that choice for this client. Monthly: submit your part (it goes out when every part is in).
 */
export async function sendReport(id: string, delivery?: Delivery, note?: string): Promise<Result<{ note: string; needsConnect?: boolean }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out. Resend it from the history." };
  if (ok.r.status === "skipped") return { ok: false, error: "It's skipped. Bring it back first." };
  const admin = createAdminClient();
  try {
    if (ok.r.kind !== "monthly") {
      const d = normalizeDelivery(delivery ?? null);
      if (d.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
      const out = await sendWeekly(admin, id, { id: ok.me.id, fullName: ok.me.fullName, email: ok.me.email }, d, note?.slice(0, 600) ?? null);
      if (!out.ok) return { ok: false, error: out.error ?? "It didn't go out.", ...(out.needsConnect ? { needsConnect: true } : {}) } as { ok: false; error: string };
      const { rememberDelivery, sentNote } = await import("@/lib/reports/send");
      await rememberDelivery(admin, ok.r.client_id as string, d, ok.me.id).catch(() => null);
      done(id);
      revalidatePath("/reports");
      return { ok: true, note: sentNote(out, "the client") };
    }
    // The recap goes where the buyer chose (kept on the recap for when the last part is in); no choice: Slack and email
    const d = delivery ? normalizeDelivery(delivery) : null;
    if (d?.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
    const out = await submitMonthly(admin, id, ok.me, d);
    if (d) await (await import("@/lib/reports/send")).rememberDelivery(admin, ok.r.client_id as string, d, ok.me.id).catch(() => null);
    done(id);
    const how = channelsPhrase(d?.channels ?? ["slack", "email"]);
    return { ok: true, note: out.sent ? `It went to the client ${how}.` : `Approved. It goes to the client ${how} as soon as ${out.waitingOn.join(" and ")} approve${out.waitingOn.length === 1 ? "s" : ""}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

/** Monthly: send my part to the client now instead of waiting on the other buyer (theirs follows on its own) */
export async function sendMyPartNow(id: string, delivery?: Delivery): Promise<Result<{ note: string }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.kind !== "monthly") return { ok: false, error: "Only a monthly recap has parts to wait on." };
  const d = delivery ? normalizeDelivery(delivery) : null;
  if (d?.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
  try {
    const { sendPartNow } = await import("@/lib/reports/run");
    const admin = createAdminClient();
    await sendPartNow(admin, id, ok.me, d);
    if (d) await (await import("@/lib/reports/send")).rememberDelivery(admin, ok.r.client_id as string, d, ok.me.id).catch(() => null);
    done(id);
    return { ok: true, note: "Sent to the client. The other part goes out on its own when its buyer approves it." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

/** Not this week (the account was paused, the client asked for no report…). */
/**
 * Writes a report's new status and appends to its log. The log column may not exist yet (the migration is applied
 * separately): then the status is still saved, just without the history.
 */
async function setSkipState(admin: ReturnType<typeof createAdminClient>, id: string, status: string, entry: LogEntry) {
  const now = new Date().toISOString();
  const { data, error } = await admin.from("reports").select("log").eq("id", id).maybeSingle();
  if (!error) {
    const { error: e2 } = await admin.from("reports").update({ status, updated_at: now, log: appendLog((data as { log?: unknown } | null)?.log, entry) }).eq("id", id);
    if (!e2) return;
  }
  await admin.from("reports").update({ status, updated_at: now }).eq("id", id);
}

/** The reports a skip or bring-back acts on: the report, or every part of a built report (one report, several services) */
async function skipTargets(id: string) {
  const ok = await mine(id);
  if (!ok) return null;
  const admin = createAdminClient();
  const { data: r } = await admin.from("reports").select("id, kind, status, bundle_id, period_end, sections, report_bundles(status)").eq("id", id).single();
  if (!r) return null;
  const sent = r.status === "posted" || (r.report_bundles as unknown as { status: string } | null)?.status === "sent";
  type Part = { id: string; kind: string; status: string; period_end: string; sections: unknown };
  const { data: parts } = r.kind === "built" && r.bundle_id ? await admin.from("reports").select("id, kind, status, period_end, sections").eq("bundle_id", r.bundle_id) : { data: null };
  // A Meta report with the TikTok part riding on it is one report: skipped and brought back together
  const { data: riders } = r.kind !== "built" ? await admin.from("reports").select("id, kind, status, period_end, sections").eq("joined_to", id) : { data: null };
  const rows = ((parts as Part[] | null) ?? [r as Part, ...((riders as Part[] | null) ?? [])]).slice(0, 12);
  // Who skipped each (the log column may not exist yet: then every skipped part counts)
  const { data: logs, error } = await admin.from("reports").select("id, log").in("id", rows.map((x) => x.id));
  const skippedBy = (partId: string) => (error ? true : Boolean(latestSkip(((logs ?? []) as { id: string; log: unknown }[]).find((l) => l.id === partId)?.log)));
  return { me: ok.me, admin, sent, rows, skippedBy };
}

/**
 * Skip a report: it leaves the queue and waits for the next period's report. Nothing is deleted; it stays in the
 * client's history, and the reason is logged on it. A report built by hand skips every part that hasn't gone out.
 */
export async function skipReport(id: string, reason: string, note?: string): Promise<Result> {
  if (!isSkipReason(reason)) return { ok: false, error: "Pick why you're skipping it." };
  const t = await skipTargets(id);
  if (!t) return { ok: false, error: "Not found." };
  if (t.sent) return { ok: false, error: "It's already gone to the client." };
  const open = t.rows.filter((x) => !["posted", "skipped"].includes(x.status));
  if (!open.length) return { ok: true };
  if (open.some((x) => ["queued", "drafting"].includes(x.status))) return { ok: false, error: "It's still being written. Try again in a moment." };
  const entry = skipEntry({ reason, note, by: t.me.id, byName: t.me.fullName });
  for (const x of open) await setSkipState(t.admin, x.id, "skipped", entry);
  done(id);
  return { ok: true };
}

/** Bring a skipped report back, while its next period isn't over: it's a draft again (or written again if it never was), logged. */
export async function unskipReport(id: string): Promise<Result> {
  const t = await skipTargets(id);
  if (!t) return { ok: false, error: "Not found." };
  if (t.sent) return { ok: false, error: "It's already gone to the client." };
  const today = nyParts(new Date()).date;
  // Only parts someone skipped (a part set aside by rebuilding stays out)
  const back = t.rows.filter((x) => x.status === "skipped" && (t.rows.length === 1 || t.skippedBy(x.id)));
  if (!back.length) return { ok: true };
  if (back.some((x) => !canBringBack(x.kind, x.period_end, today))) return { ok: false, error: "A newer report has taken its place, so this one can't be brought back." };
  if (back.some((x) => !x.sections && x.kind === "built")) return { ok: false, error: "It was never written. Build it again from Build a report." };
  const entry = unskipEntry({ by: t.me.id, byName: t.me.fullName });
  for (const x of back) await setSkipState(t.admin, x.id, x.sections ? "draft" : "queued", entry);
  if (back.some((x) => !x.sections)) after(() => draftQueued(t.admin, 200_000));
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
      .upsert({ client_id: t.client_id, target_id: t.id, platform: t.platform, kind: "custom", period_start: start, period_end: until, owner_id: t.owner_id ?? me.id, status: "drafting", posted_at: null, slack_ts: null, chat: [], hidden_at: null }, { onConflict: "target_id,kind,period_start" })
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
  // A TikTok account rides on its client's Meta report (weekly and monthly), as the scheduled ones do
  let join: { joined_to: string; owner_id: string | null } | null = null;
  if (t.platform === "tiktok") {
    const { data: metas } = await admin.from("kpi_targets").select("id, client_id, platform, owner_id").eq("client_id", t.client_id).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null);
    const j = (await tiktokJoinsFor(admin, [t, ...((metas ?? []) as typeof t[])])).get(t.id);
    const { data: host } = j ? await admin.from("reports").select("id").eq("target_id", j.metaTargetId).eq("kind", kind).eq("period_start", p.start).neq("status", "skipped").maybeSingle() : { data: null };
    if (j && host) join = { joined_to: host.id as string, owner_id: j.owner };
  }
  const { data: row } = await admin
    .from("reports")
    .upsert({ client_id: t.client_id, target_id: t.id, bundle_id: bundle, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id, status: "drafting", hidden_at: null, ...(join ?? {}) }, { onConflict: "target_id,kind,period_start" })
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
  // The TikTok part riding on it was approved with it: it goes back to review with it
  await admin.from("reports").update({ status: "draft", submitted_at: null, updated_at: new Date().toISOString() }).eq("joined_to", id).eq("status", "submitted");
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

/** The builder approves the message and where it goes (Slack, email or both): now, or as soon as the last part is approved. */
export async function approveBuiltMessage(bundleId: string, message: string, delivery?: Delivery): Promise<Result<{ sent: boolean; waitingOn: string[] }>> {
  const ok = await myBundle(bundleId);
  if (!ok) return { ok: false, error: "Not found." };
  const d = normalizeDelivery(delivery ?? null);
  if (d.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
  const { approveMessage } = await import("@/lib/reports/builder");
  try {
    const admin = createAdminClient();
    const out = await approveMessage(admin, bundleId, ok.me, message, d);
    const { data: b } = await admin.from("report_bundles").select("client_id").eq("id", bundleId).maybeSingle();
    if (b?.client_id) await (await import("@/lib/reports/send")).rememberDelivery(admin, b.client_id as string, d, ok.me.id).catch(() => null);
    revalidatePath("/reports");
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it." };
  }
}

/**
 * Takes a report off "Ready to send". Nothing is deleted: one not sent yet is set aside (skipped, every part of a
 * built report), one that was sent only leaves the list. Every report stays in the client's history.
 */
export async function removeGenerated(kind: "bundle" | "report", id: string): Promise<Result<{ deleted: boolean }>> {
  const me = await requireStaff();
  const db = await createClient();
  const admin = createAdminClient();
  const now = new Date().toISOString();
  if (kind === "bundle") {
    const { data: b } = await db.from("report_bundles").select("id, status, created_by").eq("id", id).eq("kind", "built").maybeSingle();
    if (!b) return { ok: false, error: "Not found." };
    if (b.created_by !== me.id && !me.isExec) return { ok: false, error: "Only whoever built it can remove it." };
    await admin.from("report_bundles").update({ hidden_at: now }).eq("id", id);
    if (b.status !== "sent") await admin.from("reports").update({ status: "skipped", hidden_at: now, updated_at: now }).eq("bundle_id", id).neq("status", "posted");
    revalidatePath("/reports");
    return { ok: true, deleted: false };
  }
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  await admin.from("reports").update(ok.r.status === "posted" ? { hidden_at: now } : { status: "skipped", hidden_at: now, updated_at: now }).eq("id", id);
  revalidatePath("/reports");
  return { ok: true, deleted: false };
}

// ─── Sent reports: the history, resend, duplicate ──────────────────────────────

/** A send in the history, if this person may see it: the report's account (any part's, for a built one) is theirs to report on */
async function mySend(sendId: string) {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(sendId)) return null;
  const db = await createClient();
  const admin = createAdminClient();
  const { data: s } = await admin.from("report_sends").select("id, client_id, report_id, bundle_id, kind, period_start, period_end").eq("id", sendId).maybeSingle();
  if (!s) return null;
  const q = admin.from("reports").select("owner_id, kpi_targets(id, client_id, platform, owner_id)");
  const { data: rows } = s.report_id ? await q.eq("id", s.report_id) : s.bundle_id ? await q.eq("bundle_id", s.bundle_id) : { data: [] };
  for (const r of rows ?? []) {
    const t = r.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
    if (r.owner_id === me.id || (t && (await canReportOn(db, me, t)))) return { me, s };
  }
  return null;
}

/** For the Resend sheet: the client's contacts and how the report went last time (its channels and recipients first) */
export async function deliveryForSend(sendId: string): Promise<Result<{ options: { contacts: { email: string; name?: string | null; primary: boolean }[]; initial: Delivery; slackChannel: boolean; emailReady: boolean } }>> {
  const ok = await mySend(sendId);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const { clientDelivery } = await import("@/lib/reports/send");
  const options = await clientDelivery(admin, ok.s.client_id as string);
  const { data: last } = await admin.from("report_sends").select("channels, email").eq("id", sendId).maybeSingle();
  const went = normalizeDelivery({ channels: last?.channels ?? [], recipients: ((last?.email as { to?: string[] } | null)?.to ?? []).map((email) => ({ email, name: options.contacts.find((c) => c.email === email)?.name ?? null })) }, options.initial);
  return { ok: true, options: { ...options, initial: went.channels.length ? { channels: went.channels, recipients: went.recipients.length ? went.recipients : options.initial.recipients } : options.initial } };
}

/** Sends a report again, exactly as it went, by the channel (or channels) and to the people picked now */
export async function resendReport(sendId: string, delivery: Delivery, note?: string): Promise<Result<{ note: string }>> {
  const ok = await mySend(sendId);
  if (!ok) return { ok: false, error: "Not found." };
  const d = normalizeDelivery(delivery);
  if (d.channels.includes("email") && !d.recipients.length) return { ok: false, error: "Add at least one email address to send it to." };
  try {
    const { resendReport: resend, sentNote } = await import("@/lib/reports/send");
    const out = await resend(createAdminClient(), sendId, { id: ok.me.id, fullName: ok.me.fullName, email: ok.me.email }, d, note?.slice(0, 600) ?? null);
    if (!out.ok) return { ok: false, error: out.error ?? "It didn't go out." };
    revalidatePath("/reports");
    if (ok.s.report_id) revalidatePath(`/reports/${ok.s.report_id}`);
    return { ok: true, note: sentNote(out, "the client") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it again." };
  }
}

/**
 * The same report for the period after (the next week, for a weekly): a fresh draft on the same account and layout,
 * written now, for review like any other. One already there is opened instead.
 */
export async function duplicateForNext(sendId: string): Promise<Result<{ id: string }>> {
  const ok = await mySend(sendId);
  if (!ok) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  const today = todayIn();
  const { s } = ok;
  if (!s.period_start || !s.period_end) return { ok: false, error: "This send has no dates to move on from." };
  const lastDay = (d: string) => shiftDay(`${shiftDay(`${d.slice(0, 8)}01`, 32).slice(0, 8)}01`, -1);
  // A month moves to the next month; anything else to the same number of days just after
  const next = s.kind === "monthly" ? (() => {
    const start = shiftDay(s.period_end as string, 1);
    const yesterday = shiftDay(today, -1);
    return start > yesterday ? null : { start, end: lastDay(start) > yesterday ? yesterday : lastDay(start) };
  })() : nextPeriod({ start: s.period_start as string, end: s.period_end as string }, today);
  if (!next) return { ok: false, error: "The next period isn't over yet: the data runs through yesterday." };
  if (s.bundle_id && s.kind === "built") {
    const { data: b } = await admin.from("report_bundles").select("client_id, services").eq("id", s.bundle_id).single();
    if (!b) return { ok: false, error: "Not found." };
    const out = await buildReportAction(b.client_id as string, [{ key: "custom", start: next.start, end: next.end }], (b.services ?? []) as string[]);
    return out.ok ? { ok: true, id: out.id } : out;
  }
  const reportId = s.report_id ?? (s.bundle_id ? ((await admin.from("reports").select("id").eq("bundle_id", s.bundle_id).limit(1).maybeSingle()).data?.id as string | undefined) : undefined);
  if (!reportId) return { ok: false, error: "Not found." };
  const { data: r } = await admin.from("reports").select("client_id, target_id, platform, kind, owner_id, layout").eq("id", reportId).single();
  if (!r) return { ok: false, error: "Not found." };
  const kind = r.kind === "weekly" ? "weekly" : "custom";
  const { data: was } = await admin.from("reports").select("id, status").eq("target_id", r.target_id).eq("kind", kind).eq("period_start", next.start).maybeSingle();
  if (was && was.status !== "skipped") return { ok: true, id: was.id as string };
  const { data: row, error } = await admin
    .from("reports")
    .upsert({ client_id: r.client_id, target_id: r.target_id, platform: r.platform, kind, period_start: next.start, period_end: next.end, owner_id: r.owner_id ?? ok.me.id, status: "drafting", layout: r.layout ?? null, posted_at: null, slack_ts: null, chat: [], hidden_at: null }, { onConflict: "target_id,kind,period_start" })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn't start it." };
  after(() => draftReport(admin, row.id));
  revalidatePath("/reports");
  return { ok: true, id: row.id as string };
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

/**
 * Results the team enters for the report's period from the client's own CRM (bookings and sales that never reach Meta
 * or Google). Saved on the report, so a regenerate keeps them, and merged into the report's numbers straight away: the
 * tiles, the PDF and the shared link follow. The written note follows at the next regenerate or when the AI is asked.
 * Who entered them and when are kept with them.
 */
export async function saveManualResults(id: string, lines: ManualLine[]): Promise<Result<{ lines: ManualLine[] }>> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  if (ok.r.status === "posted") return { ok: false, error: "It's already gone out." };
  if (ok.r.status === "queued" || ok.r.status === "drafting") return { ok: false, error: "It's being written right now. Add the results when it's done." };
  const admin = createAdminClient();
  const { data: row } = await admin.from("reports").select("period_start, period_end, metrics").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "Not found." };
  const clean = cleanLines(lines);
  const at = new Date().toISOString();
  const entered: ManualResults | null = clean.length ? { lines: clean, start: row.period_start as string, end: row.period_end as string, by: ok.me.id, byName: ok.me.fullName, at } : null;
  const update: Record<string, unknown> = { manual_results: entered, updated_at: at };
  if (row.metrics) update.metrics = applyManual(row.metrics as ReportMetrics, entered);
  const { error } = await admin.from("reports").update(update).eq("id", id);
  if (error) return { ok: false, error: error.message };
  done(id);
  return { ok: true, lines: clean };
}

/**
 * Save to Drive: the report as a PDF with the buyer's write-up as a last section ("Our notes"), in the client's Drive
 * (<client folder> / 30 - Reports / year / the month we're in). Saved again, it's a new version of the same file.
 * Anyone who may work on the report may save it, whatever its status (a report that's gone out is kept in Drive too).
 */
export async function saveToDrive(id: string): Promise<Result<{ save: DriveSave; newVersion: boolean; recorded: boolean }> & { fixHref?: string }> {
  const ok = await mine(id);
  if (!ok) return { ok: false, error: "Not found." };
  const { saveReportToDrive } = await import("@/lib/reports/drive-save");
  const r = await saveReportToDrive(createAdminClient(), id, { id: ok.me.id, fullName: ok.me.fullName });
  if (!r.ok) return r;
  done(id);
  return r;
}
