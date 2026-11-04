"use client";

import { useEffect, useRef, useState } from "react";

// The ad as it will run on Meta: the page, "Sponsored", the primary text cut at "See more", the creative (a picture that
// shows its thumbnail at once and sharpens when the full file lands, a video playing muted with a tap to unmute, or a
// carousel swiping card by card with each card's headline, description and button), then the link bar. Feed (4:5) or
// Stories and Reels (9:16) when both sizes exist. The colours are Facebook's own, in either theme, since it's a picture
// of their feed. Used by the copy studio and the client's portal.

export type PreviewFile = { thumb: string | null; url: string | null; mime: string; aspect: string | null };
export type PreviewCard = PreviewFile & { headline: string; description: string };
export type PreviewMedia =
  | { kind: "single"; feed: PreviewFile | null; story: PreviewFile | null }
  | { kind: "carousel"; cards: PreviewCard[] };

const VISIBLE = 125; // characters before "See more"

const ratioOf = (aspect: string | null, fallback: string) => (aspect === "1x1" ? "1 / 1" : aspect === "9x16" ? "9 / 16" : aspect === "4x5" ? "4 / 5" : fallback);

/** A picture: the thumbnail right away, the full file swapped in once it has loaded */
function Picture({ file, className = "" }: { file: PreviewFile; className?: string }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!file.url || file.url === file.thumb) return;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => setFull(true);
    img.src = file.url;
    return () => {
      img.onload = null;
    };
  }, [file.url, file.thumb]);
  const src = full ? file.url : (file.thumb ?? file.url);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" decoding="async" draggable={false} className={`absolute inset-0 h-full w-full object-cover ${!full && file.url && file.url !== file.thumb ? "blur-[0.5px]" : ""} ${className}`} />
  ) : (
    <span className="absolute inset-0 animate-pulse bg-[#e4e6eb]" />
  );
}

/**
 * A video: the poster frame at once, then playing muted and looping; a tap turns the sound on or off. With onMoment
 * (the client's portal), a tap pauses it and comments at that moment instead, and the sound has its own button.
 */
