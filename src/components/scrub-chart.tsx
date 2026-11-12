"use client";

import { useRef, useState } from "react";

/**
 * The hover and touch scrub every line chart shares (the KPI health chart, the Email tab's charts): the pointer's x
 * picks the nearest of `n` evenly spaced points, `children` draws the chart with that index (a guide line and a dot),
 * and `tooltip` says what's at that point. Points sit at i/(n-1) across the width. Touch scrubs sideways and leaves
 * vertical swipes to the page.
 */
export function ScrubChart({ n, tooltip, children, compact = false }: { n: number; tooltip: (i: number) => React.ReactNode; children: (hover: number | null) => React.ReactNode; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const point = (clientX: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setHover(n === 1 ? 0 : Math.round(f * (n - 1)));
  };
  const left = hover == null ? 0 : n === 1 ? 50 : (hover / (n - 1)) * 100;
  return (
    <div
      ref={box}
      className="relative touch-pan-y"
      onMouseMove={(e) => point(e.clientX)}
      onMouseLeave={() => setHover(null)}
      onTouchStart={(e) => point(e.touches[0].clientX)}
      onTouchMove={(e) => point(e.touches[0].clientX)}
      onTouchEnd={() => setHover(null)}
    >
      {children(hover)}
      {hover != null && (
        <div
          className={`pointer-events-none absolute z-20 grid w-max gap-0.5 whitespace-nowrap rounded-[10px] border border-line bg-surface/95 px-2.5 py-1.5 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur ${compact ? "top-0 text-[10.5px]" : "top-1 text-xs"}`}
          style={{ left: `${left}%`, transform: `translate(${left > 70 ? "-100%" : left < 30 ? "0" : "-50%"}, ${compact ? "calc(-100% - 6px)" : "0"})` }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}
