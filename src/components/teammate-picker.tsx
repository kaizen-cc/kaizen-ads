"use client";

import { useMemo, useState } from "react";

// Picking a teammate (Transfer owner, Hand off, Reassign, an Asana assignee): every active teammate, execs and the owner
// included, searchable by name or role, by role then name, 44px rows on a phone (team feedback, Nov 25 2026: the owner
// wasn't in the list). The list comes from the server already in that order.

export type Pickable = { id: string; name: string; role?: string; roleLabel?: string; onClient?: boolean };

export function TeammatePicker({ people, value, onChange, label = "Who", tone = "auto" }: { people: Pickable[] | null; value: string; onChange: (id: string) => void; label?: string; tone?: "auto" | "dark" }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !t || p.name.toLowerCase().includes(t) || (p.roleLabel ?? p.role ?? "").toLowerCase().replace(/_/g, " ").includes(t));
  }, [people, q]);
  const dark = tone === "dark";
  return (
    <div className="grid gap-1.5">
      <label className={`grid gap-1 text-[12px] ${dark ? "text-white/60" : "text-ink/60"}`}>
        {label}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={people ? "Search a name or a role" : "Loading..."} className={`h-11 rounded-brand border bg-transparent px-3 text-[16px] outline-none sm:h-9 sm:text-[13px] ${dark ? "border-white/20 text-white" : "border-ink/15 text-fg"}`} />
      </label>
      <ul role="listbox" aria-label={label} className={`max-h-[45vh] overflow-y-auto overscroll-contain rounded-[12px] border sm:max-h-56 ${dark ? "border-white/15" : "border-ink/10"}`}>
        {people && !shown.length && <li className={`px-3 py-3 text-[13px] ${dark ? "text-white/60" : "text-muted"}`}>Nobody matches that.</li>}
        {shown.map((p) => {
          const on = p.id === value;
          return (
            <li key={p.id} role="option" aria-selected={on}>
              <button type="button" onClick={() => onChange(on ? "" : p.id)} className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-[14px] sm:min-h-9 sm:text-[13px] ${on ? (dark ? "bg-white/15 text-white" : "bg-ink/10 text-fg") : dark ? "text-white/85 hover:bg-white/10" : "text-fg hover:bg-ink/[0.05]"}`}>
                <span className="min-w-0 truncate">
                  {on ? "✓ " : ""}
                  {p.name}
                </span>
                <span className={`shrink-0 text-[11.5px] ${dark ? "text-white/50" : "text-muted"}`}>
                  {p.roleLabel ?? (p.role ? p.role.replace(/_/g, " ") : "")}
                  {p.onClient ? " · on this client" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
