import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportMetrics } from "./metrics";
import type { Sections } from "./write";
import type { ReportPart } from "./pdf";
import { monthLabel, platformName, shortRange } from "./format";

// Loading a report (or a client's monthly bundle) for reading: the PDF, and the live report page the client opens from
// the link. Read-only. A bundle only shows the reports the buyers have finished (submitted or posted).

const REPORT_FIELDS = "id, client_id, platform, kind, period_start, period_end, status, metrics, extra_metrics, sections, extras, clients(name, slug), profiles!reports_owner_id_fkey(full_name)";

type Row = {
  id: string;
  platform: string;
  kind: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  status: string;
  metrics: ReportMetrics | null;
  extra_metrics?: ReportMetrics[] | null;
  sections: Sections | null;
  extras: string | null;
  clients: { name: string; slug: string } | null;
  profiles: { full_name: string | null } | null;
};

const toPart = (r: Row): ReportPart | null =>
  r.metrics && r.sections ? { platform: r.platform === "google" ? "google" : "meta", buyer: r.profiles?.full_name ?? null, metrics: r.metrics, sections: r.sections, extras: r.extras, extra: r.extra_metrics ?? null } : null;

const order = (p: ReportPart) => (p.platform === "meta" ? 0 : 1);

/** One report, ready for the PDF, with its file name ("OceanBox - Meta weekly - Oct 12-18.pdf"). */
export async function loadReport(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("reports").select(REPORT_FIELDS).eq("id", id).maybeSingle();
  const r = data as unknown as Row | null;
  if (!r) return null;
  const part = toPart(r);
  if (!part) return null;
  const client = r.clients?.name ?? "Client";
  const periodLabel = r.kind === "monthly" ? monthLabel(r.period_start) : part.metrics.main.label;
  const short = r.kind === "monthly" ? monthLabel(r.period_start) : shortRange(r.period_start, r.period_end);
  const fileName = `${client} - ${platformName(part.platform).replace(" Ads", "")} ${r.kind} - ${short}.pdf`;
  return { input: { client, kind: r.kind, periodLabel, parts: [part] }, fileName };
}

/** A client's monthly bundle by its share token: the finished reports in it, Meta first. */
export async function loadBundle(admin: SupabaseClient, token: string) {
  if (!/^[\w-]{16,80}$/.test(token)) return null;
  const { data: bundle } = await admin.from("report_bundles").select("id, client_id, kind, period_start, period_end, status, sent_at, ranges, clients(name, slug)").eq("token", token).maybeSingle();
  if (!bundle) return null;
  const client = (bundle.clients as unknown as { name: string } | null)?.name ?? "Client";
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
    input: { client, kind: built ? ("built" as const) : ("monthly" as const), periodLabel, parts },
    fileName: `${client} - ${built ? "Report" : "Monthly recap"} - ${periodLabel}.pdf`,
  };
}
