import type { CSSProperties, ReactNode } from "react";
import { BAND_TONE, ScoreBadge, ScoreChecks, WeighingDown } from "@/components/email-score-parts";
import { int, metricsSupport, money, pct, signed, socialName, takeawaysFor, postRateText, type EmailMetrics, type SocialMetrics } from "@/lib/channel-reports/core";
import { tileViews, type ChannelLayout, type TileView } from "@/lib/channel-reports/layout";
import { cardCampaigns, cardStats, fromKlaviyo, heat, klaviyoCampaignUrl, locationViews, RPR_BAR, shareText, type CardStat } from "@/lib/channel-reports/email-cards";
import { RATE_BARS, type Grade, type MessageRow } from "@/lib/channel-reports/email-detail";
import type { LocationMetricBreakdown } from "@/lib/klaviyo/locations";
import type { Sections } from "@/lib/reports/write";
import { AdImage } from "./ad-image";

// The live email or social report a client opens from the link in Slack or email: no sign-in, the token is the key, and only a
// report that went to the client opens. Always light, the same look as the ads recap beside it.

const LIGHT = { colorScheme: "light", "--brand": "#c8102e", "--brand-hover": "#a60d26", "--brand-text": "#c8102e", "--brand-soft": "rgba(200, 16, 46, 0.07)", "--bg": "#fbfbfa", "--surface": "#ffffff", "--surface-2": "#f3f3f2", "--border": "#e8e8e6", "--fg": "#0b0b0c", "--fg-muted": "#5f5f66", "--fg-faint": "#9a9aa1", "--ok": "#16794c", "--ok-soft": "rgba(22, 121, 76, 0.09)", "--warn": "#9a5f00", "--warn-soft": "rgba(214, 146, 24, 0.13)", "--bad": "#c8102e", "--bad-soft": "rgba(200, 16, 46, 0.08)" } as CSSProperties;
const NEUTRAL = { ...LIGHT, "--brand": "#475569", "--brand-hover": "#334155", "--brand-text": "#475569", "--brand-soft": "rgba(71, 85, 105, 0.07)" } as CSSProperties;

type Shared = { client: string; whiteLabel: boolean; label: string; title: string; token: string; metrics: EmailMetrics | SocialMetrics; sections: Sections; /** The tiles picked in the studio, as on the PDF (null: the defaults) */ layout?: ChannelLayout | null; /** Signed links to the drawn top of each card campaign's email, by campaign id */ shots?: Record<string, string> };

const tone = (t: TileView["move"]) => (!t ? "text-faint" : t.tone === "good" ? "text-ok" : t.tone === "bad" ? "text-bad" : "text-muted");

