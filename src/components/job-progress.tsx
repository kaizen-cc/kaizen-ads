"use client";

import { useEffect, useState } from "react";

const left = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s < 10 ? s : Math.round(s / 5) * 5}s left`;
};

/**
 * A background job's progress, from when it started (saved, so it survives a refresh) against how long it usually
 * takes: a bar easing toward 95%, what's left, "Finishing…" once past the usual, and a retry offer when it's clearly
 * stuck (three times the usual and at least five minutes).
 */
export function JobProgress({ startedAt, expectedMs, label, onRetry }: { startedAt: string | null; expectedMs: number; label: string; onRetry?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const spent = startedAt ? Math.max(0, now - Date.parse(startedAt)) : 0;
  const over = spent >= expectedMs;
  const stuck = spent > Math.max(expectedMs * 3, 5 * 60_000);
  const share = over ? 0.95 : Math.min(0.95, 0.04 + (spent / expectedMs) * 0.91);
  return (
    <div className="grid gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={label}>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
        <div className={`h-full rounded-full bg-brand transition-[width] duration-500 ease-out ${over ? "animate-pulse" : ""}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="flex items-baseline justify-between gap-2 text-[12px] text-muted">
        <span>{stuck ? "This is taking much longer than usual" : over ? "Finishing…" : label}</span>
        {stuck && onRetry ? (
          <button type="button" onClick={onRetry} className="-my-2 inline-flex h-11 shrink-0 items-center rounded-full px-2 text-[12px] text-brand-text hover:underline md:h-8">
            Start it again
          </button>
        ) : (
          <span className="tabular shrink-0">{over ? "" : left(expectedMs - spent)}</span>
        )}
      </p>
      <p className="text-[11.5px] text-faint">You can leave this page: it keeps going in the background.</p>
    </div>
  );
}
