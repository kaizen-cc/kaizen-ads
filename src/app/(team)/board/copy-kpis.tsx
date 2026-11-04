import Link from "next/link";
import type { Copywriter, CopyKpis } from "@/lib/copy-kpis";
import { HeadlineCard, KpiHeader, Meter, Section, TONES } from "./creative-kpis";
import { LiveRefresh, Tween } from "./live-kpis";
import { LateRow, TiringCard, WinnerCard } from "./kpi-parts";

// The copy team's KPIs (execs and leads, a tab on the Board): what to act on first, how fast copy moves from approved
// creative to an AI draft to approved, how often it's approved first time by us and by the client, what the client-rule
// check flags (and what's rebutted or forced through), each copywriter's card, each client's copy, and which angles and
// frameworks the copy rode into profitable winners.

const { TONE_TEXT } = TONES;

function WriterCard({ w }: { w: Copywriter }) {
  return (
    <li className="relative grid content-start gap-4 rounded-[22px] border border-line bg-surface p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-faint">
      <Link href={`/board?view=kpis&person=${w.id}`} className="absolute inset-0 rounded-[22px]" aria-label={`Everything on ${w.name}'s plate`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-heading text-[17px] leading-tight">{w.name}</p>
          <p className="text-[12px] text-muted">Copywriter</p>
        </div>
        <div className="text-right">
          <p className="tabular font-display text-[30px] leading-none">
            <Tween value={w.reviewed} />
          </p>
          <p className="text-[11px] text-muted">sets approved</p>
        </div>
      </div>
      <div className="grid gap-0.5">
        <span className={`tabular text-[22px] font-medium leading-none ${w.turnaround != null && w.turnaround > 1 ? "text-warn" : ""}`}>{w.turnaround == null ? "—" : `${w.turnaround}d`}</span>
        <span className="text-[11px] text-muted">draft → approved</span>
      </div>
      <Meter value={w.firstPass} target={70} label="AI draft approved without a rewrite" />
      <dl className="tabular grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Client sendbacks", String(w.sendbacks), w.sendbacks >= 3 ? "text-warn" : "text-fg"],
            ["Flags caught", String(w.caught), "text-fg"],
            ["Rebutted", String(w.rebutted), "text-fg"],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k} className="rounded-[12px] bg-ink/[0.04] px-2 py-2">
            <dd className={`text-[15px] font-medium ${c}`}>{v}</dd>
            <dt className="text-[10.5px] text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      {w.act ? (
        <p className="rounded-[12px] bg-warn-soft px-3 py-2.5 text-[12.5px] leading-snug text-warn">{w.act}</p>
      ) : (
        <p className="rounded-[12px] bg-ok-soft px-3 py-2.5 text-[12.5px] text-ok">{w.open ? `${w.open} open, nothing late.` : "On track: nothing to act on."}</p>
      )}
    </li>
  );
}