export function ChannelRecap({ r }: { r: Shared }) {
  const m = r.metrics;
  // The tiles chosen in the studio, the same ones the PDF draws
  const tiles = tileViews(m, r.layout);
  const takeaways = takeawaysFor(m, r.sections.takeaways);
  return (
    <div style={r.whiteLabel ? NEUTRAL : LIGHT} className="min-h-screen overflow-x-clip bg-bg pb-[env(safe-area-inset-bottom)] text-fg">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-8 sm:pt-8 print:pt-0">
        <p className="font-heading text-[13px] tracking-[0.18em] text-fg">{r.whiteLabel ? "PERFORMANCE REPORT" : "KAIZEN MARKETING"}</p>
        <a href={`/r/${r.token}/pdf`} className="shrink-0 rounded-brand bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover max-md:inline-flex max-md:min-h-11 max-md:items-center print:hidden">
          Download PDF
        </a>
      </header>

      <section className="mx-auto max-w-5xl px-4 pt-14 pb-8 sm:px-8 sm:pt-20">
        <div className="mb-6 h-[3px] w-10 bg-brand" />
        <p className="text-sm text-muted">
          {r.title} · {r.label}
        </p>
        <h1 className="mt-2 font-heading text-4xl leading-[1.05] tracking-tight [overflow-wrap:anywhere] sm:text-6xl">{r.client}</h1>
        <div className="mt-8 max-w-3xl">
          <p className="font-heading text-xl leading-snug tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{r.sections.headline}</p>
          {r.sections.summary && <p className="mt-4 text-[15px] leading-relaxed text-muted">{r.sections.summary}</p>}
        </div>
      </section>

      <main className="mx-auto grid max-w-5xl gap-14 px-4 pb-20 sm:px-8">
        <div className={`grid grid-cols-2 gap-3 ${tiles.length > 4 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
          {tiles.map((t) => (
            <div key={t.key} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
              <p className="text-[11px] tracking-[0.08em] text-muted uppercase">{t.label}</p>
              <p className="mt-2 font-heading text-[22px] tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">{t.value}</p>
              {t.sub && <p className="mt-1 text-[13px] text-muted">{t.sub}</p>}
              {t.kind === "split" ? (
                <p className="mt-3 text-[13px] text-muted">Campaigns / automated emails</p>
              ) : t.kind === "stat" ? (
                <p className={`mt-3 text-[13px] font-medium ${tone(t.move)}`}>{t.move ? `${t.move.up ? "+" : "-"}${t.move.pct} vs ${m.compare.label}` : "No comparison"}</p>
              ) : null}
            </div>
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-8 gap-y-2 text-[13px] text-muted">
          {metricsSupport(m).map((x) => (
            <li key={x.label}>
              {x.label} <span className="font-medium text-fg tabular-nums">{x.value}</span>
            </li>
          ))}
        </ul>

        {m.platform === "klaviyo" ? <EmailBody m={m} shots={r.shots ?? {}} /> : <SocialBody m={m} />}

        {takeaways.length > 0 && (
          <Block title="Key takeaways">
            <div className="grid gap-4 sm:grid-cols-3">
              {takeaways.map((t, i) => (
                <div key={i} className="rounded-xl border border-line bg-surface p-5">
                  <div className="mb-3 h-[3px] w-6 bg-brand" />
                  <p className="font-heading text-base">{t.title}</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{t.text}</p>
                </div>
              ))}
            </div>
          </Block>
        )}
      </main>

      <footer className="mx-auto max-w-5xl border-t border-line px-4 py-8 text-xs text-faint sm:px-8">
        {r.whiteLabel ? "Performance report" : "Kaizen Marketing"} · {r.client} · {r.label}
      </footer>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="break-inside-avoid">
      <p className="mb-4 text-[11px] font-medium tracking-[0.12em] text-muted uppercase">{title}</p>
      {children}
    </div>
  );
}

function EmailBody({ m, shots }: { m: EmailMetrics; shots: Record<string, string> }) {
  const sc = m.score && m.score.unmeasured.length < m.score.checks.length ? m.score : null;
  const sides = !m.sources && m.byMetric && m.byMetric.length > 1 ? m.byMetric : null;
  const src = m.sources ?? null;
  return (
    <>
      {src && (
        <Block title="Revenue by source">
          <div className="grid gap-3 sm:grid-cols-3">
            {src.sources.map((x) => (
              <div key={x.id} className="rounded-xl border border-line bg-surface p-5">
                <p className="text-[11px] tracking-[0.08em] text-faint uppercase">{x.share != null ? `${Math.round(x.share * 100)}% of the total` : "Source"}</p>
                <p className="mt-1 font-heading text-base [overflow-wrap:anywhere]">{x.name}</p>
                <p className="mt-2 font-heading text-2xl tabular-nums">{money(x.revenue.now, m.currency)}</p>
                <p className="mt-1 text-[13px] text-muted tabular-nums">
                  {int(x.orders.now)} orders{x.revenue.before != null ? ` · ${money(x.revenue.before, m.currency)} the period before` : ""}
                </p>
                {x.campaignRevenue != null && x.flowRevenue != null && (
                  <p className="mt-1 text-[13px] text-muted tabular-nums">
                    Campaigns {money(x.campaignRevenue, m.currency)} · automated {money(x.flowRevenue, m.currency)}
                  </p>
                )}
                {x.locations.length > 0 && <p className="mt-2 text-[12px] text-faint [overflow-wrap:anywhere]">Top: {x.locations.slice(0, 3).map((l) => `${l.location} ${money(l.revenue, m.currency)}`).join(", ")}</p>}
              </div>
            ))}
            <div className="rounded-xl border border-line bg-surface-2 p-5">
              <p className="text-[11px] tracking-[0.08em] text-faint uppercase">Combined</p>
              <p className="mt-3 font-heading text-2xl tabular-nums">{money(src.combined.revenue.now, m.currency)}</p>
              <p className="mt-1 text-[13px] text-muted tabular-nums">{int(src.combined.orders.now)} orders, each counted once</p>
              <p className="mt-2 text-[12px] text-faint">{src.note}</p>
            </div>
          </div>
        </Block>
      )}
      {sides && (
        <Block title="By what counts as a sale">
          <div className="grid gap-3 sm:grid-cols-2">
            {sides.map((x, i) => (
              <div key={x.id} className="rounded-xl border border-line bg-surface p-5">
                <p className="text-[11px] tracking-[0.08em] text-faint uppercase">{i === 0 ? "Primary" : `Ranked ${i + 1}`}</p>
                <p className="mt-1 font-heading text-base [overflow-wrap:anywhere]">{x.name}</p>
                <p className="mt-2 font-heading text-2xl tabular-nums">{money(x.revenue.now, m.currency)}</p>
                <p className="mt-1 text-[13px] text-muted tabular-nums">
                  {int(x.conversions.now)} conversions{x.revenue.before != null ? ` · ${money(x.revenue.before, m.currency)} the period before` : ""}
                </p>
              </div>
            ))}
          </div>
        </Block>
      )}
      {sc && (
        <Block title="Email health score">
          <div className="grid gap-5 rounded-xl border border-line bg-surface p-5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              <ScoreBadge r={sc} size="lg" />
              <span className={`text-sm font-medium ${BAND_TONE[sc.band].text}`}>{BAND_TONE[sc.band].word}</span>
              <p className="text-[12px] text-faint">Seven checks, last 30 days. Green from 80, yellow from 60.</p>
            </div>
            <ScoreChecks score={sc} currency={m.currency} />
            <WeighingDown score={sc} limit={3} currency={m.currency} />
          </div>
        </Block>
      )}
      <CampaignCards m={m} shots={shots} />
      {m.flows.length > 0 && (
        <Block title="Flows">
          <div className="grid gap-2">
            {m.flows.slice(0, 6).map((f) => (
              <div key={f.id} className="flex items-baseline justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">{f.name}</span>
                <span className="shrink-0 font-medium tabular-nums">{money(f.revenue, m.currency)}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-faint">{m.flowsBasis}</p>
        </Block>
      )}
      <Block title="List and deliverability">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-muted">
            <p className="font-heading text-base text-fg">List growth</p>
            <p className="mt-2">{m.list.net != null ? `${signed(m.list.net)} net new subscribers.` : "No list movement was read for this period."}{m.list.profiles != null ? ` ${int(m.list.profiles)} profiles in the main list.` : ""}</p>
          </div>
          <div className="rounded-xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-muted">
            <p className="font-heading text-base text-fg">{m.flags.length ? "Worth watching" : "Healthy"}</p>
            <p className="mt-2">{m.flags.length ? m.flags.slice(0, 3).map((f) => f.text).join(" ") : "Bounce, spam and unsubscribe rates are inside healthy lines."}</p>
          </div>
        </div>
      </Block>
      {m.locations && m.locations.metrics.length > 0 && (
        <Block title="Orders by location">
          <div className="grid gap-10">
            {m.locations.metrics.length > 1 && <p className="text-[13px] text-muted">{m.locations.note}</p>}
            {m.locations.metrics.map((x) => (
              <Locations key={x.metricId} x={x} m={m} several={(m.locations?.metrics.length ?? 0) > 1} />
            ))}
          </div>
        </Block>
      )}
    </>
  );
}

function SocialBody({ m }: { m: SocialMetrics }) {
  return (
    <>
      {m.platforms.length > 0 && (
        <Block title="By platform">
          <div className="grid gap-3 sm:grid-cols-2">
            {m.platforms.map((p) => (
              <div key={p.platform} className="rounded-xl border border-line bg-surface p-5">
                <p className="font-heading text-base">
                  {socialName(p.platform)}
                  {p.name ? <span className="ml-2 text-sm font-normal text-muted">{p.name}</span> : null}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] tabular-nums">
                  <div>
                    <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">Followers</dt>
                    <dd>
                      {int(p.now.followers)} <span className={(p.now.followerChange ?? 0) < 0 ? "text-bad" : "text-ok"}>{signed(p.now.followerChange)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">Reach</dt>
                    <dd>{int(p.now.reach)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">Views</dt>
                    <dd>{int(p.now.views)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">Engagement</dt>
                    <dd>{m.insightsRead ? pct(p.now.rate) : "–"}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </Block>
      )}
      {m.posts.length > 0 && (
        <Block title={`Top posts · ${m.postsTotal} published`}>
          <div className="grid gap-4 sm:grid-cols-3">
            {m.posts.slice(0, 3).map((p) => (
              <article key={`${p.platform}:${p.id}`} className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="relative aspect-square bg-surface-2">
                  <AdImage src={p.thumbnail} />
                </div>
                <div className="p-4">
                  <p className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{p.caption ?? `${socialName(p.platform)} ${p.format}`}</p>
                  <p className="mt-2 text-[13px] text-muted tabular-nums">
                    {int(p.interactions)} interactions · reach {int(p.reach)}
                  </p>
                  <p className="text-[13px] text-faint">{postRateText(p)}</p>
                  {p.permalink && (
                    <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-brand hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
                      View post
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Block>
      )}
    </>
  );
}

// ─── Campaign cards ────────────────────────────────────────────────────────

type CardRow = Pick<MessageRow, "id" | "name" | "date" | "channel" | "recipients" | "openRate" | "clickRate" | "orders" | "orderRate" | "revenue"> & { image: string | null; subject: string | null };

/** The campaigns to draw as cards: this period's (from the detail) or, on an older report, the best ones it kept */
function cardRows(m: EmailMetrics): { rows: CardRow[]; all: CardRow[] } {
  const kept = new Map(m.campaigns.map((c) => [c.id, c]));
  const all: CardRow[] = m.detail
    ? m.detail.campaigns.map((r) => ({ ...r, image: kept.get(r.id)?.image ?? null, subject: kept.get(r.id)?.subject ?? null }))
    : m.campaigns.map((c) => ({ id: c.id, name: c.name, date: c.sendDay, channel: c.channel === "sms" ? "sms" : "email", recipients: c.recipients, openRate: c.openRate, clickRate: c.clickRate, orders: Math.round(c.conversions), orderRate: c.recipients ? c.conversions / c.recipients : null, revenue: c.revenue, image: c.image, subject: c.subject }));
  return { rows: cardCampaigns(all), all };
}

const GRADE_PILL: Record<Grade, string> = { good: "bg-ok-soft text-ok", fair: "bg-warn-soft text-warn", poor: "bg-bad-soft text-bad" };
const GRADE_BAR: Record<Grade, string> = { good: "bg-ok", fair: "bg-warn", poor: "bg-bad" };
const GRADE_WORD: Record<Grade, string> = { good: "Good", fair: "Fair", poor: "Poor" };
const dayText = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : null);
const columnNote = (col: LocationMetricBreakdown["columns"][number]) => (col.sendDay ? dayText(col.sendDay) : col.id === "flows" ? "Automated" : col.id === "other" ? "Added up" : "Before these dates");

function StatCell({ x }: { x: CardStat }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] tracking-[0.08em] text-faint uppercase">{x.label}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`font-heading tracking-tight tabular-nums ${x.strong ? "text-xl" : "text-lg"}`}>{x.value}</span>
        {x.grade && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${GRADE_PILL[x.grade]}`}>{GRADE_WORD[x.grade]}</span>}
      </p>
      {x.gauge && (
        <div className="relative mt-2 h-1 rounded-full bg-surface-2">
          <div className={`h-1 rounded-full ${x.grade ? GRADE_BAR[x.grade] : "bg-fg"}`} style={{ width: `${Math.max(2, x.gauge.fill * 100)}%` }} />
          <div className="absolute -top-0.5 h-2 w-px bg-fg/50" style={{ left: `${x.gauge.mark * 100}%` }} />
        </div>
      )}
      {x.sub && <p className="mt-1 truncate text-[12px] text-faint tabular-nums">{x.sub}</p>}
    </div>
  );
}

