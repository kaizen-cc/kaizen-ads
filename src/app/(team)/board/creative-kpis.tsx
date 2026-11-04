import Link from "next/link";
import { PERIODS, type ClientAllotment, type CreativeKpis, type Headline, type Maker } from "@/lib/creative-kpis";
import { untilLabel } from "@/lib/allotment";

// The creative team's KPIs (execs and leads, a tab on the Board): what to act on first, the headline numbers against
// the period before with a plain verdict, each maker's card, every creative-package client's allotment this cycle,
// and how the new creative is doing in the ad accounts. Everything links to where it's handled.

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const TONE_SOFT = { ok: "bg-ok-soft", warn: "bg-warn-soft", bad: "bg-bad-soft" } as const;
const TONE_BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
const fmt = (v: number | null, unit: string) => (v == null ? "—" : unit === "d" ? `${v.toFixed(1)}` : `${v}`);

/** The Board's two views, in the address */
export function BoardTabs({ active }: { active: "board" | "kpis" }) {
  return (
    <nav aria-label="Board views" className="flex w-full rounded-full border border-line bg-surface p-0.5 text-sm md:w-auto md:self-start">
      {(
        [
          ["board", "Board", "/board"],
          ["kpis", "Creative KPIs", "/board?view=kpis"],
        ] as const
      ).map(([k, label, href]) => (
        <Link key={k} href={href} aria-current={active === k ? "page" : undefined} className={`grid h-10 flex-1 place-items-center rounded-full px-4 md:h-8 md:flex-initial ${active === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Delta({ h }: { h: Headline }) {
  if (h.value == null || h.previous == null) return <span className="text-[11px] text-faint">no comparison yet</span>;
  const diff = Math.round((h.value - h.previous) * 10) / 10;
  if (Math.abs(diff) < (h.unit === "%" ? 2 : 0.2)) return <span className="text-[11px] text-muted">steady</span>;
  const good = h.better === "down" ? diff < 0 : diff > 0;
  return (
    <span className={`tabular inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${good ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff)}
      {h.unit === "%" ? " pts" : "d"}
    </span>
  );
}

function HeadlineCard({ h }: { h: Headline }) {
  return (
    <div className="relative isolate grid content-between gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
      {h.tone && <span aria-hidden className={`pointer-events-none absolute -right-10 -top-12 -z-10 h-32 w-32 rounded-full opacity-70 blur-[50px] ${TONE_SOFT[h.tone]}`} />}
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] text-muted">{h.label}</span>
        <Delta h={h} />
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`tabular font-display text-[40px] leading-none tracking-tight md:text-[44px] ${h.tone ? TONE_TEXT[h.tone] : "text-fg"}`}>{fmt(h.value, h.unit)}</span>
        {h.value != null && <span className="text-[15px] text-muted">{h.unit === "d" ? "days" : h.unit}</span>}
      </div>
      <div className="grid gap-1">
        <p className="text-[13px] leading-snug text-fg">{h.verdict}</p>
        <p className="text-[11px] text-faint">{h.hint}</p>
      </div>
    </div>
  );
}

/** Pieces passed on per week, as a little line */
function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 3 - (v / max) * (h - 6)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-brand-text" aria-label={`Pieces per week: ${data.join(", ")}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - 3 - (data[data.length - 1] / max) * (h - 6)} r="2.5" fill="currentColor" />
    </svg>
  );
}

function Meter({ value, target, label }: { value: number | null; target: number; label: string }) {
  const tone = value == null ? null : value >= target ? "ok" : value >= target * 0.75 ? "warn" : "bad";
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className={`tabular font-medium ${tone ? TONE_TEXT[tone] : "text-faint"}`}>{value == null ? "—" : `${value}%`}</span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
        <span className={`block h-full rounded-full ${tone ? TONE_BAR[tone] : ""}`} style={{ width: `${Math.max(2, value ?? 0)}%` }} />
      </span>
    </div>
  );
}

