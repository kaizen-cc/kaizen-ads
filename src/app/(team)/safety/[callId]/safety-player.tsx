"use client";

import { useRef, useState } from "react";
import type { SafetyMoment } from "@/lib/assistant/core";

// The flagged call's audio (in parts, back to back), the moments to skip to and the timed transcript. Tapping a
// moment or a line plays the audio from there.

export type AudioPart = { url: string; start: number };
export type TimedLine = { at: number; who: string; text: string; person: boolean };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function SafetyPlayer({ parts, moments, lines, audioGone }: { parts: AudioPart[]; moments: SafetyMoment[]; lines: TimedLine[]; audioGone: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [part, setPart] = useState(0);
  const seek = (at: number) => {
    if (!parts.length) return;
    let i = 0;
    for (let k = 0; k < parts.length; k++) if (parts[k].start <= at) i = k;
    const go = () => {
      const el = audio.current;
      if (!el) return;
      el.currentTime = Math.max(0, at - parts[i].start - 2);
      void el.play().catch(() => undefined);
    };
    if (i !== part) {
      setPart(i);
      setTimeout(go, 150);
    } else go();
  };
  const near = (at: number) => moments.some((m) => Math.abs(m.at_seconds - at) <= 8);
  return (
    <>
      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4">
        <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">Audio</h2>
        {parts.length ? (
          <>
            <audio ref={audio} src={parts[part]?.url} controls preload="metadata" className="w-full" onEnded={() => part + 1 < parts.length && (setPart(part + 1), setTimeout(() => void audio.current?.play().catch(() => undefined), 150))} />
            <p className="text-[12px] text-faint">
              Part {part + 1} of {parts.length}, from {mmss(parts[part]?.start ?? 0)}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">{audioGone ? "The audio has been deleted." : "No audio was recorded for this call."}</p>
        )}
      </section>
      {moments.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">Moments to look at</h2>
          <ul className="grid gap-2">
            {moments.map((m, i) => (
              <li key={i}>
                <button type="button" onClick={() => seek(m.at_seconds)} className="flex min-h-12 w-full items-center gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-faint">
                  <span className="tabular shrink-0 rounded-full bg-bad-soft px-2.5 py-0.5 text-[12px] text-bad">{mmss(m.at_seconds)}</span>
                  <span className="min-w-0 flex-1 text-[13.5px] leading-snug">
                    <span className="text-faint">{m.category.replace(/_/g, " ")}: </span>
                    {m.note}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="grid gap-2">
        <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">Transcript</h2>
        <ol className="grid gap-1.5 rounded-[18px] border border-line bg-surface p-3 sm:p-4">
          {lines.map((l, i) => (
            <li key={i}>
              <button type="button" onClick={() => seek(l.at)} className={`grid w-full grid-cols-[48px_1fr] gap-2 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${near(l.at) ? "bg-bad-soft/40" : ""}`}>
                <span className="tabular text-[12px] text-faint">{mmss(l.at)}</span>
                <span className="text-[13.5px] leading-relaxed">
                  <span className={l.person ? "font-medium" : "text-muted"}>{l.who}: </span>
                  {l.text}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
