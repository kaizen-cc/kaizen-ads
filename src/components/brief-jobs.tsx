"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { markJobsSeen, myJobs, retryBriefJob } from "@/app/(team)/brief-job-actions";
import type { BriefJob } from "@/lib/brief-jobs";
import { jobKeyOf, type BriefSource } from "@/lib/quick-brief";
import { useParam } from "@/lib/url-state";
import { toast } from "./toasts";

// Briefs being written in the background, shared by the whole app. Every "Write the full brief" starts one (the quick
// preview closes at once, nothing is lost by leaving): the card it was started from shows its progress and then
// "Brief ready · Open" (useBriefJobFor + BriefJobSlot, the same everywhere), a small "1 brief writing" sits by the
// bell, and when one is ready a toast (and the bell) open it as a draft in Ready to send, wherever you are. The list is
// read from the server, so a refresh or another page picks up where it was.

/** Where a finished brief opens: the request form's Ready to send, with the brief as the team will receive it */
export const readyHref = (suggestionId: string) => `/requests/new?draft=${suggestionId}`;

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

const active = (j: BriefJob) => j.status === "queued" || j.status === "writing";

// "Brief ready" on a card until it's opened or put away (this browser only: a convenience, not a record)
const HIDDEN_KEY = "kz:brief-jobs:hidden";
let hidden: ReadonlySet<string> | null = null;
const NONE: ReadonlySet<string> = new Set();
const readHidden = () => {
  if (hidden) return hidden;
  try {
    hidden = new Set((JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]).slice(-60));
  } catch {
    hidden = new Set();
  }
  return hidden;
};
/** Put a finished brief's "Brief ready" away: the card offers a brief again */
export function hideReady(...ids: string[]) {
  const was = readHidden();
  if (ids.every((id) => was.has(id))) return;
  hidden = new Set([...was, ...ids]);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden].slice(-60)));
  } catch {}
  emit();
}
const useHidden = () => useSyncExternalStore(subscribe, readHidden, () => NONE);

export type BriefJobState = { status: "writing"; job: BriefJob } | { status: "ready"; job: BriefJob & { suggestionId: string } } | { status: "failed"; job: BriefJob } | null;

/**
 * The background brief this person started from this source (its own key; a split's briefs too): writing, with its
 * progress, or ready to open. clientId null: for any client (a library card, where the client is picked after).
 */
export function useBriefJobFor(source: BriefSource | null | undefined, clientId: string | null = null): BriefJobState {
  const all = useBriefJobs();
  const gone = useHidden();
  if (!source) return null;
  const key = jobKeyOf(source);
  const mine = all.filter((j) => j.kind === source.kind && (j.key === key || j.key?.startsWith(`${key}#`)) && (!clientId || !j.clientId || j.clientId === clientId));
  const writing = mine.find(active);
  if (writing) return { status: "writing", job: writing };
  // The newest finished one, unless it failed (the toast said so) or was opened already
  const last = mine.find((j) => !active(j));
  if (last?.status === "ready" && last.suggestionId && !gone.has(last.id)) return { status: "ready", job: { ...last, suggestionId: last.suggestionId } };
  // Couldn't be written (in the last half hour): said where it was asked for, with Retry, until it's put away
  // (older failures are left out of the list when it's read: see poll)
  if (last?.status === "failed" && !gone.has(last.id)) return { status: "failed", job: last };
  return null;
}

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
      // On the request form itself: offered, never opened for them (what they're doing there stays as it is)
      const here = window.location.pathname === "/requests/new";
      toast({
        tone: "ok",
        title: `Your brief is ready${j.client ? `: ${j.client}` : ""}`,
        body: here ? `${j.title ? `${j.title}. ` : ""}Open it in Ready to send; what you have here is kept.` : (j.title ?? undefined),
        actions: [{ label: here ? "Open" : "Open in Ready to send", primary: true, href: readyHref(sid) }],
        ms: here ? 20_000 : 12_000,
      });
    } else if (j.status === "failed") {
      toast({ tone: "bad", title: `The brief couldn't be written${j.client ? `: ${j.client}` : ""}`, body: j.error ?? "Try again.", ms: 9000 });
    }
  }
  if (done.length) void markJobsSeen(done.map((j) => j.id)).catch(() => null);
  loaded = true;
  // A failure is offered again (Retry) for half an hour where it was asked for; after that it's left out
  const now = Date.now();
  jobs = next.filter((j) => j.status !== "failed" || now - Date.parse(j.finishedAt ?? j.createdAt) < 30 * 60_000);
  emit();
  schedule(jobs.some(active) ? 2500 : 60_000);
}

