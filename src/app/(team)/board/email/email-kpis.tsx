import Link from "next/link";
import type { EmailDesignKpis } from "@/lib/email-kpis";
import { HeadlineCard, KpiHeader, Section } from "../creative-kpis";
import { LiveRefresh, Tween } from "../live-kpis";
import { CadenceList, EmailActionLink, EmailClientRevisions, EmailLateRow, EmailPersonCard, EmailPersonSheet, EmailResultCard, EmailWinnersSheet, TiringFlowCard, WorkloadList } from "./email-kpi-parts";

// The email designers' KPIs (execs and the Head of Email, a tab on the Email Board), built like the Creative KPIs and
// read top to bottom: how it's going in eight numbers, the few things to act on, the designers (tap anyone for their
// plate, glance into what came back and the AI review's fixes), each email client's sending this cycle (critical
// first), the workload, where changes come from, what's late, and the emails themselves: designs that out-click their
// account to build on, the ones that fell short, and flows whose clicks are tiring. Everything opens where it's handled.

const GROUPS: { key: string; title: string }[] = [
  { key: "email_designer", title: "Email designers" },
  { key: "email_builder", title: "Builders who design" },
  { key: "other", title: "Also designing email" },
];

function rate(n: number, of: number) {
  return of ? `${Math.round((n / of) * 100)}%` : "—";
}

