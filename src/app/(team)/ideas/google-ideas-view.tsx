"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { tintFor } from "@/lib/colors";
import type { GoogleIdea, GoogleInsight, GoogleKind } from "@/lib/google-ideas";
import { googleIdeaInsight } from "./google-actions";
import { SHEET_BACKDROP, SHEET_PANEL, SheetBar } from "../winners/winners-library";

// Google's Hall of Fame and live winners: our search ads, keywords and search terms that convert cheaper than their
// target or their account. The best three lead; every card shows ours against the bar it beat. Point at one for the
// AI's read (why it wins, and how to use it on another client); click for the whole thing. Searches for the client's
// own name are set aside (they always win, and aren't an idea for anyone else) unless asked for.

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const big = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));

// Each kind in a Kaizen color: the brand red, gold and a cool silver
const KIND: Record<GoogleKind, { label: string; plural: string; color: string; icon: string }> = {
  ad: { label: "Search ad", plural: "Ads", color: "#e0505c", icon: "M4 5h16v14H4zM4 9h16M8 13h8M8 16h5" },
  keyword: { label: "Keyword", plural: "Keywords", color: "#e0a63a", icon: "M15 7a4 4 0 1 1-3.5 6L5 19.5 3.5 18l1.5-1.5L3.5 15 5 13.5l1.5 1.5 4-4A4 4 0 0 1 15 7z" },
  search_term: { label: "Search term", plural: "Search terms", color: "#a7a2b6", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" },
};
const MATCH: Record<string, (t: string) => string> = { EXACT: (t) => `[${t}]`, PHRASE: (t) => `"${t}"`, BROAD: (t) => t };

// Each read is fetched once per page, however many times it's pointed at
const reads = new Map<string, Promise<GoogleInsight | null>>();
function useRead(i: GoogleIdea | null) {
  const [got, setGot] = useState<{ id: string; insight: GoogleInsight | null } | null>(null);
  useEffect(() => {
    if (!i || i.insight) return;
    let live = true;
    if (!reads.has(i.id)) reads.set(i.id, googleIdeaInsight(i.id));
    reads.get(i.id)!.then((x) => live && setGot({ id: i.id, insight: x }));
    return () => {
      live = false;
    };
  }, [i]);
  if (!i) return undefined;
  if (i.insight) return i.insight;
  return got?.id === i.id ? got.insight : undefined;
}

const beatOf = (i: GoogleIdea, mode: "fame" | "live") => (mode === "live" ? (i.liveBeatBy ?? i.beatBy) : i.beatBy);
const resultOf = (i: GoogleIdea, mode: "fame" | "live") => (mode === "live" ? (i.liveResult ?? i.result) : i.result);
const fmt = (i: GoogleIdea, x: number | null) => (x == null ? "–" : i.roas ? `${x.toFixed(1)}x` : money(x));
const textOf = (i: GoogleIdea) => (i.kind === "keyword" ? (MATCH[String(i.content.match)] ?? ((t: string) => t))(i.content.text ?? "") : (i.content.text ?? (i.content.headlines ?? [])[0] ?? ""));

export function GoogleIdeasView({ items, mode, verticals }: { items: GoogleIdea[]; mode: "fame" | "live"; verticals: string[] }) {
  const kind = (useParam("gk") as GoogleKind | null) ?? null;
  const vertical = useParam("gv");
  const withBrand = useParam("gb") === "1";
  const openId = useParam("gi");
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const pool = useMemo(() => items.filter((i) => withBrand || !i.branded), [items, withBrand]);
  const shown = useMemo(
    () =>
      pool
        .filter(
          (i) =>
            (!kind || i.kind === kind) &&
            (!vertical || i.vertical === vertical) &&
            (term.length < 2 || `${i.client} ${i.content.text ?? ""} ${(i.content.headlines ?? []).join(" ")} ${i.campaign ?? ""}`.toLowerCase().includes(term)),
        )
        .sort((a, b) => beatOf(b, mode) - beatOf(a, mode) || b.conversions - a.conversions),
    [pool, kind, vertical, term, mode],
  );
  const branded = items.filter((i) => i.branded).length;
  const opened = openId ? (items.find((i) => i.id === openId) ?? null) : null;
  const top = shown.slice(0, 3);
  const rest = shown.slice(3);
  const median = (() => {
    const v = pool.map((i) => beatOf(i, mode)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  })();

  // Pointing at a card (mouse only) shows the read beside it
  const [hover, setHover] = useState<{ i: GoogleIdea; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIn = (i: GoogleIdea, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    if (!window.matchMedia("(hover: hover)").matches) return;
    timer.current = setTimeout(() => setHover({ i, rect: el.getBoundingClientRect() }), 280);
  };
  const hoverOut = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(null), 180);
  };
  const keep = () => timer.current && clearTimeout(timer.current);
  const cardProps = (i: GoogleIdea) => ({ onClick: () => pushParams({ gi: i.id }), onMouseEnter: (e: React.MouseEvent<HTMLElement>) => hoverIn(i, e.currentTarget), onMouseLeave: hoverOut });

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-7">
      {/* The stage: what this is, and the numbers behind it */}
      <section className="relative isolate overflow-hidden rounded-[28px] border border-ink/[0.08] bg-deep p-6 md:p-9">
        <span aria-hidden className="pointer-events-none absolute -left-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full bg-[rgba(200,16,46,0.28)] blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-48 right-[-120px] -z-10 h-[380px] w-[380px] rounded-full bg-[rgba(79,124,255,0.14)] blur-[120px]" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-2">
            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-text">
              <span>✦</span>
              {mode === "fame" ? "Six months of proof" : "Winning right now"}
            </span>
            <h1 className="font-heading text-[34px] leading-[1.05] tracking-tight md:text-[44px]">{mode === "fame" ? "Google Hall of Fame" : "Live Google winners"}</h1>
            <p className="max-w-xl text-sm text-ink/60">
              {mode === "fame"
                ? "The search ads, keywords and searches that beat their client's target (or their account by 20%+). Point at one for why it won and how to take it to another client."
                : "Beating their client's target over the last 30 days (or their account by 20%+), and still running. Point at one for why."}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {[
              [String(pool.length), "winners"],
              [`${Math.round(median * 100)}%`, mode === "fame" ? "typical edge" : "typical edge"],
              [big(pool.reduce((n, i) => n + i.conversions, 0)), "conversions"],
            ].map(([n, l]) => (
              <span key={l} className="grid min-w-[96px] gap-0.5 rounded-[18px] border border-ink/10 bg-ink/[0.04] px-4 py-3 backdrop-blur">
                <span className="tabular font-display text-[28px] leading-none">{n}</span>
                <span className="text-[11px] text-ink/50">{l}</span>
              </span>
            ))}
          </div>
        </div>

        {/* What kind, the industry, the client's own name, a search */}
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <span className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full border border-ink/10 bg-ink/[0.04] p-1">
            <button type="button" onClick={() => pushParams({ gk: null })} className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${!kind ? "bg-fg text-bg" : "text-ink/60 hover:text-fg"}`}>
              Everything <span className="tabular opacity-60">{pool.length}</span>
            </button>
            {(Object.keys(KIND) as GoogleKind[]).map((k) => (
              <button key={k} type="button" onClick={() => pushParams({ gk: k })} className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${kind === k ? "bg-fg text-bg" : "text-ink/60 hover:text-fg"}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: KIND[k].color }} />
                {KIND[k].plural} <span className="tabular opacity-60">{pool.filter((i) => i.kind === k).length}</span>
              </button>
            ))}
          </span>
          {verticals.length > 1 && (
            <select
              value={vertical ?? ""}
              onChange={(e) => pushParams({ gv: e.target.value || null })}
              aria-label="Industry"
              className={`h-11 rounded-full border px-4 pr-8 text-sm outline-none md:h-10 ${vertical ? "border-fg/40 bg-ink/10 text-fg" : "border-ink/10 bg-ink/[0.04] text-ink/60"}`}
            >
              <option value="">Every industry</option>
              {verticals.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          {branded > 0 && (
            <button
              type="button"
              role="switch"
              aria-checked={withBrand}
              onClick={() => pushParams({ gb: withBrand ? null : "1" })}
              className="inline-flex h-11 items-center gap-2.5 rounded-full border border-ink/10 bg-ink/[0.04] pl-2 pr-4 text-sm text-ink/60 transition-colors hover:text-fg md:h-10"
              title="Searches for the client's own name always win, so they're set aside unless you want them"
            >
              <span className={`relative h-5 w-9 rounded-full transition-colors ${withBrand ? "bg-ok" : "bg-ink/15"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${withBrand ? "left-[18px]" : "left-0.5"}`} />
              </span>
              Brand searches <span className="tabular opacity-60">{branded}</span>
            </button>
          )}
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clients, copy, keywords"
            aria-label="Search Google winners"
            className="h-11 w-full rounded-full border border-ink/10 bg-ink/[0.04] px-4 text-sm outline-none placeholder:text-ink/35 focus:border-brand/60 md:ml-auto md:h-10 md:w-64"
          />
        </div>
      </section>

      {shown.length ? (
        <>
          {/* The best three, on the podium */}
          <ul className="grid gap-3 md:grid-cols-3">
            {top.map((i, n) => (
              <li key={i.id} style={{ animation: `step-in .5s cubic-bezier(.2,.8,.2,1) ${n * 70}ms both` }}>
                <Featured i={i} rank={n + 1} mode={mode} {...cardProps(i)} />
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((i) => (
                <li key={i.id}>
                  <Card i={i} mode={mode} {...cardProps(i)} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="grid place-items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-heading text-lg">{items.length ? "Nothing matches" : mode === "fame" ? "No Google Hall of Famers yet" : "No live Google winners right now"}</p>
          <p className="max-w-md text-sm text-muted">{items.length ? "Try another kind, industry or search, or include brand searches." : "Every Google Ads account is read each morning. Winners show up here once they've spent and converted enough to count."}</p>
        </div>
      )}

      {hover && !opened && <Hover i={hover.i} rect={hover.rect} mode={mode} onEnter={keep} onLeave={hoverOut} />}
      {opened && <Sheet i={opened} mode={mode} onClose={() => closeParams("gi")} />}
    </div>
  );
}

type CardEvents = { onClick: () => void; onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void };

function KindBadge({ i }: { i: GoogleIdea }) {
  const k = KIND[i.kind];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: `${k.color}1f`, color: k.color }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={k.icon} />
      </svg>
      {k.label}
      {i.kind === "keyword" && i.content.match ? <span className="opacity-70">· {String(i.content.match).toLowerCase()}</span> : null}
    </span>
  );
}

/** Ours against the bar it beat, as two bars (shorter is better for a cost; longer for ROAS). */
function Versus({ i, mode, compact = false }: { i: GoogleIdea; mode: "fame" | "live"; compact?: boolean }) {
  const ours = resultOf(i, mode);
  const bar = i.usual;
  const max = Math.max(ours ?? 0, bar ?? 0, 0.0001);
  const label = i.basis === "target" ? "Target" : "Account";
  return (
    <span className={`grid gap-1.5 ${compact ? "" : "rounded-[14px] border border-line/70 bg-bg/50 p-3"}`}>
      {[
        ["Ours", ours, "bg-ok", "text-ok"],
        [label, bar, "bg-ink/25", "text-muted"],
      ].map(([l, v, cls, tone]) => (
        <span key={l as string} className="grid grid-cols-[52px_minmax(0,1fr)_64px] items-center gap-2 text-[11px]">
          <span className="text-faint">{l as string}</span>
          <span className="h-2 overflow-hidden rounded-full bg-ink/[0.06]">
            <span className={`block h-full rounded-full ${cls as string}`} style={{ width: `${Math.max(4, ((v as number | null) ?? 0) / max) * 100}%`, transition: "width .6s cubic-bezier(.2,.8,.2,1)" }} />
          </span>
          <span className={`tabular text-right ${tone as string}`}>
            {fmt(i, v as number | null)}
            {!i.roas && <span className="text-faint">/conv</span>}
          </span>
        </span>
      ))}
    </span>
  );
}

function Owner({ i }: { i: GoogleIdea }) {
  const tint = tintFor(i.client);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[10px] font-semibold" style={{ background: `${tint}26`, color: tint }}>
        {i.client
          .replace(/[^A-Za-z0-9 ]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()}
      </span>
      <span className="grid min-w-0 leading-tight">
        <span className="truncate text-[13px]">{i.client}</span>
        {i.vertical && <span className="truncate text-[11px] text-faint">{i.vertical}</span>}
      </span>
    </span>
  );
}

function LivePill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
      </span>
      Live
    </span>
  );
}

/** The thing itself: the ad as Google shows it, or the search. */
function Body({ i, size }: { i: GoogleIdea; size: "sm" | "lg" | "xl" }) {
  if (i.kind === "ad") {
    const domain = (() => {
      try {
        return i.content.url ? new URL(i.content.url).hostname.replace(/^www\./, "") : null;
      } catch {
        return null;
      }
    })();
    const heads = i.content.headlines ?? [];
    const descs = i.content.descriptions ?? [];
    return (
      <span className="grid gap-1.5 rounded-[14px] border border-line/70 bg-bg/60 p-3.5">
        <span className="flex items-center gap-2 text-[11px] text-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {domain && <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`} alt="" width={16} height={16} className="rounded-full bg-ink/10" />}
          <span className="font-semibold text-fg">Sponsored</span>
          <span className="truncate">
            {domain ?? "your site"}
            {[i.content.path1, i.content.path2].filter(Boolean).map((p) => ` › ${p}`)}
          </span>
        </span>
        <span className={`font-medium leading-snug text-[#7aa7ff] ${size === "xl" ? "text-[20px]" : size === "lg" ? "line-clamp-3 text-[17px]" : "line-clamp-2 text-[15.5px]"}`}>{heads.slice(0, 3).join(" | ") || "Responsive search ad"}</span>
        <span className={`text-[13px] leading-snug text-muted ${size === "xl" ? "" : "line-clamp-2"}`}>{size === "xl" ? descs.join(" ") : descs[0]}</span>
        {size === "xl" && heads.length > 3 && (
          <span className="mt-2 grid gap-1.5 border-t border-line pt-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Every headline</span>
            <span className="flex flex-wrap gap-1.5">
              {heads.map((h, n) => (
                <span key={n} className="rounded-full border border-line px-2.5 py-1 text-xs text-fg/85">
                  {h}
                </span>
              ))}
            </span>
          </span>
        )}
      </span>
    );
  }
  return (
    <span className={`flex items-center gap-3 rounded-[14px] border border-line/70 bg-bg/60 ${size === "sm" ? "px-3.5 py-3" : "px-4 py-4"}`}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink/[0.06] text-muted">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <span className={`min-w-0 font-heading leading-snug [overflow-wrap:anywhere] ${size === "xl" ? "text-[26px]" : size === "lg" ? "text-[22px]" : "text-[18px]"}`}>{textOf(i)}</span>
    </span>
  );
}

