"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeGenerated } from "./actions";

// Takes a report off "Ready to send", after a second tap. Nothing is deleted: one that never went out is set aside,
// one that was sent only leaves this list. Every report stays in the client's history.

export function RemoveGenerated({ kind, id, sent }: { kind: "bundle" | "report"; id: string; sent: boolean }) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (ask)
    return (
      <span role="dialog" aria-label={sent ? "Hide this report" : "Remove this report"} className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3.5 pr-1 shadow-[0_12px_32px_-14px_rgba(0,0,0,0.8)]">
        <span className="whitespace-nowrap text-[12px] text-muted">{sent ? "Hide it?" : "Take it off the list?"}</span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await removeGenerated(kind, id);
              if (!r.ok) return setError(r.error);
              router.refresh();
            })
          }
          className="h-8 rounded-full bg-bad px-3.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 max-md:h-10"
        >
          {pending ? "…" : sent ? "Hide" : "Remove"}
        </button>
        <button type="button" onClick={() => setAsk(false)} className="h-8 rounded-full px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg max-md:h-10">
          Cancel
        </button>
        {error && <span className="pr-2 text-[11px] text-bad">{error}</span>}
      </span>
    );
  return (
    <button type="button" onClick={() => setAsk(true)} aria-label={sent ? "Hide this report" : "Remove this report"} title={sent ? "Hide from this list" : "Take it off the list (it stays in the client's history)"} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-bad-soft hover:text-bad max-md:h-11 max-md:w-11">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      </svg>
    </button>
  );
}
