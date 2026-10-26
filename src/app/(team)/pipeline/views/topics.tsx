"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

// The Overview as topics: a row of tiles up top (what's going on, at a glance) and each topic below as a panel that
// opens and closes. A tile opens its topic and brings it into view. Which topics are open is remembered per browser.

export type TopicTone = "bad" | "warn" | "ok" | "brand" | "quiet";

// Inside an opened theme every topic starts open (one theme is all that's on screen); closing one is remembered
const OpenCtx = createContext(false);
export function OpenTopics({ children }: { children: React.ReactNode }) {
  return <OpenCtx.Provider value>{children}</OpenCtx.Provider>;
}
export type TopicTile = { id: string; label: string; value: number | string; sub: string; tone: TopicTone };

const KEY = "kz:overview:open";
const listeners = new Set<() => void>();
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};
const write = (ids: string[]) => {
  try {
    localStorage.setItem(KEY, ids.join(","));
  } catch {
    /* private window: open state just isn't remembered */
  }
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** null until the browser has said what's open (the server renders each topic's default). */
function useOpen() {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  return raw === null ? null : raw === "" ? [] : raw.split(",");
}
function setOpen(id: string, open: boolean, current: string[]) {
  // Kept as "<id>" when opened and "closed:<id>" when closed, so a topic that's open by default can stay closed
  const next = current.filter((x) => x !== id && x !== `closed:${id}`);
  write([...next, open ? id : `closed:${id}`]);
}

// The same light as the "Your day" banner: a deep panel lit from one corner in the topic's colour
const TONE: Record<TopicTone, { accent: string; glow: string; soft: string; rank: number }> = {
  bad: { accent: "#ff4d5e", glow: "rgba(200,16,46,0.55)", soft: "rgba(200,16,46,0.16)", rank: 0 },
  brand: { accent: "#ff6b78", glow: "rgba(178,30,44,0.5)", soft: "rgba(178,30,44,0.14)", rank: 1 },
  warn: { accent: "#f2b14c", glow: "rgba(224,150,40,0.45)", soft: "rgba(224,150,40,0.12)", rank: 2 },
  ok: { accent: "#5be3a5", glow: "rgba(40,180,120,0.4)", soft: "rgba(40,180,120,0.1)", rank: 3 },
  quiet: { accent: "#9aa8ff", glow: "rgba(90,110,255,0.35)", soft: "rgba(90,110,255,0.1)", rank: 4 },
};

