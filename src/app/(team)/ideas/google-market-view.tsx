"use client";

import { useState } from "react";
import { pushParams, useParam } from "@/lib/url-state";
import type { MarketCompetitor, MarketIndustry, MarketSearch } from "@/lib/google-market";

// Google in the market, one industry at a time: what people search there (from Keyword Planner) and the advertisers in
// our clients' auctions (from Auction Insights), straight from Google through our own access.

const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const big = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const COMP: Record<string, string> = { high: "bg-bad-soft text-bad", medium: "bg-warn-soft text-warn", low: "bg-ok-soft text-ok" };

/** The last 12 months as a small line, and how the last three compare with the three before. */
function Trend({ months }: { months: number[] }) {
  const m = months.slice(-12);
  if (m.length < 4) return <span className="text-xs text-faint">–</span>;
  const max = Math.max(...m, 1);
  const pts = m.map((v, i) => `${(i / (m.length - 1)) * 100},${28 - (v / max) * 26}`).join(" ");
  const recent = m.slice(-3).reduce((a, b) => a + b, 0);
  const before = m.slice(-6, -3).reduce((a, b) => a + b, 0);
  const change = before ? (recent - before) / before : null;
  const up = (change ?? 0) >= 0;
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-20" aria-hidden>
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className={up ? "text-ok" : "text-bad"} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {change != null && <span className={`tabular w-12 text-xs ${up ? "text-ok" : "text-bad"}`}>{`${up ? "+" : ""}${Math.round(change * 100)}%`}</span>}
    </span>
  );
}

function SearchRow({ s, rank }: { s: MarketSearch; rank: number }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-3 transition-colors hover:border-faint/60 md:grid-cols-[28px_minmax(0,1fr)_90px_120px_92px_120px]">
      <span className="tabular text-xs text-faint">{rank}</span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-[15px]">{s.text}</span>
        {s.seeded && <span className="w-fit rounded-full bg-ok-soft px-2 py-px text-[10.5px] text-ok">Converts for our clients</span>}
      </span>
      <span className="tabular text-right font-heading text-[17px] md:text-left">
        {big(s.searches)}
        <span className="ml-1 font-sans text-[11px] text-faint">/mo</span>
      </span>
      <span className="max-md:hidden">
        <Trend months={s.months} />
      </span>
      <span className="max-md:hidden">
        <span className={`rounded-full px-2 py-0.5 text-[11px] capitalize ${COMP[s.competition] ?? "bg-surface-2 text-muted"}`}>{s.competition === "unspecified" ? "unknown" : s.competition}</span>
      </span>
      <span className="tabular text-right text-sm text-muted max-md:hidden">{s.bidHigh ? `$${s.bidLow.toFixed(2)}–$${s.bidHigh.toFixed(2)}` : "–"}</span>
    </li>
  );
}

