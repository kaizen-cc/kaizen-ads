"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A summary that opens on hover (or keyboard focus) and stays open while the pointer is on it, so the links inside it
// can be clicked. Drawn at the top of the page, so a card with clipped corners or its own layers never cuts it off.
// On touch screens there's no hover: a tap opens the same summary as a sheet from the bottom, with the tapped link as
// its main action, so nothing is lost on a phone.

export function HoverCard({ content, children, width = 340, className = "" }: { content: React.ReactNode; children: React.ReactNode; width?: number; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [sheet, setSheet] = useState<{ href: string | null } | null>(null);
  const close = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last press was a finger: the hover card stays shut and the tap opens the sheet instead
  const touch = useRef(false);

  const show = () => {
    if (touch.current) return;
    if (close.current) clearTimeout(close.current);
    if (at) return;
    openTimer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const above = r.bottom + 260 > window.innerHeight && r.top > 280;
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
      setAt({ left, top: above ? r.top - 8 : r.bottom + 8, above });
    }, 120);
  };
  const hide = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    close.current = setTimeout(() => setAt(null), 160);
  };
  useEffect(() => {
    if (!at) return;
    const off = () => setAt(null);
    window.addEventListener("scroll", off, true);
    return () => window.removeEventListener("scroll", off, true);
  }, [at]);
  // The sheet: Escape closes it, and the page behind doesn't scroll
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(null);
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [sheet]);

  return (
    <span
      ref={anchor}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") touch.current = false;
      }}
      onPointerDown={(e) => {
        // Presses inside the sheet or card (drawn elsewhere on the page) still reach here through React; skip them
        if (anchor.current?.contains(e.target as Node)) touch.current = e.pointerType === "touch";
      }}
      onClickCapture={(e) => {
        if (!touch.current || !anchor.current?.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        const a = (e.target as Element).closest("a");
        setSheet({ href: a?.getAttribute("href") ?? null });
      }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className={className}
    >
      {children}
      {at &&
        createPortal(
          <div
            onMouseEnter={show}
            onMouseLeave={hide}
            role="tooltip"
            className="fixed z-[95] grid gap-2 rounded-[16px] border border-ink/10 bg-deep-2/95 p-3.5 text-left text-white shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
            style={{ left: at.left, top: at.top, width, transform: at.above ? "translateY(-100%)" : undefined, animation: "card-in-hover .14s ease-out" }}
          >
            <style>{`@keyframes card-in-hover { from { opacity: 0; } to { opacity: 1; } }`}</style>
            {content}
          </div>,
          document.body,
        )}
      {sheet &&
        createPortal(
          <div className="fixed inset-0 z-[95]" role="dialog" aria-modal="true">
            <style>{`@keyframes sheet-up-hover { from { transform: translateY(100%); } to { transform: none; } }`}</style>
            <div className="absolute inset-0 bg-black/60" onClick={() => setSheet(null)} aria-hidden />
            <div
              className="pb-safe absolute inset-x-0 bottom-0 grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] rounded-t-[22px] border-t border-ink/10 bg-deep-2 text-left text-white shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.9)]"
              style={{ animation: "sheet-up-hover .22s ease-out" }}
            >
              <div className="relative flex justify-end pr-1 pt-1">
                <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-ink/20" aria-hidden />
                <button type="button" onClick={() => setSheet(null)} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-ink/60 active:bg-ink/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Links inside get finger-sized, and following one closes the sheet */}
              <div
                className="grid content-start gap-2 overflow-y-auto overscroll-contain px-4 pb-4 text-[15px] [&_a]:py-2.5"
                onClick={(e) => {
                  if ((e.target as Element).closest("a")) setSheet(null);
                }}
              >
                {content}
              </div>
              {sheet.href && (
                <div className="border-t border-ink/10 px-4 py-3">
                  <Link href={sheet.href} onClick={() => setSheet(null)} className="flex h-12 items-center justify-center rounded-full bg-fg text-[15px] font-semibold text-bg">
                    Open <span aria-hidden className="ml-1.5">→</span>
                  </Link>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
