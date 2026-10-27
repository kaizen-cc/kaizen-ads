"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeGenerated } from "./actions";

// Takes a report off "Reports generated", after a second tap. One that never went out is deleted; one that was sent
// is only hidden here and stays in the client's history.

export function RemoveGenerated({ kind, id, sent }: { kind: "bundle" | "report"; id: string; sent: boolean }) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (ask)
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] text-faint max-md:hidden">{sent ? "Hide it? (kept in the client's history)" : "Delete it for good?"}</span>
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
          className="h-8 rounded-full bg-bad px-3 text-xs font-medium text-white disabled:opacity-50 max-md:h-11"
        >
          {pending ? "…" : sent ? "Hide" : "Delete"}
        </button>
        <button type="button" onClick={() => setAsk(false)} className="h-8 rounded-full px-2.5 text-xs text-muted hover:text-fg max-md:h-11">
          Cancel
        </button>
        {error && <span className="text-[11px] text-bad">{error}</span>}
      </span>
    );
  return (
    <button type="button" onClick={() => setAsk(true)} aria-label={sent ? "Hide this report" : "Delete this report"} title={sent ? "Hide from this list" : "Delete"} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-bad-soft hover:text-bad max-md:h-11 max-md:w-11">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      </svg>
    </button>
  );
}
