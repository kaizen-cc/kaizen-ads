"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SearchView } from "@/lib/prospect-search";
import { STAGES, STAGE_LABEL, progressOf, type SearchStatus } from "@/lib/prospect-search-core";
import { closeParams } from "@/lib/url-state";
import { cancelSearchAction, reviewedSearchAction, searchStatusAction } from "./actions";
import { FitBadge } from "./sales-view";

// A prospect search running in the background: its stage, a percentage and the businesses found so far, read from
// its job row every couple of seconds (so a refresh, another page or a closed tab never loses it), with Cancel. Done:
// what it found, best fit first; opening it marks it reviewed (its Overview item clears).

export function SearchCard({ initial, focused }: { initial: SearchView; focused: boolean }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const live = s.status === "queued" || s.status === "running";
  const marked = useRef(false);

  useEffect(() => {
    if (!live) return;
    let on = true;
    const poll = setInterval(async () => {
      const r = await searchStatusAction(s.id);
      if (!on || !r.ok) return;
      setS(r.search);
      if (r.search.status !== "queued" && r.search.status !== "running") router.refresh();
    }, 2500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      on = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [live, s.id, router]);

  // Opened when it's done: reviewed (once)
  useEffect(() => {
    if (focused && s.status === "done" && !s.reviewedAt && !marked.current) {
      marked.current = true;
      void reviewedSearchAction(s.id);
    }
  }, [focused, s.status, s.reviewedAt, s.id]);

  const pct = Math.max(s.progress, progressOf({ status: s.status as SearchStatus, stage: s.stage, stageAt: s.stageAt, saved: s.progress }, now));
  const stageIndex = s.stage ? STAGES.indexOf(s.stage) : -1;

  return (
    <section className={`grid min-w-0 gap-3 rounded-[20px] border bg-surface p-4 md:p-5 ${focused ? "border-brand/50" : "border-line"}`} aria-live="polite">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Prospect search</p>
          <h2 className="break-words font-heading text-[18px] leading-snug">{s.profile}</h2>
        </div>
        {live ? (
          <button
            type="button"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              await cancelSearchAction(s.id);
            }}
            className="inline-flex h-11 items-center rounded-full border border-line px-4 text-[14px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60 md:h-9 md:text-[13px]"
          >
            {cancelling ? "Stopping…" : "Cancel"}
          </button>
        ) : focused ? (
          <button type="button" onClick={() => closeParams("search")} className="inline-flex h-11 items-center rounded-full px-4 text-[14px] text-muted hover:text-fg md:h-9 md:text-[13px]">
            Close
          </button>
        ) : null}
      </div>

      {live && (
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-2 text-[13px]">
            <span className="text-fg">{s.status === "queued" ? "Starting…" : `${STAGE_LABEL[s.stage ?? "searching"]}…`}</span>
            <span className="tabular-nums text-muted">{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </div>
          <ol className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            {STAGES.map((st, i) => (
              <li key={st} className={i < stageIndex ? "text-ok" : i === stageIndex ? "text-fg" : "text-faint"}>
                {i < stageIndex ? "✓ " : ""}
                {STAGE_LABEL[st]}
              </li>
            ))}
          </ol>
          <p className="text-[13.5px] text-muted">
            <span className="font-medium tabular-nums text-fg">{s.found}</span> {s.found === 1 ? "business" : "businesses"} found so far. It keeps going if you leave this page; you&apos;ll get a notification when it&apos;s done.
          </p>
        </div>
      )}

      {s.status === "done" && (
        <div className="grid gap-3">
          <p className="text-[13.5px] text-muted">
            {s.results.length ? `${s.results.length} found · ${s.added} new in the pipeline${s.results.length - s.added > 0 ? ` · ${s.results.length - s.added} already there` : ""}` : "Nothing matched. Try a wider area or fewer conditions."}
          </p>
          {s.results.length > 0 && (
            <ul className="grid min-w-0 gap-2">
              {s.results.map((r, i) => (
                <li key={`${r.website}-${i}`} className="grid min-w-0 gap-1 rounded-[14px] border border-line p-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    {r.id ? (
                      <Link href={`/sales/${r.id}`} className="inline-flex min-h-11 min-w-0 items-center break-words text-[15px] font-medium hover:underline md:min-h-0">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="break-words text-[15px] font-medium">{r.name}</span>
                    )}
                    <FitBadge fit={r.fit_score} />
                  </div>
                  <p className="break-words text-[12.5px] text-muted">{[r.location, r.industry, r.already ? "already in the pipeline" : null].filter(Boolean).join(" · ")}</p>
                  {r.fit_reason && <p className="break-words text-[13px] leading-relaxed">{r.fit_reason}</p>}
                  {r.website && (
                    <a href={r.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 w-fit items-center break-all text-[12.5px] text-brand-text hover:underline md:min-h-0">
                      {r.website.replace(/^https?:\/\//, "")} ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(s.status === "failed" || s.status === "cancelled") && <p className="text-[13.5px] text-muted">{s.status === "cancelled" ? "Stopped." : `It didn't finish: ${s.error ?? "unknown error"}.`} Start it again from Find prospects.</p>}
    </section>
  );
}
