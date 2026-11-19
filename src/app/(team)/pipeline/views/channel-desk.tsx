import Link from "next/link";
import { HoverCard } from "@/components/hover-card";
import { ChannelSpark } from "@/components/channel-spark";
import { ChannelStatusPill, ConnectCta, Gauge, SupportChips, TONE, mainCaption, mainText, targetText } from "@/components/channel-parts";
import { BAND_TONE, WeighingDown } from "@/components/email-score-parts";
import { SocialWeighingDown } from "@/components/social-score-parts";
import type { ChannelRow } from "@/lib/channel-kpis/load";
import type { Risk } from "@/lib/channel-kpis/calc";
import type { Brand } from "@/lib/overview-desk-load";
import type { Reminder } from "@/lib/overview-desk";
import { BrandChip } from "./overview-tabs";

// The pieces of the email and social Overview's tabs: compact client cards (four across on a wide screen, one on a
// phone) that open for the detail, the team's accounts in a contained scrolling area so the page stays short, the
// audit and sprint reminders, and the clients still to connect.

export type DeskRow = ChannelRow & { risk: Risk; brand: Brand };

const NO_BRAND: Brand = { color: null, light: false, logo: null };
export const brandOf = (m: Map<string, Brand>, id: string) => m.get(id) ?? NO_BRAND;

/** The ways into a client: their page, the Email Board (email), their KPI sheet and reports */
function QuickLinks({ r }: { r: DeskRow }) {
  const links = [
    { href: `/clients/${r.slug}?service=${r.line}`, label: "Client" },
    ...(r.line === "email" ? [{ href: `/board/email?client=${encodeURIComponent(r.slug)}&person=all`, label: "Board" }] : []),
    { href: `/kpis?p=${r.line}&open=${encodeURIComponent(r.clientId)}`, label: "KPIs" },
    { href: `/reports?client=${encodeURIComponent(r.slug)}`, label: "Reports" },
  ];
  return (
    <nav aria-label={`${r.name} links`} className={`grid gap-px border-t border-line bg-line ${links.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
      {links.map((l) => (
        <Link key={l.label} href={l.href} className="grid min-h-11 place-items-center bg-surface text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-9">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/** One client, small: who, why it's here and the main number; opens for the trend, what weighs on it and the crew */
export function ClientCard({ r }: { r: DeskRow }) {
  const tone = TONE[r.status];
  const goal = r.target != null && r.series.length ? (r.line === "email" ? { from: 0, to: r.target } : { from: r.target, to: r.target }) : null;
  const why = r.risk.reasons.length ? r.risk.reasons.join(" · ") : "On track";
  return (
    <li className="relative isolate grid min-w-0 content-between overflow-hidden rounded-[16px] border border-line bg-surface">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
      <span aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={{ backgroundImage: `radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, ${r.brand.color ?? tone.css} 10%, transparent), transparent 60%)` }} />
      <details className="group/card">
        <summary className="grid cursor-pointer list-none gap-2.5 p-3.5 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2.5">
            <BrandChip name={r.name} color={r.brand.color} logo={r.brand.logo} light={r.brand.light} size="sm" />
            <span className="grid min-w-0 flex-1">
              <span className="truncate font-heading text-[15px] leading-snug">{r.name}</span>
              <span className={`truncate text-[11.5px] ${r.risk.reasons.length ? "text-muted" : "text-faint"}`} title={why}>
                {why}
              </span>
            </span>
          </span>
          <span className="flex items-end justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-1.5">
              {r.score ? (
                <>
                  <span className={`tabular font-display text-[26px] leading-none tracking-tight ${BAND_TONE[r.score.band].text}`}>{r.score.score}</span>
                  <span className="truncate text-[11px] text-faint">score · {mainCaption(r)}</span>
                </>
              ) : (
                <>
                  <span className={`tabular font-display text-[24px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
                  <span className="tabular truncate text-[11px] text-faint">{r.target != null ? `/ ${targetText(r)}` : mainCaption(r)}</span>
                </>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <ChannelStatusPill status={r.status} line={r.line} />
              <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full text-faint transition-transform group-open/card:rotate-180">
                ⌄
              </span>
            </span>
          </span>
          <Gauge r={r} />
        </summary>
        <div className="grid gap-2.5 px-3.5 pb-3.5">
          <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} label={`${r.name} trend`} />
          {r.score && <WeighingDown score={r.score} limit={2} currency={r.currency} />}
          {r.socialScore && (
            <div className="grid gap-1.5">
              <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-faint">Social score</span>
                <span className={`tabular font-heading text-[15px] ${BAND_TONE[r.socialScore.band].text}`}>{r.socialScore.score}</span>
              </span>
              <SocialWeighingDown drags={r.socialScore.weighingDown} limit={2} />
            </div>
          )}
          <SupportChips r={r} />
          {r.team.length > 0 && <p className="truncate text-[11.5px] text-faint">{r.team.map((t) => `${t.seat}: ${t.name}`).join(" · ")}</p>}
        </div>
      </details>
      <QuickLinks r={r} />
    </li>
  );
}

