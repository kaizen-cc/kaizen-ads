"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { syncNow, syncOne, type SyncJob } from "./sync-actions";

export type RunState = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  by?: string | null;
  error?: string | null;
  summary?: string;
  durationMs?: number | null;
  unit?: string;
  total?: number;
  done?: number;
  failed?: number;
  current?: string | null;
  phase?: string | null;
} | null;
/** How far a running job is, worked out on the server from what the job reports. */
export type Progress = {
  pct: number;
  done?: number;
  total?: number;
  failed: number;
  unit: string;
  current: string | null;
  phase: string | null;
  estimated: boolean;
  elapsed: string;
  left: string;
  finishAt: string;
  pace: "faster" | "slower" | "usual" | null;
  usual: string | null;
  by: string | null;
} | null;

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** "Sync now" for a whole job. While it runs, the page refreshes itself until it's done. */
export function SyncNowButton({ job, run, progress }: { job: SyncJob; run: RunState; progress: Progress }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The page marks a run left "running" for 15+ minutes as timed out
  const running = Boolean(run?.running);

  const go = (e: React.MouseEvent) => {
    // Inside the card's <summary>: don't open or close it
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    start(async () => {
      const r = await syncNow(job);
      if ("error" in r) setError(r.error);
      router.refresh();
    });
  };

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-[11px] text-bad">{error}</span>}
      <button
        type="button"
        onClick={go}
        disabled={pending || running}
        className="flex h-7 items-center gap-1.5 rounded-full border border-line px-3 text-[11px] text-muted transition-colors hover:border-fg/30 hover:text-fg disabled:cursor-default disabled:hover:border-line"
      >
        {running || pending ? (
          <>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            {running && progress ? `${progress.pct}%${progress.total != null ? ` · ${progress.done}/${progress.total}` : ""}` : "Starting…"}
          </>
        ) : (
          "Sync now"
        )}
      </button>
    </span>
  );
}

/** The bar across a card while its job runs: done of total, what it's on, time left and when it should finish. Refreshes itself. */
export function ProgressBar({ progress }: { progress: Progress }) {
  const router = useRouter();
  const live = Boolean(progress);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [live, router]);
  if (!progress) return null;
  const p = progress;
  return (
    <span className="grid basis-full gap-2 pt-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="font-display text-2xl tabular tracking-tight">{p.pct}%</span>
          {p.total != null && (
            <span className="text-xs text-muted">
              <span className="tabular text-fg">{p.done}</span> of <span className="tabular">{p.total}</span> {p.unit} done
              {p.failed > 0 && <span className="text-bad"> · {p.failed} failed</span>}
            </span>
          )}
        </span>
        <span className="text-xs text-muted">
          {p.estimated ? "About " : ""}
          <span className="tabular text-fg">{p.left}</span> left · done around <span className="tabular text-fg">{p.finishAt}</span>
          {p.pace === "faster" && <span className="text-ok"> · faster than last time ({p.usual})</span>}
          {p.pace === "slower" && <span className="text-warn"> · slower than last time ({p.usual})</span>}
        </span>
      </span>
      <span className="block h-1.5 overflow-hidden rounded-full bg-line">
        <span className="relative block h-full rounded-full bg-ok transition-[width] duration-1000 ease-out" style={{ width: `${Math.max(2, p.pct)}%` }}>
          <span className="absolute inset-0 animate-pulse rounded-full bg-white/25" />
        </span>
      </span>
      <span className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[11px] text-faint">
        <span className="min-w-0 truncate">
          {p.phase ? `${p.phase}` : "Working"}
          {p.current ? <span className="text-muted"> · now: {p.current}</span> : null}
        </span>
        <span>
          Running {p.elapsed}
          {p.by ? `, started by ${p.by}` : ""} · keeps going on the server if you leave or refresh
        </span>
      </span>
    </span>
  );
}

/** The last hand-run of a job, under the card. */
export function LastRun({ run }: { run: RunState }) {
  if (!run?.startedAt) return null;
  if (run.running)
    return <p className="text-[11px] text-muted">Running now, started {ago(run.startedAt)}{run.by ? ` by ${run.by}` : ""}.</p>;
  return (
    <p className={`text-[11px] ${run.error ? "text-bad" : "text-muted"}`}>
      Last synced by hand {ago(run.finishedAt ?? run.startedAt)}
      {run.by ? ` by ${run.by}` : ""}: {run.error ? run.error : run.summary || "done"}
    </p>
  );
}

/** Retry one ad account or inbox, and wait for the answer. */
export function RetryOne({ source }: { source: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="flex items-center justify-end gap-2">
      {note && <span className={`truncate text-[11px] ${note.ok ? "text-ok" : "text-bad"}`} title={note.text}>{note.text}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await syncOne(source);
            setNote("error" in r ? { ok: false, text: r.error } : { ok: true, text: r.note });
            router.refresh();
          })
        }
        className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] text-muted hover:bg-line/50 hover:text-fg disabled:opacity-60"
      >
        {pending ? "Syncing…" : "Sync"}
      </button>
    </span>
  );
}
