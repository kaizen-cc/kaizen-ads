"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// A board's sideways scrollbar pinned to the bottom of the window on desktop. The board's own scrollbar sits under its
// longest column, often far below the fold, so columns past the first screen looked unreachable. This one is always in
// view and moves the board both ways; on phones the board snaps column by column instead and this stays hidden.

export function BoardScrollbar({ scroller, className = "-mx-4 md:-mx-10" }: { scroller: RefObject<HTMLDivElement | null>; className?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.scrollWidth);
      setNeeded(el.scrollWidth > el.clientWidth + 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const follow = () => {
      const b = bar.current;
      if (b && b.scrollLeft !== el.scrollLeft) b.scrollLeft = el.scrollLeft;
    };
    el.addEventListener("scroll", follow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", follow);
    };
  }, [scroller]);

  return (
    <div
      ref={bar}
      aria-hidden
      onScroll={(e) => {
        const el = scroller.current;
        if (el && el.scrollLeft !== e.currentTarget.scrollLeft) el.scrollTo({ left: e.currentTarget.scrollLeft, behavior: "instant" });
      }}
      className={`board-scroll sticky bottom-0 z-20 hidden overflow-x-auto overflow-y-hidden bg-bg/85 backdrop-blur-sm ${needed ? "md:block" : ""} ${className}`}
    >
      <div style={{ width, height: 1 }} />
    </div>
  );
}
