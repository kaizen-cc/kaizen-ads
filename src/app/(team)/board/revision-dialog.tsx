"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";

export type RevisionTarget = "creative" | "copy" | "both";

/** The note that goes with the move: what's being revised, then the client's changes */
export function revisionNote(target: RevisionTarget, changes: string) {
  const what = target === "both" ? "the creative and the copy" : `the ${target}`;
  return `Client revision (${what}): ${changes.trim()}`.slice(0, 1000);
}

/**
 * "Send for revision": what's being revised (creative, copy or both) and what to change, then the ticket goes to the
 * client changes stage with that note.
 */
export function RevisionDialog({ busy, error, onSend, onClose }: { busy: boolean; error: string | null; onSend: (note: string) => void; onClose: () => void }) {
  const [target, setTarget] = useState<RevisionTarget | null>(null);
  const [changes, setChanges] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  const options: [RevisionTarget, string][] = [
    ["creative", "Creative"],
    ["copy", "Copy"],
    ["both", "Both"],
  ];
  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-end justify-center bg-black/60 backdrop-blur-[2px] md:items-center md:p-6 animate-[sheet-fade_.2s_ease-out]" role="dialog" aria-modal="true" aria-label="Send for revision" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid w-full max-w-[480px] gap-4 rounded-t-[22px] border border-line bg-bg p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl md:rounded-[22px] md:pb-6">
        <div className="grid gap-1">
          <p className="font-heading text-[20px]">Send for revision</p>
          <p className="text-sm text-muted">What does the client want changed?</p>
        </div>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="What's being revised">
          {options.map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={target === k}
              onClick={() => setTarget(k)}
              className={`min-h-12 rounded-[14px] border text-sm font-medium transition-colors ${target === k ? "border-brand bg-brand-soft text-fg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
            >
              {l}
            </button>
          ))}
        </div>
        <textarea
          data-chat
          value={changes}
          onChange={(e) => setChanges(e.target.value)}
          rows={4}
          placeholder="The changes, in the client's words: e.g. Swap the hero shot for the lifestyle one and drop the word cheap"
          aria-label="The changes"
          className="rounded-[14px] border border-line bg-surface px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-brand-text/60 max-md:text-base"
        />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex gap-2 max-md:flex-col-reverse">
          <button type="button" onClick={onClose} className="min-h-12 rounded-[14px] px-5 text-sm text-muted hover:text-fg md:min-h-11">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !target || changes.trim().length < 3}
            onClick={() => target && onSend(revisionNote(target, changes))}
            className="min-h-12 flex-1 rounded-[14px] bg-brand px-5 text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-40 md:min-h-11 md:text-sm"
          >
            {busy ? "Sending…" : "Send for revision"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
