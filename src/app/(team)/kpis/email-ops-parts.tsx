"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import type { EmailAction } from "@/lib/email-ops/audit-core";
import { OWNER_LABEL } from "@/lib/email-ops/audit-core";
import { checkEmailSprintNow, closeEmailSprint, setEmailActionStatus, startEmailSprint, tickEmailAuditAction } from "./email-ops-actions";

// The buttons and cards behind the email audit page, the sprint page and the client page's Audit and ideas tab.

/** Starts an audit of the client's Klaviyo account and opens it (it fills in while it runs) */
export function RunEmailAudit({ clientId, label = "Run an audit", quiet = false }: { clientId: string; label?: string; quiet?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {error && <span className="text-[11.5px] text-bad">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await fetch("/api/email-ops/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
            const out = (await res.json().catch(() => ({ error: "Couldn't start the audit." }))) as { id?: string; error?: string };
            if (!out.id) return setError(out.error ?? "Couldn't start the audit.");
            router.push(`/kpis/email-audit/${out.id}`);
          })
        }
        className={`min-h-11 rounded-full px-4 text-[13px] font-medium transition-colors disabled:opacity-60 md:min-h-9 ${quiet ? "border border-line text-muted hover:text-fg" : "bg-fg text-bg"}`}
      >
        {pending ? "Starting…" : label}
      </button>
    </span>
  );
}

/** Refreshes the page every few seconds while an audit is running, so it opens itself when it is done */
export function WatchAudit() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}

/** Follows the whole audit as a sprint (or opens the sprint that is already on) */
export function FollowAudit({ auditId, label = "Follow it as a sprint" }: { auditId: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {error && <span className="text-[11.5px] text-bad">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await startEmailSprint(auditId);
            if (!r.ok) return setError(r.error);
            router.push(`/kpis/email-sprint/${r.sprintId}`);
          })
        }
        className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9"
      >
        {pending ? "Opening…" : label}
      </button>
    </span>
  );
}

