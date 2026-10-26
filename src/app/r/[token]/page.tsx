import type { CSSProperties, ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { count, headlineTiles, kpiRows, money, multiple, percent, platformName, singular, type Delta, type Tile } from "@/lib/reports/format";
import type { ReportPart } from "@/lib/reports/pdf";
import { loadBundle } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { AdImage } from "./ad-image";

export const metadata: Metadata = { title: "Monthly recap · Kaizen Marketing", robots: { index: false, follow: false } };
export const viewport: Viewport = { themeColor: "#ffffff" };

// Client-facing, so always light: the app's color tokens, redefined for this page only.
const LIGHT = {
  colorScheme: "light",
  "--brand": "#c8102e",
  "--brand-hover": "#a60d26",
  "--brand-text": "#c8102e",
  "--brand-soft": "rgba(200, 16, 46, 0.07)",
  "--bg": "#fbfbfa",
  "--surface": "#ffffff",
  "--surface-2": "#f3f3f2",
  "--border": "#e8e8e6",
  "--fg": "#0b0b0c",
  "--fg-muted": "#5f5f66",
  "--fg-faint": "#9a9aa1",
  "--ok": "#16794c",
  "--bad": "#c8102e",
} as CSSProperties;

const toneClass = (d: Delta | null) => (!d ? "text-faint" : d.tone === "good" ? "text-ok" : d.tone === "bad" ? "text-bad" : "text-muted");

/**
 * The live monthly recap a client opens from the link in Slack or email: no sign-in, the token is the key. Every
 * platform's finished report for the month, stacked (Meta, then Google), with a PDF of the same thing.
 */
export default async function MonthlyRecap({ params }: PageProps<"/r/[token]">) {
  const { token } = await params;
  if (!adminConfigured()) notFound();
  const bundle = await loadBundle(createAdminClient(), token);
  if (!bundle) notFound();
  const ready = bundle.ready && bundle.input.parts.length > 0;
  const parts = bundle.input.parts;

  return (
    <div style={LIGHT} className="min-h-screen overflow-x-clip bg-bg pb-[env(safe-area-inset-bottom)] text-fg">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-8 sm:pt-8 print:pt-0">
        <p className="font-heading text-[13px] tracking-[0.18em] text-fg">KAIZEN MARKETING</p>
        {ready && (
          <a href={`/r/${token}/pdf`} className="shrink-0 rounded-brand bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover active:bg-brand-hover max-md:inline-flex max-md:min-h-11 max-md:items-center print:hidden">
            Download PDF
          </a>
        )}
      </header>

      <section className="mx-auto max-w-5xl px-4 pt-14 pb-10 sm:px-8 sm:pt-20 sm:pb-14">
        <div className="mb-6 h-[3px] w-10 bg-brand" />
        <p className="text-sm text-muted">Monthly recap · {bundle.periodLabel}</p>
        <h1 className="mt-2 font-heading text-4xl leading-[1.05] tracking-tight [overflow-wrap:anywhere] sm:text-6xl">{bundle.client}</h1>
        {ready && parts.length > 1 && (
          <nav className="mt-8 flex flex-wrap gap-2 print:hidden">
            {parts.map((p) => (
              <a key={p.platform} href={`#${p.platform}`} className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-fg transition-colors hover:border-fg active:border-fg max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-5">
                {platformName(p.platform)}
              </a>
            ))}
          </nav>
        )}
      </section>

      {ready ? (
        parts.map((p) => <PlatformSection key={p.platform} part={p} token={token} />)
      ) : (
        <section className="mx-auto max-w-5xl px-4 pb-24 sm:px-8">
          <div className="rounded-xl border border-line bg-surface px-6 py-12 text-center sm:px-12">
            <p className="font-heading text-2xl tracking-tight">Your recap is being finalized</p>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
              We&apos;re putting the finishing touches on {bundle.periodLabel}. This page will show the full recap as soon as it&apos;s ready; your team will let you know.
            </p>
          </div>
        </section>
      )}

      <footer className="mx-auto max-w-5xl border-t border-line px-4 py-8 text-xs text-faint sm:px-8">Kaizen Marketing · {bundle.client} · {bundle.periodLabel}</footer>
    </div>
  );
}

function PlatformSection({ part, token }: { part: ReportPart; token: string }) {
  const m = part.metrics;
  const s = part.sections;
  const one = singular(m.conversion);
  const ads = part.platform === "meta" ? m.topAds.slice(0, 3) : [];
  const roas = m.campaigns.some((c) => c.roas != null);
  const notes = [
    { title: "What we did", items: s.did },
    { title: "What we're doing", items: s.doing },
    { title: "What's next", items: s.next },
  ].filter((g) => g.items?.length);

  return (
    <section id={part.platform} className="mx-auto max-w-5xl scroll-mt-6 px-4 pb-16 sm:px-8 sm:pb-24 print:break-before-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-brand pb-3">
        <h2 className="font-heading text-2xl tracking-tight sm:text-3xl">{platformName(part.platform)}</h2>
        <p className="text-sm text-muted">
          {m.main.label} vs {m.compare.label}
          {part.buyer ? ` · ${part.buyer}` : ""}
        </p>
      </div>

      <div className="mt-8 max-w-3xl">
        <p className="font-heading text-xl leading-snug tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{s.headline}</p>
        {s.summary && <p className="mt-4 text-[15px] leading-relaxed text-muted">{s.summary}</p>}
      </div>

      <div className="mt-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {headlineTiles(m).map((t) => (
          <TileCard key={t.label} tile={t} before={m.compare.label} now={m.main.label} />
        ))}
      </div>

      <Block title="Key metrics">
        {/* Phones: one card per metric */}
        <div className="grid gap-2 md:hidden print:hidden">
          {kpiRows(m).map((r) => (
            <div key={r.label} className="grid gap-1.5 rounded-xl border border-line bg-surface px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{r.label}</p>
                <p className="shrink-0 text-base font-medium tabular-nums">{r.now}</p>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[13px] tabular-nums">
                <span className="text-muted">
                  {m.compare.label}: {r.before}
                </span>
                <span className={`font-medium ${toneClass(r.delta)}`}>{r.delta?.text ?? "–"}</span>
              </div>
              {r.target && r.target !== "–" && <p className="text-[12px] text-faint tabular-nums">Target: {r.target}</p>}
            </div>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block print:block">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-fg text-left text-[11px] tracking-[0.08em] text-muted uppercase">
                <th className="py-2 pr-3 font-medium">Metric</th>
                <th className="py-2 pr-3 text-right font-medium">{m.main.label}</th>
                <th className="py-2 pr-3 text-right font-medium">{m.compare.label}</th>
                <th className="py-2 pr-3 text-right font-medium">Change</th>
                <th className="py-2 text-right font-medium">Target</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {kpiRows(m).map((r) => (
                <tr key={r.label} className="border-b border-line">
                  <td className="py-2.5 pr-3 font-medium">{r.label}</td>
                  <td className="py-2.5 pr-3 text-right">{r.now}</td>
                  <td className="py-2.5 pr-3 text-right text-muted">{r.before}</td>
                  <td className={`py-2.5 pr-3 text-right font-medium ${toneClass(r.delta)}`}>{r.delta?.text ?? "–"}</td>
                  <td className="py-2.5 text-right text-muted">{r.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      {ads.length > 0 && (
        <Block title="Top ads">
          <div className="grid gap-4 sm:grid-cols-3">
            {ads.map((a) => (
              <article key={a.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="relative aspect-square bg-surface-2">
                  <AdImage src={`/r/${token}/ad/${a.id}`} />
                </div>
                <div className="p-4">
                  <p className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{a.name}</p>
                  <p className="mt-2 text-[13px] text-muted tabular-nums">
                    {count(a.results)} {m.conversion.toLowerCase()} · {money(a.costPerResult)} per {one}
                  </p>
                  <p className="text-[13px] text-faint tabular-nums">
                    {money(a.spend)} spent{a.ctr != null ? ` · ${percent(a.ctr)} CTR` : ""}
                  </p>
                  {a.link && (
                    <a href={a.link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-brand hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
                      View ad
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Block>
      )}

      {m.campaigns.length > 0 && (
        <Block title="Campaigns">
          {/* Phones: one card per campaign */}
          <div className="grid gap-2 md:hidden print:hidden">
            {m.campaigns.slice(0, 8).map((c) => (
              <div key={c.name} className="grid gap-2 rounded-xl border border-line bg-surface px-4 py-3">
                <p className="text-sm font-medium [overflow-wrap:anywhere]">{c.name}</p>
                <dl className={`grid gap-2 text-[13px] tabular-nums ${roas ? "grid-cols-4" : "grid-cols-3"}`}>
                  <div className="min-w-0">
                    <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">Spend</dt>
                    <dd className="truncate">{money(c.spend)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="truncate text-[10px] tracking-[0.08em] text-faint uppercase">{m.conversion}</dt>
                    <dd className="truncate">{count(c.results)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="truncate text-[10px] tracking-[0.08em] text-faint uppercase">Per {one}</dt>
                    <dd className="truncate">{money(c.costPerResult)}</dd>
                  </div>
                  {roas && (
                    <div className="min-w-0">
                      <dt className="text-[10px] tracking-[0.08em] text-faint uppercase">ROAS</dt>
                      <dd className="truncate">{multiple(c.roas)}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block print:block">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-fg text-left text-[11px] tracking-[0.08em] text-muted uppercase">
                  <th className="py-2 pr-3 font-medium">Campaign</th>
                  <th className="py-2 pr-3 text-right font-medium">Spend</th>
                  <th className="py-2 pr-3 text-right font-medium">{m.conversion}</th>
                  <th className="py-2 pr-3 text-right font-medium">Cost per {one}</th>
                  {roas && <th className="py-2 text-right font-medium">ROAS</th>}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {m.campaigns.slice(0, 8).map((c) => (
                  <tr key={c.name} className="border-b border-line">
                    <td className="max-w-[320px] py-2.5 pr-3">{c.name}</td>
                    <td className="py-2.5 pr-3 text-right">{money(c.spend)}</td>
                    <td className="py-2.5 pr-3 text-right">{count(c.results)}</td>
                    <td className="py-2.5 pr-3 text-right">{money(c.costPerResult)}</td>
                    {roas && <td className="py-2.5 text-right">{multiple(c.roas)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {notes.length > 0 && (
        <div className="mt-14 grid gap-8 md:grid-cols-3 md:gap-10">
          {notes.map((g) => (
            <div key={g.title} className="break-inside-avoid">
              <h3 className="font-heading text-lg tracking-tight">{g.title}</h3>
              <ul className="mt-4 space-y-3">
                {g.items.map((x, i) => (
                  <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-fg/85">
                    <span className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {part.extras?.trim() && (
        <Block title="Also this month">
          <p className="max-w-3xl border-l-2 border-brand pl-4 text-[15px] leading-relaxed whitespace-pre-line text-muted">{part.extras.trim()}</p>
        </Block>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-14 break-inside-avoid">
      <p className="mb-4 text-[11px] font-medium tracking-[0.12em] text-muted uppercase">{title}</p>
      {children}
    </div>
  );
}

/** A headline number, its change, and two thin bars: last month against this month. */
function TileCard({ tile, now, before }: { tile: Tile; now: string; before: string }) {
  const max = Math.max(tile.now ?? 0, tile.before ?? 0);
  const w = (x: number | null) => (max > 0 && x != null ? `${Math.max(2, (x / max) * 100)}%` : "0%");
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-[11px] tracking-[0.08em] text-muted uppercase">{tile.label}</p>
      <p className="mt-2 font-heading text-[22px] tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">{tile.value}</p>
      {tile.sub && <p className="mt-1 text-[13px] text-muted">{tile.sub}</p>}
      <p className={`mt-3 text-[13px] font-medium ${toneClass(tile.delta)}`}>{tile.delta ? `${tile.delta.text} vs ${before}` : "No comparison"}</p>
      {max > 0 && (
        <div className="mt-auto space-y-1.5 pt-4" aria-hidden>
          <div className="flex items-center gap-2">
            <div className="flex-1"><div className="h-1.5 rounded-full bg-brand" style={{ width: w(tile.now) }} /></div>
            <span className="shrink-0 text-[10px] text-faint">{now}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1"><div className="h-1.5 rounded-full bg-fg/15" style={{ width: w(tile.before) }} /></div>
            <span className="shrink-0 text-[10px] text-faint">{before}</span>
          </div>
        </div>
      )}
    </div>
  );
}
