"use client";

import { useEffect, useState } from "react";
import { aiEta } from "@/app/(team)/eta-actions";

// Progress for an AI job the person is waiting on (a brief from a winning ad, from the market, from a call): a bar
// with a percentage, the step it's on, and the time left, timed from how long that job really takes (its recent
// runs). It runs to 90% by the usual time, then creeps on ("almost there") rather than sitting at 99% or going back.

function pct(elapsed: number, eta: number) {
  if (elapsed <= eta) return (elapsed / eta) * 90;
  return 90 + 9 * (1 - Math.exp(-(elapsed - eta) / (eta * 0.6)));
}

function useProgress(label: string, fallbackMs: number) {
  const [eta, setEta] = useState(fallbackMs);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let live = true;
    void aiEta(label, fallbackMs)
      .then((ms) => live && setEta(ms))
      .catch(() => null);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [label, fallbackMs]);
  const p = pct(elapsed, eta);
  const left = Math.ceil((eta - elapsed) / 1000);
  const time = left > 60 ? `about ${Math.round(left / 60)} min left` : left > 3 ? `about ${left}s left` : "almost there";
  return { p, time, elapsed, eta };
}

/** The full version: title, bar, percentage and time left, and the steps ticking off. */
export function AiProgress({ label, fallbackMs = 40_000, title, steps, note, size = "lg" }: { label: string; fallbackMs?: number; title: string; steps?: string[]; note?: string; size?: "lg" | "sm" }) {
  const { p, time } = useProgress(label, fallbackMs);
  const i = steps?.length ? Math.min(steps.length - 1, Math.floor((p / 90) * steps.length)) : 0;
  return (
    <div className={`grid content-center ${size === "lg" ? "gap-5 py-8" : "gap-4"}`} aria-busy="true" aria-live="polite">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 md:flex-nowrap md:gap-3">
          <p className={`min-w-0 ${size === "lg" ? "font-heading text-xl" : "text-sm font-medium"}`}>{title}</p>
          <p className="tabular shrink-0 text-sm text-muted">
            <span className="font-medium text-fg">{Math.floor(p)}%</span> · {time}
          </p>
        </div>
        <span className="relative h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
          <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand to-[#ff5a6e] transition-[width] duration-300 ease-linear" style={{ width: `${p}%` }} />
          <span className="absolute inset-y-0 w-16 animate-[shimmer_1.6s_linear_infinite] bg-gradient-to-r from-transparent via-ink/25 to-transparent" style={{ left: `calc(${p}% - 4rem)` }} />
        </span>
      </div>
      {steps?.length ? (
        <ol className="grid gap-2.5">
          {steps.map((s, n) => (
            <li key={s} className={`flex items-center gap-3 text-sm transition-colors ${n < i ? "text-muted" : n === i ? "text-fg" : "text-faint/60"}`}>
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${n < i ? "border-ok bg-ok text-white" : n === i ? "border-brand" : "border-line"}`}>
                {n < i ? "✓" : n === i ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> : null}
              </span>
              {s}
            </li>
          ))}
        </ol>
      ) : null}
      {note && <p className="text-xs text-faint">{note}</p>}
    </div>
  );
}

/** The compact version, inside a button: the button fills up as it goes, with the percentage and time left. */
export function AiProgressButton({ label, fallbackMs = 40_000, text = "Writing the brief", className = "" }: { label: string; fallbackMs?: number; text?: string; className?: string }) {
  const { p, time } = useProgress(label, fallbackMs);
  return (
    <span className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-full ${className}`} aria-busy="true" aria-live="polite">
      <span aria-hidden className="absolute inset-y-0 left-0 bg-brand/25 transition-[width] duration-300 ease-linear" style={{ width: `${p}%` }} />
      <span className="relative truncate px-3">
        {text} · <span className="tabular font-semibold">{Math.floor(p)}%</span> · {time}
      </span>
    </span>
  );
}
