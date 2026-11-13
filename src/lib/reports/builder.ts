import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { isExecOrLead, type Staff } from "@/lib/auth";
import { nyParts } from "@/lib/kpi/calc";
import { canReportOn, reportListeners } from "./access";
import { buyerRole, primarySeat, withCoBuyers } from "@/lib/buyer-seats";
import { channelsLabel, normalizeDelivery, pdfFileName, type Delivery } from "./delivery-core";
import { isPeriodKey, periodMismatch, resolvePeriod } from "./period";
import { deliver } from "./send";
import { renderReportPdf, type ReportPart, type ReportPdfInput } from "./pdf";
import type { ReportMetrics } from "./metrics";
import type { ReportLayout } from "./format";
import { layoutOf } from "./share";
import { asKpiPlatform } from "@/lib/kpi/platform";
import { siteUrl } from "@/lib/site";
import { draftReport, type Sections } from "./write";
import { forClient, isWhiteLabel, WHITE_LABEL_RULE, whiteLabelFileName } from "./white-label";
import { openWithHere } from "./slack-text";

// The report builder. Someone builds a report for a client: one or more date ranges (the last 7 days AND the month,
// say) and one or more services. Each service is a part, written by the AI for that service's buyer, who reviews and
// approves it (the person who built it gets theirs straight away; another buyer is asked for theirs). The builder
// approves the Slack message last. A report on one service goes out as its buyer; a joint one goes out once, from the
// Kaizen app: one message combining what each buyer said, and one PDF with the whole account and each service.

