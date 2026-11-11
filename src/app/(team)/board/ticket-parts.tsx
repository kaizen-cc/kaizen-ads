"use client";

import { parseBrief, openingOf } from "@/lib/brief-spec";
import { FORMAT_LABEL } from "@/lib/stages";
import { ratioProgress } from "@/lib/ratio-progress";
import { reviewSummary } from "@/lib/necessary-notes";
import { pushParams } from "@/lib/url-state";
import type { CreativeNote } from "@/lib/ai";
import type { AiReviewState } from "./review-actions";
import type { DesignSummary } from "./deliverables";
import { openComment, Progress, ScanIcon, VERDICT } from "./ai-review";
import { versionsLabel } from "./ticket-essentials";
import { FormatIcon } from "./ticket-card";
import type { Ticket } from "./types";

// The quiet pieces of the ticket's main view: the brief summary every stage opens with, the sizes against what's
// uploaded, the creative as a row of thumbnails that open the viewer, the AI review in brief and what happened in
// production. Theme tokens only, so they read the same in light and dark.

export const label = "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint";
export const card = "grid min-w-0 gap-3 rounded-[16px] border border-line bg-surface p-5 max-md:p-4";

const fmtDue = (iso: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));

/** Sizes, read for people: "4:5 · 9:16" */
export const sizesLine = (t: Pick<Ticket, "sizes">) => t.sizes.map((s) => s.replace("x", ":")).join(" · ");

/** The brief at a glance: what to make, how many outputs, who it's for and when it's due, with the brief one tap away */
export function TicketSummary({ ticket, onBrief, briefLabel = "Open brief" }: { ticket: Ticket; onBrief: () => void; briefLabel?: string }) {
  const { overview, spec } = parseBrief(ticket.brief ?? "");
  const idea = openingOf(overview).idea || spec.keyMessage || ticket.title;
  const who = spec.who || ticket.audience || ticket.avatar || null;
  const outputs = [versionsLabel(ticket), FORMAT_LABEL[ticket.format] + (ticket.format === "carousel" && ticket.cards ? `, ${ticket.cards} slides` : ""), sizesLine(ticket)].filter(Boolean).join(" · ");
  const facts: [string, React.ReactNode][] = [
    ["Outputs", <span key="o" className="inline-flex items-start gap-1.5"><span className="mt-0.5 shrink-0 text-muted"><FormatIcon format={ticket.format} /></span>{outputs}</span>],
    ["For", who ?? <span className="text-faint">Not set in the brief</span>],
    ["Due", ticket.stageDueAt ? fmtDue(ticket.stageDueAt) : <span className="text-faint">No turnaround here</span>],
  ];
  return (
    <section className={card} aria-label="Summary">
      <div className="flex items-start justify-between gap-3">
        <p className={label}>The brief</p>
        <button type="button" onClick={onBrief} className="-mr-2 -mt-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-brand-text hover:bg-surface-2">
          <DocIcon className="h-3.5 w-3.5" />
          {briefLabel}
        </button>
      </div>
      <p className="font-heading text-[18px] leading-snug text-fg max-md:text-[17px]">{idea}</p>
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DocIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" />
      <path d="M9.25 1.75V4.75h3M6 8h4.5M6 10.75h4.5" />
    </svg>
  );
}