/** One of the best three: bigger, numbered, glowing in its kind's color. */
function Featured({ i, rank, mode, ...events }: { i: GoogleIdea; rank: number; mode: "fame" | "live" } & CardEvents) {
  const k = KIND[i.kind];
  return (
    <button
      type="button"
      {...events}
      className="group relative isolate grid h-full w-full content-start gap-4 overflow-hidden rounded-[24px] border border-ink/[0.09] bg-surface p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_30px_70px_-34px_rgba(0,0,0,0.95)]"
      style={{ boxShadow: `inset 0 1px 0 ${k.color}33` }}
    >
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 -z-10 h-56 w-56 rounded-full opacity-25 blur-[70px] transition-opacity duration-300 group-hover:opacity-45" style={{ background: k.color }} />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${k.color}, transparent)` }} />
      <span className="flex items-start justify-between gap-3">
        <span className="font-display text-[44px] leading-none text-transparent [-webkit-text-stroke:1px_var(--fg-faint)]">{String(rank).padStart(2, "0")}</span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {i.live && mode === "fame" && <LivePill />}
          <KindBadge i={i} />
        </span>
      </span>
      <Body i={i} size="lg" />
      <span className="flex items-end justify-between gap-3">
        <span className="grid">
          <span className="tabular font-display text-[46px] leading-none text-ok">{Math.round(beatOf(i, mode) * 100)}%</span>
          <span className="text-[11px] text-muted">{i.roas ? "higher ROAS" : "cheaper per conversion"}</span>
        </span>
        <span className="grid text-right">
          <span className="tabular font-heading text-[19px] leading-tight">{big(i.conversions)}</span>
          <span className="text-[11px] text-faint">conversions on {money(i.spend)}</span>
        </span>
      </span>
      <Versus i={i} mode={mode} />
      <Owner i={i} />
    </button>
  );
}

