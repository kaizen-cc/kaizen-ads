"use client";

import { useId, useMemo, useState } from "react";
import { left, type Allotment } from "@/lib/allotment";
import { tintFor } from "@/lib/colors";
import type { Size } from "./draft";

export type ClientOption = { id: string; name: string; slug: string; creative: boolean };

/** "6 of 10 images left · 2 of 4 videos left" */
export function allotmentSummary(a: Allotment | undefined) {
  if (!a || (a.images === null && a.videos === null)) return "No allotment set";
  const part = (cap: number | null, used: number, what: string) => {
    const l = left(cap, used);
    return l === null ? null : l < 0 ? `${-l} ${what} over` : `${l} of ${cap} ${what} left`;
  };
  return [part(a.images, a.imagesUsed, "images"), part(a.videos, a.videosUsed, "videos")].filter(Boolean).join(" · ");
}

/** The AI mark: a small four-point spark. */
export function Spark({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="currentColor" d="M12 2c.6 4.6 2.9 7.4 8 8.2v1.6c-5.1.8-7.4 3.6-8 8.2h-.1c-.6-4.6-2.9-7.4-8-8.2v-1.6c5.1-.8 7.4-3.6 8-8.2z" />
    </svg>
  );
}

/** Five segments that fill as you go. Finished steps are clickable. */
export function Progress({ steps, current, onJump }: { steps: string[]; current: number; onJump: (i: number) => void }) {
  return (
    <nav aria-label="Request steps" className="grid gap-2.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-faint">
          Step <span className="tabular text-fg">{current + 1}</span> of {steps.length}
        </span>
        <span className="text-muted">{steps[current]}</span>
      </div>
      <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={i >= current}
              onClick={() => onJump(i)}
              aria-current={i === current ? "step" : undefined}
              className="group grid w-full gap-2 text-left disabled:cursor-default"
            >
              <span className="relative h-1 overflow-hidden rounded-full bg-surface-2">
                <span
                  className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out ${i < current ? "bg-fg/40 group-hover:bg-fg/70" : "bg-brand"}`}
                  style={{ width: i < current ? "100%" : i === current ? "50%" : "0%" }}
                />
              </span>
              <span className={`hidden text-[11px] sm:block ${i === current ? "text-fg" : i < current ? "text-muted group-hover:text-fg" : "text-faint"}`}>{s}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Type two letters, get a short list. Arrow keys and Enter work. */
export function ClientSearch({ clients, allotments, onPick }: { clients: ClientOption[]; allotments: Record<string, Allotment>; onPick: (c: ClientOption) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const term = q.trim().toLowerCase();

  const matches = useMemo(() => {
    if (term.length < 2) return [];
    const scored = clients
      .map((c) => {
        const n = c.name.toLowerCase();
        const i = n.indexOf(term);
        if (i < 0) return null;
        // Start of name first, then start of a word, then anywhere
        const rank = i === 0 ? 0 : /\s|[-&.]/.test(n[i - 1]) ? 1 : 2;
        return { c, i, rank };
      })
      .filter((x): x is { c: ClientOption; i: number; rank: number } => x !== null)
      // Clients on a creative package first; the rest show greyed out underneath
      .sort((a, b) => Number(b.c.creative) - Number(a.c.creative) || a.rank - b.rank || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, 7);
  }, [clients, term]);

  const pickable = matches.filter((m) => m.c.creative).length;
  const pick = (c: ClientOption) => {
    if (!c.creative) return;
    setQ("");
    onPick(c);
  };

  return (
    <div className="grid gap-3">
      <div className="relative">
        <svg className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, pickable - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (matches[active]) pick(matches[active].c);
            }
          }}
          placeholder="Start typing a client name"
          aria-label="Search clients"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={matches[active] ? `${listId}-${matches[active].c.id}` : undefined}
          className="h-14 w-full rounded-[10px] border border-line bg-surface pl-12 pr-4 text-lg outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
        />
      </div>

      {term.length < 2 ? (
        <p className="px-1 text-sm text-faint">
          Type 2 letters to search {clients.filter((c) => c.creative).length} clients on a creative package.
        </p>
      ) : matches.length === 0 ? (
        <p className="px-1 text-sm text-muted">No client matches &ldquo;{q.trim()}&rdquo;.</p>
      ) : (
        <ul id={listId} role="listbox" className="grid gap-1 animate-[step-in_.2s_ease-out]">
          {matches.map(({ c, i }, idx) => {
            const tint = tintFor(c.name);
            const name = (
              <>
                {c.name.slice(0, i)}
                <span className={c.creative ? "text-brand-text" : "text-muted"}>{c.name.slice(i, i + term.length)}</span>
                {c.name.slice(i + term.length)}
              </>
            );
            if (!c.creative)
              return (
                <li key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={false} aria-disabled>
                  <div className="flex w-full cursor-not-allowed items-center gap-3 rounded-[8px] px-3 py-2.5 opacity-45">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-surface-2 text-xs font-semibold text-faint">
                      {c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate">{name}</span>
                      <span className="text-[11px] text-faint">Not on a creative package</span>
                    </span>
                  </div>
                </li>
              );
            return (
              <li key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={idx === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(c)}
                  className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-left transition-colors ${idx === active ? "bg-surface-2" : "hover:bg-surface"}`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] text-xs font-semibold" style={{ background: `${tint}26`, color: tint }}>
                    {c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate">{name}</span>
                    <span className="truncate text-[11px] text-faint">{allotmentSummary(allotments[c.id])}</span>
                  </span>
                  {idx === active && <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint">Enter</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** − 3 + */
export function Stepper({ label, value, onChange, min = 0, max = 100 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] text-faint">{label}</span>
      <div className="flex h-10 items-center rounded-brand border border-line bg-bg">
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => set(value - 1)} disabled={value <= min} className="grid h-full w-9 place-items-center text-muted hover:text-fg disabled:opacity-30">
          −
        </button>
        <input
          inputMode="numeric"
          aria-label={label}
          value={value}
          onChange={(e) => set(Number(e.target.value.replace(/\D/g, "")) || 0)}
          className="tabular h-full w-10 bg-transparent text-center text-sm outline-none"
        />
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => set(value + 1)} disabled={value >= max} className="grid h-full w-9 place-items-center text-muted hover:text-fg disabled:opacity-30">
          +
        </button>
      </div>
    </div>
  );
}

