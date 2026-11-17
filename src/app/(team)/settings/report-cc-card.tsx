"use client";

import { useState, useTransition } from "react";
import { setReportCc } from "./report-cc-actions";

// Settings → Team: who is copied on every client report email, as one line (Change opens the list). A tap on a name
// saves at once (no Save button).

export function ReportCcCard({ people, selected }: { people: { id: string; name: string; role: string }[]; selected: string[] }) {
  const [ids, setIds] = useState(selected);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    const before = ids;
    setIds(next);
    setError(null);
    start(async () => {
      const r = await setReportCc(next);
      if (!r.ok) {
        setIds(before);
        setError(r.error);
      }
    });
  };

  const chosen = people.filter((p) => ids.includes(p.id));
  return (
    // One line until someone wants to change it: who's always copied, and Change to open the full list
    <section className="grid min-w-0 max-w-4xl gap-3 rounded-[18px] border border-line bg-surface px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">Copied on every report</h2>
        <p className="min-w-0 flex-1 truncate text-sm text-muted">{chosen.length ? chosen.map((p) => p.name.split(" ")[0]).join(", ") : "Nobody beyond each line's own people"}</p>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex min-h-11 items-center text-sm text-brand-text underline-offset-4 hover:underline md:min-h-0">
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open && (
        <>
          <p className="max-w-[62ch] text-xs text-faint">On top of each line&apos;s own people (the client&apos;s buyer, strategist or social manager, and that line&apos;s head), these people are copied on every report email.</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="People copied on every report">
            {people.map((p) => {
              const on = ids.includes(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={pending}
                    onClick={() => toggle(p.id)}
                    title={p.role}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors disabled:opacity-60 md:min-h-8 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                  >
                    <span aria-hidden className="text-[11px]">{on ? "✓" : "+"}</span>
                    {p.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p className="text-sm text-warn" role="alert">{error}</p>}
    </section>
  );
}
