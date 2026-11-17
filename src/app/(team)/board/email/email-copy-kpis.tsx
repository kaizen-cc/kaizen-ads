import Link from "next/link";
import type { EmailCopyKpis, EmailStrategist } from "@/lib/email-kpis";
import { HeadlineCard, KpiHeader, Meter, Section, TONES } from "../creative-kpis";
import { LiveRefresh, Tween } from "../live-kpis";
import { EmailActionLink, EmailLateRow, EmailResultCard, TiringFlowCard } from "./email-kpi-parts";

// The email copy KPIs (execs and the Head of Email, a tab on the Email Board), built like the Copy KPIs: what to act on
// first, how fast a ticket's copy goes from the AI's draft to approved, how often the AI's copy goes through first time
// (by the strategist and by the client), the rewrites asked for, each strategist's card, each client's copy, and subject
// lines judged on opens against each account's usual: the styles that win, the best and worst, and flows opening less.

const { TONE_TEXT } = TONES;

function StrategistCard({ s }: { s: EmailStrategist }) {
  return (
    <li className="relative grid content-start gap-4 rounded-[22px] border border-line bg-surface p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-faint">
      <Link href={`/board/email?person=${s.id}`} className="absolute inset-0 rounded-[22px]" aria-label={`Everything on ${s.name}'s plate`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-heading text-[17px] leading-tight">{s.name}</p>
          <p className="text-[12px] text-muted">{s.role}</p>
        </div>
        <div className="text-right">
          <p className="tabular font-display text-[30px] leading-none">
            <Tween value={s.approved} />
          </p>
          <p className="text-[11px] text-muted">tickets approved</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-0.5">
          <span className={`tabular text-[22px] font-medium leading-none ${s.turnaround != null && s.turnaround > 1 ? "text-warn" : ""}`}>{s.turnaround == null ? "—" : `${s.turnaround}d`}</span>
          <span className="text-[11px] text-muted">copy for review → approved</span>
        </div>
        <div className="grid gap-0.5">
          <span className="tabular text-[22px] font-medium leading-none">{s.openRate == null ? "—" : `${s.openRate}%`}</span>
          <span className="text-[11px] text-muted">opens on {s.subjects} {s.subjects === 1 ? "subject" : "subjects"}</span>
        </div>
      </div>
      <Meter value={s.firstPass} target={70} label="AI copy approved without a rewrite" />
      <dl className="tabular grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Client sendbacks", String(s.sendbacks), s.sendbacks >= 3 ? "text-warn" : "text-fg"],
            ["Rewrites asked", String(s.rewrites), "text-fg"],
            ["In copy review", String(s.open), s.late ? "text-warn" : "text-fg"],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k} className="rounded-[12px] bg-ink/[0.04] px-2 py-2">
            <dd className={`text-[15px] font-medium ${c}`}>{v}</dd>
            <dt className="text-[10.5px] text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      {s.act ? <p className="rounded-[12px] bg-warn-soft px-3 py-2.5 text-[12.5px] leading-snug text-warn">{s.act}</p> : <p className="rounded-[12px] bg-ok-soft px-3 py-2.5 text-[12.5px] text-ok">{s.open ? `${s.open} in copy review, nothing late.` : "On track: nothing to act on."}</p>}
    </li>
  );
}

