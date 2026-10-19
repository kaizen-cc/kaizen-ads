"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkNow, closeSprint, setActionStatus, watchSprint } from "../../sprint-actions";

export type SprintAction = {
  id: string;
  title: string;
  area: string | null;
  owner: string | null;
  when: string | null;
  steps: string[];
  why: string | null;
  impact: string | null;
  status: "todo" | "doing" | "done" | "skipped";
  note: string | null;
  aiNote: string | null;
  doneAt: string | null;
  doneBy: string | null;
};

const OWNER: Record<string, string> = { media_buyer: "Media buyer", creative: "Creative team", client: "Client", strategist: "Strategist" };
const WHEN: Record<string, string> = { now: "Today", this_week: "This week", next: "Next" };

/** One move on the action list: tick it, mark it doing or skipped, and leave a note the next check reads. */
export function ActionRow({ a, readOnly }: { a: SprintAction; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(a.status !== "done" && a.status !== "skipped");
  const [note, setNote] = useState(a.note ?? "");
  const set = (status: SprintAction["status"], n?: string) =>
    start(async () => {
      await setActionStatus(a.id, status, n);
      router.refresh();
    });
  const done = a.status === "done";
  return (
    <article className={`grid gap-3 rounded-[16px] border p-4 transition-colors ${done ? "border-ok/30 bg-ok-soft/30" : a.status === "skipped" ? "border-line bg-surface opacity-60" : "border-line bg-surface"}`}>
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          disabled={readOnly || pending}
          onClick={() => set(done ? "todo" : "done")}
          className={`mt-0.5 grid h-6 w-6 place-items-center rounded-full border transition-colors ${done ? "border-ok bg-ok text-bg" : "border-faint hover:border-fg"}`}
          aria-label={done ? "Mark as not done" : "Mark as done"}
        >
          {done && (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          )}
        </button>
        <button type="button" onClick={() => setOpen(!open)} className="grid gap-1.5 text-left">
          <span className={`font-heading leading-snug ${done ? "text-muted line-through decoration-faint" : ""}`}>{a.title}</span>
          <span className="flex flex-wrap gap-1.5 text-[11px]">
            {a.when && <span className="rounded-full bg-bg px-2 py-0.5 text-muted">{WHEN[a.when] ?? a.when}</span>}
            {a.owner && <span className="rounded-full bg-bg px-2 py-0.5 text-muted">{OWNER[a.owner] ?? a.owner}</span>}
            {a.status === "doing" && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">In progress</span>}
            {a.status === "skipped" && <span className="rounded-full border border-line px-2 py-0.5 text-faint">Skipped</span>}
            {done && a.doneBy && <span className="text-faint">Done by {a.doneBy}</span>}
          </span>
        </button>
        {!readOnly && !done && (
          <select
            value={a.status}
            disabled={pending}
            onChange={(e) => set(e.target.value as SprintAction["status"])}
            className="h-8 rounded-full border border-line bg-bg px-2 text-xs text-muted"
            aria-label="Status"
          >
            <option value="todo">To do</option>
            <option value="doing">Doing</option>
            <option value="skipped">Skip</option>
          </select>
        )}
      </div>
      {a.aiNote && <p className="ml-9 rounded-[10px] bg-bg/60 px-3 py-2 text-xs leading-relaxed text-muted">Last check: {a.aiNote}</p>}
      {open && (
        <div className="ml-9 grid gap-3">
          {a.steps.length > 0 && (
            <ol className="grid gap-1.5 text-[13px] leading-relaxed">
              {a.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                  <span className="text-[11px] tabular text-faint">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
          {a.why && <p className="text-xs leading-relaxed text-muted">{a.why}</p>}
          {a.impact && <p className="text-xs text-ok">{a.impact}</p>}
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="A note for the next check (what you changed, or why not)"
                className="h-9 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-3 text-sm"
              />
              {note !== (a.note ?? "") && (
                <button type="button" disabled={pending} onClick={() => set(a.status, note)} className="h-9 rounded-full bg-fg px-4 text-xs text-bg">
                  Save note
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function CheckNow({ sprintId, next }: { sprintId: string; next: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {note && <span className="text-xs text-muted">{note}</span>}
      <button
        type="button"
        disabled={pending || Boolean(note)}
        title={`Next scheduled: ${new Date(next).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric" })}`}
        onClick={() =>
          start(async () => {
            const r = await checkNow(sprintId);
            setNote(r.ok ? "Checking the account, about a minute…" : r.error);
            if (r.ok) setTimeout(() => router.refresh(), 60_000);
          })
        }
        className="h-9 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-60"
      >
        Check the account now
      </button>
    </span>
  );
}

export function WatchToggle({ sprintId, watching }: { sprintId: string; watching: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await watchSprint(sprintId, !watching);
          router.refresh();
        })
      }
      className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg"
    >
      {watching ? "Watching ✓" : "Watch this"}
    </button>
  );
}

export function CloseSprint({ sprintId }: { sprintId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const close = (status: "done" | "closed") =>
    start(async () => {
      await closeSprint(sprintId, status, note);
      router.refresh();
    });
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="justify-self-start text-sm text-muted hover:text-fg">
        Close this sprint…
      </button>
    );
  return (
    <div className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it's closing (optional)" className="h-9 rounded-[10px] border border-line bg-bg px-3 text-sm" />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => close("done")} className="h-9 rounded-full bg-ok px-4 text-sm text-bg">
          It worked: close as done
        </button>
        <button type="button" disabled={pending} onClick={() => close("closed")} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg">
          Stop following it
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-9 px-3 text-sm text-faint hover:text-fg">
          Cancel
        </button>
      </div>
    </div>
  );
}
