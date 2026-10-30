"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { GoogleIdea, GoogleInsight, GoogleKind } from "@/lib/google-ideas";
import { googleIdeaInsight } from "./google-actions";
import { SHEET_BACKDROP, SHEET_PANEL, SheetBar } from "../winners/winners-library";

// Google's Hall of Fame and live winners: our search ads, keywords and search terms that convert cheaper than their
// target or their account. Point at one for the AI's read (why it wins, and how to use it on another client); click for
// the whole thing.

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const KINDS: [GoogleKind | "all", string][] = [
  ["all", "Everything"],
  ["ad", "Ads"],
  ["keyword", "Keywords"],
  ["search_term", "Search terms"],
];
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

export function GoogleIdeasView({ items, mode, verticals }: { items: GoogleIdea[]; mode: "fame" | "live"; verticals: string[] }) {
  const kind = (useParam("gk") as GoogleKind | null) ?? "all";
  const vertical = useParam("gv");
  const openId = useParam("gi");
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      items.filter(
        (i) =>
          (kind === "all" || i.kind === kind) &&
          (!vertical || i.vertical === vertical) &&
          (term.length < 2 || `${i.client} ${i.content.text ?? ""} ${(i.content.headlines ?? []).join(" ")} ${i.campaign ?? ""}`.toLowerCase().includes(term)),
      ),
    [items, kind, vertical, term],
  );
  const opened = openId ? (items.find((i) => i.id === openId) ?? null) : null;

  // Pointing at a card (mouse only) shows the read beside it
  const [hover, setHover] = useState<{ i: GoogleIdea; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIn = (i: GoogleIdea, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    if (!window.matchMedia("(hover: hover)").matches) return;
    timer.current = setTimeout(() => setHover({ i, rect: el.getBoundingClientRect() }), 250);
  };
  const hoverOut = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(null), 180);
  };
  const keep = () => timer.current && clearTimeout(timer.current);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="font-heading text-[28px] leading-tight">{mode === "fame" ? "Google Hall of Fame" : "Live Google winners"}</h1>
          <p className="max-w-2xl text-sm text-muted">
            {mode === "fame"
              ? "Search ads, keywords and search terms that beat their client's target over the last six months (or their account by 20%+ without one). Point at one for why it won."
              : "What's converting at least 20% cheaper than its own account over the last 30 days, and still running. Point at one for why it's winning."}
          </p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clients, copy, keywords"
          aria-label="Search Google winners"
          className="h-11 w-full rounded-full border border-line bg-surface px-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70 md:h-10 md:w-72"
        />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <nav className="no-scrollbar -mx-4 flex w-[calc(100%+2rem)] items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:w-auto md:px-0" aria-label="What kind">
          {KINDS.map(([k, label]) => {
            const n = k === "all" ? items.length : items.filter((i) => i.kind === k).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => pushParams({ gk: k === "all" ? null : k })}
                className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${kind === k ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
              >
                {label} <span className="tabular opacity-60">{n}</span>
              </button>
            );
          })}
        </nav>
        {verticals.length > 1 && (
          <select
            value={vertical ?? ""}
            onChange={(e) => pushParams({ gv: e.target.value || null })}
            aria-label="Industry"
            className={`h-11 rounded-full border px-4 pr-8 text-sm outline-none md:h-9 ${vertical ? "border-fg/40 bg-surface-2 text-fg" : "border-line bg-surface text-muted"}`}
          >
            <option value="">Every industry</option>
            {verticals.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
      </div>

      {shown.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => pushParams({ gi: i.id })}
                onMouseEnter={(e) => hoverIn(i, e.currentTarget)}
                onMouseLeave={hoverOut}
                className="group grid h-full w-full content-start gap-4 rounded-[18px] border border-line bg-surface p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60 hover:shadow-[0_24px_50px_-28px_rgba(0,0,0,0.9)]"
              >
                <Item i={i} />
                <Numbers i={i} mode={mode} />
                <span className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-muted">
                    {i.client}
                    {i.vertical && <span className="text-faint"> · {i.vertical}</span>}
                  </span>
                  {i.live && mode === "fame" && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-ok">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" /> Live
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid place-items-center gap-2 rounded-[18px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-heading text-lg">{items.length ? "Nothing matches" : mode === "fame" ? "No Google Hall of Famers yet" : "No live Google winners right now"}</p>
          <p className="max-w-md text-sm text-muted">
            {items.length ? "Try another kind, industry or search." : "Every Google Ads account is read each morning. Winners show up here once they've spent and converted enough to count."}
          </p>
        </div>
      )}

      {hover && !opened && <Hover i={hover.i} rect={hover.rect} onEnter={keep} onLeave={hoverOut} />}
      {opened && <Sheet i={opened} mode={mode} onClose={() => closeParams("gi")} />}
    </div>
  );
}

/** The ad as it shows on Google, or the keyword or search term itself. */
function Item({ i, big = false }: { i: GoogleIdea; big?: boolean }) {
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
      <span className="grid gap-1.5 rounded-[12px] border border-line/70 bg-bg/60 p-3.5">
        <span className="flex items-center gap-2 text-[11px] text-muted">
          <span className="font-semibold text-fg">Sponsored</span>
          <span className="truncate">
            {domain ?? "your site"}
            {[i.content.path1, i.content.path2].filter(Boolean).map((p) => ` › ${p}`)}
          </span>
        </span>
        <span className={`font-medium leading-snug text-[#7aa7ff] ${big ? "text-[19px]" : "line-clamp-2 text-[16px]"}`}>{heads.slice(0, 3).join(" | ") || "Responsive search ad"}</span>
        <span className={`text-[13px] leading-snug text-muted ${big ? "" : "line-clamp-2"}`}>{big ? descs.join(" ") : descs[0]}</span>
        {big && heads.length > 3 && (
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
  const text = i.content.text ?? "";
  return (
    <span className="grid gap-2 rounded-[12px] border border-line/70 bg-bg/60 p-3.5">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{i.kind === "keyword" ? `Keyword · ${String(i.content.match ?? "").toLowerCase()} match` : "Search term · what they typed"}</span>
      <span className={`flex items-center gap-2 font-heading leading-snug ${big ? "text-2xl" : "text-[19px]"}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-faint" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="min-w-0 [overflow-wrap:anywhere]">{i.kind === "keyword" ? (MATCH[String(i.content.match)] ?? ((t: string) => t))(text) : text}</span>
      </span>
      {i.campaign && <span className="truncate text-xs text-faint">{i.campaign}</span>}
    </span>
  );
}

function Numbers({ i, mode }: { i: GoogleIdea; mode: "fame" | "live" }) {
  const live = mode === "live";
  const beat = live ? (i.liveBeatBy ?? i.beatBy) : i.beatBy;
  const result = live ? (i.liveResult ?? i.result) : i.result;
  const v = (x: number | null) => (x == null ? "–" : i.roas ? `${x.toFixed(1)}x` : money(x));
  return (
    <span className="flex items-baseline gap-2.5">
      <span className="tabular shrink-0 font-display text-[28px] leading-none text-ok">{Math.round(beat * 100)}%</span>
      <span className="text-[11px] leading-snug text-muted">
        {i.roas ? "higher ROAS" : "cheaper"}: {v(result)} {i.roas ? "" : "per conversion "}vs {v(i.usual)} {live ? "for the account" : i.basis === "target" ? "target" : "for the account"} · {Math.round(i.conversions).toLocaleString("en-US")} conversions on {money(i.spend)}
      </span>
    </span>
  );
}

function Read({ i, insight }: { i: GoogleIdea; insight: GoogleInsight | null | undefined }) {
  if (insight === undefined)
    return (
      <div className="grid gap-2" aria-busy>
        <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Reading why it wins…</p>
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
      <div className="grid gap-2.5 rounded-[14px] border border-line bg-surface-2/60 p-3.5">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">To use it on another {i.vertical ? i.vertical.toLowerCase() : ""} client</span>
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

function Hover({ i, rect, onEnter, onLeave }: { i: GoogleIdea; rect: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const insight = useRead(i);
  const width = Math.min(440, window.innerWidth - 32);
  const height = Math.min(600, window.innerHeight - 32);
  const left = window.innerWidth - rect.right - 16 >= width ? rect.right + 12 : rect.left - 12 - width >= 16 ? rect.left - 12 - width : Math.max(16, (window.innerWidth - width) / 2);
  const top = Math.min(Math.max(16, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 16);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ left, top, width, maxHeight: height, animation: "fadeIn .15s ease-out" }}
      className="fixed z-40 grid content-start gap-4 overflow-y-auto rounded-[18px] border border-line bg-bg/95 p-4 shadow-2xl backdrop-blur-xl"
    >
      <Numbers i={i} mode={i.live ? "live" : "fame"} />
      <Read i={i} insight={insight} />
    </div>
  );
}

function Sheet({ i, mode, onClose }: { i: GoogleIdea; mode: "fame" | "live"; onClose: () => void }) {
  const insight = useRead(i);
  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={i.client} className={`${SHEET_PANEL} md:max-w-[760px]`}>
        <SheetBar title={i.client} onClose={onClose} />
        <div className="flex items-start justify-between gap-3 max-md:hidden">
          <div className="grid gap-0.5">
            <p className="font-heading text-xl">{i.client}</p>
            <p className="text-xs text-faint">
              {[i.vertical, i.campaign, i.adGroup].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button onClick={onClose} className="h-9 rounded-full px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            Close
          </button>
        </div>
        <Item i={i} big />
        <Numbers i={i} mode={mode} />
        <span className="grid grid-cols-3 gap-2 text-center">
          {[
            ["Clicks", i.clicks.toLocaleString("en-US")],
            ["CTR", i.impressions ? `${((i.clicks / i.impressions) * 100).toFixed(2)}%` : "–"],
            ["Conv. rate", i.clicks ? `${((i.conversions / i.clicks) * 100).toFixed(1)}%` : "–"],
          ].map(([l, v]) => (
            <span key={l} className="grid gap-0.5 rounded-[12px] border border-line bg-surface px-2 py-2.5">
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
