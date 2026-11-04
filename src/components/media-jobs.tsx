"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { markMediaSeen, myMedia } from "@/app/(team)/media-actions";
import type { MediaJob } from "@/lib/media-models";
import { toast } from "./toasts";

// Higgsfield images and videos being made in the background, shared by the whole app (like the brief jobs): the
// panel that started one shows its progress, a small "1 making" sits by the bell, and when it's ready a toast (and
// the bell) open it wherever you are. The list is read from the server, so a refresh picks up where it was.

let jobs: MediaJob[] = [];
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const EMPTY: MediaJob[] = [];

export const activeMedia = (j: MediaJob) => j.status === "queued" || j.status === "running";

/** A job just started on this page: shown at once, and checked again shortly */
export function trackMediaJob(job: MediaJob) {
  jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
  emit();
  schedule(3000);
}

export function useMediaJobs() {
  return useSyncExternalStore(subscribe, () => jobs, () => EMPTY);
}

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
  let next: MediaJob[] = jobs;
  try {
    next = await myMedia();
  } catch {
    /* offline: try again */
  }
  const done = next.filter((j) => !activeMedia(j) && !j.seen && !announced.has(j.id));
  for (const j of done) {
    announced.add(j.id);
    if (!loaded && j.finishedAt && Date.now() - Date.parse(j.finishedAt) > 10 * 60_000) continue;
    const where = j.client ? ` — ${j.client}` : "";
    if (j.status === "ready") {
      const href = j.files[0]?.url ?? null;
      toast({
        tone: "ok",
        title: `${j.kind === "video" ? "Your video is" : j.files.length > 1 ? "Your images are" : "Your image is"} ready${where}`,
        body: j.title ?? undefined,
        actions: href ? [{ label: "Open", primary: true, href }] : undefined,
        ms: 12_000,
      });
      window.dispatchEvent(new CustomEvent("media-job-done", { detail: j }));
    } else if (j.status === "failed") {
      toast({ tone: "bad", title: `Higgsfield couldn't make it${where}`, body: j.error ?? "Try again.", ms: 9000 });
      window.dispatchEvent(new CustomEvent("media-job-done", { detail: j }));
    }
  }
  if (done.length) void markMediaSeen(done.map((j) => j.id)).catch(() => null);
  loaded = true;
  jobs = next;
  emit();
  schedule(next.some(activeMedia) ? 5000 : 60_000);
}

/** Mount once (the team shell): keeps the list and tells people when their media is ready */
export function MediaJobsRoot() {
  useEffect(() => {
    running = true;
    schedule(1500);
    const onFocus = () => document.visibilityState === "visible" && schedule(0);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      running = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return null;
}

/** "1 making", by the bell */
export function MediaJobsIndicator({ compact = false }: { compact?: boolean }) {
  const making = useMediaJobs().filter(activeMedia);
  if (!making.length) return null;
  return (
    <span
      title={making.map((j) => `${j.client ? `${j.client}: ` : ""}${j.title ?? (j.kind === "video" ? "A video" : "An image")}`).join("\n")}
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 text-muted ${compact ? "h-7 px-2 text-[11px]" : "h-7 px-2.5 text-[11.5px]"} font-medium`}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fg/40" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-fg/70" />
      </span>
      {compact ? `${making.length}` : `${making.length} ${making.length === 1 ? (making[0].kind === "video" ? "video" : "image") : "pieces"} making`}
    </span>
  );
}

const left = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s < 10 ? s : Math.round(s / 5) * 5}s left`;
};

/** A progress bar for one job, against how long that model usually takes */
export function MediaProgress({ job }: { job: MediaJob }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const spent = Math.max(0, now - start);
  const over = spent >= job.expectedMs;
  const share = job.status === "queued" && spent < 8000 ? 0.04 : over ? 0.95 : Math.min(0.95, 0.05 + (spent / job.expectedMs) * 0.9);
  return (
    <div className="grid gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Making it">
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
        <div className={`h-full rounded-full bg-brand transition-[width] duration-1000 ease-out ${over ? "animate-pulse" : ""}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="flex items-baseline justify-between gap-2 text-[11.5px] text-muted">
        <span>{job.status === "queued" ? "In Higgsfield's queue…" : over ? "Finishing…" : `Making the ${job.kind}`}</span>
        <span className="tabular shrink-0">{over || job.status === "queued" ? "" : left(job.expectedMs - spent)}</span>
      </p>
    </div>
  );
}
