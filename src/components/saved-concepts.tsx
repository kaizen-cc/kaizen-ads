"use client";

import { useEffect, useState } from "react";
import { RefThumb } from "@/components/ref-thumb";
import { savedFor } from "@/app/(team)/requests/new/saved-actions";
import { metaAdId, savedHref, SOURCE_LABEL, type SavedRef } from "@/lib/saved-references";

// "Here are the concepts you've saved": the ideas this person starred for a client, where the creative gets made (the
// request form's References, a ticket's brief). One tap adds one; adding is instant and undone if it fails.

export function SavedConcepts({
  clientId,
  initial,
  added = [],
  only,
  onAdd,
  hint = "Ideas you starred for this client anywhere in the app. Add one and it goes with the brief.",
}: {
  clientId: string;
  /** Already read (the start page has them); otherwise they're read here */
  initial?: SavedRef[] | null;
  /** Saved ids already added here */
  added?: string[];
  /** Which ones can be added here (a ticket takes links only) */
  only?: (r: SavedRef) => boolean;
  onAdd: (ref: SavedRef) => Promise<{ ok: true } | { ok: false; error: string }>;
  hint?: string;
}) {
  const [list, setList] = useState<SavedRef[] | null>(initial ?? null);
  const [on, setOn] = useState<Set<string>>(() => new Set(added));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    savedFor(clientId)
      .then((r) => live && setList(r))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [clientId, initial]);

  const shown = (list ?? []).filter((r) => !only || only(r));
  if (!shown.length) return null;

  const add = async (r: SavedRef) => {
    setError(null);
    setOn((s) => new Set(s).add(r.id));
    const res = await onAdd(r).catch(() => ({ ok: false as const, error: "Couldn't add it. Try again." }));
    if (!res.ok) {
      setError(res.error);
      setOn((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  return (
    <div className="grid min-w-0 gap-2.5 rounded-[14px] border border-line bg-surface p-3.5">
      <div className="grid gap-0.5">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <Star on />
          Here are the concepts you&rsquo;ve saved
          <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{shown.length}</span>
        </p>
        <p className="text-[12px] text-faint">{hint}</p>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      <ul className="-mx-3.5 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3.5 pb-1 [scrollbar-width:thin]">
        {shown.map((r) => {
          const done = on.has(r.id);
          const href = savedHref(r);
          return (
            <li key={r.id} className="grid w-[148px] shrink-0 snap-start content-start overflow-hidden rounded-[12px] border border-line bg-bg">
              <a href={href ?? undefined} target="_blank" rel="noreferrer" className="group relative block aspect-[4/5] overflow-hidden bg-surface-2" aria-label={`Open ${r.title ?? "the reference"}`}>
                <RefThumb src={r.thumbnail} adId={metaAdId(r)} video={typeof r.data.video === "string" ? r.data.video : null} format={r.format} />
                <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">{SOURCE_LABEL[r.source]}</span>
              </a>
              <div className="grid gap-1 p-2">
                <p className="line-clamp-2 text-[12px] font-medium leading-snug">{r.title ?? "Untitled"}</p>
                {r.subtitle && <p className="truncate text-[11px] text-faint">{r.subtitle}</p>}
                <button
                  type="button"
                  disabled={done}
                  onClick={() => void add(r)}
                  className={`mt-0.5 min-h-11 rounded-full text-[12px] font-medium transition-colors md:min-h-9 ${done ? "bg-ok-soft text-ok" : "bg-fg text-bg hover:opacity-90"}`}
                >
                  {done ? "Added" : "Add"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Star({ on, size = 14 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden className={on ? "text-warn" : ""}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
    </svg>
  );
}
