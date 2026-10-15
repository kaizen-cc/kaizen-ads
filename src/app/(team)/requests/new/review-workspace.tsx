"use client";

import Link from "next/link";
import { useState } from "react";
import type { Review, ReviewIssue } from "@/lib/ai";
import type { RefSummary, SimilarCard } from "./actions";
import type { Draft } from "./draft";
import { Spark } from "./parts";

export type IssueStatus = "open" | "fixed" | "dismissed";
export type Handled = {
  issues: IssueStatus[];
  similar: Record<number, "open" | "continued">;
  brief: "offer" | "used" | "kept" | "none";
  fixing: number[] | null; // every issue waiting for an AI fix (running or queued)
  running: number[] | null; // the ones being changed right now
  note: string | null; // what the AI couldn't do in text
  undo: { draft: Pick<Draft, "title" | "angle" | "audience" | "brief" | "refs" | "sizes" | "formats">; reopen: number[]; briefWas: "offer" | "used" | "kept" | "none" } | null;
};

export const startHandled = (review: Review, similar: SimilarCard[], brief: string): Handled => ({
  issues: review.issues.map(() => "open"),
  similar: Object.fromEntries(similar.map((s) => [s.number, "open"])),
  brief: review.strongerBrief && review.strongerBrief.trim() !== brief.trim() ? "offer" : "none",
  fixing: null,
  running: null,
  note: null,
  undo: null,
});

const FIELD_LABEL: Record<ReviewIssue["field"], string> = {
  formats: "Formats",
  sizes: "Sizes",
  title: "Title",
  angle: "Angle",
  audience: "Audience",
  brief: "Brief",
  references: "References",
};
// The AI can change any part of the request (text, references, sizes and format counts)
const FIXABLE: ReviewIssue["field"][] = ["title", "angle", "audience", "brief", "references", "sizes", "formats"];
const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }).format(new Date(iso));

