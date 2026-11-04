import Link from "next/link";
import { PERIODS, type CreativeKpis, type Headline, type Maker, type Period } from "@/lib/creative-kpis";
import { LiveRefresh, Tween } from "./live-kpis";
import { AllotmentList, CheckErrors, ClientRevisions, LateRow, PersonCard, PersonSheet, TiringCard, WinnerCard, WinnersSheet } from "./kpi-parts";

// The creative team's KPIs (execs and leads, a tab on the Board), built to read top to bottom: how it's going in six
// numbers, the few things to act on, the team by role (tap anyone for everything on their plate, glance into what came
// back and their real errors), every client's allotment this cycle (critical first), where changes come from, what's
// late, and the ads themselves: winners to brief more of and tiring ones to replace. Everything opens where it's handled.

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const TONE_SOFT = { ok: "bg-ok-soft", warn: "bg-warn-soft", bad: "bg-bad-soft" } as const;
const TONE_BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
export const TONES = { TONE_TEXT, TONE_SOFT, TONE_BAR };

/** The Board's views, a compact switch beside the title (execs and leads only; the page checks on the server) */
export function BoardTabs({ active }: { active: "board" | "kpis" | "copy-kpis" }) {
  return (
    <nav aria-label="Board views" className="inline-flex rounded-full bg-ink/[0.06] p-1 text-[13px]">
      {(
        [
          ["board", "Board", "/board"],
          ["kpis", "Creative KPIs", "/board?view=kpis"],
          ["copy-kpis", "Copy KPIs", "/board?view=copy-kpis"],
        ] as const
      ).map(([k, label, href]) => (
        <Link
          key={k}
          href={href}
          aria-current={active === k ? "page" : undefined}
          className={`grid h-8 place-items-center whitespace-nowrap rounded-full px-3.5 transition-colors max-md:h-10 ${active === k ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-muted hover:text-fg"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** The KPI tabs' header: the Board title with its views, and the period */
export function KpiHeader({ active, period, base }: { active: "kpis" | "copy-kpis"; period: Period; base: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-3xl">Board</h1>
        <BoardTabs active={active} />
      </div>
      <nav aria-label="Period" className="inline-flex rounded-full border border-line p-1 text-[12.5px]">
        {PERIODS.map((p) => (
          <Link key={p.key} href={`${base}${p.key === "cycle" ? "" : `&period=${p.key}`}`} aria-current={period === p.key ? "true" : undefined} className={`grid h-8 place-items-center whitespace-nowrap rounded-full px-3 max-md:h-10 ${period === p.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
            {p.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Delta({ h }: { h: Headline }) {
  if (h.value == null || h.previous == null) return null;
  const diff = Math.round((h.value - h.previous) * 10) / 10;
  if (Math.abs(diff) < (h.unit === "%" ? 2 : 0.2)) return <span className="text-[11px] text-faint">steady</span>;
  const good = h.better === "down" ? diff < 0 : diff > 0;
  return (
    <span className={`tabular inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${good ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff)}
      {h.unit === "%" ? " pts" : "d"}
    </span>
  );
}

/** One number, how it moved, and what that means in a sentence */
export function HeadlineCard({ h }: { h: Headline }) {
  return (
    <div className="grid content-between gap-3 rounded-[20px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] text-muted">{h.label}</span>
        <Delta h={h} />
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`tabular font-display text-[36px] leading-none tracking-tight ${h.tone ? TONE_TEXT[h.tone] : "text-fg"}`}>{h.value == null ? "—" : <Tween value={h.value} decimals={h.unit === "d" || !Number.isInteger(h.value) ? 1 : 0} />}</span>
        {h.value != null && <span className="text-[13px] text-muted">{h.unit === "d" ? "days" : h.unit}</span>}
      </div>
      <p className="text-[12px] leading-snug text-muted">{h.verdict}</p>
    </div>
  );
}

/** Kept for the copy tab's older cards: pieces per week as a little line */
export function Spark({ data }: { data: number[] }) {
  void data;
  return null;
}

export function Meter({ value, target, label }: { value: number | null; target: number; label: string }) {
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

export function Section({ title, kicker, children, aside, id }: { title: string; kicker?: string; children: React.ReactNode; aside?: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="grid scroll-mt-24 gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          {kicker && <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{kicker}</p>}
          <h2 className="font-heading text-[22px] leading-tight">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const ROLE_ORDER: { key: string; title: string }[] = [
  { key: "graphic_designer", title: "Graphic designers" },
  { key: "video_editor", title: "Video editors" },
  { key: "copywriter", title: "Copywriters" },
];

function rate(n: number, of: number) {
  return of ? `${Math.round((n / of) * 100)}%` : "—";
}

export function CreativeKpisView({ k, canDismiss }: { k: CreativeKpis; canDismiss: boolean }) {
  const total = k.split.copy + k.split.creative;
  const copyShare = total ? Math.round((k.split.copy / total) * 100) : 0;
  const groups = [...ROLE_ORDER.map((r) => ({ ...r, people: k.makers.filter((m) => m.roleKey === r.key) })), { key: "other", title: "Others", people: k.makers.filter((m) => !ROLE_ORDER.some((r) => r.key === m.roleKey)) }].filter((g) => g.people.length);
  const ts = k.teamSendbacks;
  return (
    <div className="grid gap-12">
      <LiveRefresh />
      <PersonSheet makers={k.makers as Maker[]} />
      <WinnersSheet makers={k.makers as Maker[]} />
      <KpiHeader active="kpis" period={k.period} base="/board?view=kpis" />

      {/* How it's going */}
      <section className="grid gap-5">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Creative · last {k.days} days</p>
          <h2 className="mt-1 font-heading text-[32px] leading-[1.05] tracking-tight md:text-[40px]">How creative is going</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
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
          <p className="rounded-[18px] bg-ok-soft px-5 py-3.5 text-[14px] text-ok">Nothing urgent: no late work, nobody behind on their allotment, nobody overloaded.</p>
        )}
      </section>

      {/* The team, by role */}
      <Section
        kicker="The team"
        title="Who's making what"
        aside={
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="rounded-full border border-line px-3 py-1.5">
              Sent back internally <b className="tabular font-semibold text-fg">{rate(ts.d45.internal, ts.d45.pieces)}</b> 45d · {rate(ts.d90.internal, ts.d90.pieces)} 90d
            </span>
            <span className="rounded-full border border-line px-3 py-1.5">
              By clients <b className="tabular font-semibold text-fg">{rate(ts.d45.client, ts.d45.pieces)}</b> 45d · {rate(ts.d90.client, ts.d90.pieces)} 90d
            </span>
            {canDismiss && <CheckErrors unsorted={k.errorsUnsorted} />}
          </span>
        }
      >
        {groups.length ? (
          <div className="grid gap-8">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(
                [
                  ["Brief → client", k.teamAvg.briefToDone == null ? "—" : `${k.teamAvg.briefToDone}d`, "team average"],
                  ["Met due date", k.teamAvg.metDue == null ? "—" : `${k.teamAvg.metDue}%`, "team average"],
                  ["Due dates pushed back", k.teamAvg.pushedBack == null ? "—" : `${k.teamAvg.pushedBack}%`, "of pieces held"],
                  ["Revision back in", k.teamAvg.revisionTurnaround == null ? "—" : `${k.teamAvg.revisionTurnaround}d`, "team average"],
                  ["Winning ads", String(k.teamAvg.winners), "credited to the team"],
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
                    <PersonCard key={m.profileId ?? m.name} m={m} />
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[11.5px] text-faint">Tap a card for everything on their plate. Hover the score for how it&apos;s worked out (first pass 40%, turnaround 30%, revision turnaround 15%, nothing left sitting 15%). Errors are objective mistakes only, read from internal and client feedback.</p>
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-8 text-center text-[14px] text-muted">No designer, editor or copywriter passed work on in this period yet.</p>
        )}
      </Section>

      {/* Clients */}
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-8">
        <Section kicker="Clients" title="Allotments this billing cycle">
          {k.allotments.length ? <AllotmentList rows={k.allotments} canDismiss={canDismiss} /> : <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No client is on a creative package.</p>}
        </Section>

        <div className="grid content-start gap-12 lg:gap-8">
          <Section kicker="Quality" title="Where changes come from">
            <div className="grid gap-4 rounded-[22px] border border-line bg-surface p-5">
              {total ? (
                <div className="grid gap-2">
                  <div className="flex items-baseline justify-between">
                    <span className="tabular font-display text-[30px] leading-none">
                      <Tween value={total} />
                    </span>
                    <span className="text-[12px] text-muted">changes asked for</span>
                  </div>
                  <span className="flex h-2 overflow-hidden rounded-full bg-ink/[0.07]">
                    <span className="bg-brand-text" style={{ width: `${copyShare}%` }} />
                    <span className="bg-warn" style={{ width: `${100 - copyShare}%` }} />
                  </span>
                  <span className="flex justify-between text-[12px]">
                    <span className="text-brand-text">{copyShare}% copy</span>
                    <span className="text-warn">{100 - copyShare}% creative</span>
                  </span>
                </div>
              ) : (
                <p className="text-[13px] text-muted">No changes asked for in this period.</p>
              )}
              {k.revisionClients.length > 0 && (
                <div className="grid border-t border-line pt-3">
                  <p className="pb-1 text-[11px] text-faint">Sending the most back · hover a client for their latest</p>
                  {k.revisionClients.slice(0, 5).map((c) => (
                    <ClientRevisions key={c.client} c={c} />
                  ))}
                </div>
              )}
              {k.slowClients.length > 0 && (
                <div className="grid border-t border-line pt-3">
                  <p className="pb-1 text-[11px] text-faint">Slowest to a first draft</p>
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

          <Section kicker="On the Board" title="Late right now">
            {k.late.length ? (
              <ul className="grid rounded-[22px] border border-line bg-surface p-1.5">
                {k.late.map((t) => (
                  <LateRow key={t.number} t={t} />
                ))}
              </ul>
            ) : (
              <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">Nothing late on the Board.</p>
            )}
          </Section>
        </div>
      </div>

      {/* The ads */}
      <Section
        kicker="In the ad accounts"
        title="Winners to build on"
        aside={
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="rounded-full border border-line px-3 py-1.5">
              <b className="tabular font-semibold text-fg">{k.results.hitRate == null ? "—" : `${k.results.hitRate}%`}</b> of new creative won
              {k.results.previousHitRate != null && ` (was ${k.results.previousHitRate}%)`}
            </span>
            <span className="rounded-full border border-line px-3 py-1.5">
              <span className="text-ok">{k.results.winners} won</span> · <span className="text-bad">{k.results.losers} lost</span> · {k.results.testing} testing
            </span>
          </span>
        }
      >
        {k.winners.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.winners.map((w) => (
              <WinnerCard key={w.key} w={w} />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">No profitable winners judged yet. If it isn&apos;t profitable, it isn&apos;t working.</p>
        )}
      </Section>

      <Section id="tiring" kicker="In the ad accounts" title="Tiring ads to replace" aside={<span className="text-[12px] text-faint">Each ad against its own last three weeks</span>}>
        {k.watch.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {k.watch.map((r) => (
              <TiringCard key={`${r.clientId}:${r.adId}`} r={r} />
            ))}
          </div>
        ) : (
          <p className="rounded-[18px] bg-ok-soft px-4 py-3 text-[13px] text-ok">No ad is tiring.</p>
        )}
      </Section>

      <p className="text-[11px] text-faint">
        Business days. Production from the Creative board&apos;s history{k.source.asana ? "" : " (no history read yet)"} and the Board&apos;s tickets; allotments from each client&apos;s billing cycle; results from the ad accounts (profitable winners only).
      </p>
    </div>
  );
}
