"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefThumb } from "@/components/ref-thumb";
import type { Reference } from "@/lib/ai-tools/motion";

// The live market ads the strategist brought up in Talk it through (from Motion, the client's own market only), as small
// reference cards under its message: the ad's picture, the brand, how long it has run, and "Add to brief". Hovering a
// card (tapping it on a phone) opens its preview: the ad itself, playing when it's a video, with why the strategist
// suggested it, its hook and the link to open it in Motion.

export function MarketRefCards({ refs, added, onAdd }: { refs: Reference[]; added: string[]; onAdd: (url: string) => void }) {
  const [open, setOpen] = useState<{ id: string; at: DOMRect; pinned: boolean } | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = null;
  };
  const closeSoon = () => {
    hold();
    leave.current = setTimeout(() => setOpen((o) => (o?.pinned ? o : null)), 160);
  };
  useEffect(() => () => hold(), []);

  if (!refs.length) return null;
  const shown = open ? refs.find((r) => r.id === open.id) ?? null : null;
  return (
    <>
      <ul className="-mx-1 flex max-w-full snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]" aria-label="Live ads from their market">
        {refs.map((r) => {
          const has = added.includes(r.url);
          return (
            <li
              key={r.id}
              className="grid w-[136px] shrink-0 snap-start content-start overflow-hidden rounded-[14px] border border-line bg-bg"
              onMouseEnter={(e) => {
                // Hover is for a mouse; a phone opens it with a tap
                if (!window.matchMedia("(hover: hover)").matches) return;
                hold();
                setOpen({ id: r.id, at: e.currentTarget.getBoundingClientRect(), pinned: false });
              }}
              onMouseLeave={closeSoon}
            >
              <button
                type="button"
                onClick={(e) => {
                  const at = (e.currentTarget.closest("li") ?? e.currentTarget).getBoundingClientRect();
                  setOpen((o) => (o?.id === r.id && o.pinned ? null : { id: r.id, at, pinned: true }));
                }}
                className="relative block aspect-[4/5] w-full overflow-hidden bg-gradient-to-br from-surface-2 to-surface text-left"
                aria-label={`Preview ${r.brand}'s ad`}
                aria-expanded={open?.id === r.id}
              >
                {r.thumb ? <RefThumb src={r.thumb} hoverZoom={false} /> : <span className="absolute inset-0 grid place-items-center p-2 text-center font-heading text-[14px]">{r.brand}</span>}
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-2 py-0.5 text-[10px] text-white">{r.video ? "Video" : "Motion"}</span>
                {r.video && (
                  <span aria-hidden className="absolute inset-0 grid place-items-center">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  </span>
                )}
              </button>
              <span className="grid gap-0.5 px-2 pt-1.5">
                <span className="truncate text-[12px] font-medium">{r.brand}</span>
                <span className="truncate text-[11px] text-faint">{r.days ? `Running ${r.days} days${r.proven ? " · proven" : ""}` : r.proven ? "Proven" : "Live now"}</span>
              </span>
              <button
                type="button"
                onClick={() => !has && onAdd(r.url)}
                disabled={has}
                className={`m-1.5 min-h-11 rounded-full px-2 text-[12px] font-medium md:min-h-8 ${has ? "text-ok" : "border border-line text-fg hover:border-faint"}`}
              >
                {has ? "Added ✓" : "Add to brief"}
              </button>
            </li>
          );
        })}
      </ul>
      {shown && open && (
        <Preview
          r={shown}
          at={open.at}
          pinned={open.pinned}
          has={added.includes(shown.url)}
          onAdd={() => onAdd(shown.url)}
          onClose={() => setOpen(null)}
          onEnter={hold}
          onLeave={closeSoon}
        />
      )}
    </>
  );
}

/** The ad's preview, beside its card on a desktop (above or below when there's no room), a sheet from the bottom on a phone */
function Preview({ r, at, pinned, has, onAdd, onClose, onEnter, onLeave }: { r: Reference; at: DOMRect; pinned: boolean; has: boolean; onAdd: () => void; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // A phone gets a sheet from the bottom (it only opens after a tap, so the window is there)
  const [phone] = useState(() => window.innerWidth < 640);

  useLayoutEffect(() => {
    if (phone || !box.current) return;
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const gap = 10;
    // Beside the card when it fits (right, then left), else above or below it; always inside the window
    let left = at.right + gap;
    if (left + w > window.innerWidth - 12) left = at.left - gap - w;
    let top = at.top + at.height / 2 - h / 2;
    if (left < 12) {
      left = Math.min(Math.max(12, at.left + at.width / 2 - w / 2), window.innerWidth - w - 12);
      top = at.top - gap - h >= 12 ? at.top - gap - h : at.bottom + gap;
    }
    setPos({ left, top: Math.min(Math.max(12, top), window.innerHeight - h - 12) });
  }, [at, phone]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const away = () => !pinned && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", away, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", away, true);
    };
  }, [onClose, pinned]);

  const m = r.media;
  const why = r.note || r.why;
  const body = (
    <div
      ref={box}
      role="dialog"
      aria-label={`${r.brand}'s ad`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={phone ? undefined : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      className={
        phone
          ? "fixed inset-x-0 bottom-0 z-[80] grid max-h-[88dvh] gap-3 overflow-y-auto rounded-t-[24px] border border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.6)] animate-[sheet-up_.25s_cubic-bezier(.2,.8,.2,1)]"
          : "fixed z-[80] grid w-[300px] gap-3 rounded-[20px] border border-line bg-surface p-3 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)] animate-[sheet-fade_.15s_ease-out]"
      }
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-[14px] bg-bg">
        {m?.type === "video" ? (
          <video src={m.url} poster={m.thumb ?? r.thumb ?? undefined} autoPlay muted loop playsInline controls={phone} className="h-full w-full object-cover" />
        ) : m?.url || r.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m?.url ?? r.thumb ?? ""} alt={`${r.brand}'s ad`} className="h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center p-4 text-center font-heading text-[18px]">{r.brand}</span>
        )}
      </div>
      <div className="grid gap-1">
        <p className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-medium">{r.brand}</span>
          <span className="shrink-0 text-[11.5px] text-faint">{r.days ? `${r.days} days live${r.proven ? " · proven" : ""}` : r.proven ? "Proven" : "Live now"}</span>
        </p>
        {why && (
          <p className="text-[13px] leading-snug text-fg/90">
            <span className="text-faint">Why it&apos;s here: </span>
            {why}
          </p>
        )}
        {r.hook && <p className="line-clamp-3 text-[12.5px] leading-snug text-muted">&ldquo;{r.hook}&rdquo;</p>}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => !has && onAdd()} disabled={has} className={`min-h-11 flex-1 rounded-full px-3 text-[13px] font-medium md:min-h-9 ${has ? "text-ok" : "bg-brand text-white hover:bg-brand-hover"}`}>
          {has ? "Added to the brief ✓" : "Add to brief"}
        </button>
        {r.url && (
          <a href={r.url} target="_blank" rel="noreferrer" className="grid min-h-11 place-items-center rounded-full border border-line px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
            Open ↗
          </a>
        )}
        {(phone || pinned) && (
          <button type="button" onClick={onClose} aria-label="Close the preview" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">
            ✕
          </button>
        )}
      </div>
    </div>
  );
  return createPortal(
    phone ? (
      <>
        <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-[79] bg-black/50 animate-[sheet-fade_.2s_ease-out]" />
        {body}
      </>
    ) : (
      body
    ),
    document.body,
  );
}
