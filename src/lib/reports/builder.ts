import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { isExecOrLead, type Staff } from "@/lib/auth";
import { nyParts } from "@/lib/kpi/calc";
import { postAsApp, postAsUser } from "@/lib/slack-user";
import { canReportOn } from "./access";
import { renderReportPdf, type ReportPart } from "./pdf";
import type { ReportMetrics } from "./metrics";
import { draftReport, type Sections } from "./write";

// The report builder. Someone builds a report for a client: one or more date ranges (the last 7 days AND the month,
// say) and one or more services. Each service is a part, written by the AI for that service's buyer, who reviews and
// approves it (the person who built it gets theirs straight away; another buyer is asked for theirs). The builder
// approves the Slack message last. A report on one service goes out as its buyer; a joint one goes out once, from the
// Kaizen app: one message combining what each buyer said, and one PDF with the whole account and each service.

export const RANGES = [
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
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A range as dates (data runs through yesterday, New York). */
export function resolveRange(key: string, today = nyParts(new Date()).date, custom?: { start: string; end: string }): BuiltRange | null {
  const end = shift(today, -1);
  if (key === "last7") return { key, label: "Last 7 days", start: shift(end, -6), end };
  if (key === "last14") return { key, label: "Last 14 days", start: shift(end, -13), end };
  if (key === "last30") return { key, label: "Last 30 days", start: shift(end, -29), end };
  if (key === "mtd") {
    const start = `${today.slice(0, 8)}01`;
    // On the 1st there's nothing this month yet: the month just ended
    return start > end ? { key, label: monthName(end), start: `${end.slice(0, 8)}01`, end } : { key, label: `${monthName(today).split(" ")[0]} to date`, start, end };
  }
  if (key === "lastMonth") {
    const last = shift(`${today.slice(0, 8)}01`, -1);
    return { key, label: monthName(last), start: `${last.slice(0, 8)}01`, end: last };
  }
  if (key === "custom" && custom && /^\d{4}-\d{2}-\d{2}$/.test(custom.start) && /^\d{4}-\d{2}-\d{2}$/.test(custom.end) && custom.start <= custom.end && custom.start <= end)
    return { key, label: `${fmt(custom.start)} – ${fmt(custom.end > end ? end : custom.end)}`, start: custom.start, end: custom.end > end ? end : custom.end };
  return null;
}

export const rangesLabel = (ranges: BuiltRange[]) => ranges.map((r) => r.label).join(" + ");
const platformName = (p: string) => (p === "google" ? "Google Ads" : "Meta Ads");

/** Who writes and approves a service's part: the account's owner, else the client's buyer for it, else the builder. */
async function ownerFor(admin: SupabaseClient, t: { client_id: string; platform: string; owner_id: string | null }, fallback: string) {
  if (t.owner_id) return t.owner_id;
  const { data } = await admin.from("client_assignments").select("profile_id").eq("client_id", t.client_id).eq("role", t.platform === "google" ? "google_buyer" : "meta_buyer").maybeSingle();
  return (data?.profile_id as string | undefined) ?? fallback;
}

/** Builds a report: the parts are created and written in the background. Returns the bundle and the builder's own part. */
export async function buildReport(admin: SupabaseClient, db: SupabaseClient, me: Staff, clientId: string, ranges: BuiltRange[], platforms: string[]) {
  if (!ranges.length) throw new Error("Pick at least one date range.");
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
  const row = { client_id: clientId, kind: "built", period_start: main.start, period_end: main.end, ranges, services: [...new Set(targets.map((t) => t.platform))], created_by: me.id, status: "collecting", message: null, message_approved_at: null, message_approved_by: null, error: null };
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
  // Another buyer's part: they're asked for it
  const { data: client } = await admin.from("clients").select("name").eq("id", clientId).single();
  for (const p of parts.filter((x) => x.owner !== me.id))
    await admin.from("notifications").upsert(
      {
        profile_id: p.owner,
        kind: "report",
        title: `${me.fullName.split(" ")[0]} needs your ${platformName(p.platform)} part: ${client?.name ?? "a client"} report`,
        body: `${rangesLabel(ranges)}. It's drafted for you: read it, adjust it, approve it. It goes to the client together with the rest, as one report.`,
        href: `/reports/${p.id}`,
        client_id: clientId,
        key: `report-part:${p.id}:${main.start}`,
        priority: "critical",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  const mine = parts.find((p) => p.owner === me.id) ?? parts[0];
  return { bundleId: bundle.id as string, partIds: parts.map((p) => p.id), mineId: mine?.id ?? null };
}

/** Writes every part (in the background, after building). */
export async function draftParts(admin: SupabaseClient, ids: string[]) {
  await Promise.all(ids.map((id) => draftReport(admin, id)));
}

type Part = { id: string; platform: string; status: string; owner_id: string | null; message: string | null; sections: Sections | null; metrics: ReportMetrics | null; extra_metrics: ReportMetrics[] | null; extras: string | null; profiles: { full_name: string } | null };

async function loadParts(admin: SupabaseClient, bundleId: string) {
  const [{ data: b }, { data: parts }] = await Promise.all([
    admin.from("report_bundles").select("id, token, client_id, status, ranges, created_by, message, message_approved_at, clients(name, slack_channel_id)").eq("id", bundleId).single(),
    admin.from("reports").select("id, platform, status, owner_id, message, sections, metrics, extra_metrics, extras, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", bundleId).neq("status", "skipped"),
  ]);
  if (!b) throw new Error("Report not found");
  const sorted = ((parts ?? []) as unknown as Part[]).sort((a, c) => (a.platform === "meta" ? 0 : 1) - (c.platform === "meta" ? 0 : 1));
  return { b, parts: sorted, client: b.clients as unknown as { name: string; slack_channel_id: string | null }, ranges: (b.ranges ?? []) as BuiltRange[] };
}

/** The Slack message: one part's own message, or (joint) the parts' messages combined into one post from Kaizen. */
export async function composeMessage(admin: SupabaseClient, bundleId: string) {
  const { parts, client, ranges } = await loadParts(admin, bundleId);
  const ready = parts.filter((p) => p.message?.trim());
  if (!ready.length) return "";
  if (parts.length === 1) return ready[0].message!.trim();
  const out = await askJson<{ message: string }>({
    agent: "reporter",
    label: "joint report message",
    bare: true,
    maxTokens: 6000,
    system: `You combine the buyers' report messages for one client into a single Slack post that goes to the client's channel from Kaizen Marketing, with one PDF covering everything. Open with one or two lines on the whole account across the services. Then one short part per service under its bold name (*Meta Ads*, *Google Ads*), keeping each buyer's key numbers, what we did and what's next in their own words, shortened. Every number exactly as given; nothing new. Slack formatting: *bold* for headers, "• " for bullets, no # headings, no emojis unless the buyers used them. End with one line saying the full report is attached. Never mention anything internal (AI, Kaizen Ads, team members other than the client's own people).`,
    schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    prompt: `Client: ${client.name}\nPeriod: ${rangesLabel(ranges)}\n\n${ready.map((p) => `<message service="${platformName(p.platform)}" from="${p.profiles?.full_name ?? "the buyer"}">\n${p.message}\n</message>`).join("\n\n")}`,
  });
  return out.message.trim();
}

/** A buyer approves their part. When the builder already approved the message and every part is in, it goes out. */
export async function approvePart(admin: SupabaseClient, reportId: string, by: Staff) {
  const { data: r } = await admin.from("reports").select("id, bundle_id, platform, clients(name)").eq("id", reportId).single();
  if (!r?.bundle_id) throw new Error("This report isn't part of a built report.");
  await admin.from("reports").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", reportId);
  const { b, parts } = await loadParts(admin, r.bundle_id);
  const waiting = parts.filter((p) => p.status !== "submitted" && p.status !== "posted");
  // The builder hears that a part is in
  if (b.created_by && b.created_by !== by.id)
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

/** The builder approves the Slack message: it goes now if every part is in, otherwise as soon as the last one is. */
export async function approveMessage(admin: SupabaseClient, bundleId: string, by: Staff, message: string) {
  const text = message.trim().slice(0, 12000);
  if (!text) throw new Error("Write the message first.");
  const { b, parts } = await loadParts(admin, bundleId);
  if (b.created_by && b.created_by !== by.id && !by.isExec) throw new Error("The person who built the report approves its message.");
  await admin.from("report_bundles").update({ message: text, message_approved_at: new Date().toISOString(), message_approved_by: by.id, status: "waiting" }).eq("id", bundleId);
  const waiting = parts.filter((p) => p.status !== "submitted" && p.status !== "posted");
  if (waiting.length) return { sent: false, waitingOn: waiting.map((p) => `${p.profiles?.full_name ?? "the other buyer"} (${platformName(p.platform)})`) };
  await deliverBuilt(admin, bundleId, by.id);
  return { sent: true, waitingOn: [] as string[] };
}

/** The whole report as one PDF (a cover, the whole account when there's more than one service, then each). */
export async function builtPdf(admin: SupabaseClient, bundleId: string) {
  const { parts, client, ranges } = await loadParts(admin, bundleId);
  return renderReportPdf({
    client: client.name,
    kind: "built",
    periodLabel: rangesLabel(ranges),
    parts: parts.filter((p) => p.metrics && p.sections).map((p): ReportPart => ({ platform: p.platform === "google" ? "google" : "meta", buyer: p.profiles?.full_name ?? null, metrics: p.metrics!, sections: p.sections!, extras: p.extras, extra: p.extra_metrics })),
  });
}

/** Sends it: one service as its buyer (their Slack), a joint report from the Kaizen app. One message, one PDF. */
export async function deliverBuilt(admin: SupabaseClient, bundleId: string, by: string) {
  const { data: claimed } = await admin.from("report_bundles").update({ status: "sending" }).eq("id", bundleId).in("status", ["waiting", "collecting"]).select("id").maybeSingle();
  if (!claimed) return;
  try {
    const { b, parts, client, ranges } = await loadParts(admin, bundleId);
    if (!client.slack_channel_id) throw new Error("This client has no Slack channel set. Add it on the client page.");
    const bytes = await builtPdf(admin, bundleId);
    const label = rangesLabel(ranges);
    const pdf = { filename: `${client.name} - Report - ${label}.pdf`.replace(/[\\/:*?"<>|]/g, "-"), title: `${client.name} · Report · ${label}`, bytes };
    const text = b.message ?? "";
    const joint = parts.length > 1;
    let out: { ok: boolean; ts?: string; channel?: string; error?: string };
    if (!joint) out = await postAsUser(parts[0].owner_id ?? by, { channel: client.slack_channel_id, text, pdf });
    else out = await postAsApp({ channel: client.slack_channel_id, text, pdf });
    // Couldn't attach the PDF: the message still goes, from the app, with the link to the report
    if (!out.ok) out = await postAsApp({ channel: client.slack_channel_id, text: `${text}\n\nThe full report: ${SITE()}/r/${b.token}` });
    if (!out.ok) throw new Error(out.error ?? "Slack didn't take the message.");
    const now = new Date().toISOString();
    await admin.from("report_bundles").update({ status: "sent", sent_at: now, delivered: { slack: { channel: client.slack_channel_id, ts: out.ts, as: joint ? "app" : "buyer" } } }).eq("id", bundleId);
    await admin.from("reports").update({ status: "posted", posted_at: now, posted_by: by }).eq("bundle_id", bundleId).eq("status", "submitted");
    const owners = [...new Set([b.created_by, ...parts.map((p) => p.owner_id)].filter((x): x is string => Boolean(x)))];
    await admin.from("notifications").upsert(
      owners.map((id) => ({ profile_id: id, kind: "report", title: `${client.name} report sent`, body: `${label}${joint ? ", one message and one PDF for every service, from the Kaizen app" : ""}.`, href: `/reports/${parts.find((p) => p.owner_id === id)?.id ?? parts[0].id}`, client_id: b.client_id, key: `report-sent:${bundleId}`, priority: "normal" })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  } catch (e) {
    await admin.from("report_bundles").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400) }).eq("id", bundleId);
    throw e;
  }
}