const ASPECT: Record<Size, { w: number; h: number; label: string; use: string }> = {
  "1x1": { w: 30, h: 30, label: "1:1", use: "Square feed" },
  "4x5": { w: 28, h: 35, label: "4:5", use: "Feed" },
  "9x16": { w: 22, h: 39, label: "9:16", use: "Stories · Reels" },
};

/** An outline of the actual shape, so people see the size they're picking. */
export function AspectOption({ size, on, onToggle }: { size: Size; on: boolean; onToggle: () => void }) {
  const a = ASPECT[size];
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onToggle}
      className={`group grid justify-items-center gap-2.5 rounded-[10px] border px-3 pb-3 pt-4 transition-all ${
        on ? "border-brand-text/60 bg-brand-soft" : "border-line bg-surface hover:border-faint"
      }`}
    >
      <span className="grid h-11 place-items-center">
        <span
          className={`block rounded-[3px] border-[1.5px] transition-colors ${on ? "border-brand-text" : "border-faint group-hover:border-muted"}`}
          style={{ width: a.w, height: a.h }}
        />
      </span>
      <span className="grid justify-items-center">
        <span className="text-sm font-medium tabular">{a.label}</span>
        <span className="text-[11px] text-faint">{a.use}</span>
      </span>
    </button>
  );
}

/** A clickable suggestion. */
export function Chip({ children, onClick, title, ai = false, on = false }: { children: React.ReactNode; onClick: () => void; title?: string; ai?: boolean; on?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
        on
          ? "border-brand-text/60 bg-brand-soft text-fg"
          : ai
            ? "border-brand-text/25 bg-brand-soft/40 text-muted hover:border-brand-text/60 hover:text-fg"
            : "border-line text-muted hover:border-faint hover:text-fg"
      }`}
    >
      {ai && <Spark size={10} className="shrink-0 text-brand-text" />}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** Thin shimmer used while the AI is thinking. */
export function Thinking({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid gap-2" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="relative h-2.5 overflow-hidden rounded-full bg-surface-2" style={{ width: `${90 - i * 18}%` }}>
          <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-fg/10 to-transparent animate-[ai-sweep_1.4s_ease-in-out_infinite]" />
        </span>
      ))}
    </div>
  );
}

/** This month's allotment: used, what this request adds, and what's left. */
export function AllotmentMeter({ allotment, request, compact = false }: { allotment: Allotment | undefined; request: { images: number; videos: number }; compact?: boolean }) {
  if (!allotment || (allotment.images === null && allotment.videos === null))
    return (
      <p className="rounded-[10px] border border-dashed border-line px-4 py-3 text-xs text-faint">
        No monthly allotment set for this client yet. Execs and leads can set it on the client page.
      </p>
    );
  const rows = [
    { label: "Images & carousels", cap: allotment.images, used: allotment.imagesUsed, add: request.images },
    { label: "Videos", cap: allotment.videos, used: allotment.videosUsed, add: request.videos },
  ].filter((r) => r.cap !== null) as { label: string; cap: number; used: number; add: number }[];
  return (
    <div className={`grid gap-3.5 rounded-[10px] border border-line bg-surface ${compact ? "px-4 py-3.5" : "p-4"}`}>
      {!compact && <p className="text-xs text-muted">This month&apos;s allotment</p>}
      {rows.map((r) => {
        const after = r.cap - r.used - r.add;
        const over = after < 0;
        const scale = Math.max(r.cap, r.used + r.add, 1);
        return (
          <div key={r.label} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-muted">{r.label}</span>
              <span className={`tabular ${over ? "text-bad" : after === 0 ? "text-warn" : "text-muted"}`}>
                {r.used} used{r.add > 0 && <span className="text-fg"> + {r.add} here</span>} · {over ? `${-after} over` : `${after} of ${r.cap} left`}
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
              <span className="absolute inset-y-0 left-0 bg-fg/30" style={{ width: `${(Math.min(r.used, scale) / scale) * 100}%` }} />
              <span
                className={`absolute inset-y-0 transition-[width] duration-300 ${over ? "bg-bad" : "bg-brand"}`}
                style={{ left: `${(r.used / scale) * 100}%`, width: `${(r.add / scale) * 100}%` }}
              />
              {r.used + r.add > r.cap && <span className="absolute inset-y-0 w-px bg-fg" style={{ left: `${(r.cap / scale) * 100}%` }} />}
            </div>
          </div>
        );
      })}
      {rows.some((r) => r.used + r.add > r.cap) && (
        <p className="text-xs leading-relaxed text-bad">
          This goes over what they pay for. Swap some net new for variations, or it&apos;s an upgrade conversation.
        </p>
      )}
    </div>
  );
}