function Card({ i, mode, ...events }: { i: GoogleIdea; mode: "fame" | "live" } & CardEvents) {
  const k = KIND[i.kind];
  return (
    <button
      type="button"
      {...events}
      className="group relative isolate grid h-full w-full content-start gap-3.5 overflow-hidden rounded-[20px] border border-line bg-surface p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60 hover:shadow-[0_24px_50px_-28px_rgba(0,0,0,0.9)]"
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-70 transition-opacity group-hover:opacity-100" style={{ background: `linear-gradient(90deg, ${k.color}, transparent 70%)` }} />
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 -z-10 h-44 w-44 rounded-full opacity-0 blur-[60px] transition-opacity duration-300 group-hover:opacity-25" style={{ background: k.color }} />
      <span className="flex items-center justify-between gap-2">
        <KindBadge i={i} />
        <span className="tabular rounded-full bg-ok-soft px-2.5 py-0.5 font-heading text-[15px] text-ok">{Math.round(beatOf(i, mode) * 100)}%</span>
      </span>
      <Body i={i} size="sm" />
      <Versus i={i} mode={mode} compact />
      <span className="flex items-center justify-between gap-2 border-t border-line/70 pt-3">
        <Owner i={i} />
        <span className="flex shrink-0 items-center gap-2">
          <span className="tabular text-[11px] text-faint">{big(i.conversions)} conv</span>
          {i.live && mode === "fame" && <LivePill />}
        </span>
      </span>
    </button>
  );
}

