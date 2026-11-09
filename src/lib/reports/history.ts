import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel } from "./delivery-core";
import { rangeLabel } from "./period";

// The send history, read for the Reports page (every client, or one) and for a report's own page: each send with its
// client, who sent it, where it went and to whom. Read with the admin client after the caller has decided what this
// person may see (their clients, or everything for an exec).

const FIELDS = "id, client_id, report_id, bundle_id, kind, platform, period_start, period_end, period_label, sent_by, sent_at, channels, email, status, resend_of, clients(name)";

type Row = {
  id: string;
  client_id: string;
  report_id: string | null;
  bundle_id: string | null;
  kind: string;
  platform: string | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  sent_by: string | null;
  sent_at: string;
  channels: string[] | null;
  email: { to?: string[]; failed?: { email: string }[] } | null;
  status: string;
  resend_of: string | null;
  clients: { name: string } | null;
};

export type HistoryRow = {
  id: string;
  clientId: string;
  client: string;
  kind: string;
  platform: string | null;
  periodLabel: string;
  sentAt: string;
  sentBy: string | null;
  channels: Channel[];
  to: string[];
  failed: string[];
  status: string;
  resent: boolean;
  reviewHref: string | null;
};

/** Sends, newest first: for some clients (null: all), or one report or bundle */
export async function readHistory(admin: SupabaseClient, scope: { clientIds?: string[] | null; reportId?: string | null; bundleId?: string | null; limit?: number }, today: string): Promise<HistoryRow[]> {
  let q = admin.from("report_sends").select(FIELDS).order("sent_at", { ascending: false }).limit(scope.limit ?? 200);
  if (scope.reportId && scope.bundleId) q = q.or(`report_id.eq.${scope.reportId},bundle_id.eq.${scope.bundleId}`);
  else if (scope.reportId) q = q.eq("report_id", scope.reportId);
  else if (scope.bundleId) q = q.eq("bundle_id", scope.bundleId);
  if (scope.clientIds) q = q.in("client_id", scope.clientIds.length ? scope.clientIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data, error } = await q;
  // Before its migration: no history yet, rather than a broken page
  if (error) return [];
  const rows = (data ?? []) as unknown as Row[];
  const people = [...new Set(rows.map((r) => r.sent_by).filter((x): x is string => Boolean(x)))];
  const { data: names } = people.length ? await admin.from("profiles").select("id, full_name").in("id", people) : { data: [] as { id: string; full_name: string | null }[] };
  const nameOf = new Map((names ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? null]));
  // A built report opens at one of its parts
  const bundles = [...new Set(rows.filter((r) => !r.report_id && r.bundle_id).map((r) => r.bundle_id as string))];
  const { data: parts } = bundles.length ? await admin.from("reports").select("id, bundle_id").in("bundle_id", bundles).neq("status", "skipped") : { data: [] as { id: string; bundle_id: string }[] };
  const partOf = new Map((parts ?? []).map((p) => [p.bundle_id as string, p.id as string]));
  return rows.map((r) => {
    const open = r.report_id ?? (r.bundle_id ? partOf.get(r.bundle_id) : null) ?? null;
    return {
      id: r.id,
      clientId: r.client_id,
      client: r.clients?.name ?? "Client",
      kind: r.kind,
      platform: r.platform,
      periodLabel: r.period_label ?? (r.period_start && r.period_end ? rangeLabel({ start: r.period_start, end: r.period_end }, today) : ""),
      sentAt: r.sent_at,
      sentBy: r.sent_by ? (nameOf.get(r.sent_by) ?? null) : null,
      channels: (r.channels ?? []).filter((c): c is Channel => c === "slack" || c === "email"),
      to: r.email?.to ?? [],
      failed: (r.email?.failed ?? []).map((f) => f.email).filter(Boolean),
      status: r.status,
      resent: Boolean(r.resend_of),
      reviewHref: open ? `/reports/${open}` : null,
    };
  });
}
