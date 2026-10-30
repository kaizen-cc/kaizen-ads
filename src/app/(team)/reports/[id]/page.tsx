import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { canReportOn } from "@/lib/reports/access";
import { createClient } from "@/lib/supabase/server";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { monthLabel } from "@/lib/reports/format";
import { slackConnection, slackIdentity } from "@/lib/slack-user";
import { ReportStudio } from "../report-studio";
import { after } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Report" };
// Revising and checking a report, putting a joint message together and posting it with its PDF can take a minute
export const maxDuration = 300;

export default async function ReportPage({ params }: PageProps<"/reports/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  const db = await createClient();
  const { data: r } = await db
    .from("reports")
    .select("id, kind, platform, status, period_start, period_end, owner_id, viewed_at, bundle_id, message, sections, metrics, extra_metrics, extras, qa, chat, error, posted_at, clients(name, slug, slack_channel_id), profiles!reports_owner_id_fkey(full_name), kpi_targets(id, client_id, platform, owner_id)")
    .eq("id", id)
    .maybeSingle();
  if (!r) notFound();
  // Only the account's buyer, the leads of its line and execs see a report (a link alone doesn't open it)
  const target = r.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!(r.owner_id === me.id || (target && (await canReportOn(db, me, target))))) notFound();
  // Its buyer opening it for the first time: the heads of the line see it's been looked at
  if (r.owner_id === me.id && !r.viewed_at && adminConfigured()) after(async () => {
    await createAdminClient().from("reports").update({ viewed_at: new Date().toISOString() }).eq("id", r.id).is("viewed_at", null);
  });

  const [slack, identity, { data: bundle }, { data: parts }] = await Promise.all([
    slackConnection(me.id),
    slackIdentity(me.id).catch(() => null),
    r.bundle_id ? db.from("report_bundles").select("id, kind, status, ranges, created_by, message, message_approved_at, profiles!report_bundles_created_by_fkey(full_name)").eq("id", r.bundle_id).maybeSingle() : Promise.resolve({ data: null }),
    r.bundle_id ? db.from("reports").select("id, platform, status, owner_id, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", r.bundle_id).neq("status", "skipped") : Promise.resolve({ data: [] }),
  ]);
  const client = r.clients as unknown as { name: string; slug: string; slack_channel_id: string | null };
  const metrics = (r.metrics as ReportMetrics | null) ?? null;
  const ranges = (bundle?.ranges ?? []) as { label: string }[];
  const periodLabel = r.kind === "built" && ranges.length ? ranges.map((x) => x.label).join(" + ") : r.kind === "monthly" ? monthLabel(r.period_start) : (metrics?.main.label ?? `${r.period_start} – ${r.period_end}`);
  const name = (p: unknown) => (p as { full_name: string } | null)?.full_name ?? null;

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <header className="grid gap-1">
        <Link href="/reports" className="inline-flex min-h-11 w-fit items-center text-xs text-muted hover:text-fg md:min-h-0">
          ← Reports
        </Link>
        <h1 className="font-heading text-[28px] leading-tight [overflow-wrap:anywhere]">{client.name}</h1>
        <p className="text-sm text-muted">
          {r.kind === "built" && (parts?.length ?? 0) > 1 ? "Joint report" : r.platform === "google" ? "Google Ads" : "Meta Ads"} · {periodLabel}
        </p>
      </header>
      <ReportStudio
        report={{
          id: r.id,
          kind: r.kind as "weekly" | "monthly" | "custom" | "built",
          platform: r.platform as "meta" | "google",
          status: r.status,
          periodLabel,
          message: r.message ?? "",
          sections: (r.sections as Sections | null) ?? null,
          metrics,
          extraMetrics: (r.extra_metrics as ReportMetrics[] | null) ?? null,
          extras: r.extras ?? "",
          qa: (r.qa as Qa | null) ?? null,
          chat: (r.chat ?? []) as ChatTurn[],
          error: r.error,
          owner: name(r.profiles),
        }}
        client={{ name: client.name, slug: client.slug, hasChannel: Boolean(client.slack_channel_id) }}
        bundle={
          bundle
            ? {
                id: bundle.id,
                kind: bundle.kind as "built" | "monthly",
                status: bundle.status,
                isBuilder: bundle.created_by === me.id || (!bundle.created_by && r.owner_id === me.id),
                builder: name(bundle.profiles),
                message: bundle.message,
                messageApproved: Boolean(bundle.message_approved_at),
                parts: (parts ?? []).map((p) => ({ id: p.id, platform: p.platform, status: p.status, owner: name(p.profiles), isMe: p.owner_id === me.id })),
              }
            : null
        }
        slack={{ connected: slack.connected, name: identity?.name || null, image: identity?.image ?? null, me: me.fullName }}
      />
    </div>
  );
}
