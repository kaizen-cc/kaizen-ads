"use client";

import { useEffect } from "react";
import { dismissFailure, flushPending, undoAll, undoLast, useUndo } from "@/lib/undo";

// The Undo toast (owner, Nov 24 2026): bottom of the screen in thumb reach on a phone, "Marked done · Undo" for 8
// seconds; several quick ones read "3 cleared · Undo all". Ctrl/Cmd+Z undoes the last one on a computer (never while
// typing). Leaving the page writes whatever is waiting. See src/lib/undo.ts.

export function UndoToast() {
  const { labels, failure } = useUndo();
  const n = labels.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (undoLast()) e.preventDefault();
    };
    const leave = () => flushPending();
    const hidden = () => document.visibilityState === "hidden" && flushPending();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  if (!n && !failure) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex justify-center px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
      <div role="status" aria-live="polite" className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-[18px] border border-line bg-fg py-1.5 pl-4 pr-1.5 text-bg shadow-[0_20px_50px_-20px_rgba(0,0,0,0.6)]">
        {n ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px]">{n === 1 ? labels[0] : `${n} cleared`}</span>
            <button type="button" onClick={() => (n === 1 ? undoLast() : undoAll())} className="min-h-11 shrink-0 rounded-full px-4 text-[14px] font-semibold underline-offset-2 hover:underline">
              {n === 1 ? "Undo" : "Undo all"}
            </button>
            <button type="button" aria-label="Keep the change" onClick={flushPending} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[16px] opacity-70 hover:opacity-100">
              ✕
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-[13.5px] leading-snug">{failure}</span>
            <button type="button" aria-label="Close" onClick={dismissFailure} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[16px] opacity-70 hover:opacity-100">
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
