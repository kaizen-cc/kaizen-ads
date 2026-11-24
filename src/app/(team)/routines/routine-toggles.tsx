"use client";

import { useState, useTransition } from "react";
import { runRoutineNow, saveRoutine } from "./actions";

// Each routine: on or off, its times (saved as you change them), and Run now. Mobile first: 44px targets.

type R = { kind: string; label: string; about: string; multi: boolean; enabled: boolean; times: string[]; days: string };
const DAYS: Record<string, string> = { weekdays: "Weekdays", daily: "Every day", fri: "Fridays", sun: "Sundays" };

export function RoutineToggles({ routines }: { routines: R[] }) {
  return (
    <section className="grid gap-3">
      <h2 className="font-heading text-[20px]">Your routines</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {routines.map((r) => (
          <Row key={r.kind} r={r} />
        ))}
      </ul>
    </section>
  );
}

function Row({ r }: { r: R }) {
  const [on, setOn] = useState(r.enabled);
  const [times, setTimes] = useState(r.times.join(", "));
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (patch: { enabled?: boolean; times?: string[] }) =>
    start(async () => {
      setNote(null);
      const res = await saveRoutine(r.kind, patch);
      setNote(res.ok ? "Saved" : res.error);
    });
  return (
    <li className={`grid gap-3 rounded-[18px] border p-4 transition-colors ${on ? "border-brand/35 bg-brand/[0.04]" : "border-line bg-surface"}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="grid gap-0.5">
          <span className="font-medium">{r.label}</span>
          <span className="text-[12.5px] leading-snug text-muted">{r.about}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${r.label} ${on ? "on" : "off"}`}
          disabled={pending}
          onClick={() => {
            setOn(!on);
            save({ enabled: !on });
          }}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors max-md:h-9 ${on ? "bg-brand" : "bg-surface-2 ring-1 ring-line"}`}
        >
          <span className={`absolute top-1 h-6 w-6 rounded-full bg-bg shadow transition-all max-md:h-7 max-md:w-7 ${on ? "left-7" : "left-1"}`} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-faint">
        <span>{DAYS[r.days] ?? r.days}</span>
        {r.times.length || r.multi ? (
          <input
            value={times}
            onChange={(e) => setTimes(e.target.value)}
            onBlur={() => times !== r.times.join(", ") && save({ times: times.split(/[,\s]+/).filter(Boolean) })}
            aria-label={`${r.label} times`}
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-fg outline-none focus:border-brand/60 md:h-9"
            placeholder="08:45"
          />
        ) : (
          <span>Before each call on your calendar</span>
        )}
        <button type="button" disabled={pending} onClick={() => start(async () => setNote((await runRoutineNow(r.kind)).ok ? "Running: it lands below in a minute or two" : "Couldn't start it"))} className="h-11 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg md:h-9">
          Run now
        </button>
      </div>
      {note && <p className="text-[12px] text-faint">{note}</p>}
    </li>
  );
}
