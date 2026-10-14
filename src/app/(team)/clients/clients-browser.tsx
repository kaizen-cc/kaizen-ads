"use client";

import { useState } from "react";
import type { SlotRole } from "@/lib/roles";
import type { Option } from "./assign-select";
import { ClientGrid, UpsellList, type ClientCard, type OtherClient } from "./client-grid";

/** The tabs row with a live search: from two letters typed, only matching clients stay on screen. */
export function ClientsBrowser({
  nav,
  tab,
  cards,
  other,
  slotOptions,
  canEdit,
  emptyText,
}: {
  nav: React.ReactNode;
  tab: "creative" | "other";
  cards: ClientCard[];
  other: OtherClient[];
  slotOptions: Record<SlotRole, Option[]>;
  canEdit: boolean;
  emptyText: string;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const searching = term.length >= 2;
  const match = (name: string) => !searching || name.toLowerCase().includes(term);
  const shownCards = cards.filter((c) => match(c.name));
  const shownOther = other.filter((c) => match(c.name));
  const total = tab === "creative" ? cards.length : other.length;
  const found = tab === "creative" ? shownCards.length : shownOther.length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {nav}
        <div className="relative">
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
            className="h-10 w-72 max-w-full rounded-full border border-line bg-surface pl-10 pr-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70"
          />
        </div>
      </div>

      {searching && (
        <p className="-mt-3 text-xs text-faint" aria-live="polite">
          {found ? `${found} of ${total} match "${q.trim()}"` : `Nothing matches "${q.trim()}"`}
          {found ? null : (
            <button onClick={() => setQ("")} className="ml-2 text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </button>
          )}
        </p>
      )}

      {found ? (
        tab === "creative" ? (
          <ClientGrid cards={shownCards} slotOptions={slotOptions} canEdit={canEdit} />
        ) : (
          <UpsellList clients={shownOther} />
        )
      ) : searching ? null : (
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">{emptyText}</p>
      )}
    </>
  );
}