function MakerCard({ m }: { m: Maker }) {
  const trend = m.score != null && m.previous != null ? m.score - m.previous : null;
  const scoreTone = m.score == null ? null : m.score >= 75 ? "ok" : m.score >= 60 ? "warn" : "bad";
  return (
    <li className="grid content-start gap-4 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-heading text-[17px] leading-tight">{m.name}</p>
          <p className="text-[12px] text-muted">{m.role}</p>
        </div>
        <div className="text-right">
          <p className={`tabular font-display text-[30px] leading-none ${scoreTone ? TONE_TEXT[scoreTone] : "text-faint"}`}>{m.score ?? "—"}</p>
          <p className="text-[11px] text-muted">
            {m.level}
            {trend != null && trend !== 0 && <span className={trend > 0 ? "text-ok" : "text-bad"}> {trend > 0 ? "▲" : "▼"}{Math.abs(trend)}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="tabular text-[22px] font-medium leading-none">{m.pieces}</span>
          <span className="text-[11px] text-muted">pieces passed on</span>
        </div>
        <Spark data={m.weekly} />
      </div>
      <div className="grid gap-2.5">
        <Meter value={m.firstPass} target={70} label="First-pass approval" />
        <Meter value={m.onTime} target={80} label="On time" />
      </div>
      <dl className="tabular grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Turnaround", m.turnaround == null ? "—" : `${m.turnaround}d`, m.turnaround != null && m.turnaround > m.turnaroundTarget ? "text-warn" : "text-fg"],
            ["Revisions", m.revisionTurnaround == null ? "—" : `${m.revisionTurnaround}d`, m.revisionTurnaround != null && m.revisionTurnaround > 1 ? "text-warn" : "text-fg"],
            ["Open", String(m.open + m.sitting.length), m.late || m.sitting.length > 2 ? "text-warn" : "text-fg"],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k} className="rounded-[12px] bg-ink/[0.04] px-2 py-2">
            <dd className={`text-[15px] font-medium ${c}`}>{v}</dd>
            <dt className="text-[10.5px] text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      {m.act ? (
        <Link href={m.profileId ? `/board?person=${m.profileId}` : "/board"} className="rounded-[12px] bg-warn-soft px-3 py-2.5 text-[12.5px] leading-snug text-warn hover:underline">
          → {m.act}
        </Link>
      ) : (
        <p className="rounded-[12px] bg-ok-soft px-3 py-2.5 text-[12.5px] text-ok">On track: nothing to act on.</p>
      )}
    </li>
  );
}

const STATUS: Record<ClientAllotment["status"], { label: string; tone: "ok" | "warn" | "bad" }> = {
  missed: { label: "Missed last cycle", tone: "bad" },
  at_risk: { label: "At risk", tone: "bad" },
  behind: { label: "Behind", tone: "warn" },
  on_track: { label: "On track", tone: "ok" },
  ahead: { label: "Ahead", tone: "ok" },
};

