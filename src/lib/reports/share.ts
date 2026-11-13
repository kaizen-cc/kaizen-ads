import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportMetrics } from "./metrics";
import type { Sections } from "./write";
import type { ReportPart } from "./pdf";
import { monthLabel, platformName, shortRange, type ReportLayout } from "./format";
import { siteUrl } from "@/lib/site";
import { isWhiteLabel, whiteLabelFileName } from "./white-label";

// Loading a report (or a client's monthly bundle) for reading: the PDF, and the live report page the client opens from
// the link. Read-only. A bundle only shows the reports the buyers have finished (submitted or posted).

const REPORT_FIELDS = "id, client_id, platform, kind, period_start, period_end, status, metrics, extra_metrics, sections, extras, layout, kpi_targets(report_layout), clients(name, slug, portal_live, client_type), profiles!reports_owner_id_fkey(full_name)";

type Row = {
  id: string;
  client_id: string;
  platform: string;
  kind: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  status: string;
  metrics: ReportMetrics | null;
  extra_metrics?: ReportMetrics[] | null;
  sections: Sections | null;
  extras: string | null;
  layout?: ReportLayout | null;
  kpi_targets?: { report_layout: ReportLayout | null } | null;
  clients: { name: string; slug: string; portal_live?: boolean; client_type?: string | null } | null;
  profiles: { full_name: string | null } | null;
};

const toPart = (r: Row): ReportPart | null =>
  r.metrics && r.sections ? { platform: r.platform === "google" ? "google" : r.platform === "tiktok" ? "tiktok" : "meta", buyer: r.profiles?.full_name ?? null, metrics: r.metrics, sections: r.sections, extras: r.extras, extra: r.extra_metrics ?? null, layout: layoutOf(r) } : null;

/** The buyer's layout for this report, else (while it's still being worked on) the one this client's last report used */
export const layoutOf = (r: { status: string; layout?: ReportLayout | null; kpi_targets?: { report_layout: ReportLayout | null } | null }) =>
  r.layout ?? (["submitted", "posted"].includes(r.status) ? null : (r.kpi_targets?.report_layout ?? null));

const order = (p: ReportPart) => (p.platform === "meta" ? 0 : p.platform === "tiktok" ? 1 : 2);

/** One report, ready for the PDF, with its file name ("OceanBox - Meta weekly - Oct 12-18.pdf"). */
export async function loadReport(admin: SupabaseClient, id: string, edit = false) {
  const { data } = await admin.from("reports").select(REPORT_FIELDS).eq("id", id).maybeSingle();
  const r = data as unknown as Row | null;
  if (!r) return null;
  const part = toPart(r);
  if (!part) return null;
  const client = r.clients?.name ?? "Client";
  const periodLabel = r.kind === "monthly" ? monthLabel(r.period_start) : part.metrics.main.label;
  const short = r.kind === "monthly" ? monthLabel(r.period_start) : shortRange(r.period_start, r.period_end);
  // A white label client's: generic, no agency anywhere (and no link to the agency's portal)
  const whiteLabel = isWhiteLabel(r.clients?.client_type);
  const fileName = whiteLabel ? whiteLabelFileName(client, r.kind, short, platformName(part.platform)) : `${client} - ${platformName(part.platform).replace(" Ads", "")} ${(r.kind as string) === "built" ? "report" : r.kind} - ${short}.pdf`;
  const dashboard = r.clients?.portal_live && !whiteLabel ? `${siteUrl()}/c/${r.clients.slug}/dashboard` : null;
  // A Meta report (weekly or monthly) carries the TikTok part that rides with it (one document, a section each), as it's sent
  const parts = [part];
  if (r.kind === "weekly" || r.kind === "monthly") {
    const { data: riders } = await admin.from("reports").select(REPORT_FIELDS).eq("joined_to", id).neq("status", "skipped");
    for (const x of (riders ?? []) as unknown as Row[]) {
      const p = toPart(x);
      if (p) parts.push(p);
    }
    parts.sort((a, b) => order(a) - order(b));
  }
  const joint = parts.length > 1;
  const name = joint ? whiteLabel ? whiteLabelFileName(client, r.kind, short, "Meta + TikTok") : `${client} - Meta + TikTok ${r.kind} - ${short}.pdf` : fileName;
  // An on-demand recap goes out as a weekly does (its dates against the days before), so it's drawn as one here too
  const kind = (r.kind as string) === "custom" ? ("weekly" as const) : r.kind;
  return { input: { client, clientId: r.client_id, kind, periodLabel, parts, edit, dashboard, whiteLabel }, fileName: name };
}

/** A client's monthly bundle by its share token: the finished reports in it, Meta first. */
export async function loadBundle(admin: SupabaseClient, token: string) {
  if (!/^[\w-]{16,80}$/.test(token)) return null;
  const { data: bundle } = await admin.from("report_bundles").select("id, client_id, kind, period_start, period_end, status, sent_at, ranges, clients(name, slug, client_type)").eq("token", token).maybeSingle();
  if (!bundle) return null;
  const client = (bundle.clients as unknown as { name: string } | null)?.name ?? "Client";
  const whiteLabel = isWhiteLabel((bundle.clients as unknown as { client_type?: string | null } | null)?.client_type);
  const built = bundle.kind === "built";
  const periodLabel = built ? ((bundle.ranges ?? []) as { label: string }[]).map((r) => r.label).join(" + ") : monthLabel(bundle.period_start);
  const { data } = await admin.from("reports").select(REPORT_FIELDS).eq("bundle_id", bundle.id).in("status", ["submitted", "posted"]);
  const parts = ((data ?? []) as unknown as Row[])
    .map(toPart)
    .filter((p): p is ReportPart => p !== null)
    .sort((a, b) => order(a) - order(b));
  return {
    ready: bundle.status === "sent",
    client,
    periodLabel,
    title: built ? "Report" : "Monthly recap",
    whiteLabel,
    input: { client, clientId: bundle.client_id as string, kind: built ? ("built" as const) : ("monthly" as const), periodLabel, parts, whiteLabel },
    fileName: whiteLabel ? whiteLabelFileName(client, built ? "built" : "monthly", periodLabel) : `${client} - ${built ? "Report" : "Monthly recap"} - ${periodLabel}.pdf`,
  };
}
