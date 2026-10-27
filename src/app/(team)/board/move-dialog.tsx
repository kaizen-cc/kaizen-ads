"use client";

import { useEffect, useState, useTransition } from "react";
import { BOARD_ORDER, stageInfo, type Stage } from "@/lib/stages";
import { moveCheck, moveTicket, type MoveCheck } from "./actions";
import type { Ticket } from "./types";

// Moving a ticket by hand, to any column (back to production, straight to the client…): pick where (or drop it there
// on the board), see what that stage needs, and say why when it goes back or skips something. What's missing is said
// with the way to fix it (upload the approved creative, approve the copy); the move waits until it's there.

export function MoveDialog({
  ticket,
  to: initial,
  onClose,
  onMoved,
  onFix,
}: {
  ticket: Pick<Ticket, "id" | "number" | "title" | "stage">;
  to: Stage | null;
  onClose: () => void;
  onMoved: (stage: Stage) => void;
  /** Open the ticket where the missing thing is done (upload, copy) */
  onFix?: (fix: "upload" | "copy") => void;
}) {
  const [to, setTo] = useState<Stage | null>(initial);
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (!to) return;
    let live = true;
    moveCheck(ticket.id, to).then((c) => live && (setCheck(c), setError(null)));
    return () => {
      live = false;
      setCheck(null);
    };
  }, [ticket.id, to]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const needsNote = Boolean(check && (check.backwards || check.warnings.length));
  const ready = Boolean(to && check && !check.blockers.length && (!needsNote || note.trim().length >= 3));
  const go = () =>
    start(async () => {
      if (!to) return;
      const r = await moveTicket(ticket.id, to, note.trim() || (check?.backwards ? "Moved back" : "Moved by hand"));
      if (!r.ok) return setError(r.error);
      onMoved(to);
    });

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4 max-md:items-end max-md:p-0" role="dialog" aria-modal="true" aria-label={`Move #${ticket.number}`}>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative grid max-h-[90svh] w-full max-w-[480px] gap-4 overflow-y-auto rounded-[16px] border border-line bg-bg p-5 shadow-2xl max-md:rounded-b-none max-md:pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="grid gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Move #{ticket.number}</p>
          <p className="line-clamp-2 text-sm text-muted">{ticket.title}</p>
        </div>

        <div className="grid gap-1.5">
          <p className="text-xs text-faint">
            Now in <span className="text-fg">{stageInfo(ticket.stage).label}</span>. Move it to:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[...BOARD_ORDER, "launched" as Stage]
              .filter((s) => s !== ticket.stage)
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => (setTo(s), setNote(""))}
                  className={`h-9 rounded-full border px-3 text-sm transition-colors max-md:h-11 ${to === s ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                >
                  {stageInfo(s).label}
                </button>
              ))}
          </div>
        </div>

        {to && !check && <p className="text-xs text-faint">Checking what {stageInfo(to).label} needs…</p>}
        {to && check && (
          <div className="grid gap-2.5">
            {check.blockers.map((b, i) => (
              <div key={i} className="grid gap-2 rounded-[10px] border border-bad/40 bg-bad-soft/40 px-3.5 py-3 text-sm">
                <p className="text-bad">{b.text}</p>
                {b.fix && onFix && (
                  <button type="button" onClick={() => onFix(b.fix!)} className="h-9 justify-self-start rounded-brand bg-fg px-3.5 text-sm font-medium text-bg max-md:h-11 max-md:w-full">
                    {b.fix === "upload" ? "Upload it now" : "Go to the copy"}
                  </button>
                )}
              </div>
            ))}
            {check.warnings.length > 0 && (
              <ul className="grid gap-1.5 rounded-[10px] border border-warn/40 bg-warn-soft/40 px-3.5 py-3 text-sm text-warn">
                {check.warnings.map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {!check.blockers.length && !check.warnings.length && <p className="text-sm text-ok">It has what {stageInfo(to).label} needs.</p>}
            {check.effects.length > 0 && (
              <ul className="grid gap-1 text-xs text-faint">
                {check.effects.map((e, i) => (
                  <li key={i}>· {e}</li>
                ))}
              </ul>
            )}
            {!check.blockers.length && (
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={check.backwards ? "Why it's going back (the person who picks it up sees this)" : needsNote ? "Why it's moving anyway" : "A note for the history (optional)"}
                className="w-full rounded-brand border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand-text/60"
              />
            )}
          </div>
        )}

        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center justify-end gap-2 max-md:flex-col-reverse max-md:items-stretch">
          <button type="button" onClick={onClose} className="h-10 rounded-brand px-4 text-sm text-muted hover:text-fg max-md:h-11">
            Cancel
          </button>
          <button type="button" disabled={!ready || busy} onClick={go} className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40 max-md:h-12">
            {busy ? "Moving…" : to ? `Move to ${stageInfo(to).label}` : "Pick where it goes"}
          </button>
        </div>
      </div>
    </div>
  );
}
