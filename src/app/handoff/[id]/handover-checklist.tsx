"use client";

import { useState, useTransition } from "react";
import { toggleHandOver } from "../actions";

/** The person handing over: what to pass on before stepping away, ticked off as they go (everyone else sees it read only) */
export function HandOverChecklist({ id, items, done: start, canTick }: { id: string; items: string[]; done: number[]; canTick: boolean }) {
  const [done, setDone] = useState(start);
  const [pending, run] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {items.map((x, i) => {
          const on = done.includes(i);
          return (
            <li key={i} className="break-inside-avoid">
              <label className={`flex min-h-11 items-start gap-3 rounded-[8px] border px-4 py-3 ${on ? "border-[#cfe5d6] bg-[#eef6f0]" : "border-[#e7e2e3]"} ${canTick ? "cursor-pointer" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!canTick || pending}
                  onChange={() =>
                    run(async () => {
                      setError(null);
                      const r = await toggleHandOver(id, i);
                      if (r.ok) setDone(r.done);
                      else setError(r.error);
                    })
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#1f7a43]"
                />
                <span className={`text-[14px] leading-relaxed ${on ? "text-[#4d464f] line-through" : ""}`}>{x}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="no-print text-[12px] text-[#8a8189]">
        {done.length} of {items.length} handed over{canTick ? "" : " · the person handing over ticks these off"}
      </p>
      {error && <p className="text-[12px] text-[#c8102e]">{error}</p>}
    </div>
  );
}