export function CopyKpisView({ k }: { k: CopyKpis }) {
  const total = k.split.copy + k.split.creative;
  const copyShare = total ? Math.round((k.split.copy / total) * 100) : 0;
  return (
    <div className="grid gap-12">
      <LiveRefresh />
      <KpiHeader active="copy-kpis" period={k.period} base="/board?view=copy-kpis" />
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Copy · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How copy is going</h2>
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
                  <Link href={a.href} className="group flex h-full items-start gap-3 rounded-[16px] px-3 py-3 hover:bg-ink/[0.04]">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.tone === "bad" ? "bg-bad" : "bg-warn"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium leading-snug">{a.title}</span>
                      <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-faint group-hover:text-fg">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-5 py-3.5 text-[14px] text-ok">No late copy, nothing blocked by a client&apos;s rules, nothing forced through.</p>
        )}
      </section>
      <Section kicker="The team" title="Copywriters" aside={<span className="text-[12px] text-faint">Tap a card for everything on their plate</span>}>
        {k.writers.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {k.writers.map((w) => (
              <WriterCard key={w.id} w={w} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No copy approved in this period yet.</p>
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
                      {c.topRules.length > 0 && <span className="block truncate text-[12px] text-muted">Most flagged: &ldquo;{c.topRules[0].rule}&rdquo;{c.topRules[0].n > 1 ? ` ×${c.topRules[0].n}` : ""}</span>}
                    </span>
                    <span className="tabular flex flex-wrap gap-1.5 text-[11.5px]">
                      <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-muted">{c.sets} sets</span>
                      {c.sendbacks > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">{c.sendbacks} sent back</span>}
                      {c.open > 0 && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-brand-text">{c.open} open</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No copy in this period yet.</p>
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
                    <span className="text-warn">{100 - copyShare}% creative</span>
                  </span>
                </>
              ) : (
                <p className="text-[13px] text-muted">No client changes in this period.</p>
              )}
            </div>
          </Section>

          <Section kicker="Client rules" title="Rebutted and forced through">
            {k.overrides.length ? (
              <ul className="grid gap-1 rounded-[20px] border border-line bg-surface p-2">
                {k.overrides.map((o, i) => (
                  <li key={i}>
                    <Link href={o.number ? `/board?t=${o.number}` : `/clients/${o.slug}`} className="grid gap-0.5 rounded-[12px] px-2.5 py-2 text-[13px] hover:bg-ink/[0.04]">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate">&ldquo;{o.rule}&rdquo;</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${o.kind === "force" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{o.kind === "force" ? "Forced" : "Rebutted"}</span>
                      </span>
                      <span className="truncate text-[11.5px] text-muted">
                        {o.client}
                        {o.by ? ` · ${o.by}` : ""}
                        {o.reason ? ` · ${o.reason}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">Nothing rebutted or forced through.</p>
            )}
          </Section>

          <Section kicker="On the Board" title="Copy late right now">
            {k.late.length ? (
              <ul className="grid rounded-[20px] border border-line bg-surface p-1.5">
                {k.late.map((t) => (
                  <LateRow key={t.number} t={t} />
                ))}
              </ul>
            ) : (
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No copy late on the Board.</p>
            )}
          </Section>
        </div>
      </div>

      <Section kicker="In the feed" title="Copy that's winning" aside={<span className="text-[12px] text-faint">Profitable winners, read for their words</span>}>
        {k.copyWinners.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.copyWinners.map((w) => (
              <WinnerCard key={w.key} w={w} copy={{ ctr: w.ctr, angle: w.angle }} />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No profitable winner with its copy read yet.</p>
        )}
      </Section>

      <Section kicker="In the feed" title="Copy wearing out" aside={<span className="text-[12px] text-faint">Clicks falling while the creative still stops people</span>}>
        {k.copyTiring.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.copyTiring.map((r) => (
              <TiringCard key={`${r.clientId}:${r.adId}`} r={r} copy />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No ad&apos;s words are wearing out.</p>
        )}
        {k.repeated.length > 0 && (
          <div className="grid gap-1 rounded-[20px] border border-line bg-surface p-3">
            <p className="px-1.5 pb-1 text-[12px] font-medium">Angles leaned on again and again (60 days)</p>
            {k.repeated.map((r) => (
              <Link key={`${r.slug}${r.angle}`} href={`/clients/${r.slug}`} className="flex items-baseline justify-between gap-3 rounded-[12px] px-1.5 py-1.5 text-[13px] hover:bg-ink/[0.04]">
                <span className="min-w-0 truncate">
                  {r.angle} <span className="text-muted">· {r.client}</span>
                </span>
                <span className="tabular shrink-0 text-[12px] text-warn">{r.sets} sets</span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section kicker="In the ad accounts" title="Copy that won" aside={<span className="text-[12px] text-faint">Each set&apos;s angle judged in the ad account: profitable winners only</span>}>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4">
            <p className="text-[13px] font-medium">By framework</p>
            {k.frameworks.length ? (
              <ul className="grid gap-2.5">
                {k.frameworks.map((f) => {
                  const tone = f.rate == null ? null : f.rate >= 40 ? "ok" : f.rate >= 20 ? "warn" : "bad";
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
              <p className="text-[13px] text-muted">No approved copy&apos;s angle has been judged in the ad accounts yet.</p>
            )}
          </div>
          <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4">
            <p className="text-[13px] font-medium">Angles the copy rode</p>
            {k.angles.length ? (
              <ul className="grid gap-1">
                {k.angles.map((a) => (
                  <li key={`${a.slug}${a.title}`}>
                    <Link href={`/clients/${a.slug}`} className="flex items-baseline justify-between gap-3 rounded-[12px] px-1.5 py-1.5 text-[13px] hover:bg-ink/[0.04]">
                      <span className="min-w-0 truncate">
                        {a.title} <span className="text-muted">· {a.client}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${a.verdict === "winner" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{a.verdict === "winner" ? "Winner" : "Loser"}</span>
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

      <p className="text-[11px] text-faint">Business days. Timings from the Board&apos;s ticket history; client changes from the portal; results from the ad accounts&apos; angles.</p>
    </div>
  );
}
