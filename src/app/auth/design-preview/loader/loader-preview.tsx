"use client";

import { useState } from "react";
import { LOADER_CAPTIONS, LOADER_SCENES, LogoLoader } from "@/components/logo-loader";

const NAMES = { cook: "Cooking", read: "Reading", laptop: "On a computer", sleep: "Sleeping", eat: "Eating", watch: "Watching a show", stare: "Staring at you", spin: "Spinning" };

export function LoaderPreview() {
  const [round, setRound] = useState(0);
  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-fg md:px-10">
      <div className="mx-auto grid max-w-6xl gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <h1 className="font-display text-3xl tracking-tight">Loading scenes</h1>
            <p className="text-sm text-muted">What people see while a page loads. Each card holds one scene; a real wait picks one at random and moves on every few seconds.</p>
          </div>
          <button type="button" onClick={() => setRound((r) => r + 1)} className="min-h-11 rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover">
            Shuffle
          </button>
        </header>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {LOADER_SCENES.map((s) => (
            <section key={`${s}-${round}`} className="grid gap-3 rounded-[18px] border border-line bg-surface p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{NAMES[s]}</p>
              <div className="grid min-h-40 place-items-center">
                <LogoLoader scene={s} size="md" />
              </div>
              <p className="text-[11px] leading-relaxed text-faint">{LOADER_CAPTIONS[s].join(" · ")}</p>
            </section>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <section className="grid min-h-72 place-items-center rounded-[18px] border border-line bg-surface p-4">
            <div className="grid justify-items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Full page (random, cycles)</p>
              <LogoLoader key={round} size="lg" />
            </div>
          </section>
          <section className="grid min-h-72 place-items-center rounded-[18px] bg-[#07060a] p-4">
            <div className="grid justify-items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">The day recap stage</p>
              <LogoLoader key={round} size="md" label="Opening your day…" onDark />
            </div>
          </section>
          <section className="grid min-h-72 place-items-center gap-3 rounded-[18px] border border-line bg-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">A panel streaming in</p>
            <div className="grid h-24 w-full place-items-center rounded-[18px] border border-line bg-surface">
              <LogoLoader key={round} size="sm" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