/** One action in the audit's plan: tick it off when it is done (everyone sees who and when), or add just this one to the sprint */
export function EmailActionCard({ auditId, index, action, areaLabel, done, listed }: { auditId: string; index: number; action: EmailAction; areaLabel: string; done: { by: string; at: string } | null; listed: string | null }) {
  const router = useRouter();
  const [adding, startAdd] = useTransition();
  const [, start] = useTransition();
  const [checked, setChecked] = useOptimistic(Boolean(done));
  const [open, setOpen] = useState(false);
  const toggle = () =>
    start(async () => {
      setChecked(!checked);
      await tickEmailAuditAction(auditId, index, !checked);
      router.refresh();
    });
  return (
    <article className={`grid min-w-0 content-start gap-3 rounded-[16px] border p-4 transition-colors md:p-5 ${checked ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface"}`}>
      <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? "Mark as not done" : "Mark as done"}
          onClick={toggle}
          className={`relative mt-0.5 grid h-[22px] w-[22px] place-items-center rounded-full border transition-colors max-md:after:absolute max-md:after:-inset-3 ${checked ? "border-ok bg-ok text-bg" : "border-faint hover:border-fg"}`}
        >
          {checked && (
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          )}
        </button>
        <div className="grid min-w-0 gap-2">
          <p className={`font-heading leading-snug ${checked ? "text-muted line-through decoration-faint" : ""}`}>{action.title}</p>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full bg-bg px-2 py-0.5 text-fg">{OWNER_LABEL[action.owner] ?? action.owner}</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-muted">{areaLabel}</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-muted">{action.effort} effort</span>
          </div>
          <p className="text-[13px] leading-relaxed text-ok">{action.impact}</p>
          {(open || !checked) && (
            <ol className="grid gap-1.5 text-[13px] leading-relaxed">
              {action.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                  <span className="text-[11px] tabular text-faint">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
          {open && <p className="text-[12.5px] leading-relaxed text-muted">{action.why}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setOpen(!open)} className="-my-2 min-h-11 pr-3 text-[11.5px] text-faint hover:text-fg md:my-0 md:min-h-0 md:pr-0">
              {open ? "Hide the reasoning" : "The reasoning"}
            </button>
            {done && checked && (
              <span className="text-[11px] text-faint">
                Done by {done.by} · {new Date(done.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
            {listed === "replaced" ? (
              <span className="text-[11px] text-faint">Replaced by a newer audit</span>
            ) : listed ? (
              <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">On the action list{listed === "done" ? " · done" : listed === "doing" ? " · in progress" : ""}</span>
            ) : (
              <button
                type="button"
                disabled={adding}
                onClick={() =>
                  startAdd(async () => {
                    await startEmailSprint(auditId, index);
                    router.refresh();
                  })
                }
                className="min-h-11 rounded-full border border-line px-3 text-[11.5px] text-muted hover:text-fg disabled:opacity-60 md:min-h-8 md:px-2.5"
              >
                {adding ? "Adding…" : "+ Add to my action list"}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

const STATUS: { value: "todo" | "doing" | "done" | "skipped"; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "Doing" },
  { value: "done", label: "Done" },
  { value: "skipped", label: "Skip" },
];

/** One sprint move: set where it stands (saved on change) and leave a note the next check reads */
export function SprintMove({ id, title, owner, steps, why, impact, status, note, aiNote }: { id: string; title: string; owner: string | null; steps: string[]; why: string | null; impact: string | null; status: "todo" | "doing" | "done" | "skipped"; note: string | null; aiNote: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(status);
  const [text, setText] = useState(note ?? "");
  const [open, setOpen] = useState(status === "todo" || status === "doing");
  const save = (s: typeof status, n?: string) =>
    start(async () => {
      setCurrent(s);
      await setEmailActionStatus(id, s, n);
      router.refresh();
    });
  const finished = current === "done" || current === "skipped";
  return (
    <article className={`grid min-w-0 gap-3 rounded-[16px] border p-4 md:p-5 ${current === "done" ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface"} ${pending ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className={`font-heading leading-snug ${finished ? "text-muted line-through decoration-faint" : ""}`}>{title}</p>
          {owner && <p className="text-[11.5px] text-faint">{OWNER_LABEL[owner as keyof typeof OWNER_LABEL] ?? owner}</p>}
        </div>
        <div role="radiogroup" aria-label="Where this move stands" className="flex overflow-hidden rounded-full border border-line text-[12px]">
          {STATUS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={current === o.value} onClick={() => save(o.value)} className={`min-h-11 px-3 md:min-h-8 ${current === o.value ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {impact && <p className="text-[13px] leading-relaxed text-ok">{impact}</p>}
      {open && (
        <>
          {steps.length > 0 && (
            <ol className="grid gap-1.5 text-[13px] leading-relaxed">
              {steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                  <span className="text-[11px] tabular text-faint">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
          {why && <p className="text-[12.5px] leading-relaxed text-muted">{why}</p>}
        </>
      )}
      {aiNote && <p className="rounded-[10px] bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-muted">{aiNote}</p>}
      <label className="grid gap-1 text-[11.5px] text-faint">
        Note for the next check
        <textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (note ?? "") && save(current, text)} rows={2} placeholder="What you did, or what is in the way" className="min-h-11 w-full resize-y rounded-[10px] border border-line bg-bg px-3 py-2 text-[13px] text-fg" />
      </label>
      <button type="button" onClick={() => setOpen(!open)} className="min-h-11 justify-self-start text-[11.5px] text-faint hover:text-fg md:min-h-0">
        {open ? "Hide the steps" : "Show the steps"}
      </button>
    </article>
  );
}

/** Look now instead of waiting for the next check, and close the sprint when it is over */
export function SprintControls({ sprintId, active }: { sprintId: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  if (!active) return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {note && <span className="text-[11.5px] text-muted">{note}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await checkEmailSprintNow(sprintId);
            setNote(r.ok ? "Measuring now. The check shows here in a minute." : r.error);
            setTimeout(() => router.refresh(), 6000);
          })
        }
        className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9"
      >
        Check the score now
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await closeEmailSprint(sprintId, "done", "Closed by the team");
            if (r.ok) router.refresh();
            else setNote(r.error);
          })
        }
        className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9"
      >
        Close as done
      </button>
    </span>
  );
}
