"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import type { RingPrefs } from "@/lib/assistant/ring-core";
import { useAgentCall } from "@/components/agent-call-provider";
import { setRingPrefs } from "./actions";

// When something's urgent: their assistant rings them in the app (the default) or leaves it in the chat only, and
// quiet hours when it never rings. Saved on change. The bell and email are the same either way.

const field = "h-11 rounded-[12px] border border-line bg-bg/60 px-3 text-[16px] text-fg outline-none transition-colors focus:border-faint md:h-10 md:text-[14px]";

export function RingSettings({ prefs }: { prefs: RingPrefs }) {
  const { assistantName, assistantTint: tint } = useAgentCall();
  const who = assistantName || "Your assistant";
  const [mode, setMode] = useState(prefs.mode);
  const [quiet, setQuiet] = useState(Boolean(prefs.quietStart && prefs.quietEnd));
  const [start, setStart] = useState(prefs.quietStart ?? "21:00");
  const [end, setEnd] = useState(prefs.quietEnd ?? "08:00");
  const [note, setNote] = useState<string | null>(null);
  const [pending, run] = useTransition();
  // Their device's time zone (the saved one until the page is in the browser)
  const tz = useSyncExternalStore(
    () => () => undefined,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || prefs.tz,
    () => prefs.tz,
  );

  const save = (next: { mode?: RingPrefs["mode"]; quiet?: boolean; start?: string; end?: string }) => {
    const m = next.mode ?? mode;
    const q = next.quiet ?? quiet;
    const a = next.start ?? start;
    const b = next.end ?? end;
    run(async () => {
      const r = await setRingPrefs({ mode: m, quietStart: q ? a : null, quietEnd: q ? b : null, tz });
      setNote(r.ok ? "Saved." : r.error);
    });
  };

  const options: { key: RingPrefs["mode"]; title: string; sub: string }[] = [
    { key: "ring", title: "Ring me", sub: `${who} calls you in the app for ten seconds. Miss it and it waits in your chat.` },
    { key: "chat", title: "Chat only", sub: "No ring. Urgent things wait in your chat, unread." },
  ];

  return (
    <section aria-labelledby="ring-title" className="grid gap-4 rounded-[24px] border border-line bg-surface p-5 sm:p-6">
      <div>
        <h2 id="ring-title" className="font-heading text-[18px] leading-tight">
          When something&apos;s urgent
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">Urgent call action items, critical account alerts, a client changing direction, an exec&apos;s ask due today. Never during a call or a chat, and only while you&apos;re in Kaizen OS.</p>
      </div>
      <div role="radiogroup" aria-label="How you hear about it" className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const on = mode === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending}
              onClick={() => {
                setMode(o.key);
                save({ mode: o.key });
              }}
              className={`grid min-h-16 gap-1 rounded-[16px] border p-3.5 text-left transition-colors ${on ? "bg-surface-2" : "border-line hover:bg-surface-2/60"}`}
              style={on ? { borderColor: tint, boxShadow: `inset 0 0 0 1px ${tint}` } : undefined}
            >
              <span className="text-[14px] font-medium text-fg">{o.title}</span>
              <span className="text-[12.5px] leading-snug text-muted">{o.sub}</span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={quiet}
            disabled={pending}
            onChange={(e) => {
              setQuiet(e.target.checked);
              save({ quiet: e.target.checked });
            }}
            className="h-5 w-5 shrink-0 accent-[var(--color-brand)]"
          />
          <span className="text-[14px] text-fg">Quiet hours</span>
          <span className="text-[12.5px] text-faint">no ring, the chat still gets it</span>
        </label>
        {quiet && (
          <div className="flex flex-wrap items-center gap-2 pl-8">
            <label className="sr-only" htmlFor="quiet-start">
              From
            </label>
            <input id="quiet-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => save({})} className={field} />
            <span className="text-[13px] text-faint">to</span>
            <label className="sr-only" htmlFor="quiet-end">
              Until
            </label>
            <input id="quiet-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={() => save({})} className={field} />
            <span className="text-[12px] text-faint">{tz.replace(/_/g, " ")}</span>
          </div>
        )}
      </div>
      <p aria-live="polite" className="min-h-[1.2em] text-[12.5px] text-muted">
        {note}
      </p>
    </section>
  );
}