export function EmailCopyKpisView({ k, switcher = false }: { k: EmailCopyKpis; switcher?: boolean }) {
  const total = k.split.copy + k.split.design;
  const copyShare = total ? Math.round((k.split.copy / total) * 100) : 0;
  return (
    <div className="grid gap-12">
      <LiveRefresh board="email" />
      <KpiHeader active="copy-kpis" period={k.period} base="/board/email?view=copy-kpis" switcher={switcher} board="email" />
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Email copy · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How email copy is going</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {k.headlines.map((h) => (
            <HeadlineCard key={h.key} h={h} />
          ))}
        </div>
        {k.actions.length ? (
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
          <p className="rounded-[18px] bg-ok-soft px-5 py-3.5 text-[14px] text-ok">No late copy, nothing the AI couldn&apos;t write, no client sending copy back again and again.</p>
        )}
      </section>

      <Section kicker="The team" title="Email strategists" aside={<span className="text-[12px] text-faint">Tap a card for their tickets on the Email Board</span>}>
        {k.strategists.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {k.strategists.map((s) => (
              <StrategistCard key={s.id} s={s} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No email copy approved in this period yet.</p>
        )}
      </Section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section kicker="Clients" title="Copy by client">
          {k.clients.length ? (
            <ul className="grid max-h-[440px] gap-1 overflow-y-auto overscroll-contain rounded-[22px] border border-line bg-surface p-1.5 md:p-2">
              {k.clients.map((c) => (
                <li key={c.id}>
                  <Link href={`/clients/${c.slug}`} className="grid gap-1.5 rounded-[14px] px-3 py-3 hover:bg-ink/[0.04] md:grid-cols-[minmax(0,1.2fr)_auto] md:items-center md:gap-4">
                    <span className="min-w-0">
                      <span className="block truncate text-[14px]">{c.name}</span>
                      {c.lastAsk && <span className="block truncate text-[12px] text-muted">Latest ask: &ldquo;{c.lastAsk}&rdquo;</span>}
                    </span>
                    <span className="tabular flex flex-wrap gap-1.5 text-[11.5px]">
                      <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-muted">{c.tickets} approved</span>
                      {c.openRate != null && <span className={`rounded-full px-2 py-0.5 ${c.usualOpen != null && c.openRate < c.usualOpen * 0.9 ? "bg-warn-soft text-warn" : "bg-ink/[0.05] text-muted"}`}>opens {c.openRate}%{c.usualOpen != null ? ` (usual ${c.usualOpen}%)` : ""}</span>}
                      {c.copyBack > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">{c.copyBack} sent back</span>}
                      {c.open > 0 && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-brand-text">{c.open} in review</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No email copy in this period yet.</p>
          )}
        </Section>

        <div className="grid content-start gap-8">
          <Section kicker="Quality" title="Where client changes come from">
            <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4">
              {total ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="tabular font-display text-[32px] leading-none">
                      <Tween value={total} />
                    </span>
                    <span className="text-[12px] text-muted">changes clients asked for</span>
                  </div>
                  <span className="flex h-2.5 overflow-hidden rounded-full bg-ink/[0.07]">
                    <span className="bg-brand-text" style={{ width: `${copyShare}%` }} />
                    <span className="bg-warn" style={{ width: `${100 - copyShare}%` }} />
                  </span>
                  <span className="flex justify-between text-[12px]">
                    <span className="text-brand-text">{copyShare}% copy</span>
                    <span className="text-warn">{100 - copyShare}% design</span>
                  </span>
                </>
              ) : (
                <p className="text-[13px] text-muted">No client changes in this period.</p>
              )}
            </div>
          </Section>

          <Section kicker="Teaching the AI" title="Rewrites asked for">
            {k.rewrites.length ? (
              <ul className="grid gap-1 rounded-[20px] border border-line bg-surface p-2">
                {k.rewrites.map((r, i) => (
                  <li key={i}>
                    <Link href={r.number ? `/board/email?t=${r.number}` : `/clients/${r.slug}`} className="grid gap-0.5 rounded-[12px] px-2.5 py-2 text-[13px] hover:bg-ink/[0.04]">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate">{r.note ? <>&ldquo;{r.note}&rdquo;</> : "Rewrite with no note"}</span>
                        <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{r.number ? `E-${r.number}` : "Rewrite"}</span>
                      </span>
                      <span className="truncate text-[11.5px] text-muted">
                        {r.client}
                        {r.by ? ` · ${r.by}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No rewrites asked for: the AI&apos;s copy went through.</p>
            )}
          </Section>

          <Section kicker="On the Email Board" title="Copy late right now">
            {k.late.length ? (
              <ul className="grid rounded-[20px] border border-line bg-surface p-1.5">
                {k.late.map((t) => (
                  <EmailLateRow key={t.number} t={t} />
                ))}
              </ul>
            ) : (
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No copy late on the Email Board.</p>
            )}
          </Section>
        </div>
      </div>

      <Section
        kicker="In the inbox"
        title="Subject lines that won"
        aside={
          <span className="rounded-full border border-line px-3 py-1.5 text-[12px] text-muted">
            Opens <b className="tabular font-semibold text-fg">{k.openRate.now == null ? "—" : `${k.openRate.now}%`}</b> send-weighted{k.openRate.before != null ? ` (was ${k.openRate.before}%)` : ""} · {k.openRate.sends} emails
          </span>
        }
      >
        {k.best.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.best.map((r) => (
              <EmailResultCard key={r.key} r={r} on="open" />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No subject line out-opened its account&apos;s usual in this period yet.</p>
        )}
      </Section>

      {k.worst.length > 0 && (
        <Section kicker="In the inbox" title="Subject lines that missed" aside={<span className="text-[12px] text-faint">Opened 12% or more below their account&apos;s usual</span>}>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.worst.map((r) => (
              <EmailResultCard key={r.key} r={r} on="open" />
            ))}
          </div>
        </Section>
      )}

      <Section kicker="In the inbox" title="Flows opening less" aside={<span className="text-[12px] text-faint">Each flow&apos;s opens, last 30 days against the 60 before</span>}>
        {k.opensTiring.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {k.opensTiring.map((f) => (
              <TiringFlowCard key={f.key} f={f} on="open" />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No flow&apos;s opens are falling.</p>
        )}
      </Section>

      <Section kicker="In the email accounts" title="Subject lines judged" aside={<span className="text-[12px] text-faint">Each subject against its account&apos;s usual open rate, 90 days</span>}>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4">
            <p className="text-[13px] font-medium">By style</p>
            {k.styles.length ? (
              <ul className="grid gap-2.5">
                {k.styles.map((f) => {
                  const tone = f.rate == null ? null : f.rate >= 60 ? "ok" : f.rate >= 40 ? "warn" : "bad";
                  return (
                    <li key={f.name} className="grid gap-1">
                      <span className="flex items-baseline justify-between text-[13px]">
                        <span>{f.name}</span>
                        <span className={`tabular text-[12px] ${tone ? TONE_TEXT[tone] : "text-faint"}`}>
                          {f.winners} of {f.judged} won{f.rate != null ? ` · ${f.rate}%` : ""}
                        </span>
                      </span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
                        <span className={`block h-full rounded-full ${tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-bad"}`} style={{ width: `${Math.max(3, f.rate ?? 0)}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Not enough subject lines judged yet.</p>
            )}
          </div>
          <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4">
            <p className="text-[13px] font-medium">This period&apos;s standouts</p>
            {k.subjects.length ? (
              <ul className="grid gap-1">
                {k.subjects.map((a) => (
                  <li key={`${a.slug}${a.subject}`}>
                    <Link href={`/clients/${a.slug}`} className="flex items-baseline justify-between gap-3 rounded-[12px] px-1.5 py-1.5 text-[13px] hover:bg-ink/[0.04]">
                      <span className="min-w-0 truncate">
                        {a.subject} <span className="text-muted">· {a.client}</span>
                      </span>
                      <span className={`tabular shrink-0 rounded-full px-2 py-0.5 text-[11px] ${a.verdict === "winner" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
                        {a.openRate != null ? `${a.openRate}%` : ""}
                        {a.lift != null ? ` ${a.lift >= 0 ? "+" : "−"}${Math.abs(a.lift)}%` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Nothing judged yet.</p>
            )}
          </div>
        </div>
      </Section>

      <p className="text-[11px] text-faint">Business days. Timings from the Email Board&apos;s ticket history and the Asana email board&apos;s; client changes from the portal; results from each client&apos;s email platform, every subject line against its own account&apos;s usual open rate.</p>
    </div>
  );
}
