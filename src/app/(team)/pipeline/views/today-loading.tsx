"use client";

import { useEffect, useState } from "react";

// The first look at the day: while the daily review is built (once a day, the first visit), it says what it's doing
// instead of sitting blank. Fades in only if the wait is real, so a saved review never flashes it.

const STEPS = ["Reading your clients", "Checking every ad account against its target", "Looking for work that's stuck or late", "Gathering what clients said and what we promised", "Ranking what needs you first"];

export function TodayLoading() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1600);
    return () => clearInterval(t);
  }, []);

  return (
    <section
      aria-busy="true"
      aria-label="Loading your daily review"
      className="relative grid min-h-[200px] gap-6 overflow-hidden rounded-[24px] border border-line bg-deep p-5 opacity-0 animate-[fade-in-late_.5s_ease-out_.25s_forwards] md:p-7"
    >
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-[340px] w-[340px] animate-pulse rounded-full bg-[rgba(200,16,46,0.35)] blur-[110px]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 h-[300px] w-[300px] animate-pulse rounded-full bg-[rgba(90,110,255,0.22)] blur-[120px] [animation-delay:800ms]" />

      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/50">Your day</p>
          <p className="font-display text-3xl leading-tight tracking-tight text-fg md:text-4xl">
            Loading your daily review
            <span className="inline-flex w-8">
              <span className="animate-pulse">.</span>
              <span className="animate-pulse [animation-delay:200ms]">.</span>
              <span className="animate-pulse [animation-delay:400ms]">.</span>
            </span>
          </p>
          <p className="text-sm text-ink/55">The first look of the day takes a moment. After this it opens instantly and keeps itself current.</p>
        </div>
        <span className="relative grid h-14 w-14 place-items-center">
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-ink/10 border-t-[#ff4d5e] [animation-duration:1.4s]" />
          <span className="tabular text-xs text-ink/60">
            {step + 1}/{STEPS.length}
          </span>
        </span>
      </div>

      <ol className="relative grid gap-2 sm:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s} className={`grid gap-2 rounded-[12px] border px-3 py-2.5 text-xs transition-all duration-500 ${i < step ? "border-ink/10 text-ink/55" : i === step ? "border-[#ff4d5e]/40 bg-[#ff4d5e]/[0.07] text-white" : "border-ink/[0.06] text-ink/30"}`}>
            <span className="relative h-0.5 overflow-hidden rounded-full bg-ink/10">
              <span className={`absolute inset-y-0 left-0 rounded-full bg-[#ff4d5e] transition-[width] ease-out ${i < step ? "w-full duration-300" : i === step ? "w-2/3 duration-[1500ms]" : "w-0"}`} />
            </span>
            <span className="flex items-start gap-1.5 leading-snug">
              {i < step && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#5be3a5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
                  <path d="M5 12l5 5L19 7" />
                </svg>
              )}
              {s}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
