"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { closeParams, closeThen, pushParams, useParam } from "@/lib/url-state";
import { logLine, SKIP_REASONS, skipLine, type LogEntry, type SkipReason } from "@/lib/reports/skip-log";
import { toast } from "@/components/toasts";
import { skipReport, unskipReport } from "./actions";

// Skipping a report: not ready yet, or it went out the old way or their own way. It leaves the queue and waits for the
// next period's report; the reason is kept on the report. The sheet lives in the address (?skip=<report>), so back
// closes it and a pasted link opens it.

const PARAM = "skip";

function Sheet({ id, title, onDone }: { id: string; title: string; onDone: "list" | "refresh" }) {
  const router = useRouter();
  const [reason, setReason] = useState<SkipReason | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams(PARAM);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  if (typeof document === "undefined") return null;
  const go = () =>
    start(async () => {
      if (!reason) return;
      const r = await skipReport(id, reason, note);
      if (!r.ok) return setError(r.error);
      toast({ tone: "ok", title: "Skipped", body: "It waits for the next report. You can bring it back from the Skipped list." });
      closeThen(() => (onDone === "list" ? router.push("/reports") : router.refresh()), PARAM);
    });
  return createPortal(
    <div className="fixed inset-0 z-[80] grid items-end bg-black/60 backdrop-blur-sm md:place-items-center md:p-6 animate-[sheet-fade_.2s_ease-out]" role="dialog" aria-modal="true" aria-label="Skip this report" onMouseDown={(e) => e.target === e.currentTarget && closeParams(PARAM)}>
      <div className="grid max-h-[92vh] w-full gap-4 overflow-y-auto rounded-t-[24px] border border-line bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl md:max-w-md md:rounded-[24px] md:pb-5">
        <div className="grid gap-1">
          <h2 className="font-heading text-[20px] leading-tight">Skip this report?</h2>
          <p className="text-sm text-muted">
            {title}. It leaves your list and waits for the next report. Nothing is deleted, and why you skipped it is kept on the report.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Why">
          {SKIP_REASONS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="radio"
              aria-checked={reason === x.key}
              onClick={() => setReason(x.key)}
              className={`inline-flex h-11 items-center rounded-full border px-4 text-sm transition-colors ${reason === x.key ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        <label className="grid gap-1.5 text-xs text-faint">
          Add a note (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 400))} rows={2} placeholder="Anything the team should know" className="w-full resize-none rounded-[14px] border border-line bg-transparent px-3.5 py-2.5 text-[15px] text-fg placeholder:text-faint focus:border-faint focus:outline-none" />
        </label>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => closeParams(PARAM)} className="h-11 rounded-full px-4 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            Cancel
          </button>
          <button type="button" disabled={!reason || pending} onClick={go} className="h-11 rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-40">
            {pending ? "Skipping…" : "Skip it"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * "Skip": a quiet icon on a card's corner, or a plain text link in the studio. Opens the reason sheet. For a report
 * built by hand, it skips every part that hasn't gone out.
 */
export function SkipButton({ id, title, variant, onDone = "refresh" }: { id: string; title: string; variant: "icon" | "link"; onDone?: "list" | "refresh" }) {
  const open = useParam(PARAM) === id;
  return (
    <>
      {variant === "icon" ? (
        <button type="button" onClick={() => pushParams({ [PARAM]: id })} aria-label="Skip this report" title="Skip this report (it waits for the next one)" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-faint transition-colors hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 5l9 7-9 7zM19 5v14" />
          </svg>
        </button>
      ) : (
        <button type="button" onClick={() => pushParams({ [PARAM]: id })} className="inline-flex min-h-11 items-center hover:text-fg md:min-h-0">
          Skip this report
        </button>
      )}
      {open && <Sheet id={id} title={title} onDone={onDone} />}
    </>
  );
}

/** Puts a skipped report back where it was (a draft again), logged. */
export function BringBack({ id, variant = "pill" }: { id: string; variant?: "pill" | "solid" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await unskipReport(id);
          if (!r.ok) return toast({ tone: "bad", title: "Couldn't bring it back", body: r.error });
          router.refresh();
        })
      }
      className={`inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm disabled:opacity-50 md:h-9 ${variant === "solid" ? "bg-fg font-medium text-bg" : "border border-line text-muted hover:border-faint hover:text-fg"}`}
    >
      {pending ? "Bringing it back…" : "Bring back"}
    </button>
  );
}

/** What happened to a report, newest last: skipped (and why), brought back. */
export function SkipHistory({ log }: { log: LogEntry[] }) {
  if (!log.length) return null;
  return (
    <details className="group text-xs text-faint">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 hover:text-fg md:min-h-0">
        <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
        History · {log.length}
      </summary>
      <ul className="mt-1.5 grid gap-1 border-l border-line pl-3">
        {[...log].reverse().map((e, i) => (
          <li key={`${e.at}-${i}`}>{logLine(e)}</li>
        ))}
      </ul>
    </details>
  );
}

/** The studio of a skipped report: who skipped it, when and why; bring it back while it still can be. */
export function SkippedBanner({ id, log, canBringBack }: { id: string; log: LogEntry[]; canBringBack: boolean }) {
  const last = [...log].reverse().find((e) => e.action === "skipped") ?? null;
  return (
    <div className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Skipped</p>
          <p className="text-sm text-fg">{last ? skipLine(last) : "Skipped. It waits for the next report."}</p>
          {last?.note && <p className="text-sm text-muted">&ldquo;{last.note}&rdquo;</p>}
        </div>
        {canBringBack ? <BringBack id={id} variant="solid" /> : <span className="text-xs text-faint">A newer report has taken its place</span>}
      </div>
      <SkipHistory log={log} />
    </div>
  );
}
