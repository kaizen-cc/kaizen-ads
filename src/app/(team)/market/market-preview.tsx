"use client";

import { useEffect, useState } from "react";
import type { MarketAd } from "@/lib/market";
import { FeedPreview, type FeedView } from "../winners/fb-preview";
import { marketRead, type MarketRead } from "./actions";

// A market ad as it runs in the feed, and the AI's read of why it's working: shared by the hover card, the full view
// and the client page.

const reads = new Map<string, Promise<MarketRead | null>>();
const loadRead = (a: MarketAd) => {
  if (!reads.has(a.id)) reads.set(a.id, a.read && a.why ? Promise.resolve({ observation: a.observation, why: a.why, hook: a.hook, angle: a.angle, takeaways: a.takeaways }) : marketRead(a.id));
  return reads.get(a.id)!;
};

export function useMarketRead(a: MarketAd) {
  const [read, setRead] = useState<MarketRead | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadRead(a).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [a]);
  return read;
}

export const viewOf = (a: MarketAd): FeedView => ({
  pageName: a.pageName ?? a.brand,
  pagePicture: a.brandLogo,
  text: a.body,
  headline: a.headline,
  cta: a.cta,
  link: a.landingUrl,
  media: a.media.map((m) => ({ type: m.type, url: m.url, poster: m.thumb })),
  placeholder: a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null,
  preview: null,
});

export function MarketPreview({ a, autoPlay = false, compact = false }: { a: MarketAd; autoPlay?: boolean; compact?: boolean }) {
  return <FeedPreview view={viewOf(a)} autoPlay={autoPlay} compact={compact} />;
}

/** What its run says, why the creative is most likely working, and what to borrow. */
export function MarketReadPanel({ a, read, dense = false }: { a: MarketAd; read: MarketRead | null | undefined; dense?: boolean }) {
  const body = dense ? "text-[13px] leading-[1.55]" : "text-sm leading-relaxed";
  return (
    <div className={`grid content-start ${dense ? "gap-3.5" : "gap-3"}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {a.daysActive != null && <span className={`rounded-full px-2.5 py-1 ${a.proven ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>Live {a.daysActive} days</span>}
        {a.rank === 1 && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Brand&apos;s most-shown ad</span>}
        {a.rank != null && a.rank > 1 && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">#{a.rank} most shown</span>}
        {a.testing && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Brand is testing a lot</span>}
        {a.fresh && <span className="rounded-full bg-brand-soft px-2.5 py-1 text-brand-text">New this week</span>}
      </div>
      {read === undefined ? (
        <div className="grid gap-2" aria-busy>
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Reading the ad…</p>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${92 - i * 14}%` }} />
          ))}
        </div>
      ) : read === null || !read.why ? (
        <p className="text-xs text-faint">The AI read isn&apos;t available for this ad right now.</p>
      ) : (
        <>
          {read.observation && (
            <section className="grid gap-1">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">What its run says</p>
              <p className={body}>{read.observation}</p>
            </section>
          )}
          <section className="grid gap-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">Why it&apos;s likely working</p>
            <p className={`${body} text-muted`}>{read.why}</p>
          </section>
          {(read.hook || read.angle) && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[12px] border border-line px-3 py-2.5 text-[12px] leading-snug">
              {read.hook && (
                <>
                  <dt className="text-faint">Hook</dt>
                  <dd className="text-muted">{read.hook}</dd>
                </>
              )}
              {read.angle && (
                <>
                  <dt className="text-faint">Angle</dt>
                  <dd className="text-muted">{read.angle}</dd>
                </>
              )}
            </dl>
          )}
          {read.takeaways.length > 0 && (
            <section className="grid gap-1 rounded-[12px] border border-ok/25 bg-ok/[0.06] p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ok">Take from it</p>
              <ul className="grid gap-1.5 text-[13px] leading-snug">
                {read.takeaways.map((t) => (
                  <li key={t} className="flex gap-2">
                    <span className="text-ok">→</span>
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Hovering a market ad (with a mouse): the ad as it runs, playing if it's a video, with the AI's read beside it. */
export function MarketHoverCard({ a, rect, sub, onEnter, onLeave, onOpen }: { a: MarketAd; rect: DOMRect; sub: string; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const read = useMarketRead(a);
  const width = Math.min(780, window.innerWidth - 32);
  const height = Math.min(640, window.innerHeight - 32);
  const left = window.innerWidth - rect.right - 16 >= width ? rect.right + 12 : rect.left - 12 - width >= 16 ? rect.left - 12 - width : Math.max(16, (window.innerWidth - width) / 2);
  const top = Math.min(Math.max(16, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 16);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ left, top, width, height }}
      className="fixed z-40 grid grid-cols-[minmax(0,330px)_minmax(0,1fr)] gap-4 overflow-hidden rounded-[18px] border border-line bg-bg/95 p-3 shadow-2xl backdrop-blur-xl"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain rounded-[12px] [scrollbar-width:thin]">
        <MarketPreview a={a} autoPlay compact />
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex shrink-0 items-start justify-between gap-2 pt-1">
          <div className="min-w-0">
            <p className="truncate font-heading text-[15px] leading-tight">{a.pageName ?? a.brand}</p>
            <p className="truncate text-[11px] text-faint">{sub}</p>
          </div>
          <button onClick={onOpen} className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
            Brief a client
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1.5 [scrollbar-width:thin]">
          <MarketReadPanel a={a} read={read} dense />
        </div>
      </div>
    </div>
  );
}
