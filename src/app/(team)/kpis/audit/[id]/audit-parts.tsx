"use client";

import { inPlatform } from "@/lib/in-platform";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import type { AuditResult } from "@/lib/audit";
import { tickAuditAction } from "../../audit-actions";
import { requestAudit } from "@/components/audit-watcher";
import { addToActionList, startSprint } from "../../sprint-actions";
import { GoogleChange } from "../../google-change";

const OWNER: Record<string, string> = { media_buyer: "Media buyer", creative: "Creative team", client: "Client", strategist: "Strategist" };

/** One action in the plan: tick it off when it's done (everyone sees who did and when). */
export function ActionCard({ auditId, index, action, area, done, listed, writable = null }: { auditId: string; index: number; action: AuditResult["actions"][number]; area: string; done: { by: string; at: string } | null; listed: string | null; writable?: "google" | "meta" | null }) {
  const router = useRouter();
  const [adding, startAdd] = useTransition();
  const [, start] = useTransition();
  const [checked, setChecked] = useOptimistic(Boolean(done));
  const [open, setOpen] = useState(false);
  const toggle = () =>
    start(async () => {
      setChecked(!checked);
      await tickAuditAction(auditId, index, !checked);
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
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          )}
        </button>
        <div className="grid min-w-0 gap-2">
          <p className={`font-heading leading-snug ${checked ? "text-muted line-through decoration-faint" : ""}`}>{action.title}</p>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full bg-bg px-2 py-0.5 text-fg">{OWNER[action.owner] ?? action.owner}</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-muted">{area}</span>
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
          {open && <p className="text-[12px] leading-relaxed text-muted">{action.why}</p>}
          {writable && !checked && inPlatform(action, writable) && <GoogleChange platform={writable} from={{ source: "audit", auditId, index }} />}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setOpen(!open)} className="-my-2 py-2 pr-3 text-[11px] text-faint hover:text-fg md:my-0 md:py-0 md:pr-0">
              {open ? "Less" : "Why"}
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
                    await addToActionList(auditId, index);
                    router.refresh();
                  })
                }
                className="rounded-full border border-line px-3 py-2 text-[11px] text-muted hover:text-fg disabled:opacity-60 md:px-2.5 md:py-0.5"
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

export function RerunAudit({ targetId, quiet }: { targetId: string; quiet?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2 md:flex-nowrap">
      {note && <span className="text-[11px] text-muted">{note}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await requestAudit({ targetId });
            if (r.error) return setNote(r.error);
            setNote(r.status === "queued" ? "Queued until a slot frees up." : "Running. Follow it on the KPI board.");
            router.push("/kpis");
          })
        }
        className={`rounded-full px-3 py-2.5 text-xs disabled:opacity-60 md:py-1 ${quiet ? "border border-line text-muted hover:text-fg" : "bg-fg px-4 py-3 text-sm text-bg md:py-2"}`}
      >
        Run a new audit
      </button>
    </span>
  );
}

/** For an audit with no sprint running: follow it with the buyer. */
export function StartSprint({ auditId }: { auditId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2 md:flex-nowrap">
      {error && <span className="text-[11px] text-bad">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await startSprint(auditId);
            if (!r.ok) return setError(r.error);
            router.push(`/kpis/sprint/${r.sprintId}`);
          })
        }
        className="rounded-full bg-fg px-3 py-2.5 text-xs text-bg disabled:opacity-60 md:py-1"
      >
        {pending ? "Starting…" : "Start the sprint"}
      </button>
    </span>
  );
}