const GRID = "grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** A group of client cards; `contained` keeps a long list in its own scrolling area so the page stays short */
export function ClientGroup({ id, title, aside, rows, contained = false, empty }: { id: string; title: string; aside?: string; rows: DeskRow[]; contained?: boolean; empty?: string }) {
  return (
    <section id={id} className="grid scroll-mt-24 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          {title} <span className="tabular text-[15px] text-faint">{rows.length}</span>
        </h2>
        {aside && <span className="text-xs text-faint">{aside}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">{empty ?? "Nothing here."}</p>
      ) : contained ? (
        <div className="relative rounded-[20px] border border-line bg-bg/40">
          <div className="max-h-[min(68vh,760px)] overflow-y-auto overscroll-contain p-3">
            <ul className={GRID}>
              {rows.map((r) => (
                <ClientCard key={r.clientId} r={r} />
              ))}
            </ul>
          </div>
          {rows.length > 8 && <span aria-hidden className="pointer-events-none absolute inset-x-px bottom-px h-10 rounded-b-[20px] bg-gradient-to-t from-bg to-transparent" />}
        </div>
      ) : (
        <ul className={GRID}>
          {rows.map((r) => (
            <ClientCard key={r.clientId} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

const LEVEL = {
  critical: { label: "Critical", chip: "bg-bad-soft text-bad", bar: "bg-bad" },
  stale: { label: "Gone stale", chip: "bg-warn-soft text-warn", bar: "bg-warn" },
  open: { label: "Open", chip: "bg-ink/[0.06] text-muted", bar: "bg-faint" },
} as const;
const BAND_TEXT = { bad: "text-bad", watch: "text-warn", good: "text-ok" } as const;

/** Audits and sprints as compact reminders, in a contained list */
export function Reminders({ items, line, clients, head, href, board }: { items: Reminder[]; line: "email" | "social" | "meta" | "google"; clients: Map<string, { name: string; brand: Brand }>; head: boolean; /** Where one opens (default: the email or social audit and sprint pages) */ href?: (r: Reminder) => string; /** The board the rest stays on, in words */ board?: string }) {
  const open = href ?? ((r: Reminder) => `/kpis/${line}-${r.kind}/${r.id}`);
  if (!items.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">{head ? "Nothing needs you here" : "No open audits or sprints"}</p>
        <p className="max-w-prose text-sm text-muted">
          {head ? `No audit or sprint is critical or has sat untouched. The team works through the rest on their own Overview and ${board ?? `the ${line === "email" ? "Email" : "Social"} board`}.` : "Red accounts audit themselves; what an audit asks for shows here until it's done."}
        </p>
      </section>
    );
  const crit = items.filter((i) => i.level === "critical").length;
  const stale = items.filter((i) => i.level === "stale").length;
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">{head ? "Needs you" : "Your audits and sprints"}</h2>
        <span className="text-xs text-faint">{[crit ? `${crit} critical` : "", stale ? `${stale} gone stale` : "", head ? "the rest stays with whoever owns it" : ""].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="max-h-[min(68vh,700px)] overflow-y-auto overscroll-contain rounded-[20px] border border-line bg-surface">
        <ul className="divide-y divide-line">
          {items.map((i) => {
            const c = clients.get(i.clientId);
            const lv = LEVEL[i.level];
            return (
              <li key={`${i.kind}:${i.id}`} className="relative">
                <span aria-hidden className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${lv.bar}`} />
                <Link href={open(i)} className="grid min-h-11 gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
                  <span className="flex min-w-0 items-center gap-3">
                    {c && <BrandChip name={c.name} color={c.brand.color} logo={c.brand.logo} light={c.brand.light} size="sm" />}
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="truncate font-heading text-[15px]">{c?.name ?? "A client"}</span>
                        <span className="text-[11.5px] text-faint">{i.kind === "audit" ? "Audit" : "Sprint"}</span>
                        {i.score != null && <span className={`tabular font-display text-[15px] ${i.band ? BAND_TEXT[i.band] : ""}`}>{i.score}</span>}
                      </span>
                      <span className="truncate text-[12.5px] text-muted">{i.why}</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2 pl-11 md:pl-0">
                    {i.progress.of > 0 && (
                      <span className="tabular text-[11.5px] text-faint">
                        {i.progress.done}/{i.progress.of} moves
                      </span>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${lv.chip}`}>{lv.label}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Clients whose numbers can't be read yet, and the one step that fixes each */
export function SetupList({ rows, line }: { rows: DeskRow[]; line: "email" | "social" }) {
  if (!rows.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Everything is connected</p>
        <p className="text-sm text-muted">Every client&apos;s {line === "email" ? "email platform" : "Page and Instagram"} is reading.</p>
      </section>
    );
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Needs connecting <span className="tabular text-[15px] text-faint">{rows.length}</span>
        </h2>
        <span className="text-xs text-faint">{line === "email" ? "Paste the client's Klaviyo key" : "Share the Page, or pick it on their Social tab"}</span>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <li key={r.clientId} className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <BrandChip name={r.name} color={r.brand.color} logo={r.brand.logo} light={r.brand.light} size="sm" />
              <Link href={`/clients/${r.slug}?service=${r.line}`} className="min-w-0 flex-1 truncate font-heading text-[15px] hover:text-brand-text">
                {r.name}
              </Link>
              <ChannelStatusPill status={r.status} line={r.line} />
            </div>
            <ConnectCta r={r} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Any line's client card (the ads and creative lines) ─────────────────

export type DeskCardData = {
  key: string;
  name: string;
  /** A second line under the name (the ad account's KPI label, the owner) */
  sub?: string | null;
  brand: Brand;
  risk: Risk;
  tone: "bad" | "warn" | "ok" | "quiet";
  statusLabel: string;
  big: string;
  bigCaption?: string | null;
  /** 0 to 1 toward the goal; mark: where it should be by today */
  gauge?: { fill: number; mark?: number | null } | null;
  detail: { label: string; value: string }[];
  links: { href: string; label: string }[];
  /** "What to know": the few critical things about the account, worst first, shown on hover over the card's name */
  brief?: { tone: "bad" | "warn" | "ok"; text: string }[] | null;
  /** The account's open audit or sprint, small under the card: its progress and what it needs, opens it */
  work?: { label: string; why: string; href: string; tone: "bad" | "warn" | "quiet" } | null;
};

const CARD_TONE = {
  bad: { bar: "bg-bad", text: "text-bad", pill: "bg-bad-soft text-bad", css: "var(--color-bad)" },
  warn: { bar: "bg-warn", text: "text-warn", pill: "bg-warn-soft text-warn", css: "var(--color-warn)" },
  ok: { bar: "bg-ok", text: "text-ok", pill: "bg-ok-soft text-ok", css: "var(--color-ok)" },
  quiet: { bar: "bg-faint", text: "text-muted", pill: "bg-ink/[0.06] text-muted", css: "var(--color-muted)" },
} as const;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

const BRIEF_DOT = { bad: "bg-bad", warn: "bg-warn", ok: "bg-ok" } as const;

/** What to know about an account, on hover: the critical things first, one line each */
function BriefCard({ name, items }: { name: string; items: NonNullable<DeskCardData["brief"]> }) {
  return (
    <div className="grid gap-2.5 p-1">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-faint">What to know · {name}</p>
      <ol className="grid gap-2">
        {items.map((b, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] leading-snug">
            <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${BRIEF_DOT[b.tone]}`} />
            <span className={b.tone === "ok" ? "text-muted" : "text-fg"}>{b.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One client or ad account, small, the same look as the email and social cards: opens for the detail */
export function DeskCard({ c }: { c: DeskCardData }) {
  const t = CARD_TONE[c.tone];
  const why = c.risk.reasons.length ? c.risk.reasons.join(" · ") : "On track";
  return (
    <li className="relative isolate grid min-w-0 content-between overflow-hidden rounded-[16px] border border-line bg-surface">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${t.bar}`} />
      <span aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={{ backgroundImage: `radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, ${c.brand.color ?? t.css} 10%, transparent), transparent 60%)` }} />
      <details className="group/card">
        <summary className="grid cursor-pointer list-none gap-2.5 p-3.5 [&::-webkit-details-marker]:hidden">
          {(() => {
            const head = (
              <span className="flex min-w-0 items-center gap-2.5">
                <BrandChip name={c.name} color={c.brand.color} logo={c.brand.logo} light={c.brand.light} size="sm" />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-heading text-[15px] leading-snug">{c.name}</span>
                  <span className={`truncate text-[11.5px] ${c.risk.reasons.length ? "text-muted" : "text-faint"}`} title={c.brief?.length ? undefined : why}>
                    {why}
                  </span>
                </span>
              </span>
            );
            return c.brief?.length ? (
              <HoverCard width={400} className="flex min-w-0" content={<BriefCard name={c.name} items={c.brief} />}>
                {head}
              </HoverCard>
            ) : (
              head
            );
          })()}
          <span className="flex items-end justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className={`tabular font-display text-[24px] leading-none tracking-tight ${t.text}`}>{c.big}</span>
              {c.bigCaption && <span className="tabular truncate text-[11px] text-faint">{c.bigCaption}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${t.pill}`}>{c.statusLabel}</span>
              <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full text-faint transition-transform group-open/card:rotate-180">
                ⌄
              </span>
            </span>
          </span>
          {c.gauge && (
            <span className="relative block h-1.5 rounded-full bg-surface-2" role="img" aria-label={`${Math.round(clamp(c.gauge.fill) * 100)}%`}>
              <span className={`block h-full rounded-full ${t.bar}`} style={{ width: `${clamp(c.gauge.fill) * 100}%` }} />
              {c.gauge.mark != null && <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-fg/60" style={{ left: `${clamp(c.gauge.mark) * 100}%` }} />}
            </span>
          )}
        </summary>
        <div className="grid gap-2.5 px-3.5 pb-3.5">
          {c.sub && <p className="truncate text-[11.5px] text-faint">{c.sub}</p>}
          {c.detail.length > 0 && (
            <dl className="grid grid-cols-3 gap-2 border-t border-line pt-2.5">
              {c.detail.map((d) => (
                <div key={d.label} className="min-w-0">
                  <dt className="text-[10.5px] text-faint">{d.label}</dt>
                  <dd className="tabular truncate text-[13px] text-fg">{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </details>
      {c.work && (
        <Link href={c.work.href} className="group/work flex min-h-10 items-center gap-2 border-t border-line px-3.5 py-2 text-[11.5px] transition-colors hover:bg-surface-2 md:min-h-0">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.work.tone === "bad" ? "bg-bad" : c.work.tone === "warn" ? "bg-warn" : "bg-faint"}`} />
          <span className="shrink-0 font-medium text-fg">{c.work.label}</span>
          <span className="min-w-0 truncate text-faint">{c.work.why}</span>
          <span aria-hidden className="ml-auto shrink-0 text-faint transition-transform group-hover/work:translate-x-0.5">→</span>
        </Link>
      )}
      <nav aria-label={`${c.name} links`} className="grid gap-px border-t border-line bg-line" style={{ gridTemplateColumns: `repeat(${c.links.length}, minmax(0, 1fr))` }}>
        {c.links.map((l) => (
          <Link key={l.label} href={l.href} className="grid min-h-11 place-items-center bg-surface text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-9">
            {l.label}
          </Link>
        ))}
      </nav>
    </li>
  );
}

/** A group of DeskCards; `contained` keeps a long list in its own scrolling area so the page stays short */
export function DeskGroup({ id, title, aside, cards, contained = false, empty }: { id: string; title: string; aside?: string; cards: DeskCardData[]; contained?: boolean; empty?: string }) {
  const list = (
    <ul className={GRID}>
      {cards.map((c) => (
        <DeskCard key={c.key} c={c} />
      ))}
    </ul>
  );
  return (
    <section id={id} className="grid scroll-mt-24 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          {title} <span className="tabular text-[15px] text-faint">{cards.length}</span>
        </h2>
        {aside && <span className="text-xs text-faint">{aside}</span>}
      </div>
      {cards.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">{empty ?? "Nothing here."}</p>
      ) : contained ? (
        <div className="relative rounded-[20px] border border-line bg-bg/40">
          <div className="max-h-[min(68vh,760px)] overflow-y-auto overscroll-contain p-3">{list}</div>
          {cards.length > 8 && <span aria-hidden className="pointer-events-none absolute inset-x-px bottom-px h-10 rounded-b-[20px] bg-gradient-to-t from-bg to-transparent" />}
        </div>
      ) : (
        list
      )}
    </section>
  );
}