export const RANGES = [
  { key: "lastWeek", label: "Last week" },
  { key: "last7", label: "Last 7 days" },
  { key: "last14", label: "Last 14 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "mtd", label: "Month to date" },
  { key: "lastMonth", label: "Last month" },
  { key: "custom", label: "Custom" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];
export type BuiltRange = { key: string; label: string; start: string; end: string };

const SITE = () => process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A range as dates (data runs through yesterday, New York): the same presets as a report's period picker. */
export function resolveRange(key: string, today = nyParts(new Date()).date, custom?: { start: string; end: string }): BuiltRange | null {
  const p = resolvePeriod(key === "mtd" ? "thisMonth" : isPeriodKey(key) ? key : "custom", today, key === "custom" ? custom : null);
  if (!p || (!isPeriodKey(key) && key !== "mtd")) return null;
  if (key === "lastWeek") return { key, label: `Week of ${fmt(p.start)}`, start: p.start, end: p.end };
  if (key === "mtd") return p.start === `${today.slice(0, 8)}01` ? { key, label: `${monthName(today).split(" ")[0]} to date`, start: p.start, end: p.end } : { key, label: monthName(p.end), start: p.start, end: p.end };
  if (key === "lastMonth") return { key, label: monthName(p.start), start: p.start, end: p.end };
  if (key === "custom") return { key, label: `${fmt(p.start)} – ${fmt(p.end)}`, start: p.start, end: p.end };
  return { key, label: p.label, start: p.start, end: p.end };
}

export const rangesLabel = (ranges: BuiltRange[]) => ranges.map((r) => r.label).join(" + ");
const platformName = (p: string) => (p === "google" ? "Google Ads" : p === "tiktok" ? "TikTok Ads" : "Meta Ads");
const partOrder = (p: string) => (p === "meta" ? 0 : p === "tiktok" ? 1 : 2);

/** Who writes and approves a service's part: the account's owner, else the client's buyer for it, else the builder. */
async function ownerFor(admin: SupabaseClient, t: { client_id: string; platform: string; owner_id: string | null }, fallback: string) {
  if (t.owner_id) return t.owner_id;
  // The seat's primary (a seat with a secondary too has two rows, which maybeSingle() read as none)
  return (await primarySeat(admin, t.client_id, buyerRole(t.platform))) ?? fallback;
}

/** Builds a report: the parts are created and written in the background. Returns the bundle and the builder's own part. */
export async function buildReport(admin: SupabaseClient, db: SupabaseClient, me: Staff, clientId: string, ranges: BuiltRange[], platforms: string[]) {
  if (!ranges.length) throw new Error("Pick a date range.");
  // One range per report (several made reports hard to read): only the first is used
  ranges = ranges.slice(0, 1);
  if (!platforms.length) throw new Error("Pick at least one service.");
  const { data: found } = await admin.from("kpi_targets").select("id, client_id, platform, owner_id").eq("client_id", clientId).eq("active", true).not("ad_account_id", "is", null).in("platform", platforms);
  const targets = found ?? [];
  if (!targets.length) throw new Error("No ad account with a KPI for those services. Set one on the KPI board.");
  // Anyone on one of the client's accounts can build it (and ask the other buyer for their part)
  let allowed = isExecOrLead(me);
  for (const t of targets) if (!allowed && (await canReportOn(db, me, t))) allowed = true;
  if (!allowed) throw new Error("You can only build reports for clients you work on.");

  const main = ranges[0];
  const { data: was } = await admin.from("report_bundles").select("id, status").eq("client_id", clientId).eq("kind", "built").eq("period_start", main.start).maybeSingle();
  if (was?.status === "sent") throw new Error(`A report starting ${fmt(main.start)} already went to this client. Pick different dates.`);
  const row = { client_id: clientId, kind: "built", period_start: main.start, period_end: main.end, ranges, services: [...new Set(targets.map((t) => t.platform))], created_by: me.id, status: "collecting", message: null, message_approved_at: null, message_approved_by: null, error: null, hidden_at: null };
  const { data: bundle, error } = was ? await admin.from("report_bundles").update(row).eq("id", was.id).select("id").single() : await admin.from("report_bundles").insert(row).select("id").single();
  if (error || !bundle) throw new Error(error?.message ?? "Couldn't start it.");
  // A rebuild: parts no longer asked for are set aside
  await admin.from("reports").update({ status: "skipped" }).eq("bundle_id", bundle.id).not("target_id", "in", `(${targets.map((t) => t.id).join(",")})`);

  const parts: { id: string; owner: string; platform: string }[] = [];
  for (const t of targets) {
    const owner = await ownerFor(admin, t, me.id);
    const { data: r } = await admin
      .from("reports")
      .upsert({ client_id: clientId, target_id: t.id, bundle_id: bundle.id, platform: t.platform, kind: "built", period_start: main.start, period_end: main.end, owner_id: owner, status: "drafting", message: null, sections: null, chat: [], qa: null, posted_at: null, submitted_at: null, slack_ts: null, error: null }, { onConflict: "target_id,kind,period_start" })
      .select("id")
      .single();
    if (r) parts.push({ id: r.id as string, owner, platform: t.platform });
  }
  // Another buyer's part: they're asked for it (only executives and media buyers hear about reports)
  const { data: client } = await admin.from("clients").select("name").eq("id", clientId).single();
  // The part's owner, with the client's secondary buyers on that platform copied in (never the builder themselves)
  const askOf = new Map<string, string[]>();
  for (const p of parts.filter((x) => x.owner !== me.id)) askOf.set(p.id, (await withCoBuyers(admin, clientId, p.platform, [p.owner])).filter((id) => id !== me.id));
  const askable = await reportListeners(admin, [...askOf.values()].flat());
  for (const p of parts.filter((x) => askOf.get(x.id)?.some((id) => askable.has(id))))
    await admin.from("notifications").upsert(
      askOf
        .get(p.id)!
        .filter((id) => askable.has(id))
        .map((id) => ({
          profile_id: id,
          kind: "report",
          title: `${me.fullName.split(" ")[0]} needs your ${platformName(p.platform)} part: ${client?.name ?? "a client"} report`,
          body: `${rangesLabel(ranges)}. It's drafted for you: read it, adjust it, approve it. It goes to the client together with the rest, as one report.`,
          href: `/reports/${p.id}`,
          client_id: clientId,
          key: `report-part:${p.id}:${main.start}`,
          priority: "critical",
        })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  const mine = parts.find((p) => p.owner === me.id) ?? parts[0];
  return { bundleId: bundle.id as string, partIds: parts.map((p) => p.id), mineId: mine?.id ?? null };
}

/** Writes every part (in the background, after building). */
export async function draftParts(admin: SupabaseClient, ids: string[]) {
  await Promise.all(ids.map((id) => draftReport(admin, id)));
}

type Part = { id: string; platform: string; status: string; owner_id: string | null; message: string | null; sections: Sections | null; metrics: ReportMetrics | null; extra_metrics: ReportMetrics[] | null; extras: string | null; layout: ReportLayout | null; kpi_targets: { report_layout: ReportLayout | null } | null; profiles: { full_name: string } | null };

async function loadParts(admin: SupabaseClient, bundleId: string) {
  const [{ data: b }, { data: parts }] = await Promise.all([
    admin.from("report_bundles").select("id, token, client_id, status, ranges, created_by, message, message_approved_at, clients(name, slack_channel_id, slug, portal_live, client_type)").eq("id", bundleId).single(),
    admin.from("reports").select("id, platform, status, owner_id, message, sections, metrics, extra_metrics, extras, layout, kpi_targets(report_layout), profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", bundleId).neq("status", "skipped"),
  ]);
  if (!b) throw new Error("Report not found");
  const sorted = ((parts ?? []) as unknown as Part[]).sort((a, c) => partOrder(a.platform) - partOrder(c.platform));
  const client = b.clients as unknown as { name: string; slack_channel_id: string | null; slug?: string; portal_live?: boolean; client_type?: string | null };
  return { b, parts: sorted, client, ranges: (b.ranges ?? []) as BuiltRange[], whiteLabel: isWhiteLabel(client.client_type) };
}

/** The Slack message: one part's own message, or (joint) the parts' messages combined into one post from Kaizen. */
export async function composeMessage(admin: SupabaseClient, bundleId: string) {
  const { parts, client, ranges, whiteLabel } = await loadParts(admin, bundleId);
  const ready = parts.filter((p) => p.message?.trim());
  if (!ready.length) return "";
  if (parts.length === 1) return openWithHere(forClient(ready[0].message!.trim(), whiteLabel));
  const out = await askJson<{ message: string }>({
    agent: "reporter",
    label: "joint report message",
    bare: true,
    maxTokens: 6000,
    system: `${whiteLabel ? `You combine the buyers' report messages for one client into a single Slack post that goes to the client's channel, with one PDF covering everything. ${WHITE_LABEL_RULE}` : "You combine the buyers' report messages for one client into a single Slack post that goes to the client's channel from Kaizen Marketing, with one PDF covering everything."} Open with <!here> (Slack's @here, written exactly like that), never a person's mention, then one or two lines on the whole account across the services. Then one short part per service under its bold name (*Meta Ads*, *TikTok Ads*, *Google Ads*), keeping each buyer's key numbers, what we did and what's next in their own words, shortened. Every number exactly as given; nothing new. Slack formatting: *bold* for headers, "• " for bullets, no # headings, no emojis unless the buyers used them. End with one line saying the full report is attached. Never mention anything internal (AI, Kaizen Ads, team members other than the client's own people).`,
    schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    prompt: `Client: ${client.name}\nPeriod: ${rangesLabel(ranges)}\n\n${ready.map((p) => `<message service="${platformName(p.platform)}" from="${p.profiles?.full_name ?? "the buyer"}">\n${p.message}\n</message>`).join("\n\n")}`,
  });
  // The backstop: a white label client's message never names the agency, whatever the AI wrote
  return openWithHere(forClient(out.message.trim(), whiteLabel));
}

/** A buyer approves their part. When the builder already approved the message and every part is in, it goes out. */
export async function approvePart(admin: SupabaseClient, reportId: string, by: Staff) {
  const { data: r } = await admin.from("reports").select("id, bundle_id, platform, clients(name)").eq("id", reportId).single();
  if (!r?.bundle_id) throw new Error("This report isn't part of a built report.");
  await admin.from("reports").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", reportId);
  const { b, parts } = await loadParts(admin, r.bundle_id);
  const waiting = parts.filter((p) => p.status !== "submitted" && p.status !== "posted");
  // The builder hears that a part is in
  if (b.created_by && b.created_by !== by.id && (await reportListeners(admin, [b.created_by])).has(b.created_by))
    await admin.from("notifications").upsert(
      {
        profile_id: b.created_by,
        kind: "report",
        title: `${by.fullName.split(" ")[0]} approved the ${platformName(r.platform)} part: ${(r.clients as unknown as { name: string }).name} report`,
        body: waiting.length ? "Still waiting on the rest." : b.message_approved_at ? "Every part is in: it's going to the client now." : "Every part is in: approve the Slack message and it goes out.",
        href: `/reports/${parts.find((p) => p.owner_id === b.created_by)?.id ?? reportId}`,
        client_id: b.client_id,
        key: `report-part-in:${reportId}`,
        priority: "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  if (!waiting.length && b.message_approved_at && b.status === "waiting") {
    await deliverBuilt(admin, r.bundle_id, b.created_by ?? by.id);
    return { sent: true, waitingOn: [] as string[] };
  }
  return { sent: false, waitingOn: waiting.map((p) => `${p.profiles?.full_name ?? "the other buyer"} (${platformName(p.platform)})`) };
}

/**
 * The builder approves the message and where it goes (Slack, email or both): it goes now if every part is in,
 * otherwise as soon as the last one is.
 */
export async function approveMessage(admin: SupabaseClient, bundleId: string, by: Staff, message: string, delivery: Delivery = { channels: ["slack"], recipients: [] }) {
  const text = message.trim().slice(0, 12000);
  if (!text && delivery.channels.includes("slack")) throw new Error("Write the message first.");
  const { b, parts } = await loadParts(admin, bundleId);
  if (b.created_by && b.created_by !== by.id && !by.isExec) throw new Error("The person who built the report approves its message.");
  await admin.from("report_bundles").update({ message: text, message_approved_at: new Date().toISOString(), message_approved_by: by.id, status: "waiting" }).eq("id", bundleId);
  const { error } = await admin.from("report_bundles").update({ delivery }).eq("id", bundleId);
  if (error && !delivery.channels.every((c) => c === "slack")) throw new Error("Email for built reports needs the latest database update. Send it by Slack for now.");
  const waiting = parts.filter((p) => p.status !== "submitted" && p.status !== "posted");
  if (waiting.length) return { sent: false, waitingOn: waiting.map((p) => `${p.profiles?.full_name ?? "the other buyer"} (${platformName(p.platform)})`) };
  await deliverBuilt(admin, bundleId, by.id);
  return { sent: true, waitingOn: [] as string[] };
}

/** The whole report as one PDF (the whole account when there's more than one service, then a section each). */
export async function builtPdf(admin: SupabaseClient, bundleId: string, edit = false) {
  return renderReportPdf(await builtInput(admin, bundleId, edit));
}

/** The whole report's file name, as it goes out (a white label client's names no agency) */
export async function builtFileName(admin: SupabaseClient, bundleId: string) {
  const { client, ranges, whiteLabel } = await loadParts(admin, bundleId);
  const label = rangesLabel(ranges);
  return whiteLabel ? whiteLabelFileName(client.name, "built", label) : pdfFileName(client.name, "Report", label);
}

/** The whole report's document input (every part), for the PDF and the studio's preview */
export async function builtInput(admin: SupabaseClient, bundleId: string, edit = false): Promise<ReportPdfInput> {
  const { parts, client, ranges, whiteLabel } = await loadParts(admin, bundleId);
  const { data: who } = await admin.from("report_bundles").select("client_id").eq("id", bundleId).maybeSingle();
  return {
    client: client.name,
    clientId: (who?.client_id as string | undefined) ?? null,
    kind: "built",
    periodLabel: rangesLabel(ranges),
    parts: parts.filter((p) => p.metrics && p.sections).map((p): ReportPart => ({ platform: asKpiPlatform(p.platform), buyer: p.profiles?.full_name ?? null, metrics: p.metrics!, sections: p.sections!, extras: p.extras, extra: p.extra_metrics, layout: layoutOf(p) })),
    edit,
    dashboard: client.portal_live && client.slug && !whiteLabel ? `${siteUrl()}/c/${client.slug}/dashboard` : null,
    whiteLabel,
  };
}

/**
 * Sends it where the builder chose (Slack, email or both; kept on the bundle when the message was approved): in Slack,
 * one service as its buyer, a joint report from the Kaizen app; by email from the agency, replies to the builder. One
 * message, one PDF, and the send kept in the history.
 */
export async function deliverBuilt(admin: SupabaseClient, bundleId: string, by: string) {
  const { data: claimed } = await admin.from("report_bundles").update({ status: "sending" }).eq("id", bundleId).in("status", ["waiting", "collecting"]).select("id").maybeSingle();
  if (!claimed) return;
  try {
    const { b, parts, client, ranges, whiteLabel } = await loadParts(admin, bundleId);
    const { data: chosen } = await admin.from("report_bundles").select("delivery").eq("id", bundleId).maybeSingle().then((r) => (r.error ? { data: null } : r));
    const delivery = normalizeDelivery(chosen?.delivery ?? null);
    if (delivery.channels.includes("slack") && !client.slack_channel_id) throw new Error("This client has no Slack channel set. Add it on the client page, or send it by email.");
    // Every part drawn for the report's dates (a part redrawn for other dates can't go out with the rest)
    const main = ranges[0];
    const stale = main ? parts.filter((p) => periodMismatch(main, p.metrics, p.sections).length) : [];
    if (stale.length) throw new Error(`The ${stale.map((p) => platformName(p.platform)).join(" and ")} part isn't for ${main.label} yet. Regenerate it first.`);
    const bytes = await builtPdf(admin, bundleId);
    const label = rangesLabel(ranges);
    const pdf = { filename: whiteLabel ? whiteLabelFileName(client.name, "built", label) : pdfFileName(client.name, "Report", label), title: `${client.name} · Report · ${label}`, bytes };
    const joint = parts.length > 1;
    const { data: me } = await admin.from("profiles").select("full_name, email").eq("id", by).maybeSingle();
    const out = await deliver(admin, {
      client: { id: b.client_id as string, ...client },
      kind: "built",
      platform: joint ? null : parts[0].platform,
      period: { start: main?.start ?? null, end: main?.end ?? null, label },
      message: b.message ?? "",
      pdf,
      parts: parts.map((p) => ({ platform: asKpiPlatform(p.platform), metrics: p.metrics, sections: p.sections })),
      by: { id: by, fullName: (me?.full_name as string | null) ?? "Kaizen", email: (me?.email as string | null) ?? null },
      delivery,
      slackAs: joint ? "app" : "user",
      slackUserId: joint ? null : (parts[0].owner_id ?? by),
      // Couldn't post as the buyer: the message still goes, from the app, with the link to the report (never for a white
      // label client: that page is the agency's)
      appFallback: whiteLabel ? "" : `\n\nThe full report: ${SITE()}/r/${b.token}`,

      bundleId,
      reportId: joint ? null : parts[0].id,
      owners: parts.map((p) => p.owner_id),
    });
    if (!out.ok) throw new Error(out.error ?? "It didn't go out.");
    const now = new Date().toISOString();
    await admin.from("report_bundles").update({ status: "sent", sent_at: now, delivered: { ...(out.slack && "channel" in out.slack ? { slack: out.slack } : {}), ...(out.email?.to.length ? { email: out.email.to } : {}) } }).eq("id", bundleId);
    await admin.from("reports").update({ status: "posted", posted_at: now, posted_by: by }).eq("bundle_id", bundleId).eq("status", "submitted");
    // The automatic weekly or monthly on the same accounts and dates was covered by this one: set aside, logged
    await coverScheduled(admin, bundleId, by, (me?.full_name as string | null) ?? null).catch(() => {});
    // The builder and each part's owner, with the client's secondary buyers on those platforms copied in
    const co = (await Promise.all(parts.map((p) => withCoBuyers(admin, b.client_id as string, p.platform, [p.owner_id])))).flat();
    const told = await reportListeners(admin, [b.created_by, ...parts.map((p) => p.owner_id), ...co]);
    const owners = [...told];
    if (owners.length)
      await admin.from("notifications").upsert(
        owners.map((id) => ({ profile_id: id, kind: "report", title: `${client.name} report sent`, body: `${label}, by ${channelsLabel(out.went).toLowerCase()}${joint && out.went.includes("slack") ? " (one message and one PDF for every service, from the Kaizen app)" : ""}.`, href: `/reports/${parts.find((p) => p.owner_id === id)?.id ?? parts[0].id}`, client_id: b.client_id, key: `report-sent:${bundleId}`, priority: "normal" })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  } catch (e) {
    await admin.from("report_bundles").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400) }).eq("id", bundleId);
    throw e;
  }
}

/**
 * A report sent from the builder covers the automatic one for the same account and overlapping dates (a buyer who
 * builds their own week instead of the Monday draft): that draft is set aside as skipped, with a log entry saying
 * why, so it stops asking to be reviewed. Nothing is deleted; it can be brought back.
 */
export async function coverScheduled(admin: SupabaseClient, bundleId: string, by: string | null, byName: string | null) {
  const { data: parts } = await admin.from("reports").select("target_id, period_start, period_end").eq("bundle_id", bundleId).eq("status", "posted");
  const { skipEntry, appendLog } = await import("./skip-log");
  for (const p of parts ?? []) {
    const { data: open } = await admin
      .from("reports")
      .select("id, kind, period_start, period_end, log")
      .eq("target_id", p.target_id)
      .in("kind", ["weekly", "monthly"])
      .not("status", "in", "(posted,skipped)")
      .lte("period_start", p.period_end)
      .gte("period_end", p.period_start);
    for (const r of (open ?? []).filter((x) => coveredBy(x, p))) {
      const entry = skipEntry({ reason: "Sent as a built report", note: null, by, byName });
      await admin.from("reports").update({ status: "skipped", log: appendLog((r as { log?: unknown }).log, entry), updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
}

const dayN = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);
/** A weekly is covered when most of its week (4 days or more) is in the sent report; a monthly only when all of it is */
export function coveredBy(r: { kind: string; period_start: string; period_end: string }, sent: { period_start: string; period_end: string }) {
  const overlap = Math.min(dayN(r.period_end), dayN(sent.period_end)) - Math.max(dayN(r.period_start), dayN(sent.period_start)) + 1;
  if (r.kind === "monthly") return sent.period_start <= r.period_start && sent.period_end >= r.period_end;
  return overlap >= 4;
}
