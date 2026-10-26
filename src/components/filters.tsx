"use client";

import { useState } from "react";

// The calm filter pieces shared by Market and Winners: a quiet dropdown and a removable pill for a filter in use.

/** A filter in use, with its own clear button. */
export function FilterPill({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="flex h-7 items-center gap-1 rounded-full border border-line bg-surface pl-3 pr-1 text-xs">
      <span className="max-w-[220px] truncate">{children}</span>
      <button onClick={onClear} aria-label="Remove this filter" className="grid h-5 w-5 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg max-md:h-8 max-md:w-8">
        ×
      </button>
    </span>
  );
}

/** A quiet dropdown: a button that opens a short list (with counts), closing on a pick or a click elsewhere. */
export function FilterMenu<T extends string | null>({ label, on, options, value, onPick }: { label: string; on: boolean; options: readonly (readonly [T, string, number | null])[]; value: T; onPick: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex h-10 items-center gap-2 rounded-[12px] px-3.5 text-sm transition-colors ${on ? "bg-fg text-bg" : "bg-bg/60 text-muted hover:text-fg"}`}
        aria-expanded={open}
      >
        <span className="max-w-[180px] truncate">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
        {/* Phones: a bottom sheet over a dimmed page (tapping outside closes it, as the menu loses focus) */}
        <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-[59] bg-black/50 md:hidden" />
        <div className="absolute right-0 top-12 z-30 grid max-h-[60vh] w-64 gap-0.5 overflow-y-auto rounded-[14px] border border-line bg-surface p-1.5 shadow-2xl max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:z-[60] max-md:max-h-[70dvh] max-md:w-auto max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:p-2 max-md:pb-[calc(12px+env(safe-area-inset-bottom))]">
          {options.map(([k, l, n]) => (
            <button
              key={k ?? "any"}
              onClick={() => {
                onPick(k);
                setOpen(false);
              }}
              className={`flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left text-sm hover:bg-surface-2 max-md:min-h-12 max-md:text-[15px] ${value === k ? "text-fg" : "text-muted"}`}
            >
              <span className="flex items-center gap-2 truncate">
                <span className={`w-3 text-xs ${value === k ? "text-brand-text" : "text-transparent"}`}>✓</span>
                {l}
              </span>
              {n !== null && <span className="tabular text-[11px] text-faint">{n}</span>}
            </button>
          ))}
        </div>
        </>
      )}
    </div>
  );
}