export function EmailDesignKpisView({ k, canDismiss, switcher = false }: { k: EmailDesignKpis; canDismiss: boolean; switcher?: boolean }) {
  const total = k.split.copy + k.split.design;
  const copyShare = total ? Math.round((k.split.copy / total) * 100) : 0;
  const groups = GROUPS.map((g) => ({ ...g, people: k.makers.filter((m) => m.roleKey === g.key) })).filter((g) => g.people.length);
  const ts = k.teamSendbacks;
  return (
    <div className="grid gap-12">
      <LiveRefresh board="email" />
      <EmailPersonSheet makers={k.makers} />
      <EmailWinnersSheet makers={k.makers} />
      <KpiHeader active="kpis" period={k.period} base="/board/email?view=kpis" switcher={switcher} board="email" />

      {/* How it's going */}
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Email design · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How email design is going</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {k.headlines.map((h) => (
            <HeadlineCard key={h.key} h={h} />
          ))}
        </div>
        {k.actions.length > 0 ? (
          <div className="grid gap-2 rounded-[22px] border border-line bg-surface p-2">
            <p className="px-3 pt-2 text-[12px] font-medium text-fg">Act on this first</p>
            <ul className="grid md:grid-cols-2">
              {k.actions.map((a) => (
                <li key={a.key}>
                  <EmailActionLink href={a.href} className="group flex h-full items-start gap-3 rounded-[16px] px-3 py-3 hover:bg-ink/[0.04]">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.tone === "bad" ? "bg-bad" : "bg-warn"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium leading-snug">{a.title}</span>
                      <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-faint group-hover:text-fg">→</span>
                  </EmailActionLink>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-5 py-3.5 text-[14px] text-ok">Nothing urgent: no late tickets, every client sending on pace, nobody overloaded.</p>
        )}
      </section>

      {/* The designers */}
      <Section
        kicker="The team"
        title="Who's designing what"
        aside={
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="rounded-full border border-line px-3 py-1.5">
              Sent back in review <b className="tabular font-semibold text-fg">{rate(ts.d45.internal, ts.d45.pieces)}</b> 45d · {rate(ts.d90.internal, ts.d90.pieces)} 90d
            </span>
            <span className="rounded-full border border-line px-3 py-1.5">
              By clients <b className="tabular font-semibold text-fg">{rate(ts.d45.client, ts.d45.pieces)}</b> 45d · {rate(ts.d90.client, ts.d90.pieces)} 90d
            </span>
            <span className="rounded-full border border-line px-3 py-1.5">
              AI fixes <b className="tabular font-semibold text-fg">{k.fixes.d45}</b> 45d · {k.fixes.d90} 90d
            </span>
          </span>
        }
      >
        {groups.length ? (
          <div className="grid gap-8">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ["Request → client", k.teamAvg.briefToDone == null ? "—" : `${k.teamAvg.briefToDone}d`, "team average"],
                  ["Met due date", k.teamAvg.metDue == null ? "—" : `${k.teamAvg.metDue}%`, "ready to send by then"],
                  ["Due dates pushed back", k.teamAvg.pushedBack == null ? "—" : `${k.teamAvg.pushedBack}%`, "of tickets held"],
                  ["Revision back in", k.teamAvg.revisionTurnaround == null ? "—" : `${k.teamAvg.revisionTurnaround}d`, "team average"],
                  ["Winning emails", String(k.teamAvg.winners), "credited to the team, 90 days"],
                ] as const
              ).map(([label, v, sub]) => (
                <div key={label} className="grid gap-1 rounded-[18px] border border-line bg-surface px-4 py-3">
                  <dt className="text-[11.5px] text-muted">{label}</dt>
                  <dd className="tabular font-display text-[24px] leading-none">{v}</dd>
                  <span className="text-[11px] text-faint">{sub}</span>
                </div>
              ))}
            </dl>
            {groups.map((g) => (
              <div key={g.key} className="grid gap-3">
                <p className="text-[13px] font-medium text-muted">
                  {g.title} <span className="text-faint">· {g.people.length}</span>
                </p>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {g.people.map((m) => (
                    <EmailPersonCard key={m.profileId} m={m} />
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[11.5px] text-faint">Tap a card for everything on their plate. Hover the score for how it&apos;s worked out (first pass 40%, turnaround 30%, revision turnaround 15%, nothing left sitting 15%). AI fixes are the must-fix notes the AI review pinned on their designs before anyone else looked.</p>
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-8 text-center text-[14px] text-muted">No email designer passed a design on in this period yet.</p>
        )}
      </Section>

      {/* Clients */}
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-8">
        <div className="grid content-start gap-12 lg:gap-8">
          <Section id="cadence" kicker="Clients" title="Sending this cycle">
            {k.cadence.length ? <CadenceList rows={k.cadence} canDismiss={canDismiss} /> : <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No client buys email marketing.</p>}
          </Section>
          <Section kicker="The team" title="Workload right now" aside={<span className="text-[12px] text-faint">Open tickets and the emails in them</span>}>
            <WorkloadList rows={k.workload} />
          </Section>
        </div>

        <div className="grid content-start gap-12 lg:gap-8">
          <Section kicker="Quality" title="Where changes come from">
            <div className="grid gap-4 rounded-[22px] border border-line bg-surface p-5">
              {total ? (
                <div className="grid gap-2">
                  <div className="flex items-baseline justify-between">
                    <span className="tabular font-display text-[30px] leading-none">
                      <Tween value={total} />
                    </span>
                    <span className="text-[12px] text-muted">changes clients asked for</span>
                  </div>
                  <span className="flex h-2 overflow-hidden rounded-full bg-ink/[0.07]">
                    <span className="bg-brand-text" style={{ width: `${copyShare}%` }} />
                    <span className="bg-warn" style={{ width: `${100 - copyShare}%` }} />
                  </span>
                  <span className="flex justify-between text-[12px]">
                    <span className="text-brand-text">{copyShare}% copy</span>
                    <span className="text-warn">{100 - copyShare}% design</span>
                  </span>
                </div>
              ) : (
                <p className="text-[13px] text-muted">No changes asked for in this period.</p>
              )}
              {k.revisionClients.length > 0 && (
                <div className="grid border-t border-line pt-3">
                  <p className="pb-1 text-[11px] text-faint">Sending the most back · hover a client for their latest</p>
                  {k.revisionClients.slice(0, 5).map((c) => (
                    <EmailClientRevisions key={c.client} c={c} />
                  ))}
                </div>
              )}
              {k.slowClients.length > 0 && (
                <div className="grid border-t border-line pt-3">
                  <p className="pb-1 text-[11px] text-faint">Slowest to the client</p>
                  {k.slowClients.slice(0, 4).map((c) => (
                    <Link key={c.client} href={c.slug ? `/clients/${c.slug}` : "#"} className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px] hover:underline">
                      <span className="min-w-0 truncate">{c.client}</span>
                      <span className="tabular shrink-0 text-[12px] text-warn">{c.days}d avg</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section kicker="On the Email Board" title="Late right now">
            {k.late.length ? (
              <ul className="grid rounded-[22px] border border-line bg-surface p-1.5">
                {k.late.map((t) => (
                  <EmailLateRow key={t.number} t={t} />
                ))}
              </ul>
            ) : (
              <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">Nothing late on the Email Board.</p>
            )}
          </Section>
        </div>
      </div>

      {/* The emails */}
      <Section
        kicker="In the inbox"
        title="Designs to build on"
        aside={
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="rounded-full border border-line px-3 py-1.5">
              <b className="tabular font-semibold text-fg">{k.results.hitRate == null ? "—" : `${k.results.hitRate}%`}</b> out-clicked their usual
              {k.results.previousHitRate != null && ` (was ${k.results.previousHitRate}%)`}
            </span>
            <span className="rounded-full border border-line px-3 py-1.5">
              <span className="text-ok">{k.results.winners} above</span> · <span className="text-bad">{k.results.losers} below</span> · {k.results.par} on par
            </span>
          </span>
        }
      >
        {k.winners.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.winners.map((r) => (
              <EmailResultCard key={r.key} r={r} on="click" />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No email out-clicked its account&apos;s usual in this period yet.</p>
        )}
      </Section>

      {k.losers.length > 0 && (
        <Section kicker="In the inbox" title="Designs that fell short" aside={<span className="text-[12px] text-faint">Clicked 20% or more below their account&apos;s usual</span>}>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.losers.map((r) => (
              <EmailResultCard key={r.key} r={r} on="click" />
            ))}
          </div>
        </Section>
      )}

      <Section id="tiring" kicker="In the inbox" title="Flows to redesign" aside={<span className="text-[12px] text-faint">Each flow&apos;s last 30 days against the 60 before</span>}>
        {k.tiring.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {k.tiring.map((f) => (
              <TiringFlowCard key={f.key} f={f} />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No flow&apos;s clicks are tiring.</p>
        )}
      </Section>

      <p className="text-[11px] text-faint">
        Business days. Production from the Email Board&apos;s history ({k.source.kaizen} tickets) and the Asana email board&apos;s ({k.source.asana} tasks not moved over yet); results from each client&apos;s email platform, every email against its own account&apos;s usual numbers. Emails come from the ticket they were made on when the campaign is noted on it ({k.source.linked} so far), otherwise from the client&apos;s designer seat.
      </p>
    </div>
  );
}
