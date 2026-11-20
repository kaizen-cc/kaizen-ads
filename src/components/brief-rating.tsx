"use client";

import { useState, useTransition } from "react";
import { rateDraftedBrief, type BriefRating as Rating } from "@/app/(team)/brief-rating-actions";

// The creative leads' quick rating on an auto-drafted brief: good or needs work, plus one line why. It teaches the
// brief writer (a lesson, like every correction). Two taps for "good"; "needs work" asks for the line.

export function BriefRating({ id }: { id: string }) {
  const [pick, setPick] = useState<Rating | null>(null);
  const [why, setWhy] = useState("");
  const [saved, setSaved] = useState<Rating | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const save = (r: Rating) =>
    start(async () => {
      setError(null);
      const res = await rateDraftedBrief(id, r, why);
      if (!res.ok) return setError(res.error);
      setSaved(r);
    });
  if (saved)
    return (
      <p className="text-[12px] text-faint" onClick={(e) => e.stopPropagation()}>
        Rated {saved === "good" ? "good" : "needs work"}: the brief writer learns from it.{" "}
        <button type="button" onClick={() => setSaved(null)} className="underline underline-offset-2 hover:text-fg">
          Change
        </button>
      </p>
    );
  const pill = (on: boolean) => `min-h-11 rounded-full border px-3.5 text-[12.5px] sm:min-h-8 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`;
  return (
    <div className="grid gap-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] text-faint">Rate this draft</span>
        <button type="button" aria-pressed={pick === "good"} onClick={() => setPick("good")} className={pill(pick === "good")}>
          Good
        </button>
        <button type="button" aria-pressed={pick === "needs_work"} onClick={() => setPick("needs_work")} className={pill(pick === "needs_work")}>
          Needs work
        </button>
      </div>
      {pick && (
        <div className="flex flex-wrap gap-1.5">
          <input
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(pick)}
            maxLength={300}
            placeholder={pick === "good" ? "Why, in one line (optional)" : "What it needs, in one line"}
            className="h-11 min-w-0 flex-1 rounded-[12px] border border-line bg-transparent px-3 text-[16px] text-fg outline-none focus:border-faint sm:h-9 sm:text-[13px]"
          />
          <button type="button" disabled={busy || (pick === "needs_work" && !why.trim())} onClick={() => save(pick)} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:min-h-9">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}
