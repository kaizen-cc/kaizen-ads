"use client";

import { useMemo, useRef, useState } from "react";
import type { PickClient } from "../winners/winners-library";

/**
 * Type a client's name to see the market for them: after two letters, the matching clients drop down (names that start
 * with it first). Arrow keys and Enter pick one; the pick shows as a chip with a clear button.
 */
export function ClientSearch({ clients, value, onPick }: { clients: PickClient[]; value: PickClient | null; onPick: (id: string | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (term.length < 2) return [];
    return clients
      .filter((c) => c.name.toLowerCase().includes(term) || c.detail?.toLowerCase().includes(term))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(term)) - Number(a.name.toLowerCase().startsWith(term)) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [clients, term]);

  const choose = (c: PickClient) => {
    onPick(c.id);
    setQ("");
    setOpen(false);
  };

  if (value)
    return (
      <span className="flex h-10 max-w-[260px] items-center gap-2 rounded-[12px] bg-brand-soft pl-3.5 pr-1.5 text-sm">
        <span className="truncate">For {value.name}</span>
        <button
          onClick={() => {
            onPick(null);
            setTimeout(() => input.current?.focus(), 0);
          }}
          aria-label="Clear the client"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted hover:bg-bg/40 hover:text-fg"
        >
          ×
        </button>
      </span>
    );

  return (
    <div className="relative">
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((i) => Math.min(matches.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && matches[at]) {
            e.preventDefault();
            choose(matches[at]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="For a client…"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls="client-search-list"
        aria-autocomplete="list"
        className="h-10 w-[210px] rounded-[12px] bg-bg/60 px-3.5 text-sm outline-none placeholder:text-faint focus:ring-1 focus:ring-faint"
      />
      {open && term.length >= 2 && (
        <ul id="client-search-list" role="listbox" className="absolute left-0 top-11 z-30 grid w-[280px] gap-0.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-2xl">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-faint">No client matches &ldquo;{q.trim()}&rdquo;</li>
          ) : (
            matches.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === at}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setAt(i)}
                  onClick={() => choose(c)}
                  className={`grid w-full gap-0.5 rounded-[10px] px-3 py-2 text-left ${i === at ? "bg-surface-2" : ""}`}
                >
                  <span className="truncate text-sm">{c.name}</span>
                  {c.detail && <span className="truncate text-[11px] text-faint">{c.detail}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