function BriefJobsHost() {
  const router = useRouter();
  const ready = useParam("ready");
  const draft = useParam("draft");
  const all = useBriefJobs();

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

  // ?ready=<brief> (an older notice or a shared link): the finished brief opens in Ready to send, like the toast's
  useEffect(() => {
    if (ready && /^[0-9a-f-]{36}$/i.test(ready)) router.replace(readyHref(ready));
  }, [ready, router]);

  // Opened (from the toast, the bell or its card): its card stops saying "Brief ready"
  useEffect(() => {
    if (!draft) return;
    const opened = all.filter((j) => j.suggestionId === draft).map((j) => j.id);
    if (opened.length) hideReady(...opened);
  }, [draft, all]);

  return null;
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

/** "about 2 min" for how long a brief usually takes */
export const aboutLabel = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `about ${Math.max(10, Math.round(s / 10) * 10)}s` : `about ${Math.round(s / 60)} min`;
};

const secs = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s < 10 ? s : Math.round(s / 5) * 5}s left`;
};

/**
 * A real progress bar for one job: against how long this kind of brief usually takes, with what's left
 * ("Writing the brief · 42% · about 1 min left"). compact: no line about leaving the page (a small card). Spans only,
 * so it can sit anywhere a button could (a line of text too).
 */
export function BriefProgress({ job, compact = false, client = false, tone = "plain" }: { job: BriefJob; compact?: boolean; /** Say which client (a card any client can be briefed from) */ client?: boolean; tone?: Tone }) {
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
  const pct = Math.round(share * 100);
  const left = job.status === "queued" ? "starting" : over ? "finishing" : secs(job.expectedMs - spent);
  const dark = tone === "dark";
  return (
    <span className="grid min-w-0 gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Writing the brief">
      <span className="flex min-w-0 items-baseline gap-1.5 text-[12.5px]">
        <span className="relative mr-0.5 flex h-2 w-2 shrink-0 self-center" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
        </span>
        <span className={`truncate font-medium ${dark ? "text-white" : "text-fg"}`}>Writing the brief{client && job.client ? ` for ${job.client}` : ""}</span>
        <span className={`tabular shrink-0 ${dark ? "text-white/60" : "text-muted"}`}>· {pct}%</span>
        <span className={`tabular min-w-0 truncate ${dark ? "text-white/60" : "text-muted"}`}>· {left}</span>
      </span>
      <span className={`block h-1.5 overflow-hidden rounded-full ${dark ? "bg-white/15" : "bg-ink/[0.08]"}`}>
        <span className={`block h-full rounded-full bg-brand transition-[width] duration-500 ease-out ${over ? "animate-pulse" : ""}`} style={{ width: `${share * 100}%` }} />
      </span>
      {!compact && (
        <span className={`block text-[11.5px] ${dark ? "text-white/55" : "text-muted"}`}>
          You&apos;ll get a notice when it&apos;s ready ({aboutLabel(job.expectedMs)}) · Keep working
        </span>
      )}
    </span>
  );
}

/** A finished brief on the card it was started from: open it in Ready to send, or put the notice away */
export function BriefReady({ job, client = false }: { job: BriefJob & { suggestionId: string }; client?: boolean }) {
  return (
    <span className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-full border border-ok/35 bg-ok-soft py-1 pl-3.5 pr-1 animate-[step-in_.3s_cubic-bezier(.2,.8,.2,1)]" role="status">
      <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok text-[11px] text-white">
        ✓
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ok" title={job.title ?? undefined}>
        Brief ready{client && job.client ? ` for ${job.client}` : ""}
      </span>
      <Link href={readyHref(job.suggestionId)} onClick={() => hideReady(job.id)} className="grid h-10 shrink-0 place-items-center rounded-full bg-ok px-4 text-[13px] font-medium text-white transition hover:opacity-90 md:h-9">
        Open
      </Link>
      <button type="button" onClick={() => hideReady(job.id)} aria-label="Put away: brief it again" title="Put away" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[13px] text-ok/80 hover:bg-ok/10 hover:text-ok md:h-9 md:w-9">
        ✕
      </button>
    </span>
  );
}

type Tone = "plain" | "dark";

type SlotProps = {
  source: BriefSource | null | undefined;
  /** The client it's for; null: any (a card any client can be briefed from) */
  clientId?: string | null;
  /** No line about leaving the page */
  compact?: boolean;
  /** Say which client */
  client?: boolean;
  /** The box the progress or "Brief ready" sits in */
  className?: string;
  /** Over a dark surface whatever the theme (the daily story) */
  tone?: Tone;
};
const SLOT = "grid w-full min-w-0 sm:min-w-[220px]";

/** A brief that couldn't be written, where it was asked for: why, and Retry (the same brief, from what was agreed) */
export function BriefFailed({ job, client = false }: { job: BriefJob; client?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setError(null);
    const r = await retryBriefJob(job.id).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if ("job" in r) {
      hideReady(job.id);
      trackJob(r.job);
    }
  };
  return (
    <span className="grid min-w-0 gap-1.5 rounded-[16px] border border-bad/35 bg-bad-soft px-3.5 py-2.5 animate-[step-in_.3s_cubic-bezier(.2,.8,.2,1)]" role="alert">
      <span className="text-[13px] font-medium text-bad">The brief couldn&apos;t be written{client && job.client ? ` for ${job.client}` : ""}</span>
      <span className="text-[12.5px] leading-relaxed text-bad/90">{error ?? job.error ?? "Try again."}</span>
      <span className="flex flex-wrap items-center gap-2 pt-0.5">
        <button type="button" disabled={busy} onClick={() => void retry()} className="min-h-11 rounded-full bg-bad px-4 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-60 md:min-h-9">
          {busy ? "Starting…" : "Retry"}
        </button>
        <button type="button" onClick={() => hideReady(job.id)} className="min-h-11 rounded-full px-3 text-[13px] text-bad/80 hover:bg-bad/10 md:min-h-9">
          Put away
        </button>
      </span>
    </span>
  );
}

/** Its job's progress, then "Brief ready · Open" (or why it couldn't be written, with Retry), or nothing */
export function BriefJobStatus({ source, clientId = null, compact = true, client = false, className = SLOT, tone = "plain" }: SlotProps) {
  const state = useBriefJobFor(source, clientId);
  if (!state) return null;
  return (
    <span className={className}>
      {state.status === "writing" ? <BriefProgress job={state.job} compact={compact} client={client} tone={tone} /> : state.status === "failed" ? <BriefFailed job={state.job} client={client} /> : <BriefReady job={state.job} client={client} />}
    </span>
  );
}

/**
 * The card's "Brief on this" (children) while nothing's being written from it; in its place, the job's progress and
 * then "Brief ready · Open". The same on every card that offers a brief.
 */
export function BriefJobSlot({ children, ...props }: SlotProps & { children: React.ReactNode }) {
  const state = useBriefJobFor(props.source, props.clientId ?? null);
  return state ? <BriefJobStatus {...props} /> : <>{children}</>;
}