/** Each campaign as its email (the top half, opening the campaign in Klaviyo) beside its numbers against Kaizen's bars */
function CampaignCards({ m, shots }: { m: EmailMetrics; shots: Record<string, string> }) {
  const { rows, all } = cardRows(m);
  if (!all.length) return null;
  const link = fromKlaviyo(m.source);
  const total = all.reduce((a, r) => a + r.revenue, 0);
  const carded = new Set(rows.map((r) => r.id));
  const others = all.filter((r) => !carded.has(r.id));
  const measured = m.revenueMeasured !== false;
  const count = m.detail ? all.length : m.campaignsTotal;
  return (
    <Block title={`Campaigns · ${count} sent`}>
      <p className="-mt-2 mb-4 text-[13px] text-muted">
        Graded against Kaizen&apos;s bars: open {pct(RATE_BARS.campaign.open, 0)}, click {pct(RATE_BARS.campaign.click, 0)}
        {measured ? `, ${money(RPR_BAR, m.currency)} per recipient` : ""}.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((r) => {
          const href = link ? klaviyoCampaignUrl(r.id) : null;
          const src = shots[r.id] ?? r.image;
          const pic = (
            <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-2">
              <AdImage src={src} top />
              {!src && <span className="absolute inset-0 grid place-items-center text-[11px] tracking-[0.12em] text-faint uppercase">{r.channel === "sms" ? "SMS" : "No preview"}</span>}
            </div>
          );
          return (
            <article key={r.id} className="grid grid-cols-[96px_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-[148px_minmax(0,1fr)]">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="block border-r border-line" aria-label={`Open ${r.name} in Klaviyo`}>
                  {pic}
                </a>
              ) : (
                <div className="border-r border-line">{pic}</div>
              )}
              <div className="flex min-w-0 flex-col p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium tracking-[0.1em] text-brand-text uppercase">
                      {dayText(r.date) ?? "Sent"} · {r.channel === "sms" ? "SMS" : "Email"}
                    </p>
                    <p className="mt-1 line-clamp-2 font-heading text-base leading-snug [overflow-wrap:anywhere]">{r.name}</p>
                    {r.subject && <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">{r.subject}</p>}
                  </div>
                  {measured && total > 0 && (
                    <p className="shrink-0 text-right">
                      <span className="block font-heading text-xl tabular-nums">{shareText(r.revenue / total)}</span>
                      <span className="text-[11px] text-faint">of campaign revenue</span>
                    </p>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-line pt-4 sm:grid-cols-3">
                  {cardStats(r, m.currency, measured).map((x) => (
                    <StatCell key={x.key} x={x} />
                  ))}
                </div>
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="mt-4 self-start text-sm font-medium text-brand hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
                    Open the campaign in Klaviyo
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {others.length > 0 && (
        <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-2">
          <p className="py-2 text-[11px] tracking-[0.08em] text-faint uppercase">The other {others.length}</p>
          {others.map((r) => (
            <div key={r.id} className="flex items-baseline justify-between gap-3 border-t border-line py-2.5 text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {r.name}
                <span className="ml-2 text-[12px] text-faint">{dayText(r.date)}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="mr-3 text-[13px] text-muted">{pct(r.openRate)} opened</span>
                {measured && <span className="font-medium">{money(r.revenue, m.currency)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}

// ─── Locations ─────────────────────────────────────────────────────────────

/** One metric's restaurants: the headline numbers, the ranked bars, the three best and every location by campaign, shaded */
function Locations({ x, m, several }: { x: LocationMetricBreakdown; m: EmailMetrics; several: boolean }) {
  const c = m.currency;
  const v = locationViews(x, x.ranked.length <= 18 ? 18 : 15);
  const lead = v.leader;
  const max = v.shown[0]?.revenue ?? 0;
  const stats = [
    { label: "Attributed revenue", value: money(x.revenue, c) },
    { label: "Locations converted", value: int(x.ranked.length) },
    { label: "Orders", value: int(x.conversions) },
    { label: "Per location", value: money(v.average, c) },
  ];
  return (
    <div className="grid gap-6">
      {several && <p className="font-heading text-lg">{x.name}</p>}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          {stats.map((st) => (
            <div key={st.label} className="bg-surface p-4">
              <p className="text-[10px] tracking-[0.08em] text-faint uppercase">{st.label}</p>
              <p className="mt-1.5 font-heading text-xl tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-2xl">{st.value}</p>
            </div>
          ))}
        </div>
        {lead && (
          <div className="rounded-xl border border-line bg-brand-soft p-4">
            <p className="text-[10px] font-medium tracking-[0.1em] text-brand-text uppercase">Top location</p>
            <p className="mt-1 font-heading text-base [overflow-wrap:anywhere]">{lead.name}</p>
            <p className="mt-1 flex items-baseline justify-between gap-3 tabular-nums">
              <span className="font-heading text-2xl">{money(lead.revenue, c)}</span>
              <span className="text-sm font-medium text-brand-text">{shareText(lead.share)} share</span>
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <p className="mb-3 text-[11px] tracking-[0.08em] text-faint uppercase">{v.rest ? `Revenue by location · best ${v.shown.length} of ${v.all.length}` : "Revenue by location"}</p>
        <ol className="grid gap-1.5">
          {v.shown.map((r) => (
            <li key={r.full} className="grid grid-cols-[1.5rem_minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-x-3 text-[13px] sm:grid-cols-[1.5rem_minmax(0,12rem)_minmax(0,1fr)_5rem_3rem]">
              <span className={`tabular-nums ${r.rank <= 3 ? "font-medium text-fg" : "text-faint"}`}>{r.rank}</span>
              <span className={`truncate ${r.rank <= 3 ? "font-medium" : ""}`} title={r.full}>
                {r.name}
              </span>
              <span className="h-2 rounded-full bg-surface-2">
                <span className={`block h-2 rounded-full ${r.rank <= 3 ? "bg-brand" : "bg-brand/40"}`} style={{ width: `${max > 0 ? Math.max(1.5, (r.revenue / max) * 100) : 0}%` }} />
              </span>
              <span className="text-right font-medium tabular-nums">{money(r.revenue, c)}</span>
              <span className="hidden text-right text-muted tabular-nums sm:block">{shareText(r.share)}</span>
            </li>
          ))}
        </ol>
        {v.rest && (
          <p className="mt-3 border-t border-line pt-3 text-[13px] text-muted">
            And {v.rest.count} more {v.rest.count === 1 ? "location" : "locations"} with {money(v.rest.revenue, c)} ({shareText(v.rest.share)}), each in the table below.
          </p>
        )}
      </div>

      {v.all.length >= 2 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {v.all.slice(0, 3).map((r, i) => (
            <div key={r.full} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className={`h-[3px] ${i === 0 ? "bg-brand" : i === 1 ? "bg-brand/60" : "bg-brand/30"}`} />
              <div className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium text-white ${i === 0 ? "bg-brand" : "bg-fg"}`}>#{r.rank}</span>
                  <span className="text-[13px] font-medium text-brand-text tabular-nums">{shareText(r.share)} of revenue</span>
                </div>
                <p className="mt-3 line-clamp-2 font-heading text-base [overflow-wrap:anywhere]">{r.name}</p>
                <p className="mt-1 font-heading text-2xl tracking-tight tabular-nums">{money(r.revenue, c)}</p>
                <p className="mt-3 border-t border-line pt-3 text-[13px] text-muted tabular-nums">
                  {int(r.conversions)} orders · {r.conversions > 0 ? money(r.revenue / r.conversions, c) : "–"} per order
                </p>
                {r.best && (
                  <p className="mt-1 text-[13px] text-muted">
                    Most from <span className="font-medium text-fg">{r.best.id === "flows" ? "automated emails" : r.best.name}</span> ({shareText(r.best.share)})
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <p className="mb-3 text-[11px] tracking-[0.08em] text-faint uppercase">By location and campaign · darker earns more</p>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[40rem] border-separate border-spacing-0.5 text-[13px] tabular-nums">
            <thead>
              <tr className="text-[11px] text-muted">
                <th className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium">Location</th>
                {x.columns.map((col) => (
                  <th key={col.id} className="px-2 py-2 text-right align-bottom font-medium">
                    <span className="line-clamp-2">{col.name}</span>
                    <span className="block font-normal text-faint">{columnNote(col)}</span>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {x.rows.map((row) => (
                <tr key={row.location}>
                  <td className="sticky left-0 z-10 max-w-[12rem] truncate bg-surface px-3 py-1.5" title={row.location}>
                    {v.name(row.location)}
                  </td>
                  {row.cells.map((val, j) => {
                    const t = heat(val, v.maxCell);
                    return (
                      <td key={x.columns[j].id} className={`rounded px-2 py-1.5 text-right ${t > 0.55 ? "font-medium text-white" : val ? "" : "text-faint"}`} style={{ backgroundColor: t ? `color-mix(in srgb, var(--brand) ${Math.round(t * 100)}%, transparent)` : "var(--surface-2)" }}>
                        {val ? money(val, c) : "–"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right font-medium">{money(row.total, c)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="sticky left-0 z-10 bg-surface-2 px-3 py-2">Total</td>
                {x.columns.map((col, j) => (
                  <td key={col.id} className="bg-surface-2 px-2 py-2 text-right">
                    {money(
                      x.rows.reduce((t, r) => t + (r.cells[j] ?? 0), 0),
                      c,
                    )}
                  </td>
                ))}
                <td className="bg-surface-2 px-3 py-2 text-right">{money(x.revenue, c)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-3 text-xs text-faint">{x.summary}</p>
      </div>
    </div>
  );
}
