import type { CSSProperties, ReactNode } from "react";
import { BAND_TONE, ScoreBadge, ScoreChecks, WeighingDown } from "@/components/email-score-parts";
import { int, metricsSupport, metricsTiles, money, pct, signed, socialName, takeawaysFor, postRateText, type ChannelTile, type EmailMetrics, type SocialMetrics } from "@/lib/channel-reports/core";
import type { Sections } from "@/lib/reports/write";
import { AdImage } from "./ad-image";

// The live email or social report a client opens from the link in Slack or email: no sign-in, the token is the key, and only a
// report that went to the client opens. Always light, the same look as the ads recap beside it.

const LIGHT = { colorScheme: "light", "--brand": "#c8102e", "--brand-hover": "#a60d26", "--brand-text": "#c8102e", "--brand-soft": "rgba(200, 16, 46, 0.07)", "--bg": "#fbfbfa", "--surface": "#ffffff", "--surface-2": "#f3f3f2", "--border": "#e8e8e6", "--fg": "#0b0b0c", "--fg-muted": "#5f5f66", "--fg-faint": "#9a9aa1", "--ok": "#16794c", "--bad": "#c8102e" } as CSSProperties;
const NEUTRAL = { ...LIGHT, "--brand": "#475569", "--brand-hover": "#334155", "--brand-text": "#475569", "--brand-soft": "rgba(71, 85, 105, 0.07)" } as CSSProperties;

type Shared = { client: string; whiteLabel: boolean; label: string; title: string; token: string; metrics: EmailMetrics | SocialMetrics; sections: Sections };

const tone = (t: ChannelTile["move"]) => (!t ? "text-faint" : t.tone === "good" ? "text-ok" : t.tone === "bad" ? "text-bad" : "text-muted");

export function ChannelRecap({ r }: { r: Shared }) {
  const m = r.metrics;
  const tiles = metricsTiles(m);
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
              <p className="text-[11px] tracking-[0.08em] text-muted uppercase">{t.label}</p>
              <p className="mt-2 font-heading text-[22px] tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">{t.value}</p>
              {t.sub && <p className="mt-1 text-[13px] text-muted">{t.sub}</p>}
              <p className={`mt-3 text-[13px] font-medium ${tone(t.move)}`}>{t.move ? `${t.move.up ? "+" : "-"}${t.move.pct} vs ${m.compare.label}` : "No comparison"}</p>
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

        {m.platform === "klaviyo" ? <EmailBody m={m} /> : <SocialBody m={m} />}

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

function EmailBody({ m }: { m: EmailMetrics }) {
  const sc = m.score && m.score.unmeasured.length < m.score.checks.length ? m.score : null;
  return (
    <>
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
      {m.campaigns.length > 0 && (
        <Block title={`Campaigns · ${m.campaignsTotal} sent`}>
          <div className="grid gap-3">
            {m.campaigns.slice(0, 6).map((c) => (
              <article key={c.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-4 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:items-center sm:p-4">
                <div className="relative aspect-square overflow-hidden rounded-lg bg-surface-2">
                  <AdImage src={c.image} />
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{c.name}</p>
                  {c.subject && <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">{c.subject}</p>}
                  <p className="mt-2 text-[13px] text-muted tabular-nums">
                    {int(c.recipients)} sent{c.openRate != null ? ` · ${pct(c.openRate)} opened` : ""} · {pct(c.clickRate, 2)} clicked
                  </p>
                </div>
                <p className="col-span-2 font-heading text-xl tabular-nums sm:col-span-1 sm:text-right">{money(c.revenue, m.currency)}</p>
              </article>
            ))}
          </div>
        </Block>
      )}
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
