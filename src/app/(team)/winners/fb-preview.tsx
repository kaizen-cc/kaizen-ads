"use client";

import { useEffect, useRef, useState } from "react";
import type { AdDetail } from "@/lib/context/meta";
import type { Winner } from "@/lib/industry";
import type { WinnerInsight } from "@/lib/winner-insight";
import { winnerAd, winnerInsight } from "./actions";

// Read once per page: the full ad from Meta and the AI's read, shared by the hover card and the full view
const ads = new Map<string, Promise<AdDetail | null>>();
const insights = new Map<string, Promise<WinnerInsight | null>>();
export const loadAd = (id: string) => {
  if (!ads.has(id)) ads.set(id, winnerAd(id));
  return ads.get(id)!;
};
export const loadInsight = (w: Winner, ad: AdDetail | null) => {
  if (!insights.has(w.id)) insights.set(w.id, winnerInsight(w, { text: ad?.text, headline: ad?.headline, image: ad?.image ?? ad?.video?.poster ?? null, cta: ad?.cta }));
  return insights.get(w.id)!;
};

export function useAd(id: string) {
  const [ad, setAd] = useState<AdDetail | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadAd(id).then((d) => live && setAd(d));
    return () => {
      live = false;
    };
  }, [id]);
  return ad;
}

export function useInsight(w: Winner, ad: AdDetail | null | undefined) {
  const [insight, setInsight] = useState<WinnerInsight | null | undefined>(undefined);
  useEffect(() => {
    if (ad === undefined) return;
    let live = true;
    loadInsight(w, ad).then((d) => live && setInsight(d));
    return () => {
      live = false;
    };
  }, [w, ad]);
  return insight;
}

const domainOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "").toUpperCase() : null;
  } catch {
    return null;
  }
};

/**
 * The ad as it shows in the Facebook feed: the Page, the primary text (with See more), the image or the video playing
 * on its own, then the link bar with the headline and the button. The image, headline and button go where the ad goes.
 */
