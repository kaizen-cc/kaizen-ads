import type { Metadata } from "next";
import type { ReportLayout } from "@/lib/reports/format";
import { layoutOf } from "@/lib/reports/share";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { canReportOn } from "@/lib/reports/access";
import { canUndo, type Previous } from "@/lib/reports/regenerate";
import { createClient } from "@/lib/supabase/server";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { monthLabel } from "@/lib/reports/format";
import { slackConnection, slackIdentity } from "@/lib/slack-user";
import { ReportStudio } from "../report-studio";
import { after } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { writeStatus } from "@/lib/write-status";
import { lastFullWeek, periodMismatch, rangeLabel, todayIn } from "@/lib/reports/period";
import { clientDelivery } from "@/lib/reports/send";
import { readHistory } from "@/lib/reports/history";
import { isWhiteLabel } from "@/lib/reports/white-label";

export const metadata: Metadata = { title: "Report" };
// Revising and checking a report, putting a joint message together and posting it with its PDF can take a minute
export const maxDuration = 800; // a chat change can look things up (the ad account, Motion, calls, Slack) before it rewrites

export default async function ReportPage({ params }: PageProps<"/reports/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  // Nobody works on reports without their own Slack connected: the Reports page asks for it first
  if (!(await slackConnection(me.id)).connected) redirect("/reports");
  const db = await createClient();
  const { data: r } = await db
    .from("reports")
    .select("id, kind, platform, status, client_id, period_start, period_end, owner_id, viewed_at, bundle_id, message, message_basis, sections, metrics, extra_metrics, extras, layout, qa, chat, error, posted_at, previous, clients(name, slug, slack_channel_id, client_type), profiles!reports_owner_id_fkey(full_name), kpi_targets(id, client_id, platform, owner_id, report_layout, ad_account_id)")
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

  const account = (r.kpi_targets as unknown as { ad_account_id: string | null } | null)?.ad_account_id ?? null;
  const [slack, identity, { data: bundle }, { data: parts }, write] = await Promise.all([
    slackConnection(me.id),
    slackIdentity(me.id).catch(() => null),
    r.bundle_id ? db.from("report_bundles").select("id, kind, status, ranges, created_by, message, message_approved_at, profiles!report_bundles_created_by_fkey(full_name)").eq("id", r.bundle_id).maybeSingle() : Promise.resolve({ data: null }),
    r.bundle_id ? db.from("reports").select("id, platform, status, owner_id, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", r.bundle_id).neq("status", "skipped") : Promise.resolve({ data: [] }),
    // Whether the report's next steps can be applied in the ad account (live changes for the client), read up front
    target && adminConfigured() && (r.platform === "meta" || r.platform === "google") ? writeStatus(createAdminClient(), { clientId: target.client_id, account }, r.platform).catch(() => null) : Promise.resolve(null),
  ]);
  const client = r.clients as unknown as { name: string; slug: string; slack_channel_id: string | null; client_type?: string | null };
  const metrics = (r.metrics as ReportMetrics | null) ?? null;
  const ranges = (bundle?.ranges ?? []) as { key?: string; label: string }[];
  const today = todayIn();
  // The report's own dates are the one source of truth (the numbers follow them), so the header never shows stale ones
  const own = rangeLabel({ start: r.period_start, end: r.period_end }, today);
  const periodLabel = r.kind === "built" && ranges.length ? [own, ...ranges.slice(1).map((x) => x.label)].join(" + ") : r.kind === "monthly" ? monthLabel(r.period_start) : own;
  const name = (p: unknown) => (p as { full_name: string } | null)?.full_name ?? null;
  const admin = adminConfigured() ? createAdminClient() : null;
  const sentNow = r.status === "posted" || bundle?.status === "sent";
  const [delivery, history, { data: keyRow }] = await Promise.all([
    admin && r.kind !== "monthly" && !sentNow ? clientDelivery(admin, r.client_id as string).catch(() => null) : Promise.resolve(null),
    admin ? readHistory(admin, { reportId: r.id, bundleId: r.bundle_id, limit: 40 }, today) : Promise.resolve([]),
    db.from("reports").select("period_key").eq("id", id).maybeSingle().then((x) => (x.error ? { data: null } : x)),
  ]);
  // Every page drawn for the report's dates? (a page for other dates is redrawn before it can go out)
  const stale = !["queued", "drafting", "failed"].includes(r.status) && metrics && r.kind !== "monthly" ? periodMismatch({ start: r.period_start, end: r.period_end }, metrics, r.sections as Sections | null) : [];
  // A weekly still on an older week than the one that just ended: offered last week in one tap
  const week = lastFullWeek(today);
  const behind = r.kind === "weekly" && !sentNow && r.period_end < week.end ? rangeLabel(week, today) : null;
  const locked = sentNow ? "It went to the client with these dates. Duplicate it from the history for other dates." : r.kind === "monthly" ? "A monthly recap covers its month." : r.kind === "built" && bundle?.created_by && bundle.created_by !== me.id && !me.isExec ? "Whoever built the report sets its dates." : null;

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
          messageBasis: (r.message_basis as string | null) ?? null,
          sections: (r.sections as Sections | null) ?? null,
          metrics,
          extraMetrics: (r.extra_metrics as ReportMetrics[] | null) ?? null,
          extras: r.extras ?? "",
          layout: layoutOf({ status: r.status, layout: r.layout as ReportLayout | null, kpi_targets: r.kpi_targets as unknown as { report_layout: ReportLayout | null } | null }),
          qa: (r.qa as Qa | null) ?? null,
          chat: (r.chat ?? []) as ChatTurn[],
          error: r.error,
          owner: name(r.profiles),
          regen: canUndo({ status: r.status, previous: r.previous as Previous | null }) ? { at: (r.previous as Previous).at, by: (r.previous as Previous).by } : null,
          period: { start: r.period_start, end: r.period_end, key: (keyRow?.period_key as string | null) ?? null, today, stale, behind, locked },
        }}
        delivery={delivery}
        history={history}
        client={{ name: client.name, slug: client.slug, hasChannel: Boolean(client.slack_channel_id), whiteLabel: isWhiteLabel(client.client_type) }}

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
        act={target ? { write, canSwitch: me.isExec } : null}
      />
    </div>
  );
}
