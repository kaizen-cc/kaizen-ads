"use client";

import { useEffect, useState } from "react";
import { OpenTopics, type TopicTone } from "./topics";

// The Overview as a few big themes (clients at risk, creative and growth, new clients, delivery): each a lit card with
// one number, one line and two or three points. Opening a theme shows only its detail, so the page is never long; the
// back arrow returns to the themes. The open theme is kept in the address (?theme=) so a refresh or a link lands on it.

export type Theme = {
  id: string;
  title: string;
  tone: TopicTone;
  count: number;
  headline: string;
  points: string[];
  content: React.ReactNode;
};

const TONE: Record<TopicTone, { accent: string; glow: string }> = {
  bad: { accent: "#ff4d5e", glow: "rgba(200,16,46,0.5)" },
  brand: { accent: "#ff6b78", glow: "rgba(178,30,44,0.45)" },
  warn: { accent: "#f2b14c", glow: "rgba(224,150,40,0.4)" },
  ok: { accent: "#5be3a5", glow: "rgba(40,180,120,0.32)" },
  quiet: { accent: "#9aa8ff", glow: "rgba(90,110,255,0.3)" },
};

const read = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("theme"));

export function Themes({ themes }: { themes: Theme[] }) {
  const [open, setOpen] = useState<string | null>(null);
  // The theme in the address (a link or a refresh) opens on load; changes keep the address in step
  useEffect(() => {
    const t = setTimeout(() => setOpen(read()), 0);
    const onPop = () => setOpen(read());
    window.addEventListener("popstate", onPop);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  const choose = (id: string | null) => {
    setOpen(id);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("theme", id);
    else u.searchParams.delete("theme");
    window.history.pushState(null, "", u);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const current = themes.find((t) => t.id === open) ?? null;

  if (current) {
    const t = TONE[current.tone];
    return (
      <section className="grid gap-6" style={{ animation: "card-in-topic .35s cubic-bezier(.2,.8,.2,1) both" }}>
        <style>{`@keyframes card-in-topic { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }`}</style>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => choose(null)} className="grid h-10 w-10 place-items-center rounded-full border border-white/12 text-white/60 transition-colors hover:border-white/30 hover:text-white" aria-label="All themes">
            ←
          </button>
          <div className="grid">
            <h2 className="font-display text-3xl tracking-tight md:text-4xl">
              <span style={{ color: t.accent }}>{current.count}</span> {current.title}
            </h2>
            <p className="text-sm text-white/55">{current.headline}</p>
          </div>
          <nav className="ml-auto flex flex-wrap gap-1.5">
            {themes
              .filter((x) => x.id !== current.id)
              .map((x) => (
                <button key={x.id} type="button" onClick={() => choose(x.id)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:border-white/25 hover:text-white">
                  {x.title} <span className="tabular" style={{ color: TONE[x.tone].accent }}>{x.count}</span>
                </button>
              ))}
          </nav>
        </div>
        <span aria-hidden className="h-px w-full" style={{ background: `linear-gradient(90deg, ${t.accent}, transparent 70%)`, opacity: 0.5 }} />
        <OpenTopics>
          <div className="grid gap-3">{current.content}</div>
        </OpenTopics>
      </section>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {themes.map((x, i) => {
        const t = TONE[x.tone];
        const calm = x.count === 0;
        return (
          <button
            key={x.id}
            type="button"
            onClick={() => choose(x.id)}
            style={{ ["--glow" as string]: calm ? TONE.ok.glow : t.glow, ["--accent" as string]: calm ? TONE.ok.accent : t.accent, animation: `card-in-topic .45s ${0.06 * i}s cubic-bezier(.2,.8,.2,1) both` }}
            className="group relative isolate grid min-h-[210px] content-between gap-5 overflow-hidden rounded-[26px] border border-white/[0.07] bg-[#0b0a0e] p-6 text-left shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] transition duration-300 hover:-translate-y-0.5 hover:border-white/15 md:p-7"
          >
            <style>{`@keyframes card-in-topic { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
            <span aria-hidden className={`pointer-events-none absolute -left-16 -top-24 -z-10 h-[260px] w-[260px] rounded-full blur-[80px] transition-opacity duration-500 group-hover:opacity-100 ${calm ? "opacity-40" : "opacity-80"}`} style={{ background: "var(--glow)" }} />
            <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 -z-10 h-px opacity-60" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
            <span className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-white/60">{x.title}</span>
              <span className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-white/50 transition duration-300 group-hover:translate-x-0.5 group-hover:border-white/30 group-hover:text-white">→</span>
            </span>
            <span className="grid gap-3">
              <span className="flex items-end gap-3">
                <span className="tabular font-display text-7xl leading-none tracking-tight" style={{ color: "var(--accent)" }}>
                  {calm ? "✓" : x.count}
                </span>
                <span className="pb-1.5 text-[15px] leading-snug text-white/80">{x.headline}</span>
              </span>
              {x.points.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {x.points.slice(0, 3).map((p) => (
                    <span key={p} className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[11.5px] text-white/65">
                      {p}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