function Video({ file, onMoment }: { file: PreviewFile; onMoment?: (tMs: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const sound = () => {
    setMuted(!muted);
    void ref.current?.play().catch(() => undefined);
  };
  return (
    <>
      <video
        ref={ref}
        src={file.url ?? undefined}
        poster={file.thumb ?? undefined}
        muted={muted}
        autoPlay
        loop
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full object-cover"
        onClick={(e) => {
          e.stopPropagation();
          const v = ref.current;
          if (onMoment && v) {
            v.pause();
            onMoment(Math.round(v.currentTime * 1000));
          } else sound();
        }}
      />
      {onMoment ? (
        <>
          <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">Tap to comment at this moment</span>
          <button
            type="button"
            aria-label={muted ? "Sound on" : "Sound off"}
            onClick={(e) => {
              e.stopPropagation();
              sound();
            }}
            className="absolute bottom-2 right-2 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-[15px] text-white"
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </>
      ) : (
        <span className="pointer-events-none absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-[13px] text-white">{muted ? "🔇" : "🔊"}</span>
      )}
    </>
  );
}

function Media({ file, onPick, onMoment }: { file: PreviewFile; onPick?: (e: React.MouseEvent<HTMLDivElement>) => void; onMoment?: (tMs: number) => void }) {
  return (
    <div className="absolute inset-0" onClick={onPick}>
      {file.mime.startsWith("video/") ? <Video file={file} onMoment={onMoment} /> : <Picture file={file} />}
    </div>
  );
}

export function AdPreview({
  page,
  primaryText,
  headline,
  description,
  cta,
  landing,
  media,
  copyPending = false,
  onMediaClick,
  onVideoMoment,
  overlay,
}: {
  page: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  landing?: string | null;
  media: PreviewMedia | null;
  /** The copy isn't written or approved yet: a quiet placeholder where it goes */
  copyPending?: boolean;
  /** A click on the creative (the portal pins a comment there): which card, and where as fractions */
  onMediaClick?: (at: { card: number; x: number; y: number }) => void;
  /** A tap on a video (the portal comments at that moment): which card, and when, in milliseconds */
  onVideoMoment?: (at: { card: number; tMs: number }) => void;
  /** Drawn over the creative (the portal's pins), given the card shown */
  overlay?: (card: number) => React.ReactNode;
}) {
  const [more, setMore] = useState(false);
  const hasStory = media?.kind === "single" && Boolean(media.story);
  const hasFeed = media?.kind === "single" && Boolean(media.feed);
  const [placement, setPlacement] = useState<"feed" | "story">(hasFeed || !hasStory ? "feed" : "story");
  const [card, setCard] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const cut = primaryText.length > VISIBLE && !more;
  const domain = landing ? landing.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : `${page.replace(/\s+/g, "").toLowerCase()}.com`;
  const pick = (index: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onMediaClick) return;
    const r = e.currentTarget.getBoundingClientRect();
    onMediaClick({ card: index, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const moment = (index: number) => (onVideoMoment ? (tMs: number) => onVideoMoment({ card: index, tMs }) : undefined);
  const go = (i: number) => {
    const el = strip.current;
    if (!el || media?.kind !== "carousel") return;
    const next = Math.max(0, Math.min(media.cards.length - 1, i));
    const child = el.children[next] as HTMLElement | undefined;
    if (child) el.scrollTo({ left: child.offsetLeft - 12, behavior: "smooth" });
  };

  const text = copyPending ? (
    <p className="px-3 py-2 text-[13px] italic text-[#65676b]">The ad copy is being written: it shows here once it&apos;s ready.</p>
  ) : (
    <p className="whitespace-pre-wrap px-3 py-2 text-[13px] leading-[1.35]">
      {cut ? primaryText.slice(0, VISIBLE).trimEnd() : primaryText}
      {cut && (
        <button type="button" onClick={() => setMore(true)} className="text-[#65676b]">
          … See more
        </button>
      )}
    </p>
  );
  const ctaPill = <span className="shrink-0 rounded-[6px] bg-[#e4e6eb] px-3 py-1.5 text-[13px] font-semibold text-[#050505]">{cta || "Learn More"}</span>;

  // Stories and Reels: the creative full screen, the text over its foot
  if (placement === "story" && media?.kind === "single" && media.story)
    return (
      <div className="grid gap-2">
        <Placements value={placement} onChange={setPlacement} show={hasFeed && hasStory} />
        <div className="relative mx-auto w-full max-w-[300px] overflow-hidden rounded-[16px] bg-black" style={{ aspectRatio: "9 / 16" }}>
          <Media file={media.story} onPick={pick(0)} onMoment={moment(0)} />
          {overlay?.(0)}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/50 to-transparent p-3 text-white">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-[12px] font-semibold text-black">{page.charAt(0)}</span>
            <span className="text-[12px] font-semibold">{page}</span>
            <span className="text-[11px] opacity-80">Sponsored</span>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 grid gap-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 pt-10 text-white">
            {!copyPending && <p className="line-clamp-2 text-[12px] leading-snug">{primaryText}</p>}
            <span className="mx-auto rounded-full bg-white px-4 py-1.5 text-[12px] font-semibold text-black">{cta || "Learn More"}</span>
          </div>
        </div>
      </div>
    );

  return (
    <div className="grid gap-2">
      <Placements value={placement} onChange={setPlacement} show={hasFeed && hasStory} />
      <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-[14px] text-[#050505] shadow-[0_20px_60px_-25px_rgba(0,0,0,0.6)]" style={{ background: "#ffffff" }}>
        <div className="flex items-center gap-2 px-3 pt-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1d1d1f] text-sm font-semibold text-white">{page.charAt(0)}</span>
          <span className="grid leading-tight">
            <span className="text-[13px] font-semibold">{page}</span>
            <span className="text-[11px] text-[#65676b]">Sponsored · ◍</span>
          </span>
          <span className="ml-auto text-[#65676b]">···</span>
        </div>
        {text}

        {media?.kind === "carousel" ? (
          <div className="relative pb-3">
            <div
              ref={strip}
              // Its own swipe area: dragging here moves the cards, never the portal's swipe to approve
              data-carousel
              onScroll={(e) => {
                const el = e.currentTarget;
                const w = (el.children[0] as HTMLElement | undefined)?.offsetWidth ?? 1;
                setCard(Math.round(el.scrollLeft / (w + 8)));
              }}
              className="flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {media.cards.map((c, i) => (
                <div key={i} className="w-[78%] shrink-0 snap-start overflow-hidden rounded-[10px] border border-[#e4e6eb]">
                  <div className="relative w-full bg-[#e4e6eb]" style={{ aspectRatio: ratioOf(c.aspect, "1 / 1") }}>
                    <Media file={c} onPick={pick(i)} onMoment={moment(i)} />
                    {overlay?.(i)}
                  </div>
                  <div className="flex items-center gap-2 bg-[#f0f2f5] px-2.5 py-2">
                    <span className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-[13px] font-semibold">{copyPending ? "Headline" : c.headline || headline || "Headline"}</span>
                      {(c.description || (!copyPending && description)) && <span className="truncate text-[11px] text-[#65676b]">{c.description || description}</span>}
                    </span>
                    {ctaPill}
                  </div>
                </div>
              ))}
            </div>
            {media.cards.length > 1 && (
              <>
                <button type="button" aria-label="Previous card" onClick={() => go(card - 1)} className={`absolute left-1 top-[40%] hidden h-8 w-8 place-items-center rounded-full bg-white/95 text-[#050505] shadow md:grid ${card === 0 ? "md:hidden" : ""}`}>
                  ‹
                </button>
                <button type="button" aria-label="Next card" onClick={() => go(card + 1)} className={`absolute right-1 top-[40%] hidden h-8 w-8 place-items-center rounded-full bg-white/95 text-[#050505] shadow md:grid ${card >= media.cards.length - 1 ? "md:hidden" : ""}`}>
                  ›
                </button>
                <div className="mt-2 flex justify-center gap-1.5">
                  {media.cards.map((_, i) => (
                    <button key={i} type="button" aria-label={`Card ${i + 1}`} onClick={() => go(i)} className={`h-1.5 rounded-full transition-all ${i === card ? "w-4 bg-[#1877f2]" : "w-1.5 bg-[#bcc0c4]"}`} />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="relative w-full bg-[#e4e6eb]" style={{ aspectRatio: ratioOf(media?.kind === "single" ? (media.feed ?? media.story)?.aspect ?? null : null, "4 / 5") }}>
              {media?.kind === "single" && (media.feed ?? media.story) ? (
                <>
                  <Media file={(media.feed ?? media.story)!} onPick={pick(0)} onMoment={moment(0)} />
                  {overlay?.(0)}
                </>
              ) : (
                <span className="absolute inset-0 animate-pulse bg-[#e4e6eb]" />
              )}
            </div>
            <a
              href={landing ?? undefined}
              target="_blank"
              rel="noreferrer"
              title={landing ? `Opens ${landing}` : "No landing page set"}
              className={`flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5 ${landing ? "hover:bg-[#e8eaed]" : "pointer-events-none"}`}
            >
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-[11px] uppercase text-[#65676b]">{domain}</span>
                <span className="truncate text-[14px] font-semibold">{copyPending ? "Headline" : headline || "Headline"}</span>
                {!copyPending && description && <span className="truncate text-[12px] text-[#65676b]">{description}</span>}
              </span>
              {ctaPill}
            </a>
          </>
        )}
        <div className="flex justify-around border-t border-[#e4e6eb] py-2 text-[12px] font-medium text-[#65676b]">
          <span>Like</span>
          <span>Comment</span>
          <span>Share</span>
        </div>
      </div>
    </div>
  );
}

function Placements({ value, onChange, show }: { value: "feed" | "story"; onChange: (v: "feed" | "story") => void; show: boolean }) {
  if (!show) return null;
  return (
    <div className="mx-auto flex rounded-full border border-line p-0.5 text-xs" role="tablist">
      {(["feed", "story"] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)} className={`h-8 rounded-full px-3.5 max-md:h-10 ${value === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
          {k === "feed" ? "Feed 4:5" : "Stories & Reels 9:16"}
        </button>
      ))}
    </div>
  );
}

/** A design's files as the preview takes them: a carousel's cards in order, or its feed (4:5) and story (9:16) files */
export function previewMedia(
  format: "image" | "video" | "carousel",
  files: { thumbUrl: string | null; url: string | null; mime: string; aspect: string | null; card: number | null }[],
  cardCopy: { headline: string; description: string }[] = [],
): PreviewMedia | null {
  if (!files.length) return null;
  const as = (f: (typeof files)[number]): PreviewFile => ({ thumb: f.thumbUrl, url: f.url, mime: f.mime, aspect: f.aspect });
  if (format === "carousel") {
    const sorted = [...files].sort((a, b) => (a.card ?? 0) - (b.card ?? 0));
    // Each card's own headline and description, by its card number (in order when the files aren't numbered)
    const copyOf = (f: (typeof files)[number], i: number) => cardCopy[f.card != null && f.card > 0 ? f.card - 1 : i];
    return { kind: "carousel", cards: sorted.map((f, i) => ({ ...as(f), headline: copyOf(f, i)?.headline ?? "", description: copyOf(f, i)?.description ?? "" })) };
  }
  const feed = files.find((f) => f.aspect === "4x5") ?? files.find((f) => f.aspect !== "9x16") ?? null;
  const story = files.find((f) => f.aspect === "9x16") ?? null;
  return { kind: "single", feed: feed ? as(feed) : null, story: story ? as(story) : null };
}