function Competitor({ c }: { c: MarketCompetitor }) {
  return (
    <li className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
      <span className="flex items-center gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=64`} alt="" width={22} height={22} className="rounded-[6px] bg-ink/10" />
        <span className="min-w-0 flex-1 truncate font-heading text-[15px]">{c.domain}</span>
        <span className="text-[11px] text-faint">{c.accounts > 1 ? `in ${c.accounts} of our accounts` : "in 1 account"}</span>
      </span>
      <span className="grid gap-1">
        <span className="flex justify-between text-xs">
          <span className="text-muted">Shows in</span>
          <span className="tabular">{pct(c.impressionShare)} of searches</span>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((c.impressionShare ?? 0) * 100)}%` }} />
        </span>
      </span>
      <span className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Overlap", c.overlap],
          ["Above us", c.above],
          ["We outrank", c.outranking],
        ].map(([l, v]) => (
          <span key={l as string} className="grid gap-0.5 rounded-[10px] bg-surface-2/70 py-1.5">
            <span className="tabular text-sm">{pct(v as number | null)}</span>
            <span className="text-[10.5px] text-faint">{l as string}</span>
          </span>
        ))}
      </span>
    </li>
  );
}

export function GoogleMarketView({ industries }: { industries: MarketIndustry[] }) {
  const wanted = useParam("gm");
  const current = industries.find((i) => i.id === wanted) ?? industries[0] ?? null;
  const [all, setAll] = useState(false);

  if (!current)
    return (
      <div className="mx-auto grid w-full max-w-3xl place-items-center gap-3 rounded-[22px] border border-dashed border-line px-6 py-16 text-center">
        <p className="font-heading text-2xl">Google in the market</p>
        <p className="max-w-lg text-sm text-muted">
          What people search in each industry we run Google for (volume, trend, competition and what the top spot costs), and the advertisers in our clients&apos; auctions. It&apos;s read straight from Google every Monday morning; the first read fills this in.
        </p>
      </div>
    );

  const searches = all ? current.searches : current.searches.slice(0, 15);
  const total = current.searches.reduce((n, s) => n + s.searches, 0);
  const updated = current.updatedAt ? new Date(current.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      {/* The industries */}
      <nav className="no-scrollbar -mx-4 flex w-[calc(100%+2rem)] items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:w-auto md:flex-wrap md:px-0" aria-label="Industry">
        {industries.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => pushParams({ gm: i.id })}
            className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${current.id === i.id ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}
          >
            {i.name}
          </button>
        ))}
      </nav>

      <section className="relative isolate grid gap-5 overflow-hidden rounded-[26px] border border-ink/[0.08] bg-deep p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:p-8">
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 -z-10 h-[340px] w-[340px] rounded-full bg-[rgba(200,16,46,0.28)] blur-[110px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-40 right-[-80px] -z-10 h-[300px] w-[300px] rounded-full bg-[rgba(79,124,255,0.14)] blur-[110px]" />
        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-text">{current.parent ?? "Industry"}</span>
          <h2 className="font-heading text-[30px] leading-tight md:text-[36px]">{current.name}</h2>
          <p className="max-w-xl text-sm text-ink/55">
            {current.clients.length ? `Our Google clients here: ${current.clients.join(", ")}.` : "No live Google client here right now."} From Keyword Planner and our accounts&apos; Auction Insights{updated ? `, read ${updated}` : ""}.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <span className="grid gap-0.5 rounded-[16px] border border-ink/10 bg-ink/[0.04] px-4 py-3">
            <span className="tabular font-display text-[28px] leading-none">{big(total)}</span>
            <span className="text-[11px] text-ink/50">searches a month</span>
          </span>
          <span className="grid gap-0.5 rounded-[16px] border border-ink/10 bg-ink/[0.04] px-4 py-3">
            <span className="tabular font-display text-[28px] leading-none">{current.competitors.length}</span>
            <span className="text-[11px] text-ink/50">competitors seen</span>
          </span>
        </div>
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-heading text-xl">What people search</h3>
          <span className="text-xs text-faint">US · monthly searches, the last 12 months, competition and the top-of-page bid</span>
        </div>
        {current.searches.length ? (
          <>
            <ul className="grid gap-1.5">
              {searches.map((s, i) => (
                <SearchRow key={s.text} s={s} rank={i + 1} />
              ))}
            </ul>
            {current.searches.length > 15 && (
              <button type="button" onClick={() => setAll(!all)} className="justify-self-start text-sm text-muted hover:text-fg max-md:min-h-11">
                {all ? "Show the top 15" : `Show all ${current.searches.length}`}
              </button>
            )}
          </>
        ) : (
          <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-muted">Keyword Planner hasn&apos;t returned searches for this industry yet.</p>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-heading text-xl">Who we&apos;re up against</h3>
          <span className="text-xs text-faint">The other advertisers in our clients&apos; searches, the last 30 days</span>
        </div>
        {current.competitors.length ? (
          <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {current.competitors.map((c) => (
              <Competitor key={c.domain} c={c} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-muted">Auction Insights aren&apos;t readable for these accounts through our access yet, or there&apos;s no search spend to compare.</p>
        )}
      </section>
    </div>
  );
}
