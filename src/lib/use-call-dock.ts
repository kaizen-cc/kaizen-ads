import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampDock, dockKey, moved, nudge, parsePos, snapToEdge, type Pos } from "./call-dock";

// The call widget, movable: drag it by its handle (mouse or touch) anywhere on screen, or focus the handle and use the
// arrow keys (Home puts it back in its corner). Kept on screen as the window changes; the spot is remembered per
// device in this browser. On phones the collapsed pill snaps to the nearer side when dropped.

const read = (device: "desktop" | "phone"): Pos | null => {
  try {
    return parsePos(localStorage.getItem(dockKey(device)));
  } catch {
    return null;
  }
};
const write = (device: "desktop" | "phone", p: Pos | null) => {
  try {
    if (p) localStorage.setItem(dockKey(device), JSON.stringify(p));
    else localStorage.removeItem(dockKey(device));
  } catch {
    /* private window: the spot just isn't remembered */
  }
};

export function useCallDock(device: "desktop" | "phone", opts: { snap: boolean }) {
  // The widget itself (a callback ref into state, so nothing reads a ref while rendering)
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Pos | null>(() => (typeof window === "undefined" ? null : read(device)));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ start: Pos; from: Pos; id: number; moved: boolean } | null>(null);
  /** Set when a drag just ended, so the click that follows a drop doesn't also open or press anything */
  const justDragged = useRef(false);

  const fit = useCallback(
    (p: Pos, snap = false) => {
      const size = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 };
      const view = { w: window.innerWidth, h: window.innerHeight };
      return snap ? snapToEdge(p, size, view) : clampDock(p, size, view);
    },
    [el],
  );

  // Kept on screen when the window (or the widget, collapsing or expanding) changes size
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    // The observer reports the widget's size once at the start, then on every change
    const keep = () => setPos((p) => (p ? fit(p, opts.snap) : p));
    window.addEventListener("resize", keep);
    const ro = typeof ResizeObserver !== "undefined" && el ? new ResizeObserver(keep) : null;
    if (ro && el) ro.observe(el);
    return () => {
      window.removeEventListener("resize", keep);
      ro?.disconnect();
    };
  }, [opts.snap, fit, placed, el]);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { start: { x: e.clientX, y: e.clientY }, from: { x: r.left, y: r.top }, id: e.pointerId, moved: false };
    justDragged.current = false;
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const now = { x: e.clientX, y: e.clientY };
    if (!d.moved) {
      if (!moved(d.start, now)) return;
      d.moved = true;
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture isn't essential */
      }
    }
    e.preventDefault();
    setPos(fit({ x: d.from.x + now.x - d.start.x, y: d.from.y + now.y - d.start.y }));
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.moved) return;
    justDragged.current = true;
    setDragging(false);
    setPos((p) => {
      const out = p ? fit(p, opts.snap) : p;
      write(device, out);
      return out;
    });
  };
  /** Swallows the click a drop makes, so dragging the pill doesn't also open it */
  const onClickCapture = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (!justDragged.current) return;
    justDragged.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Home") {
      e.preventDefault();
      setPos(null);
      write(device, null);
      return;
    }
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = nudge(pos ?? { x: r.left, y: r.top }, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    const out = fit(next);
    setPos(out);
    write(device, out);
  };

  return {
    ref: setEl,
    dragging,
    /** Inline position once it's been moved (otherwise the docked corner from its classes) */
    style: pos ? ({ left: pos.x, top: pos.y, right: "auto", bottom: "auto" } as const) : undefined,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture },
    keys: { onKeyDown },
    reset: () => {
      setPos(null);
      write(device, null);
    },
  };
}