function Read({ i, insight }: { i: GoogleIdea; insight: GoogleInsight | null | undefined }) {
  if (insight === undefined)
    return (
      <div className="grid gap-2" aria-busy>
        <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Reading why it wins…
        </p>
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${94 - n * 12}%` }} />
        ))}
      </div>
    );
  if (!insight) return <p className="text-sm text-muted">The read isn&apos;t available right now. The numbers above still tell the story.</p>;
  return (
    <div className="grid content-start gap-4 text-[13.5px] leading-relaxed">
      <p className="text-muted">{insight.observation}</p>
      <div className="grid gap-1">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Why it wins · {insight.angle}</span>
        <p>{insight.why}</p>
      </div>
      {insight.takeaways.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-faint">What to take from it</span>
          {insight.takeaways.map((t, n) => (
            <span key={n} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="relative grid gap-2.5 overflow-hidden rounded-[16px] border border-brand/30 bg-brand-soft p-4">
        <span className="text-[10px] uppercase tracking-[0.14em] text-brand-text">To use it on another {i.vertical ? i.vertical.toLowerCase() : ""} client</span>
        <p>
          <span className="text-faint">Copy · </span>
          {insight.deploy.copy}
        </p>
        <p>
          <span className="text-faint">Campaign · </span>
          {insight.deploy.campaign}
        </p>
        {insight.deploy.keywords.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {insight.deploy.keywords.map((k) => (
              <span key={k} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs">
                {k}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Hover({ i, rect, mode, onEnter, onLeave }: { i: GoogleIdea; rect: DOMRect; mode: "fame" | "live"; onEnter: () => void; onLeave: () => void }) {
  const insight = useRead(i);
  const width = Math.min(460, window.innerWidth - 32);
  const height = Math.min(620, window.innerHeight - 32);
  const left = window.innerWidth - rect.right - 16 >= width ? rect.right + 12 : rect.left - 12 - width >= 16 ? rect.left - 12 - width : Math.max(16, (window.innerWidth - width) / 2);
  const top = Math.min(Math.max(16, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 16);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ left, top, width, maxHeight: height, animation: "fadeIn .15s ease-out" }}
      className="fixed z-40 grid content-start gap-4 overflow-y-auto rounded-[20px] border border-line bg-bg/95 p-5 shadow-2xl backdrop-blur-xl"
    >
      <span className="flex items-center justify-between gap-3">
        <KindBadge i={i} />
        <span className="tabular font-display text-[32px] leading-none text-ok">{Math.round(beatOf(i, mode) * 100)}%</span>
      </span>
      <Versus i={i} mode={mode} />
      <Read i={i} insight={insight} />
    </div>
  );
}

function Sheet({ i, mode, onClose }: { i: GoogleIdea; mode: "fame" | "live"; onClose: () => void }) {
  const insight = useRead(i);
  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={i.client} className={`${SHEET_PANEL} md:max-w-[780px]`}>
        <SheetBar title={i.client} onClose={onClose} />
        <div className="flex items-start justify-between gap-3 max-md:hidden">
          <Owner i={i} />
          <button onClick={onClose} className="h-9 rounded-full px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            Close
          </button>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <KindBadge i={i} />
          {i.live && <LivePill />}
          <span className="truncate text-xs text-faint">{[i.campaign, i.adGroup].filter(Boolean).join(" · ")}</span>
        </span>
        <Body i={i} size="xl" />
        <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
          <span className="grid">
            <span className="tabular font-display text-[52px] leading-none text-ok">{Math.round(beatOf(i, mode) * 100)}%</span>
            <span className="text-xs text-muted">{i.roas ? "higher ROAS" : "cheaper per conversion"}</span>
          </span>
          <Versus i={i} mode={mode} />
        </div>
        <span className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          {[
            ["Conversions", big(i.conversions)],
            ["Spend", money(i.spend)],
            ["CTR", i.impressions ? `${((i.clicks / i.impressions) * 100).toFixed(2)}%` : "–"],
            ["Conv. rate", i.clicks ? `${((i.conversions / i.clicks) * 100).toFixed(1)}%` : "–"],
          ].map(([l, v]) => (
            <span key={l} className="grid gap-0.5 rounded-[14px] border border-line bg-surface px-2 py-3">
              <span className="tabular font-heading text-lg">{v}</span>
              <span className="text-[11px] text-faint">{l}</span>
            </span>
          ))}
        </span>
        <Read i={i} insight={insight} />
      </div>
    </div>
  );
}
