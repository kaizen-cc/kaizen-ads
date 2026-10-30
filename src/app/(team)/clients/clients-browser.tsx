"use client";

import { useState } from "react";
import type { SlotRole } from "@/lib/roles";
import { pushParams, useParam } from "@/lib/url-state";
import type { Option } from "./assign-select";
import { ClientGrid, type ClientCard } from "./client-grid";
import { SERVICES, type ServiceSlug } from "@/lib/services";

// The tabs: every client we're working for now, then each service line, then the paused ones (counted nowhere else)
export type Filter = "all" | ServiceSlug | "paused";

const live = (c: ClientCard) => c.status !== "paused";
const FILTERS: { key: Filter; label: string; test: (c: ClientCard) => boolean }[] = [
  { key: "all", label: "All clients", test: live },
  ...SERVICES.map((s) => ({ key: s.slug as Filter, label: s.label, test: (c: ClientCard) => live(c) && c.services.includes(s.slug) })),
  { key: "paused", label: "Paused", test: (c) => !live(c) },
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
  // Narrow by service, by who's on the account, and by creative package tier (each in the address too)
  const who = useParam("who");
  const tier = useParam("tier");
  const people = [...new Map(cards.flatMap((c) => Object.values(c.assigned).filter((o): o is Option => Boolean(o)).map((o) => [o.id, o.name] as const))).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tiers = [...new Set(cards.map((c) => (c.pkg !== "none" ? c.packageLabel : null)).filter((t): t is string => Boolean(t)))].sort();
  const narrow = (c: ClientCard) =>
    (!who || Object.values(c.assigned).some((o) => o?.id === who)) && (!tier || (c.pkg !== "none" && c.packageLabel === tier));
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const inFilter = cards.filter(test).filter(narrow);
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
            return (
              <span key={f.key} className="contents">
                {f.key === "paused" && <span className="mx-1 h-4 w-px shrink-0 bg-line" />}
                <button
                  onClick={() => pick(f.key)}
                  className={`inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 ${
                    on ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"
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

      <div className="-mt-2 flex flex-wrap items-center gap-2">
        {(
          [
            ["who", who, "Everyone on the team", people],
            ["tier", tier, "Any package tier", tiers.map((t) => [t, t] as const)],
          ] as const
        ).map(([key, value, all, options]) => (
          <select
            key={key}
            value={value ?? ""}
            onChange={(e) => pushParams({ [key]: e.target.value || null })}
            aria-label={all}
            className={`h-11 rounded-full border px-4 pr-8 text-sm outline-none transition-colors md:h-9 ${value ? "border-fg/40 bg-surface-2 text-fg" : "border-line bg-surface text-muted hover:border-faint/60"}`}
          >
            <option value="">{all}</option>
            {options.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ))}
        {(who || tier) && (
          <button type="button" onClick={() => pushParams({ who: null, tier: null })} className="h-11 px-2 text-xs text-muted hover:text-fg md:h-9">
            Clear filters
          </button>
        )}
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
          {filter === "paused" ? "No paused clients." : "No clients here yet."}
        </p>
      )}
    </>
  );
}
