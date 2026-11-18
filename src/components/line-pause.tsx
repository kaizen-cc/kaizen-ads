"use client";

import { useEffect, useState, useTransition } from "react";
import { linePauseState, pauseLine, resumeLine, type LinePause } from "@/lib/account-watch/pause-actions";

// "Pause email for this client": until a date, with a reason. On the client's email card (tone "light") and on a recap
// item as "Paused: hide until..." (tone "dark", over the recap's dark card). A lead or exec only; anyone else sees the pause.

const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const show = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function LinePauseControl({ clientId, service, label, tone = "light", onPaused }: { clientId: string; service: string; label: string; tone?: "light" | "dark"; onPaused?: () => void }) {
  const [state, setState] = useState<{ pause: LinePause | null; canManage: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState(plusDays(30));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dark = tone === "dark";

  useEffect(() => {
    let live = true;
    linePauseState(clientId, service).then((s) => live && setState(s)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clientId, service]);

  if (!state || (!state.canManage && !state.pause)) return null;
  const quiet = dark ? "text-white/70 hover:text-white" : "text-muted hover:text-fg";
  const field = dark ? "border-white/25 bg-white/10 text-white placeholder:text-white/40" : "border-line bg-surface text-fg";

  const refresh = () => linePauseState(clientId, service).then(setState).catch(() => undefined);
  const save = () =>
    start(async () => {
      const r = await pauseLine(clientId, service, until, reason);
      if (!r.ok) return setError(r.error);
      setError(null);
      setOpen(false);
      setReason("");
      await refresh();
      onPaused?.();
    });

  if (state.pause) {
    return (
      <span className={`inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] ${dark ? "text-white/70" : "text-muted"}`}>
        <span>
          Paused until {show(state.pause.until)}
          {state.pause.reason ? `: ${state.pause.reason}` : ""}
        </span>
        {state.canManage && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await resumeLine(state.pause!.id);
                if (!r.ok) setError(r.error);
                await refresh();
              })
            }
            className={`min-h-11 md:min-h-0 ${quiet} underline-offset-2 hover:underline disabled:opacity-50`}
          >
            Resume now
          </button>
        )}
        {error && <span className="text-bad">{error}</span>}
      </span>
    );
  }

  return (
    <span className="grid gap-2">
      {!open && (
        <button type="button" onClick={() => setOpen(true)} className={`inline-flex min-h-11 w-fit items-center text-[13px] md:min-h-0 ${quiet}`}>
          {dark ? "Paused: hide until..." : label}
        </button>
      )}
      {open && (
        <span className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
          <input type="date" value={until} min={plusDays(1)} onChange={(e) => setUntil(e.target.value)} aria-label="Pause until" className={`h-11 rounded-[10px] border px-3 text-sm outline-none md:h-9 ${field}`} />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (the client asked, off season...)" aria-label="Reason" maxLength={200} className={`h-11 min-w-0 flex-1 rounded-[10px] border px-3 text-sm outline-none md:h-9 sm:basis-56 ${field}`} />
          <span className="flex gap-2">
            <button type="button" disabled={pending || reason.trim().length < 3} onClick={save} className={`h-11 rounded-full px-4 text-[13px] font-medium disabled:opacity-50 md:h-9 ${dark ? "bg-white text-black" : "bg-fg text-bg"}`}>
              {pending ? "Saving..." : "Pause"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={`h-11 rounded-full px-3 text-[13px] md:h-9 ${quiet}`}>
              Cancel
            </button>
          </span>
        </span>
      )}
      {error && <span className="text-[12.5px] text-bad">{error}</span>}
    </span>
  );
}
