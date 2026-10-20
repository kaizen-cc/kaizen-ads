import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { slackConnection } from "@/lib/slack-user";
import { ReportEditor, type BundlePart } from "../report-parts";

export const metadata: Metadata = { title: "Report" };
// Revising and checking a report, and posting it with its PDF, can take a minute
export const maxDuration = 300;

export default async function ReportPage({ params }: PageProps<"/reports/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  const db = await createClient();
  const { data: r } = await db
    .from("reports")
    .select("id, kind, platform, status, period_start, period_end, owner_id, bundle_id, message, sections, metrics, extras, qa, chat, error, posted_at, slack_channel, clients(name, slug, slack_channel_id), profiles!reports_owner_id_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!r) notFound();
  const canEdit = r.owner_id === me.id || isExecOrLead(me);
  const [slack, parts] = await Promise.all([
    slackConnection(me.id),
    r.bundle_id ? db.from("reports").select("id, platform, status, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", r.bundle_id) : Promise.resolve({ data: [] }),
  ]);
  const { data: bundle } = r.bundle_id ? await db.from("report_bundles").select("status, token, sent_at").eq("id", r.bundle_id).maybeSingle() : { data: null };
  const client = r.clients as unknown as { name: string; slug: string; slack_channel_id: string | null };

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <Link href="/reports" className="text-xs text-muted hover:text-fg">
        ← Reports
      </Link>
      <ReportEditor
        report={{
          id: r.id,
          kind: r.kind as "weekly" | "monthly" | "custom",
          platform: r.platform as "meta" | "google",
          status: r.status,
          periodStart: r.period_start,
          periodEnd: r.period_end,
          message: r.message ?? "",
          sections: (r.sections as Sections | null) ?? null,
          metrics: (r.metrics as ReportMetrics | null) ?? null,
          extras: r.extras ?? "",
          qa: (r.qa as Qa | null) ?? null,
          chat: (r.chat ?? []) as ChatTurn[],
          error: r.error,
          postedAt: r.posted_at,
          owner: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        }}
        client={{ name: client.name, slug: client.slug, hasChannel: Boolean(client.slack_channel_id) }}
        canEdit={canEdit}
        slackConnected={slack.connected}
        bundle={bundle ? { status: bundle.status, link: `/r/${bundle.token}`, sentAt: bundle.sent_at } : null}
        parts={((parts.data ?? []) as { id: string; platform: string; status: string; profiles: unknown }[]).map((p): BundlePart => ({ id: p.id, platform: p.platform, status: p.status, owner: (p.profiles as { full_name: string } | null)?.full_name ?? null }))}
      />
    </div>
  );
}
