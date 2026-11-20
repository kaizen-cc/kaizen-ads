"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/components/toasts";
import { pushParams, closeParams, useParam } from "@/lib/url-state";
import { sourceLabel, type StyleSource } from "@/lib/reports/style-core";
import { forgetStyleRule, undoReportStyle } from "./style-actions";

// "Using this client's report style (updated Nov 20 by …)": what the team has taught Kaizen OS about this client's
// reports, right above the report. Open it (?style=1, so back closes it) to see every rule, where each came from, the
// last changes, and undo the newest one or forget a rule. The next report is drafted with whatever is shown here.

export type StyleView = {
  banner: string | null;
  version: number | null;
  rules: { text: string; by: string | null; source: StyleSource; at: string }[];
  history: { version: number; change: string; by: string | null; source: StyleSource; at: string; undone: boolean }[];
  line: "ads" | "email" | "social";
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const first = (n: string | null) => n?.trim().split(/\s+/)[0] ?? null;

function Spark() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4 shrink-0">
      <path fill="currentColor" d="M10 1.5l1.6 4.6a3 3 0 0 0 1.8 1.8L18 9.5l-4.6 1.6a3 3 0 0 0-1.8 1.8L10 17.5l-1.6-4.6a3 3 0 0 0-1.8-1.8L2 9.5l4.6-1.6a3 3 0 0 0 1.8-1.8z" />
    </svg>
  );
}

export function ReportStyle({ reportId, view }: { reportId: string; view: StyleView }) {
  const open = useParam("style") === "1";
  const router = useRouter();
  const [pending, start] = useTransition();
  const has = view.rules.length > 0;
  const run = (fn: () => Promise<{ ok: true; note: string } | { ok: false; error: string }>, title: string) =>
    start(async () => {
      const r = await fn();
      toast(r.ok ? { tone: "ok", title, body: r.note } : { tone: "bad", title: "Couldn't do that", body: r.error });
      router.refresh();
    });
  const lastLive = view.history.find((h) => !h.undone);

  return (
    <section className="overflow-hidden rounded-[20px] border border-line bg-surface">
      <button
        type="button"
        onClick={() => (open ? closeParams("style") : pushParams({ style: "1" }))}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${has ? "bg-fg text-bg" : "bg-surface-2 text-faint"}`}>
          <Spark />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium">{has ? view.banner : "This client's report style"}</span>
          <span className="truncate text-xs text-muted">
            {has ? `${view.rules.length} ${view.rules.length === 1 ? "preference" : "preferences"} · every report for this client is drafted with them` : "Nothing learned yet. Lasting changes you make here (asks, edits, metrics) are remembered for the next report."}
          </span>
        </span>
        <svg viewBox="0 0 20 20" aria-hidden className={`h-4 w-4 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M5 8l5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="grid gap-4 border-t border-line px-4 pb-4 pt-3 animate-[sheet-fade_.2s_ease-out]">
          {has ? (
            <ul className="grid gap-1.5">
              {view.rules
                .slice()
                .reverse()
                .map((r) => (
                  <li key={r.text} className="group flex items-start gap-3 rounded-[14px] bg-surface-2/60 px-3 py-2.5">
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-[15px] leading-snug [overflow-wrap:anywhere]">{r.text}</span>
                      <span className="text-xs text-faint">
                        {[first(r.by), sourceLabel(r.source), day(r.at)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => forgetStyleRule(reportId, r.text), "Forgotten")}
                      aria-label={`Forget: ${r.text}`}
                      className="-mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:bg-surface hover:text-fg disabled:opacity-40 md:h-8 md:w-8"
                    >
                      <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4">
                        <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M5 5l10 10M15 5L5 15" />
                      </svg>
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Ask the AI for a change that should stick (&ldquo;they always want the offers compared&rdquo;), edit the report, or pick its metrics. Lasting preferences show here, with who taught them, and the next report for this client starts from them.</p>
          )}
          {view.history.length > 0 && (
            <div className="grid gap-2">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-faint">Changes</p>
              <ol className="grid gap-1.5">
                {view.history.slice(0, 5).map((h) => (
                  <li key={h.version} className={`flex gap-3 text-sm ${h.undone ? "text-faint line-through" : "text-muted"}`}>
                    <span className="w-8 shrink-0 tabular-nums text-faint">v{h.version}</span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {h.change} <span className="text-faint">· {[first(h.by), sourceLabel(h.source), day(h.at)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {lastLive && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-faint">Undo steps back one version. Nothing is deleted.</p>
              <button type="button" disabled={pending} onClick={() => run(() => undoReportStyle(reportId), "Style change undone")} className="h-11 rounded-full border border-line px-4 text-sm hover:border-faint disabled:opacity-40">
                {pending ? "Working…" : `Undo v${lastLive.version}`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
