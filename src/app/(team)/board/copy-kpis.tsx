import Link from "next/link";
import { PERIODS } from "@/lib/creative-kpis";
import type { Copywriter, CopyKpis } from "@/lib/copy-kpis";
import { HeadlineCard, Meter, Section, Spark, TONES } from "./creative-kpis";
import { LiveRefresh, Tween } from "./live-kpis";

// The copy team's KPIs (execs and leads, a tab on the Board): what to act on first, how fast copy moves from approved
// creative to an AI draft to approved, how often it's approved first time by us and by the client, what the client-rule
// check flags (and what's rebutted or forced through), each copywriter's card, each client's copy, and which angles and
// frameworks the copy rode into profitable winners.

const { TONE_TEXT } = TONES;

function WriterCard({ w }: { w: Copywriter }) {
  return (
    <li className="grid content-start gap-4 rounded-[20px] border border-line bg-surface p-4 md:p-5">
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
      <div className="flex items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <span className={`tabular text-[22px] font-medium leading-none ${w.turnaround != null && w.turnaround > 1 ? "text-warn" : ""}`}>{w.turnaround == null ? "—" : `${w.turnaround}d`}</span>
          <span className="text-[11px] text-muted">draft → approved</span>
        </div>
        <Spark data={w.weekly} />
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
        <Link href={`/board?person=${w.id}`} className="rounded-[12px] bg-warn-soft px-3 py-2.5 text-[12.5px] leading-snug text-warn hover:underline">
          → {w.act}
        </Link>
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
    <div className="grid gap-8">
      <LiveRefresh />
      <div className="relative isolate grid gap-5 overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-6 pt-7 md:px-8 md:pb-8 md:pt-9">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full bg-brand/25 blur-[110px]" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Copy team</p>
            <h1 className="mt-1.5 font-heading text-[30px] leading-[1.05] tracking-tight md:text-[40px]">How copy is going</h1>
            <p className="mt-2 max-w-xl text-[14px] text-muted">
              From approved creative to approved copy over the last {k.days} days against the {k.days} before: speed, first-time approvals, what the client&apos;s rules flag, and which copy rode into profitable winners.
            </p>
          </div>
          <nav aria-label="Period" className="flex w-full rounded-full border border-line bg-surface p-0.5 text-[13px] md:w-auto">
            {PERIODS.map((p) => (
              <Link key={p.key} href={`/board?view=copy-kpis${p.key === "cycle" ? "" : `&period=${p.key}`}`} aria-current={k.period === p.key ? "true" : undefined} className={`grid h-10 flex-1 place-items-center whitespace-nowrap rounded-full px-3 md:h-8 md:flex-initial ${k.period === p.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-fg">{k.actions.length ? "Act on this first" : "Nothing urgent"}</p>
          {k.actions.length ? (
            <ul className="grid gap-2 md:grid-cols-2">
              {k.actions.map((a) => (
                <li key={a.key}>
                  <Link href={a.href} className={`group flex h-full items-start gap-3 rounded-[16px] border px-4 py-3 transition-colors ${a.tone === "bad" ? "border-bad/30 bg-bad-soft hover:border-bad/60" : "border-warn/30 bg-warn-soft hover:border-warn/60"}`}>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.tone === "bad" ? "bg-bad" : "bg-warn"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium leading-snug text-fg">{a.title}</span>
                      <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-muted group-hover:text-fg">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[14px] text-ok">No late copy, nothing blocked by a client&apos;s rules, nothing forced through. Keep it going.</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {k.headlines.map((h) => (
          <HeadlineCard key={h.key} h={h} />
        ))}
      </div>

      <Section kicker="The team" title="Each copywriter" aside={<span className="text-[12px] text-faint">Sets approved, how fast, how often first time, what came back</span>}>
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
            <ul className="grid gap-1 rounded-[20px] border border-line bg-surface p-1.5 md:p-2">
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
              <ul className="grid gap-1 rounded-[20px] border border-line bg-surface p-2">
                {k.late.map((t) => (
                  <li key={t.number}>
                    <Link href={`/board?t=${t.number}`} className="flex items-baseline justify-between gap-3 rounded-[12px] px-2.5 py-2 text-[13px] hover:bg-ink/[0.04]">
                      <span className="min-w-0 truncate">
                        <span className="text-faint">#{t.number}</span> {t.client && <span className="text-muted">{t.client} · </span>}
                        {t.title}
                      </span>
                      <span className="tabular shrink-0 text-[12px] text-bad">{t.hoursOver}h over</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No copy late on the Board.</p>
            )}
          </Section>
        </div>
      </div>

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
