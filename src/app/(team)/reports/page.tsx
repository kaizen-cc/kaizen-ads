import type { Metadata } from "next";
import Link from "next/link";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { nyParts } from "@/lib/kpi/calc";
import { periodsFor } from "@/lib/reports/metrics";
import type { Qa } from "@/lib/reports/write";
import { slackConnection } from "@/lib/slack-user";
import { SlackConnect } from "@/components/slack-connect";
import { ReportButton } from "../clients/[slug]/report-button";
import { reportableTargets } from "@/lib/reports/access";

export const metadata: Metadata = { title: "Reports" };
export const maxDuration = 300;

type Row = { id: string; kind: "weekly" | "monthly" | "custom"; platform: string; status: string; qa: Qa | null; posted_at: string | null; bundle_id: string | null; clients: { name: string; slug: string }; profiles: { full_name: string } | null };

/** On-demand recaps stay listed for two weeks. */
const twoWeeksAgo = () => new Date(Date.now() - 14 * 86_400_000).toISOString();

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-faint" },
  drafting: { label: "Writing…", tone: "text-faint" },
  draft: { label: "Ready to review", tone: "text-fg" },
  submitted: { label: "Submitted · waiting on the other buyer", tone: "text-warn" },
  posted: { label: "Sent", tone: "text-ok" },
  skipped: { label: "Skipped", tone: "text-faint" },
  failed: { label: "Couldn't write it", tone: "text-bad" },
};

/** This week's reports and this month's recap, for each buyer (theirs) and for leads and execs (their line, or all). */
export default async function ReportsPage() {
  const me = await requireStaff();
  const db = await createClient();
  const today = nyParts(new Date()).date;
  const week = periodsFor("weekly", today).main;
  const month = periodsFor("monthly", today).main;
  const lead = isExecOrLead(me);
  // The accounts this person reports on (their own; their line's for a lead; all for an exec): what they see and can draft
  const accounts = await reportableTargets(db, me);
  let q = db
    .from("reports")
    .select("id, kind, platform, status, qa, posted_at, bundle_id, clients(name, slug), profiles!reports_owner_id_fkey(full_name)")
    .or(`and(kind.eq.weekly,period_start.eq.${week.start}),and(kind.eq.monthly,period_start.eq.${month.start}),and(kind.eq.custom,updated_at.gte.${twoWeeksAgo()})`)
    .order("created_at");
  if (!me.isExec) q = q.in("target_id", accounts.length ? accounts.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"]);
  const [{ data }, slack] = await Promise.all([q, slackConnection(me.id)]);
  const rows = (data ?? []) as unknown as Row[];
  const weekly = rows.filter((r) => r.kind === "weekly");
  const monthly = rows.filter((r) => r.kind === "monthly");
  const onDemand = rows.filter((r) => r.kind === "custom");
  const dom = Number(today.slice(8, 10));
  const open = weekly.filter((r) => r.status === "draft").length;

  const list = (items: Row[]) => (
    <ul className="grid gap-2">
      {items
        .sort((a, b) => a.clients.name.localeCompare(b.clients.name))
        .map((r) => {
          const s = STATUS[r.status] ?? STATUS.draft;
          const flags = r.status === "draft" ? (r.qa?.flags ?? []) : [];
          const fix = flags.filter((f) => f.severity === "fix").length;
          const alert = flags.filter((f) => f.severity === "alert").length;
          return (
            <li key={r.id}>
              <Link href={`/reports/${r.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[14px] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-faint/70 active:bg-surface-2 max-md:gap-3">
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-heading text-[15px] max-md:whitespace-normal max-md:[overflow-wrap:anywhere]">
                    {r.clients.name} <span className="text-muted">· {r.platform === "google" ? "Google" : "Meta"}</span>
                  </span>
                  <span className={`text-xs ${s.tone}`}>
                    {s.label}
                    {lead && r.profiles?.full_name ? <span className="text-faint"> · {r.profiles.full_name}</span> : null}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 max-md:max-w-[9.5rem] max-md:flex-wrap max-md:justify-end">
                  {fix > 0 && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{fix} to fix</span>}
                  {alert > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{alert} alert{alert === 1 ? "" : "s"}</span>}
                  {r.status === "draft" && !fix && !alert && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">QA clean</span>}
                  <span className="text-faint">→</span>
                </span>
              </Link>
            </li>
          );
        })}
    </ul>
  );

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Reports</h1>
          <p className="max-w-2xl text-sm text-muted">
            Drafted every Monday (the last 7 days and the month so far) and on the 1st (the monthly recap), in your voice, checked by the QA. Read it, tweak it or ask the AI to, then send it as you.
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2 max-md:w-full">
          <SlackConnect connected={slack.connected} next="/reports" />
          <ReportButton
            primary
            label="New report"
            today={today}
            accounts={accounts.map((a) => ({ id: a.id, client: a.clients.name, label: `${a.platform === "google" ? "Google" : "Meta"}${a.label ? ` · ${a.label}` : ""}` }))}
          />
        </span>
      </header>

      {dom <= 7 && monthly.length > 0 && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">{month.label} recap</h2>
            <span className="text-xs text-faint">Due by the 5th · it goes to the client once every buyer on the account submits</span>
          </div>
          {list(monthly)}
        </section>
      )}

      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-xl">This week · {week.label}</h2>
          <span className="text-xs text-faint">{open ? `${open} ready to review` : weekly.length ? "All reviewed" : "Drafted Monday morning"}</span>
        </div>
        {weekly.length ? list(weekly) : <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-muted">Nothing drafted for this week yet. They&apos;re written Monday morning for every account that spent; for one now, use New report (Last 7 days).</p>}
      </section>

      {onDemand.length > 0 && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">On demand</h2>
            <span className="text-xs text-faint">Recaps asked for from a client page, last two weeks</span>
          </div>
          {list(onDemand)}
        </section>
      )}

    </div>
  );
}
