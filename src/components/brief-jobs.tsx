"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { markJobsSeen, myJobs, openBrief } from "@/app/(team)/brief-job-actions";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import type { BriefJob } from "@/lib/brief-jobs";
import type { OpenSuggestion } from "@/lib/suggestions";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import { toast } from "./toasts";

// Briefs being written in the background, shared by the whole app: the card that asked shows a progress bar, a small
// "1 brief writing" sits by the bell, and when one is ready a toast (and the bell) open it, wherever you are. The
// list is read from the server, so a refresh or another page picks up where it was.

let jobs: BriefJob[] = [];
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const EMPTY: BriefJob[] = [];

/** A job just started on this page: shown at once, and checked again shortly */
export function trackJob(job: BriefJob) {
  jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
  emit();
  schedule(2500);
}

export function useBriefJobs() {
  return useSyncExternalStore(subscribe, () => jobs, () => EMPTY);
}

/** The job writing a brief from this ad (the newest), if any */
export function useJobFor(kind: BriefJob["kind"], match: (j: BriefJob) => boolean) {
  const all = useBriefJobs();
  return all.find((j) => j.kind === kind && match(j)) ?? null;
}

const active = (j: BriefJob) => j.status === "queued" || j.status === "writing";

// Checks the server: every 2.5s while something's writing, otherwise every minute and when the tab comes back
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
const announced = new Set<string>();
function schedule(ms: number) {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void poll(), ms);
}
async function poll() {
  if (timer) clearTimeout(timer);
  let next: BriefJob[] = jobs;
  try {
    next = await myJobs();
  } catch {
    /* offline: try again */
  }
  // Finished and not yet shown: a toast, once (on the first look, only those finished in the last ten minutes)
  const done = next.filter((j) => !active(j) && !j.seen && !announced.has(j.id));
  for (const j of done) {
    announced.add(j.id);
    if (!loaded && j.finishedAt && Date.now() - Date.parse(j.finishedAt) > 10 * 60_000) continue;
    if (j.status === "ready" && j.suggestionId) {
      const sid = j.suggestionId;
      toast({
        tone: "ok",
        title: `Your brief is ready${j.client ? ` — ${j.client}` : ""}`,
        body: j.title ?? undefined,
        actions: [{ label: "Open", primary: true, run: () => pushParams({ ready: sid }) }],
        ms: 12_000,
      });
    } else if (j.status === "failed") {
      toast({ tone: "bad", title: `The brief couldn't be written${j.client ? ` — ${j.client}` : ""}`, body: j.error ?? "Try again.", ms: 9000 });
    }
  }
  if (done.length) void markJobsSeen(done.map((j) => j.id)).catch(() => null);
  loaded = true;
  jobs = next;
  emit();
  schedule(next.some(active) ? 2500 : 60_000);
}

function BriefJobsHost() {
  const router = useRouter();
  const ready = useParam("ready");
  const [sheet, setSheet] = useState<OpenSuggestion | null>(null);

  useEffect(() => {
    running = true;
    schedule(0);
    const onFocus = () => document.visibilityState === "visible" && schedule(0);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      running = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // ?ready=<brief>: the finished brief, open in its sheet (from the toast, the bell or a shared link)
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void openBrief(ready).then((s) => live && setSheet(s));
    return () => {
      live = false;
    };
  }, [ready]);

  return sheet && ready === sheet.id ? (
    <SuggestionSheet
      s={sheet}
      onClose={() =>
        closeThen(() => {
          setSheet(null);
          router.refresh();
        }, "ready")
      }
    />
  ) : null;
}

/** Mount once (the team shell): keeps the list and opens finished briefs */
export function BriefJobsRoot() {
  return (
    <Suspense fallback={null}>
      <BriefJobsHost />
    </Suspense>
  );
}

/** "1 brief writing", by the bell: hover or tap for which */
export function BriefJobsIndicator({ compact = false }: { compact?: boolean }) {
  const writing = useBriefJobs().filter(active);
  if (!writing.length) return null;
  return (
    <span
      title={writing.map((j) => `${j.client ? `${j.client}: ` : ""}${j.title ?? "A brief"}`).join("\n")}
      className={`inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 text-brand-text ${compact ? "h-7 px-2 text-[11px]" : "h-7 px-2.5 text-[11.5px]"} font-medium`}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
      </span>
      {compact ? writing.length : `${writing.length} brief${writing.length === 1 ? "" : "s"} writing`}
    </span>
  );
}

const secs = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s < 10 ? s : Math.round(s / 5) * 5}s left`;
};

/** A real progress bar for one job: against how long this kind of brief usually takes, with what's left */
export function BriefProgress({ job }: { job: BriefJob }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const spent = Math.max(0, now - start);
  const over = spent >= job.expectedMs;
  // Eases toward 95% so it never sits at the end while the last words are written
  const share = job.status === "queued" ? 0.03 : over ? 0.95 : Math.min(0.95, 0.04 + (spent / job.expectedMs) * 0.91);
  return (
    <div className="grid gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Writing the brief">
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
        <div className={`h-full rounded-full bg-brand transition-[width] duration-500 ease-out ${over ? "animate-pulse" : ""}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="flex items-baseline justify-between gap-2 text-[11.5px] text-muted">
        <span>{job.status === "queued" ? "Starting…" : over ? "Finishing…" : "The strategist is writing it"}</span>
        <span className="tabular shrink-0">{job.status === "queued" ? "" : over ? "" : secs(job.expectedMs - spent)}</span>
      </p>
      <p className="text-[11px] text-faint">You can leave this page: it keeps writing, and you&apos;ll be told when it&apos;s ready.</p>
    </div>
  );
}
