"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { groupOptions, searchOptions, type MetricOption } from "@/lib/reports/metric-options";

// The metric picker on a report (ads, email, social): "Show in this tile", a row or a column, and "+ Tile". A search field
// on top (type to filter, arrows to move, Enter to pick, Escape to close), every metric the report has data for in its
// groups, the one shown now marked "Now", and one already elsewhere on the page marked "Swaps places" or "On the page".
// It sits in the page's menu (a sheet on phones), so every row is a full 44px touch target there.

export function MetricPicker({
  title,
  options,
  current,
  taken,
  takenNote = "Swaps places",
  hideTaken = false,
  onPick,
  onRemove,
  removeLabel,
  onClose,
  full,
}: {
  title: string;
  options: MetricOption[];
  current: string | null;
  /** Already shown elsewhere in the same place */
  taken: string[];
  takenNote?: string;
  /** Leave the ones already shown out of the list (adding) instead of marking them */
  hideTaken?: boolean;
  onPick: (key: string) => void;
  onRemove?: () => void;
  removeLabel?: string;
  onClose?: () => void;
  /** Why nothing more can be added (the tiles are full) */
  full?: string | null;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => searchOptions(options.filter((o) => o.key === current || !(hideTaken && taken.includes(o.key))), q), [options, current, taken, hideTaken, q]);
  const groups = useMemo(() => groupOptions(shown), [shown]);
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const indexOf = useMemo(() => new Map(flat.map((o, n) => [o.key, n])), [flat]);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  // Typing goes straight to the search on a computer; a phone keeps its keyboard down until the field is tapped
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setAt(Math.max(0, flat.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = flat[at];
      if (o && !full) onPick(o.key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    }
  };

  return (
    <div className="grid gap-2" onKeyDown={onKey}>
      <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{title}</p>
      <label className="relative block">
        <span className="sr-only">Search metrics</span>
        <svg viewBox="0 0 20 20" aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint">
          <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => (setQ(e.target.value), setAt(0))}
          placeholder={`Search ${options.length} metrics`}
          role="combobox"
          aria-expanded
          aria-controls={id}
          aria-activedescendant={flat[at] ? `${id}-${at}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-11 w-full rounded-[12px] border border-line bg-bg pl-9 pr-9 text-[15px] text-fg outline-none placeholder:text-faint focus:border-brand-text/60 md:h-10 md:text-[14px]"
        />
        {q && (
          <button type="button" onClick={() => (setQ(""), setAt(0), input.current?.focus())} aria-label="Clear the search" className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-faint hover:text-fg">
            <svg viewBox="0 0 20 20" aria-hidden className="h-3.5 w-3.5">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </label>
      {full && <p className="px-1 text-[12px] text-muted">{full}</p>}
      <div ref={list} id={id} role="listbox" aria-label={title} className="-mx-1 grid max-h-[min(46vh,360px)] gap-0.5 overflow-y-auto overscroll-contain px-1">
        {groups.map((g) => (
          <div key={g.group} role="group" aria-label={g.group} className="grid gap-0.5">
            <p className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-faint">{g.group}</p>
            {g.options.map((o) => {
              const me = indexOf.get(o.key) ?? 0;
              const now = o.key === current;
              const elsewhere = !now && taken.includes(o.key);
              return (
                <button
                  key={o.key}
                  id={`${id}-${me}`}
                  data-i={me}
                  type="button"
                  role="option"
                  aria-selected={me === at}
                  disabled={Boolean(full) && !now}
                  onMouseMove={() => at !== me && setAt(me)}
                  onClick={() => onPick(o.key)}
                  className={`flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-3 text-left text-[14px] transition-colors disabled:opacity-40 md:min-h-9 md:text-[13.5px] ${me === at ? "bg-surface-2 text-fg" : now ? "text-fg" : "text-muted"}`}
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {o.label}
                    {o.hint && <span className="ml-2 text-[11.5px] text-faint">{o.hint}</span>}
                  </span>
                  {now ? <span className="shrink-0 rounded-full bg-fg px-2 py-0.5 text-[10.5px] font-medium text-bg">Now</span> : elsewhere ? <span className="shrink-0 text-[11px] text-faint">{takenNote}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && <p className="px-3 py-4 text-[13px] text-muted">No metric matches &ldquo;{q}&rdquo; in this report&rsquo;s data.</p>}
      </div>
      {onRemove && (
        <button type="button" onClick={onRemove} className="min-h-11 rounded-[10px] border-t border-line px-3 text-left text-[13.5px] text-bad hover:bg-bad-soft/40 md:min-h-10 md:text-[13px]">
          {removeLabel ?? "Remove"}
        </button>
      )}
    </div>
  );
}
