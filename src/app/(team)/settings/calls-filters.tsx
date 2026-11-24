"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";

// Settings › Calls & usage › Call logs: the filters live in the URL (each change is a new history entry, so back
// returns to the last view). Selects and dates apply at once; the search applies on Enter or leaving the box.

type Opt = { value: string; label: string };

export function CallFilters({ teams, people, values }: { teams: Opt[]; people: Opt[]; values: { team: string; person: string; from: string; to: string; flag: string; q: string } }) {
  const router = useRouter();
  const sp = useSearchParams();
  const qRef = useRef<HTMLInputElement>(null);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    next.set("tab", "calls");
    next.delete("call");
    next.delete("thread");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.push(`/settings?${next.toString()}`, { scroll: false });
  };
  const field = "h-11 min-w-0 rounded-xl border border-line bg-surface px-3 text-sm text-fg md:h-9";
  return (
    <form
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-center"
      onSubmit={(e) => {
        e.preventDefault();
        set({ q: qRef.current?.value.trim() ?? "" });
      }}
    >
      <input
        ref={qRef}
        type="search"
        defaultValue={values.q}
        placeholder="Search what was said"
        aria-label="Search transcripts"
        className={`${field} col-span-2 sm:col-span-3 lg:w-64`}
        onBlur={(e) => e.currentTarget.value.trim() !== values.q && set({ q: e.currentTarget.value.trim() })}
      />
      <select aria-label="Flagged or normal" className={field} value={values.flag} onChange={(e) => set({ flag: e.target.value })}>
        <option value="">Flagged and normal</option>
        <option value="flagged">Flagged only</option>
        <option value="normal">Normal only</option>
      </select>
      <select aria-label="Team" className={field} value={values.team} onChange={(e) => set({ team: e.target.value })}>
        <option value="">Every team</option>
        {teams.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <select aria-label="Person" className={field} value={values.person} onChange={(e) => set({ person: e.target.value })}>
        <option value="">Everyone</option>
        {people.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-muted">
        From
        <input type="date" aria-label="From" className={`${field} flex-1`} value={values.from} max={values.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        To
        <input type="date" aria-label="To" className={`${field} flex-1`} value={values.to} min={values.from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
      </label>
    </form>
  );
}
