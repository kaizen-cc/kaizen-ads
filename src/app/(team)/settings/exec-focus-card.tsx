"use client";

import { useState, useTransition } from "react";
import { FOCUS_LABEL, FOCUS_LINES, type FocusLine } from "@/lib/exec-focus/core";
import { setExecFocus } from "./exec-focus-actions";

// Settings → Team: each exec's focus, one line each (Change opens the lines). A tap on a line saves at once.

type Exec = { id: string; name: string; focus: FocusLine[] };

export function ExecFocusCard({ execs, me }: { execs: Exec[]; me: string }) {
  return (
    <section className="grid min-w-0 max-w-4xl gap-3 rounded-[18px] border border-line bg-surface px-4 py-3 md:px-5">
      <div className="grid gap-0.5">
        <h2 className="text-sm font-medium">What each exec hears about</h2>
        <p className="max-w-[62ch] text-xs text-faint">Their lines, anything on them, and every client on fire. The rest stays under Everything else on their Overview, never in the bell.</p>
      </div>
      <ul className="grid divide-y divide-line">
        {execs.map((e) => (
          <Row key={e.id} exec={e} mine={e.id === me} />
        ))}
      </ul>
    </section>
  );
}

function Row({ exec, mine }: { exec: Exec; mine: boolean }) {
  const [lines, setLines] = useState<FocusLine[]>(exec.focus);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (l: FocusLine) => {
    const before = lines;
    const next = FOCUS_LINES.filter((x) => (x === l ? !lines.includes(l) : lines.includes(x)));
    setLines(next);
    setError(null);
    start(async () => {
      const r = await setExecFocus(exec.id, next);
      if (!r.ok) {
        setLines(before);
        setError(r.error);
      }
    });
  };

  return (
    <li className="grid gap-2 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm">{mine ? "You" : exec.name.split(" ")[0]}</span>
        <p className="min-w-0 flex-1 truncate text-sm text-muted">{lines.length ? lines.map((l) => FOCUS_LABEL[l]).join(", ") : "Everything (no focus set)"}</p>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex min-h-11 items-center text-sm text-brand-text underline-offset-4 hover:underline md:min-h-0">
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${mine ? "Your" : `${exec.name}'s`} focus`}>
          {FOCUS_LINES.map((l) => {
            const on = lines.includes(l);
            return (
              <li key={l}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={pending}
                  onClick={() => toggle(l)}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors disabled:opacity-60 md:min-h-8 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                >
                  <span aria-hidden className="text-[11px]">{on ? "✓" : "+"}</span>
                  {FOCUS_LABEL[l]}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="text-sm text-warn" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
