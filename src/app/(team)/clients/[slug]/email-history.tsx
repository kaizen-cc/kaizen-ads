"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { emailHistoryState, readFullHistory, type HistoryView } from "./email-history-actions";

// "Read full history" on the email card: the months before what is stored, read from the provider in the background
// (Klaviyo a few pieces at a time, inside its rate limits), with the progress shown here and on any report waiting for it.

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function EmailHistory({ clientId }: { clientId: string }) {
  const [view, setView] = useState<HistoryView | null>(null);
  const [span, setSpan] = useState<"start" | "2y">("2y");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(() => emailHistoryState(clientId).then(setView).catch(() => undefined), [clientId]);
  useEffect(() => {
    load();
  }, [load]);
  // While it reads, the progress is looked at again every few seconds
  useEffect(() => {
    if (!view?.busy) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [view?.busy, load]);

  if (!view) return null;
  return (
    <div className="grid gap-1.5 border-t border-line pt-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
        <span className="text-muted">{view.stored ? `History stored from ${day(view.stored)}` : "No history stored yet"}</span>
        {view.busy ? (
          <span className="text-brand-text">{view.line ?? "Reading the history..."}</span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <select value={span} onChange={(e) => setSpan(e.target.value as "start" | "2y")} aria-label="How far back" className="h-11 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] md:h-9">
              <option value="2y">Up to 2 years</option>
              <option value="start">From the client&apos;s start</option>
            </select>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await readFullHistory(clientId, span);
                  setError(r.ok ? null : r.error);
                  setNote(r.ok ? r.message : null);
                  await load();
                })
              }
              className="min-h-11 text-[13px] text-brand-text hover:underline disabled:opacity-50 md:min-h-0"
            >
              Read full history
            </button>
          </span>
        )}
      </div>
      {view.busy && (
        <span className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={view.pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="block h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(4, view.pct)}%` }} />
        </span>
      )}
      {!view.busy && view.done && <p className="text-[12px] text-muted">Read {view.done}. Reports and the KPI sheet use it.</p>}
      {view.failed && <p className="text-[12px] text-warn">{view.failed}</p>}
      {note && !view.busy && <p className="text-[12px] text-muted">{note}</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}
