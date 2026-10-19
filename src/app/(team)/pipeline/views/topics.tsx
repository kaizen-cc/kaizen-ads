"use client";

import { useSyncExternalStore } from "react";

// The Overview as topics: a row of tiles up top (what's going on, at a glance) and each topic below as a panel that
// opens and closes. A tile opens its topic and brings it into view. Which topics are open is remembered per browser.

export type TopicTone = "bad" | "warn" | "ok" | "brand" | "quiet";
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

const TONE: Record<TopicTone, { dot: string; ring: string; text: string }> = {
  bad: { dot: "bg-bad", ring: "hover:border-bad/50", text: "text-bad" },
  warn: { dot: "bg-warn", ring: "hover:border-warn/50", text: "text-warn" },
  ok: { dot: "bg-ok", ring: "hover:border-ok/50", text: "text-ok" },
  brand: { dot: "bg-brand", ring: "hover:border-brand/60", text: "text-brand-text" },
  quiet: { dot: "bg-faint", ring: "hover:border-faint", text: "text-faint" },
};

/** Today at a glance: one tile per topic that has something in it. */
export function TopicDeck({ tiles }: { tiles: TopicTile[] }) {
  const open = useOpen();
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
      {tiles.map((t) => {
        const tone = TONE[t.tone];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setOpen(t.id, true, open ?? []);
              requestAnimationFrame(() => document.getElementById(`topic-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}
            className={`group relative grid content-between gap-3 overflow-hidden rounded-[16px] border border-line bg-surface p-4 text-left transition-colors ${tone.ring}`}
          >
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {t.label}
            </span>
            <span className="grid gap-0.5">
              <span className={`tabular font-display text-3xl leading-none tracking-tight ${t.tone === "quiet" ? "text-muted" : ""}`}>{t.value}</span>
              <span className="line-clamp-2 text-[11.5px] leading-snug text-muted">{t.sub}</span>
            </span>
            <span className="absolute right-3 top-3 text-faint opacity-0 transition-opacity group-hover:opacity-100">↓</span>
          </button>
        );
      })}
    </div>
  );
}

/** A group of topics under one heading ("Act on today", "Your accounts", "The work"). */
export function Compartment({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">{title}</h2>
        {note && <span className="text-xs text-faint">{note}</span>}
      </div>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}

/** One topic: a header that says what's in it, and the detail to act on when it's open. */
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
  const isOpen = open === null ? defaultOpen : open.includes(id) || (defaultOpen && !open.includes(`closed:${id}`));
  const t = TONE[tone];
  return (
    <div id={`topic-${id}`} className={`scroll-mt-6 overflow-hidden rounded-[16px] border bg-surface transition-colors ${isOpen ? "border-line" : "border-line/70 hover:border-line"}`}>
      <button type="button" onClick={() => setOpen(id, !isOpen, open ?? [])} aria-expanded={isOpen} className="flex w-full items-center gap-3 px-4 py-3.5 text-left md:px-5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="font-heading text-[16px]">{title}</span>
            {count !== undefined && count !== 0 && <span className={`tabular text-xs ${t.text}`}>{count}</span>}
          </span>
          <span className="truncate text-xs text-muted">{summary}</span>
        </span>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line text-faint transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {isOpen && <div className="border-t border-line px-4 pb-5 pt-4 md:px-5 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0 [&>section]:shadow-none">{children}</div>}
    </div>
  );
}
