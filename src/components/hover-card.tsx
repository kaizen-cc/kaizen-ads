"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A summary that opens on hover (or keyboard focus) and stays open while the pointer is on it, so the links inside it
// can be clicked. Drawn at the top of the page, so a card with clipped corners or its own layers never cuts it off.

export function HoverCard({ content, children, width = 340, className = "" }: { content: React.ReactNode; children: React.ReactNode; width?: number; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const close = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
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

  return (
    <span ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} className={className}>
      {children}
      {at &&
        createPortal(
          <div
            onMouseEnter={show}
            onMouseLeave={hide}
            role="tooltip"
            className="fixed z-[95] grid gap-2 rounded-[16px] border border-white/10 bg-[#121016]/95 p-3.5 text-left text-white shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
            style={{ left: at.left, top: at.top, width, transform: at.above ? "translateY(-100%)" : undefined, animation: "card-in-hover .14s ease-out" }}
          >
            <style>{`@keyframes card-in-hover { from { opacity: 0; } to { opacity: 1; } }`}</style>
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
