import type { EmailDesignKpis } from "@/lib/email-kpis";
import { REQUEST_LEAD_DAYS } from "@/lib/team-kpis-core";
import { KpiHeader, Section } from "../creative-kpis";
import { LiveRefresh } from "../live-kpis";
import { BuildCard, StrategistScorecard, WorkloadList } from "./email-kpi-parts";

// The Email Team KPIs' Build and Strategy tabs (execs and the Head of Email). Build: each email builder's card (builds,
// turnaround, what came back, real errors read from comments, the due dates they pushed) with their plate in a list
// that scrolls on its own. Strategy: each strategist's scorecard (their accounts' email score and its trend, how early
// requests come in against the send date, how long work sent back to them sits, Slack and email replies, client reports
// on time). Both end with the whole team's workload. Only people whose role belongs on the tab appear, never the viewer.

function Summary({ items }: { items: [string, string, string][] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, v, sub]) => (
        <div key={label} className="grid gap-1 rounded-[18px] border border-line bg-surface px-4 py-3">
          <dt className="text-[11.5px] text-muted">{label}</dt>
          <dd className="tabular font-display text-[24px] leading-none">{v}</dd>
          <span className="text-[11px] text-faint">{sub}</span>
        </div>
      ))}
    </dl>
  );
}

const avgOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

function Workload({ k, viewerId, tab }: { k: EmailDesignKpis; viewerId: string | null; tab: string }) {
  return (
    <Section kicker="The team" title="Workload right now" aside={<span className="text-[12px] text-faint">Everyone on the email team: open tickets and the emails in them</span>}>
      <WorkloadList rows={k.workload.filter((r) => r.profileId !== viewerId)} tab={tab} />
    </Section>
  );
}

export function EmailBuildView({ k, switcher = false, viewerId = null }: { k: EmailDesignKpis; switcher?: boolean; viewerId?: string | null }) {
  const people = k.builders.filter((b) => k.members.build.includes(b.profileId) && b.profileId !== viewerId);
  const builds = people.reduce((n, b) => n + b.builds, 0);
  const back = people.reduce((n, b) => n + b.returns, 0);
  return (
    <div className="grid gap-12">
      <LiveRefresh board="email" />
      <KpiHeader active="kpis" period={k.period} base="/board/email?view=kpis&tab=build" switcher={switcher} board="email" tab="build" />
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Email build · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How email build is going</h2>
        </div>
        <Summary
          items={[
            ["Builds finished", String(builds), "Ready for build to send"],
            ["Turnaround", avgOf(people.map((b) => b.turnaround)) == null ? "—" : `${avgOf(people.map((b) => b.turnaround))}d`, `team average · target ${people[0]?.turnaroundTarget ?? 1}d`],
            ["Came back", builds ? `${Math.round((back / builds) * 100)}%` : "—", `${back} builds returned to build`],
            ["Errors", String(people.reduce((n, b) => n + b.errors.d90, 0)), "read from comments, 90 days"],
          ]}
        />
      </section>
      <Section kicker="The team" title="Builders">
        {people.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {people.map((b) => (
              <BuildCard key={b.profileId} b={b} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-8 text-center text-[14px] text-muted">No email builder is on the team yet.</p>
        )}
      </Section>
      <Workload k={k} viewerId={viewerId} tab="build" />
      <p className="text-[11px] text-faint">
        Business days. Builds from the Email Board&apos;s history and the Asana email board&apos;s. Came back: a build moved back to Ready for build after it left. Pushback: tasks they held whose due date they moved later. Errors are comments on their builds (Asana and the Email Board) that an AI pass read as a real mistake: a wrong link or image, something broken.
        {k.errorsUnsorted ? ` ${k.errorsUnsorted} comments are still being read.` : ""}
      </p>
    </div>
  );
}

export function EmailStrategyView({ k, switcher = false, viewerId = null }: { k: EmailDesignKpis; switcher?: boolean; viewerId?: string | null }) {
  const people = k.strategists.filter((s) => k.members.strategy.includes(s.profileId) && s.profileId !== viewerId);
  const bottlenecks = people.filter((s) => s.response.bottleneck);
  const onTimeReports = people.reduce((n, s) => n + s.reports.onTime, 0);
  const lateReports = people.reduce((n, s) => n + s.reports.late, 0);
  return (
    <div className="grid gap-12">
      <LiveRefresh board="email" />
      <KpiHeader active="kpis" period={k.period} base="/board/email?view=kpis&tab=strategy" switcher={switcher} board="email" tab="strategy" />
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Email strategy · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How the strategists are doing</h2>
        </div>
        <Summary
          items={[
            ["Accounts' email score", avgOf(people.map((s) => s.accounts.avg)) == null ? "—" : String(Math.round(avgOf(people.map((s) => s.accounts.avg))!)), "average across their accounts"],
            ["Requests on time", avgOf(people.map((s) => s.requests.onTime)) == null ? "—" : `${Math.round(avgOf(people.map((s) => s.requests.onTime))!)}%`, `in by ${REQUEST_LEAD_DAYS} business days before send`],
            ["Reports on time", onTimeReports + lateReports ? `${Math.round((onTimeReports / (onTimeReports + lateReports)) * 100)}%` : "—", `${lateReports} late, weekly and monthly`],
            ["Bottlenecks", String(bottlenecks.length), bottlenecks.length ? bottlenecks.map((s) => s.name.split(" ")[0]).join(", ") : "nobody holding work up"],
          ]}
        />
      </section>
      <Section kicker="The team" title="Strategists">
        {people.length ? (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {people.map((s) => (
              <StrategistScorecard key={s.profileId} s={s} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-8 text-center text-[14px] text-muted">No email strategist is on the team yet.</p>
        )}
      </Section>
      <Workload k={k} viewerId={viewerId} tab="strategy" />
      <p className="text-[11px] text-faint">
        Accounts: every client they hold the strategist seat on, each client&apos;s email score (the main email KPI), the trend from the scores kept each day. Requests: Board tickets they put in (Asana tasks count for the client&apos;s strategist) against the send date, which needs {REQUEST_LEAD_DAYS} business days for copy, design, review, the client, revisions, build and send. Sent back to them: how long work sits in copy review, the final look and the final check with them. Slack and email: the replies owed to them, from asked to answered. Reports: weekly due two days after the week, monthly three business days after the month.
      </p>
    </div>
  );
}