export function FbPreview({ ad, w, autoPlay = false, compact = false }: { ad: AdDetail | null | undefined; w: Winner; autoPlay?: boolean; compact?: boolean }) {
  const [more, setMore] = useState(false);
  const [muted, setMuted] = useState(true);
  const [frame, setFrame] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const text = ad?.text ?? w.text;
  const headline = ad?.headline ?? w.headline;
  const link = ad?.link ?? null;
  const name = ad?.page?.name ?? w.client;
  const long = (text?.length ?? 0) > 140;
  const canPlay = Boolean(ad?.video?.source);
  const still = ad?.image ?? ad?.video?.poster ?? w.thumbnail;

  const open = (e: React.MouseEvent) => {
    if (!link) return;
    e.preventDefault();
    window.open(link, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="overflow-hidden rounded-[12px] bg-white text-[#050505] shadow-sm">
      <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        {ad?.page?.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.page.picture} alt="" className="h-9 w-9 rounded-full object-cover" />
        ) : (
          <span className="grid h-9 w-9 place-items-center rounded-full bg-[#e4e6eb] text-sm font-semibold">{name[0]}</span>
        )}
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[14px] font-semibold">{name}</span>
          <span className="flex items-center gap-1 text-[12px] text-[#65676b]">
            Sponsored ·
            <svg width="11" height="11" viewBox="0 0 16 16" fill="#65676b" aria-hidden>
              <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm5.6 5H11a12 12 0 0 0-1-3.4A6.5 6.5 0 0 1 13.6 5ZM8 1.6c.7 1 1.2 2.1 1.5 3.4h-3C6.8 3.7 7.3 2.6 8 1.6ZM1.7 9.5a6.6 6.6 0 0 1 0-3h2.7a13 13 0 0 0 0 3H1.7Zm.7 1.5H5c.3 1.2.7 2.4 1 3.4A6.5 6.5 0 0 1 2.4 11ZM5 5H2.4A6.5 6.5 0 0 1 6 1.6 12 12 0 0 0 5 5Zm3 9.4c-.7-1-1.2-2.1-1.5-3.4h3c-.3 1.3-.8 2.4-1.5 3.4Zm1.8-4.9H6.2a11.7 11.7 0 0 1 0-3h3.6a11.7 11.7 0 0 1 0 3Zm.2 4.9c.4-1 .8-2.2 1-3.4h2.6a6.5 6.5 0 0 1-3.6 3.4Zm1.6-4.9a13 13 0 0 0 0-3h2.7a6.6 6.6 0 0 1 0 3h-2.7Z" />
            </svg>
          </span>
        </span>
        <span className="text-lg leading-none text-[#65676b]">···</span>
      </div>

      {text && (
        <p className={`whitespace-pre-wrap px-3 pb-2.5 text-[14px] leading-[1.34] ${more || !long ? "" : "line-clamp-3"} `}>
          {text}
        </p>
      )}
      {text && long && !more && (
        <button onClick={() => setMore(true)} className="-mt-2 mb-2 px-3 text-[14px] font-semibold text-[#65676b] hover:underline">
          See more
        </button>
      )}

      <div className="relative bg-black">
        {ad === undefined ? (
          <div className="relative aspect-[4/5] animate-pulse bg-[#e9ebee]">
            {w.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={w.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
            )}
          </div>
        ) : canPlay ? (
          <>
            <video
              ref={video}
              src={ad!.video!.source!}
              poster={ad!.video!.poster ?? w.thumbnail ?? undefined}
              autoPlay={autoPlay}
              muted={muted}
              loop
              playsInline
              controls={!autoPlay}
              onClick={autoPlay ? open : undefined}
              className={`block w-full bg-black object-contain ${compact ? "max-h-[360px]" : "max-h-[62vh]"} ${autoPlay && link ? "cursor-pointer" : ""}`}
            />
            {autoPlay && (
              <button
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "Unmute" : "Mute"}
                className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur"
              >
                {muted ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M3 9v6h4l5 5V4L7 9H3Zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7Z" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z" />
                  </svg>
                )}
              </button>
            )}
          </>
        ) : frame && ad?.preview ? (
          <iframe src={ad.preview} title="Ad preview" className="block h-[560px] w-full border-0 bg-white" scrolling="no" />
        ) : (
          <a href={link ?? undefined} onClick={open} className={`relative block ${link ? "cursor-pointer" : "cursor-default"}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {still && <img src={still} alt="" className={`block w-full bg-white object-contain ${compact ? "max-h-[360px]" : "max-h-[62vh]"}`} />}
            {ad?.video && ad.preview && (
              <span
                role="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFrame(true);
                }}
                className="absolute inset-0 grid place-items-center bg-black/20 transition-colors hover:bg-black/30"
                aria-label="Play the video"
              >
                <span className="grid h-14 w-14 place-items-center rounded-full bg-white/95 shadow-xl">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#050505" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </span>
            )}
          </a>
        )}
      </div>

      {!frame && (headline || ad?.cta || link) && (
        <a href={link ?? undefined} onClick={open} className={`flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5 ${link ? "cursor-pointer hover:bg-[#e8eaed]" : "cursor-default"}`}>
          <span className="min-w-0 flex-1 leading-tight">
            {domainOf(link) && <span className="block truncate text-[12px] text-[#65676b]">{domainOf(link)}</span>}
            {headline && <span className="block truncate text-[15px] font-semibold">{headline}</span>}
          </span>
          {ad?.cta && <span className="shrink-0 rounded-md bg-[#e4e6eb] px-3 py-2 text-[14px] font-semibold">{ad.cta}</span>}
        </a>
      )}
      {link && <p className="truncate bg-white px-3 py-1.5 text-[11px] text-[#65676b]">Goes to {link.replace(/^https?:\/\//, "").split("?")[0]}</p>}
    </div>
  );
}

/** The AI's read: what the numbers show, and why the creative most likely works. */
export function InsightPanel({ w, insight, dense = false }: { w: Winner; insight: WinnerInsight | null | undefined; dense?: boolean }) {
  const body = dense ? "text-[13px] leading-[1.55]" : "text-sm leading-relaxed";
  const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: x < 100 ? 2 : 0 })}`;
  return (
    <div className={`grid content-start ${dense ? "gap-3.5" : "gap-3"}`}>
      <div className="flex items-baseline gap-2.5 rounded-[12px] border border-ok/25 bg-ok/[0.06] px-3 py-2.5">
        <span className={`tabular shrink-0 font-display text-ok ${dense ? "text-2xl" : "text-3xl"}`}>{w.ratio}x</span>
        <span className="text-[11px] leading-snug text-muted">
          {money(w.costPerResult)} vs {money(w.usual)} per {w.result ?? "result"} · {w.results.toLocaleString("en-US")} on {money(w.spend)} · CTR {w.ctr}%
        </span>
      </div>
      {insight === undefined ? (
        <div className="grid gap-2" aria-busy>
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Reading the ad…</p>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${92 - i * 14}%` }} />
          ))}
        </div>
      ) : insight === null ? (
        <p className="text-xs text-faint">The AI read isn&apos;t available for this ad right now.</p>
      ) : (
        <>
          <section className="grid gap-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">What the numbers show</p>
            <p className={body}>{insight.observation}</p>
          </section>
          <section className="grid gap-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">Why the creative works</p>
            <p className={`${body} text-muted`}>{insight.creative}</p>
          </section>
          {(insight.hook || insight.angle) && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[12px] border border-line px-3 py-2.5 text-[12px] leading-snug">
              {insight.hook && (
                <>
                  <dt className="text-faint">Hook</dt>
                  <dd className="text-muted">{insight.hook}</dd>
                </>
              )}
              {insight.angle && (
                <>
                  <dt className="text-faint">Angle</dt>
                  <dd className="text-muted">{insight.angle}</dd>
                </>
              )}
            </dl>
          )}
          {insight.takeaways.length > 0 && (
            <section className="grid gap-1 rounded-[12px] border border-ok/25 bg-ok/[0.06] p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ok">Borrow this</p>
              <ul className="grid gap-1.5 text-[13px] leading-snug">
                {insight.takeaways.map((t) => (
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