/** Today at a glance: one lit tile per topic with something in it, the most pressing first and largest. */
export function TopicDeck({ tiles }: { tiles: TopicTile[] }) {
  const open = useOpen();
  if (!tiles.length) return null;
  const sorted = [...tiles].sort((a, b) => TONE[a.tone].rank - TONE[b.tone].rank);
  return (
    <div className="grid grid-flow-dense grid-cols-2 gap-3 md:grid-cols-4">
      {sorted.map((t, i) => {
        const tone = TONE[t.tone];
        const lead = i === 0 && sorted.length > 2;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setOpen(t.id, true, open ?? []);
              requestAnimationFrame(() => document.getElementById(`topic-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}
            style={{ ["--glow" as string]: tone.glow, ["--accent" as string]: tone.accent }}
            className={`group relative isolate grid min-h-[132px] content-between gap-4 overflow-hidden rounded-[22px] border border-white/[0.07] bg-[#0b0a0e] p-5 text-left shadow-[0_24px_60px_-34px_rgba(0,0,0,0.9)] transition duration-300 hover:-translate-y-0.5 hover:border-white/15 ${lead ? "col-span-2 md:p-6" : ""}`}
          >
            <span aria-hidden className={`pointer-events-none absolute -z-10 rounded-full opacity-80 blur-[60px] transition-opacity duration-500 group-hover:opacity-100 ${lead ? "-left-16 -top-24 h-[240px] w-[240px]" : "-left-10 -top-16 h-[150px] w-[150px]"}`} style={{ background: "var(--glow)" }} />
            <span aria-hidden className="pointer-events-none absolute inset-x-5 top-0 -z-10 h-px opacity-60" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">{t.label}</span>
              <span className="text-white/30 transition-transform duration-300 group-hover:translate-y-0.5 group-hover:text-white/70">↓</span>
            </span>
            <span className="grid gap-1.5">
              <span className={`tabular font-display leading-none tracking-tight ${lead ? "text-6xl md:text-7xl" : "text-5xl"}`} style={{ color: "var(--accent)" }}>
                {t.value}
              </span>
              <span className={`leading-snug text-white/65 ${lead ? "max-w-[30ch] text-sm" : "line-clamp-2 text-[12px]"}`}>{t.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A group of topics under one heading ("Act on today", "Your accounts", "The work"), with a line lit in its colour. */
export function Compartment({ title, note, tone = "brand", children }: { title: string; note?: string; tone?: TopicTone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <section className="grid gap-4">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-display text-2xl tracking-tight md:text-[28px]">{title}</h2>
          {note && <span className="pb-1 text-xs text-white/45">{note}</span>}
        </div>
        <span aria-hidden className="h-px w-full" style={{ background: `linear-gradient(90deg, ${t.accent}, ${t.soft} 35%, transparent 80%)` }} />
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

/** One topic: a lit header that says what's in it, and the detail to act on when it's open. */
export function Topic({
  id,
  title,
  summary,
  count,
  tone = "quiet",
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  count?: number | string;
  tone?: TopicTone;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const open = useOpen();
  const inTheme = useContext(OpenCtx);
  const startsOpen = defaultOpen || inTheme;
  const isOpen = open === null ? startsOpen : open.includes(id) || (startsOpen && !open.includes(`closed:${id}`));
  const t = TONE[tone];
  return (
    <div
      id={`topic-${id}`}
      style={{ ["--glow" as string]: t.glow, ["--soft" as string]: t.soft, ["--accent" as string]: t.accent }}
      className={`group/topic relative isolate scroll-mt-20 md:scroll-mt-6 overflow-hidden rounded-[22px] border bg-[#0b0a0e] shadow-[0_24px_60px_-40px_rgba(0,0,0,0.9)] transition-colors duration-300 ${isOpen ? "border-white/12" : "border-white/[0.06] hover:border-white/12"}`}
    >
      <span aria-hidden className={`pointer-events-none absolute -left-20 -top-20 -z-10 h-[220px] w-[220px] rounded-full blur-[70px] transition-opacity duration-500 ${isOpen ? "opacity-70" : "opacity-40 group-hover/topic:opacity-60"}`} style={{ background: "var(--glow)" }} />
      <span aria-hidden className="pointer-events-none absolute inset-y-4 left-0 -z-10 w-[3px] rounded-r-full" style={{ background: "var(--accent)" }} />
      <button type="button" onClick={() => setOpen(id, !isOpen, open ?? [])} aria-expanded={isOpen} className="flex w-full items-center gap-4 px-5 py-4 text-left md:px-6 md:py-5">
        {count !== undefined && count !== 0 && (
          <span className="tabular grid h-12 min-w-12 shrink-0 place-items-center rounded-[14px] px-2 font-display text-2xl leading-none" style={{ color: "var(--accent)", background: "var(--soft)" }}>
            {count}
          </span>
        )}
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="font-heading text-[17px] leading-tight text-white md:text-lg">{title}</span>
          <span className="truncate text-[13px] text-white/55">{summary}</span>
        </span>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 text-white/50 transition duration-300 group-hover/topic:border-white/25 group-hover/topic:text-white ${isOpen ? "rotate-180" : ""}`} aria-hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {isOpen && (
        <div className="relative px-5 pb-6 pt-1 md:px-6 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0 [&>section]:shadow-none" style={{ animation: "card-in-topic .35s cubic-bezier(.2,.8,.2,1) both" }}>
          <style>{`@keyframes card-in-topic { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }`}</style>
          <span aria-hidden className="mb-5 block h-px w-full" style={{ background: "linear-gradient(90deg, var(--accent), transparent 70%)", opacity: 0.35 }} />
          {children}
        </div>
      )}
    </div>
  );
}
