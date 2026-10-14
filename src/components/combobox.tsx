"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ComboOption = { value: string; label: string; hint?: string; dot?: string };

/** A searchable picker. Type to narrow, arrow keys + Enter to choose, Esc to close. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  allLabel,
  label,
  className = "",
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  allLabel?: string; // shows a "clear" option at the top, e.g. "All clients"
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [q, options]);
  const rows: (ComboOption | null)[] = allLabel ? [null, ...filtered] : filtered;

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const choose = (o: ComboOption | null) => {
    onChange(o ? o.value : null);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setCursor(0);
          setTimeout(() => input.current?.focus(), 0);
        }}
        className={`flex h-9 w-full items-center gap-2 rounded-full border px-3 text-sm transition-colors ${
          selected ? "border-brand-text/50 bg-brand-soft text-fg" : "border-line bg-surface text-muted hover:border-faint hover:text-fg"
        }`}
      >
        {selected?.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: selected.dot }} />}
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <span className="ml-auto text-[10px] text-faint">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-40 w-72 overflow-hidden rounded-brand border border-line bg-surface-2 shadow-2xl">
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(rows.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (rows[cursor] !== undefined) choose(rows[cursor]);
              } else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search…"
            aria-label={`Search ${label.toLowerCase()}`}
            className="h-10 w-full border-b border-line bg-transparent px-3 text-sm outline-none"
          />
          <ul role="listbox" className="max-h-72 overflow-y-auto p-1">
            {rows.map((o, i) => (
              <li
                key={o?.value ?? "__all"}
                role="option"
                aria-selected={o ? o.value === value : value === null}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(o)}
                className={`flex cursor-pointer items-center gap-2 rounded-brand px-2.5 py-2 text-sm ${i === cursor ? "bg-surface text-fg" : "text-muted"}`}
              >
                {o?.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.dot }} />}
                <span className="truncate">{o ? o.label : allLabel}</span>
                {o?.hint && <span className="ml-auto shrink-0 text-xs text-faint">{o.hint}</span>}
              </li>
            ))}
            {rows.length === 0 && <li className="px-2.5 py-3 text-sm text-faint">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