/** One review finding: fix it with the AI, go edit it yourself, or dismiss it (dismissals are kept on the ticket). */
function IssueRow({
  x,
  status,
  fixing,
  queued,
  onFix,
  onEdit,
  onDismiss,
  onReopen,
}: {
  x: ReviewIssue;
  status: IssueStatus;
  fixing: boolean;
  queued: boolean;
  onFix: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  onReopen: () => void;
}) {
  const canFix = FIXABLE.includes(x.field);
  if (status !== "open")
    return (
      <li className="flex min-w-0 items-center gap-3 rounded-[10px] border border-line px-4 py-2.5 text-sm animate-[step-in_.2s_ease-out]">
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] ${status === "fixed" ? "bg-ok text-bg" : "bg-surface-2 text-faint"}`}>{status === "fixed" ? "✓" : "–"}</span>
        <span className="line-clamp-1 min-w-0 flex-1 break-words text-muted">{x.issue}</span>
        <span className={`shrink-0 text-xs ${status === "fixed" ? "text-ok" : "text-faint"}`}>{status === "fixed" ? "Fixed" : "Dismissed · noted on the ticket"}</span>
        <button type="button" onClick={onReopen} className="shrink-0 text-xs text-faint hover:text-fg">
          Undo
        </button>
      </li>
    );
  return (
    <li className={`relative grid gap-2 overflow-hidden rounded-[10px] bg-surface-2 px-4 py-3.5 ${fixing ? "ring-1 ring-brand-text/40" : queued ? "ring-1 ring-line" : ""}`}>
      {fixing && <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-brand/15 to-transparent animate-[ai-sweep_1.6s_ease-in-out_infinite]" />}
      <div className="relative flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-medium ${x.severity === "block" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{x.severity === "block" ? "Must fix" : "Heads up"}</span>
          <span className="text-faint">{FIELD_LABEL[x.field]}</span>
        </span>
        <span className="flex items-center gap-1">
          <button type="button" onClick={onEdit} className="rounded-full px-2.5 py-1 text-xs text-muted hover:bg-surface hover:text-fg">
            Edit myself
          </button>
          <button type="button" onClick={onDismiss} className="rounded-full px-2.5 py-1 text-xs text-muted hover:bg-surface hover:text-fg" title="Dismiss. It's noted on the ticket's history with your name.">
            Dismiss
          </button>
        </span>
      </div>
      <p className="relative text-sm">{x.issue}</p>
      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">{x.fix}</p>
        {canFix && (
          <button
            type="button"
            disabled={fixing || queued}
            onClick={onFix}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-fg px-3.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Spark size={11} className={fixing ? "animate-[ai-pulse_1.2s_ease-in-out_infinite]" : ""} /> {fixing ? "Changing…" : queued ? "Queued" : "Make this change"}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Everything the review found, and what to do about each: fix with the AI, dismiss (logged), take the fuller brief,
 * or look at a similar ticket before making a new one.
 */
/** Which reference links the AI actually opened, so nobody assumes it saw something it couldn't. */
function RefsRead({ refs }: { refs: RefSummary[] }) {
  if (!refs.length) return null;
  const read = refs.filter((r) => r.ok).length;
  return (
    <div className="grid gap-2 rounded-[12px] border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">
        <Spark size={10} className="mr-1.5 inline text-brand-text" />
        Read {read} of {refs.length} reference{refs.length === 1 ? "" : "s"}
      </p>
      <ul className="grid gap-1">
        {refs.map((r) => (
          <li key={r.url} className="flex min-w-0 items-start gap-2 text-xs">
            <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] ${r.ok ? "bg-ok text-bg" : "bg-warn-soft text-warn"}`}>{r.ok ? "✓" : "!"}</span>
            <span className="min-w-0 flex-1 break-words">
              <a href={r.url} target="_blank" rel="noreferrer" className={r.ok ? "text-fg hover:underline" : "text-muted hover:underline"}>
                {r.label}
              </a>
              {!r.ok && r.note && <span className="text-faint"> · {r.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewWorkspace({
  review,
  similar,
  refs = [],
  handled,
  brief,
  onFix,
  onEdit,
  onSetIssue,
  onBrief,
  onSimilar,
  onUndo,
}: {
  review: Review;
  similar: SimilarCard[];
  refs?: RefSummary[];
  handled: Handled;
  brief: string;
  onFix: (indexes: number[]) => void;
  onEdit: (field: ReviewIssue["field"]) => void;
  onSetIssue: (i: number, s: IssueStatus) => void;
  onBrief: (choice: "used" | "kept") => void;
  onSimilar: (n: number, s: "open" | "continued") => void;
  onUndo: () => void;
}) {
  const [showBrief, setShowBrief] = useState(false);
  const open = handled.issues.filter((s) => s === "open").length;
  const blockers = review.issues.filter((x, i) => x.severity === "block" && handled.issues[i] === "open").length;
  const nothing = review.issues.length === 0 && similar.length === 0 && handled.brief === "none";

  if (nothing)
    return (
      <div className="grid gap-3">
      <RefsRead refs={refs} />
      <div className="flex items-center gap-3 rounded-[10px] border border-ok/30 bg-ok-soft px-4 py-3.5 animate-[step-in_.25s_ease-out]">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ok text-xs text-bg">✓</span>
        <p className="text-sm">{review.summary || "Looks good. Sending it to the team."}</p>
      </div>
      </div>
    );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 animate-[step-in_.3s_ease-out]">
      <RefsRead refs={refs} />
      {/* Already asked for? */}
      {similar.length > 0 && (
        <div className="grid gap-3 rounded-[12px] border border-warn/35 bg-warn-soft/30 p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-warn text-xs font-semibold text-bg">!</span>
            <div>
              <p className="font-medium">{similar.length === 1 ? "There's already a request like this" : `${similar.length} requests already look like this`}</p>
              <p className="mt-0.5 text-sm text-muted">Check it before making another. If you need a variation or a fresh take, continue anyway.</p>
            </div>
          </div>
          <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
            {similar.map((t) => {
              const state = handled.similar[t.number] ?? "open";
              return (
                <li key={t.number} className={`grid gap-3 rounded-[10px] border border-line bg-surface p-4 transition-opacity ${state === "continued" ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="tabular text-faint">#{t.number}</span>
                        <span className="font-medium">{t.title}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${t.overlap === "same" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{t.overlap === "same" ? "Same request" : "Very close"}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        <span className="capitalize">{t.format}</span> · <span className="text-fg">{t.stageLabel}</span>
                        {t.assignee && ` · with ${t.assignee}`} · requested {fmt(t.createdAt)}
                      </p>
                    </div>
                    <Link href={`/board?t=${t.number}`} target="_blank" className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:border-faint hover:text-fg">
                      Open ticket ↗
                    </Link>
                  </div>
                  <p className="text-sm text-muted">{t.why}</p>
                  {t.brief && <p className="line-clamp-2 rounded-[8px] bg-surface-2 px-3 py-2 text-xs leading-relaxed text-faint">{t.brief}</p>}
                  <div className="flex items-center justify-end">
                    {state === "continued" ? (
                      <button type="button" onClick={() => onSimilar(t.number, "open")} className="text-xs text-faint hover:text-fg">
                        Continuing anyway · undo
                      </button>
                    ) : (
                      <button type="button" onClick={() => onSimilar(t.number, "continued")} className="h-8 rounded-full border border-line px-3.5 text-xs text-muted hover:border-faint hover:text-fg">
                        Continue anyway
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* A fuller brief */}
      {handled.brief !== "none" && (
        <div className={`grid gap-3 rounded-[12px] border p-5 ${handled.brief === "used" ? "border-ok/30 bg-ok-soft/30" : "border-brand-text/25 bg-surface"}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Spark size={14} className="mt-1 shrink-0 text-brand-text" />
              <div>
                <p className="font-medium">{handled.brief === "used" ? "Using the stronger brief" : "A stronger brief, filled in from what we know"}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {handled.brief === "used"
                    ? "Your brief was replaced. Undo to go back."
                    : "The review filled the gaps from the client's briefing, memory, performance and past requests."}
                </p>
              </div>
            </div>
            {handled.brief === "offer" ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => onBrief("kept")} className="h-9 rounded-full px-3 text-xs text-muted hover:text-fg">
                  Keep mine
                </button>
                <button type="button" onClick={() => onBrief("used")} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-xs font-medium text-white hover:bg-brand-hover">
                  <Spark size={11} /> Use this brief
                </button>
              </div>
            ) : handled.brief === "used" ? (
              <button type="button" onClick={onUndo} className="h-9 rounded-full px-3 text-xs text-muted hover:text-fg">
                Undo
              </button>
            ) : (
              <button type="button" onClick={() => onBrief("used")} className="h-9 rounded-full px-3 text-xs text-muted hover:text-fg">
                Use it after all
              </button>
            )}
          </div>
          {handled.brief === "offer" && (
            <>
              <p className={`whitespace-pre-wrap rounded-[10px] bg-surface-2 px-4 py-3 text-sm leading-relaxed ${showBrief ? "" : "line-clamp-6"}`}>{review.strongerBrief}</p>
              <button type="button" onClick={() => setShowBrief((v) => !v)} className="justify-self-start text-xs text-muted hover:text-fg">
                {showBrief ? "Show less" : "Read it all"}
              </button>
            </>
          )}
          {handled.brief === "used" && <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted">{brief}</p>}
        </div>
      )}

      {/* Findings */}
      {review.issues.length > 0 && (
        <div className="grid gap-4 rounded-[12px] border border-line bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Spark size={14} className="mt-1 shrink-0 text-brand-text" />
              <div>
                <p className="font-medium">
                  {open === 0 ? "All handled" : blockers ? `${blockers} to fix before this goes out` : `${open} worth a second look`}
                </p>
                <p className="mt-0.5 text-sm text-muted">{review.summary}</p>
              </div>
            </div>
            {open > 1 && (
              <button
                type="button"
                disabled={Boolean(handled.fixing)}
                onClick={() => onFix(review.issues.map((x, i) => (handled.issues[i] === "open" && FIXABLE.includes(x.field) ? i : -1)).filter((i) => i >= 0))}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-fg px-4 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-60"
              >
                <Spark size={11} /> {handled.fixing ? "Changing…" : "Fix them all"}
              </button>
            )}
          </div>
          {handled.note && <p className="rounded-[8px] border border-warn/30 bg-warn-soft/40 px-3 py-2 text-xs text-warn">{handled.note}</p>}
          <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
            {review.issues.map((x, i) => (
              <IssueRow
                key={i}
                x={x}
                status={handled.issues[i]}
                fixing={Boolean(handled.running?.includes(i))}
                queued={Boolean(handled.fixing?.includes(i) && !handled.running?.includes(i))}
                onFix={() => onFix([i])}
                onEdit={() => onEdit(x.field)}
                onDismiss={() => onSetIssue(i, "dismissed")}
                onReopen={() => onSetIssue(i, "open")}
              />
            ))}
          </ul>
          {handled.undo && (
            <button type="button" onClick={onUndo} className="justify-self-start text-xs text-faint hover:text-fg">
              Undo the AI&apos;s last change
            </button>
          )}
        </div>
      )}
    </div>
  );
}