/** Sizes needed against uploaded, version by version: "V1 4:5 ✓ 9:16 missing" */
export function RatioBars({ ticket, designs }: { ticket: Ticket; designs: DesignSummary[] }) {
  const p = ratioProgress(ticket, designs);
  if (!p.total) return null;
  const pct = Math.round((p.done / p.total) * 100);
  return (
    <section className={card} aria-label="Sizes uploaded">
      <div className="flex items-baseline justify-between gap-3">
        <p className={label}>Sizes</p>
        <span className={`tabular text-xs ${p.done === p.total ? "text-ok" : "text-muted"}`}>
          {p.done} of {p.total} in
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${p.done === p.total ? "bg-ok" : "bg-brand"}`} style={{ width: `${pct}%` }} />
      </div>
      <ul className="grid gap-1.5">
        {p.rows.map((r) => (
          <li key={r.label} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="tabular w-8 shrink-0 font-medium">{r.label}</span>
            {r.items.map((i) => (
              <span key={i.label} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${i.ok ? "bg-ok/15 text-ok" : "bg-surface-2 text-muted"}`}>
                {i.label} {i.ok ? "✓" : "missing"}
              </span>
            ))}
            {r.variation && <span className="text-[11px] text-faint">variation</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The creative as thumbnails: a tap opens it in the viewer */
export function CreativeStrip({ designs, loaded, title = "Creative" }: { designs: DesignSummary[]; loaded: boolean; title?: string }) {
  return (
    <section className={card} aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <p className={label}>{title}</p>
        {designs.length > 0 && <span className="text-xs text-faint">{designs.length === 1 ? "1 version" : `${designs.length} versions`} · tap to view</span>}
      </div>
      {!loaded ? (
        <div className="flex gap-2.5">
          {[0, 1].map((i) => (
            <span key={i} className="aspect-[4/5] w-24 animate-pulse rounded-[10px] bg-surface-2" />
          ))}
        </div>
      ) : designs.length ? (
        <ul className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
          {designs.map((d) => (
            <li key={d.id} className="shrink-0">
              <button type="button" onClick={() => pushParams({ design: d.id, ver: null, pin: null })} className="group grid w-24 gap-1.5 text-left" aria-label={`View V${d.position}, ${d.name}`}>
                <span className="relative block aspect-[4/5] overflow-hidden rounded-[10px] border border-line bg-surface-2 transition-colors group-hover:border-faint">
                  {d.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.thumbUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">V{d.position}</span>
                  {d.video && <span className="absolute inset-0 grid place-items-center text-lg text-white drop-shadow">▶</span>}
                </span>
                <span className="truncate text-[11px] text-muted">{d.version > 1 ? `v${d.version} · ` : ""}{d.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">No creative uploaded.</p>
      )}
    </section>
  );
}

/** The AI review of the current files, in brief: running, or its verdict and the comments that matter */
export function AiSummary({ ticket, state, showForced = false }: { ticket: Ticket; state: AiReviewState | null; showForced?: boolean }) {
  const run = state?.latest ?? null;
  if (!state) return null;
  if (!run)
    return (
      <section className={card} aria-label="AI review">
        <p className={`${label} flex items-center gap-2`}>
          <ScanIcon className="h-3.5 w-3.5 text-[#6c7ee1]" /> AI review
        </p>
        <p className="text-sm text-muted">No AI review was run on this creative.</p>
      </section>
    );
  const notes = (run.notes?.notes ?? []) as CreativeNote[];
  const s = reviewSummary(notes);
  return (
    <section className={card} aria-label="AI review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`${label} flex items-center gap-2`}>
          <ScanIcon className="h-3.5 w-3.5 text-[#6c7ee1]" /> AI review
        </p>
        {run.status === "done" && run.notes && <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${VERDICT[run.notes.verdict].cls}`}>{VERDICT[run.notes.verdict].label}</span>}
      </div>
      {run.status === "running" ? (
        <Progress p={run.progress} />
      ) : run.status === "failed" ? (
        <p className="text-sm text-muted">{run.error ?? "The last review didn't finish."}</p>
      ) : (
        <>
          <p className="text-sm leading-relaxed">{s.fixes || s.watch ? `${s.fixes ? `${s.fixes} to fix` : ""}${s.fixes && s.watch ? ", " : ""}${s.watch ? `${s.watch} to check` : ""}.` : "Nothing to fix: the creative is clean against the brief, the specs and the client's rules."}</p>
          {s.top.length > 0 && (
            <ul className="grid gap-1.5">
              {s.top.map((n, i) => (
                <li key={i}>
                  <button
                    type="button"
                    disabled={!n.commentId}
                    onClick={() => openComment(ticket.id, n)}
                    className="flex w-full gap-2.5 rounded-[10px] bg-bg/60 px-3 py-2.5 text-left text-sm hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-bg/60"
                  >
                    <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${n.severity === "fix" ? "bg-bad" : "bg-warn"}`} />
                    <span className="min-w-0 flex-1 leading-relaxed">
                      <span className="mr-1.5 text-xs text-faint">{[n.design, n.area].filter(Boolean).join(" · ")}</span>
                      {n.note}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!run.current && <p className="text-xs text-warn">About an earlier version of the files.</p>}
        </>
      )}
      {showForced && state.forced && (
        <p className="rounded-[10px] border border-warn/30 bg-warn-soft/40 px-3 py-2 text-xs text-warn">
          {state.forced.skipped ? "Sent without an AI review" : `Sent with ${state.forced.fixes} AI fix${state.forced.fixes === 1 ? "" : "es"} still open`}
          {state.forced.note ? `: "${state.forced.note}"` : ""}
        </p>
      )}
    </section>
  );
}

/** What happened in production: versions uploaded, comments resolved, time it took */
export function Story({ designs, comments, minutes, rounds }: { designs: DesignSummary[]; comments: { open: number; resolved: number } | undefined; minutes: string | null; rounds: number }) {
  const versions = designs.reduce((n, d) => n + d.versions, 0);
  const facts: [string, string][] = [
    ["Versions uploaded", `${versions}${designs.length ? ` across ${designs.length} design${designs.length === 1 ? "" : "s"}` : ""}`],
    ["Comments resolved", comments ? `${comments.resolved}${comments.open ? `, ${comments.open} still open` : ""}` : "None"],
    ["In production", minutes ?? "Not known"],
  ];
  if (rounds) facts.push(["Sent back", `${rounds} time${rounds === 1 ? "" : "s"}`]);
  return (
    <section className={card} aria-label="What happened">
      <p className={label}>What happened</p>
      <dl className="grid grid-cols-2 gap-3 max-[380px]:grid-cols-1">
        {facts.map(([k, v]) => (
          <div key={k} className="grid gap-0.5 rounded-[12px] bg-bg/60 px-3.5 py-3">
            <dt className="text-[11px] text-faint">{k}</dt>
            <dd className="tabular text-sm font-medium text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
