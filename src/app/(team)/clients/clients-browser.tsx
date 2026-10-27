"use client";

import { useState } from "react";
import type { SlotRole } from "@/lib/roles";
import { pushParams, useParam } from "@/lib/url-state";
import type { Option } from "./assign-select";
import { ClientGrid, type ClientCard } from "./client-grid";

export type Filter = "all" | "creative" | "sprint" | "none" | "gaps";

const FILTERS: { key: Filter; label: string; test: (c: ClientCard) => boolean }[] = [
  { key: "all", label: "All clients", test: () => true },
  { key: "creative", label: "Creative package", test: (c) => c.pkg !== "none" },
  { key: "sprint", label: "Sprint", test: (c) => c.pkg === "sprint" },
  { key: "none", label: "No package", test: (c) => c.pkg === "none" },
  { key: "gaps", label: "Missing someone", test: (c) => c.missing > 0 },
];

/** Every client in one place: filter chips plus a live search that narrows the cards from two letters typed. */
export function ClientsBrowser({
  cards,
  slotOptions,
  canEdit,
}: {
  cards: ClientCard[];
  slotOptions: Record<SlotRole, Option[]>;
  canEdit: boolean;
}) {
  const [q, setQ] = useState("");
  // The filter is in the address (?filter=), so back returns to the list as it was
  const asked = useParam("filter");
  const filter: Filter = FILTERS.find((f) => f.key === asked)?.key ?? "all";
  const term = q.trim().toLowerCase();
  const searching = term.length >= 2;
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const inFilter = cards.filter(test);
  const shown = inFilter.filter((c) => !searching || c.name.toLowerCase().includes(term));

  const pick = (f: Filter) => pushParams({ filter: f === "all" ? null : f });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="no-scrollbar -mx-4 flex w-[calc(100%+2rem)] items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:w-auto md:flex-wrap md:overflow-visible md:px-0">
          {FILTERS.map((f) => {
            const n = cards.filter(f.test).length;
            if (!n && f.key !== "all" && f.key !== filter) return null;
            const on = filter === f.key;
            const warn = f.key === "gaps";
            return (
              <span key={f.key} className="contents">
                {warn && <span className="mx-1 h-4 w-px shrink-0 bg-line" />}
                <button
                  onClick={() => pick(f.key)}
                  className={`inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 ${
                    on ? (warn ? "bg-warn-soft text-warn" : "bg-fg text-bg") : "text-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  {f.label} <span className="tabular opacity-60">{n}</span>
                </button>
              </span>
            );
          })}
        </nav>
        <div className="relative w-full md:w-auto">
          <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
            placeholder="Search clients"
            aria-label="Search clients"
            className="h-11 w-full max-w-full rounded-full md:h-10 md:w-72 border border-line bg-surface pl-10 pr-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70"
          />
        </div>
      </div>

      {searching && (
        <p className="-mt-3 text-xs text-faint" aria-live="polite">
          {shown.length ? `${shown.length} of ${inFilter.length} match "${q.trim()}"` : `Nothing matches "${q.trim()}"`}
          {shown.length ? null : (
            <button onClick={() => setQ("")} className="ml-2 min-h-11 text-muted md:min-h-0 underline-offset-4 hover:text-fg hover:underline">
              Clear
            </button>
          )}
        </p>
      )}

      {shown.length ? (
        <ClientGrid cards={shown} slotOptions={slotOptions} canEdit={canEdit} />
      ) : searching ? null : (
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">
          {filter === "gaps" ? "Every client is fully staffed." : filter === "sprint" ? "No clients on a sprint package." : "No clients here yet."}
        </p>
      )}
    </>
  );
}