function AllotmentRow({ a }: { a: ClientAllotment }) {
  const s = STATUS[a.status];
  const share = a.cap ? Math.min(1, a.used / a.cap) : null;
  return (
    <li>
      <Link href={`/clients/${a.slug}`} className="grid gap-2 rounded-[14px] px-3 py-3 hover:bg-ink/[0.04] md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] md:items-center md:gap-4">
        <span className="min-w-0 truncate text-[14px]">{a.name}</span>
        <span className="relative h-2.5 overflow-hidden rounded-full bg-ink/[0.07]" aria-label={`${a.used} of ${a.cap ?? "?"} used, ${Math.round(a.elapsed * 100)}% through the cycle`}>
          {share != null && <span className={`absolute inset-y-0 left-0 rounded-full ${TONE_BAR[s.tone]}`} style={{ width: `${Math.max(3, share * 100)}%` }} />}
          {/* Where they should be by now */}
          <span className="absolute inset-y-[-2px] w-[2px] bg-fg/60" style={{ left: `${a.elapsed * 100}%` }} />
        </span>
        <span className="flex items-center justify-between gap-3 md:justify-end">
          <span className="tabular text-[12px] text-muted">
            {a.used}/{a.cap ?? "?"}
            {a.resets && <span className="text-faint"> · resets {untilLabel(a.resets)}</span>}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TONE_SOFT[s.tone]} ${TONE_TEXT[s.tone]}`}>{s.label}</span>
        </span>
      </Link>
    </li>
  );
}

function Section({ title, kicker, children, aside }: { title: string; kicker?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          {kicker && <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{kicker}</p>}
          <h2 className="font-heading text-[21px] leading-tight">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function CreativeKpisView({ k }: { k: CreativeKpis }) {
  const total = k.split.copy + k.split.creative;
  const copyShare = total ? Math.round((k.split.copy / total) * 100) : 0;
  const counts = { missed: 0, at_risk: 0, behind: 0, on_track: 0, ahead: 0 };
  for (const a of k.allotments) counts[a.status]++;
  return (
    <div className="grid gap-8">
      {/* Header: what this is, and the period */}
      <div className="relative isolate grid gap-5 overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-6 pt-7 md:px-8 md:pb-8 md:pt-9">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full bg-brand/25 blur-[110px]" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Creative team</p>
            <h1 className="mt-1.5 font-heading text-[30px] leading-[1.05] tracking-tight md:text-[40px]">How creative is going</h1>
            <p className="mt-2 max-w-xl text-[14px] text-muted">
              Speed, quality and volume over the last {k.days} days against the {k.days} before, every client&apos;s allotment this billing cycle, and what the new creative is doing in the ad accounts.
            </p>
          </div>
          <nav aria-label="Period" className="flex w-full rounded-full border border-line bg-surface p-0.5 text-[13px] md:w-auto">
            {PERIODS.map((p) => (
              <Link key={p.key} href={`/board?view=kpis${p.key === "cycle" ? "" : `&period=${p.key}`}`} aria-current={k.period === p.key ? "true" : undefined} className={`grid h-10 flex-1 place-items-center whitespace-nowrap rounded-full px-3 md:h-8 md:flex-initial ${k.period === p.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Act on this */}
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
            <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[14px] text-ok">No late work, no client behind on their allotment, nobody overloaded. Keep it going.</p>
          )}
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {k.headlines.map((h) => (
          <HeadlineCard key={h.key} h={h} />
        ))}
      </div>

      {/* Makers */}
      <Section kicker="The team" title="Each maker" aside={<span className="text-[12px] text-faint">Score weighs first pass, turnaround, revisions and nothing left sitting</span>}>
        {k.makers.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {k.makers.map((m) => (
              <MakerCard key={m.profileId ?? m.name} m={m} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No designer, editor or copywriter passed work on in this period yet.</p>
        )}
      </Section>

      {/* Clients */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section
          kicker="Clients"
          title="Allotments this billing cycle"
          aside={
            <span className="flex flex-wrap gap-1.5 text-[11px]">
              {(["missed", "at_risk", "behind", "on_track", "ahead"] as const)
                .filter((s) => counts[s])
                .map((s) => (
                  <span key={s} className={`rounded-full px-2 py-0.5 ${TONE_SOFT[STATUS[s].tone]} ${TONE_TEXT[STATUS[s].tone]}`}>
                    {counts[s]} {STATUS[s].label.toLowerCase()}
                  </span>
                ))}
            </span>
          }
        >
          {k.allotments.length ? (
            <div className="rounded-[20px] border border-line bg-surface p-1.5 md:p-2">
              <p className="px-3 pb-1 pt-2 text-[11px] text-faint">The bar is what&apos;s been made; the line is where they should be by now in their cycle.</p>
              <ul className="grid">
                {k.allotments.map((a) => (
                  <AllotmentRow key={a.id} a={a} />
                ))}
              </ul>
            </div>
          ) : (
            <p className="rounded-[16px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No client is on a creative package.</p>
          )}
        </Section>

        <div className="grid content-start gap-8">
          <Section kicker="Quality" title="Where changes come from">
            <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4">
              {total ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="tabular font-display text-[32px] leading-none">{total}</span>
                    <span className="text-[12px] text-muted">changes asked for</span>
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
                <p className="text-[13px] text-muted">No changes asked for in this period.</p>
              )}
              {k.revisionClients.length > 0 && (
                <div className="grid gap-1 border-t border-line pt-3">
                  <p className="text-[11px] text-faint">Sending the most back</p>
                  {k.revisionClients.slice(0, 4).map((c) => (
                    <Link key={c.client} href={c.slug ? `/clients/${c.slug}` : "#"} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px] hover:text-fg">
                      <span className="min-w-0 truncate">{c.client}</span>
                      <span className="tabular shrink-0 text-[12px] text-warn">{c.perPiece} per piece</span>
                    </Link>
                  ))}
                </div>
              )}
              {k.slowClients.length > 0 && (
                <div className="grid gap-1 border-t border-line pt-3">
                  <p className="text-[11px] text-faint">Slowest to a first draft</p>
                  {k.slowClients.slice(0, 4).map((c) => (
                    <Link key={c.client} href={c.slug ? `/clients/${c.slug}` : "#"} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px] hover:text-fg">
                      <span className="min-w-0 truncate">{c.client}</span>
                      <span className="tabular shrink-0 text-[12px] text-warn">{c.days}d avg</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section kicker="On the Board" title="Late right now">
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
              <p className="rounded-[16px] bg-ok-soft px-4 py-3 text-[13px] text-ok">Nothing late on the Board.</p>
            )}
          </Section>
        </div>
      </div>

      {/* In the ad accounts */}
      <Section kicker="In the ad accounts" title="What the new creative is doing" aside={<span className="text-[12px] text-faint">Profitable winners only: if it isn&apos;t profitable, it isn&apos;t working</span>}>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="grid content-start gap-4 rounded-[20px] border border-line bg-surface p-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="tabular font-display text-[44px] leading-none">{k.results.hitRate == null ? "—" : `${k.results.hitRate}%`}</p>
                <p className="mt-1 text-[12px] text-muted">of judged new creative became a winner</p>
              </div>
              {k.results.previousHitRate != null && k.results.hitRate != null && <span className={`tabular text-[12px] ${k.results.hitRate >= k.results.previousHitRate ? "text-ok" : "text-bad"}`}>{k.results.previousHitRate}% the period before</span>}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ["Winners", k.results.winners, "text-ok"],
                  ["Losers", k.results.losers, "text-bad"],
                  ["Still testing", k.results.testing, "text-muted"],
                ] as const
              ).map(([label, n, c]) => (
                <div key={label} className="rounded-[12px] bg-ink/[0.04] px-2 py-2.5">
                  <p className={`tabular text-[20px] font-medium leading-none ${c}`}>{n}</p>
                  <p className="mt-1 text-[11px] text-muted">{label}</p>
                </div>
              ))}
            </div>
            {k.results.topClients.length > 0 && (
              <div className="grid gap-1 border-t border-line pt-3">
                <p className="text-[11px] text-faint">Most winners</p>
                {k.results.topClients.map((c) => (
                  <Link key={c.slug} href={`/clients/${c.slug}`} className="flex items-baseline justify-between gap-3 py-1 text-[13px] hover:text-fg">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="tabular shrink-0 text-[12px] text-ok">
                      {c.winners} of {c.judged}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-[13px] font-medium">Tiring ads</p>
              <Link href="/fatigue" className="text-[12px] text-muted hover:text-fg">
                All →
              </Link>
            </div>
            {k.tiring.length ? (
              <ul className="grid gap-1.5">
                {k.tiring.map((t) => (
                  <li key={`${t.slug}${t.ad}`}>
                    <Link href={`/clients/${t.slug}`} className="flex items-center gap-3 rounded-[12px] px-1.5 py-1.5 hover:bg-ink/[0.04]">
                      {t.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.thumbnail} alt="" className="h-10 w-10 shrink-0 rounded-[8px] bg-ink/[0.06] object-cover" />
                      ) : (
                        <span className="h-10 w-10 shrink-0 rounded-[8px] bg-ink/[0.06]" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{t.ad}</span>
                        <span className="block truncate text-[11px] text-muted">{t.client}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${t.refreshing ? "bg-ok-soft text-ok" : t.severity === "tired" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{t.refreshing ? "Refreshing" : t.severity === "tired" ? "Tired" : "Tiring"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ok">No ad is tiring.</p>
            )}
          </div>
        </div>
      </Section>

      <p className="text-[11px] text-faint">
        Business days. Production from the Creative board&apos;s history{k.source.asana ? "" : " (no history read yet)"} and the Board&apos;s tickets; allotments from each client&apos;s billing cycle; results from the ad accounts.
      </p>
    </div>
  );
}
