"use client";

import { useState, useTransition } from "react";
import { setReportCc } from "./report-cc-actions";

// Settings → Team: who is copied on every client report email. A tap on a name saves at once (no Save button).

export function ReportCcCard({ people, selected }: { people: { id: string; name: string; role: string }[]; selected: string[] }) {
  const [ids, setIds] = useState(selected);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <section className="grid min-w-0 max-w-4xl gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="grid gap-1">
        <h2 className="font-heading text-lg">Copied on every client report</h2>
        <p className="max-w-[62ch] text-sm text-muted">
          Each report email goes to all of the client&apos;s contacts, with the media buyers on that account copied in. These people are copied on every one, on top of the buyers.
        </p>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="People copied on every report">
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
                className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm transition-colors disabled:opacity-60 md:min-h-9 ${on ? "border-fg bg-fg text-bg" : "border-line bg-surface text-muted hover:border-faint hover:text-fg"}`}
              >
                <span aria-hidden className="text-[11px]">{on ? "✓" : "+"}</span>
                {p.name}
                <span className={`text-[11px] ${on ? "opacity-70" : "text-faint"}`}>{p.role}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-faint">{ids.length ? `${ids.length} ${ids.length === 1 ? "person" : "people"} always copied.` : "Nobody is always copied: only the media buyers on each account."}</p>
      {error && <p className="text-sm text-warn" role="alert">{error}</p>}
    </section>
  );
}
