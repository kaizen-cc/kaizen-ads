"use client";

import { dueLabel, type LiveTask } from "@/lib/asana-live-core";
import { openAsanaTask } from "./asana-task-sheet";

// "My tasks": the person's next open Asana tasks on their Overview, overdue first then by due date, each opening its
// full preview (?task=<gid>) where the due date, fields, subtasks and comments are changed straight in Asana.

export function MyAsanaTasks({ tasks, limit = 8 }: { tasks: LiveTask[]; limit?: number }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const late = tasks.filter((t) => t.due && t.due < today).length;
  return (
    <section id="my-tasks" className="grid scroll-mt-24 gap-3" aria-labelledby="my-tasks-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 id="my-tasks-title" className="font-heading text-xl">
          My tasks <span className="tabular text-[15px] text-faint">{tasks.length}</span>
        </h2>
        <span className="text-xs text-faint">{late ? <span className="text-bad">{late} overdue · </span> : null}from Asana, overdue first</span>
      </div>
      {tasks.length ? (
        <ul className="grid gap-px overflow-hidden rounded-[20px] border border-line bg-line">
          {tasks.slice(0, limit).map((t) => {
            const d = dueLabel(t.due, today);
            return (
              <li key={t.gid}>
                <button type="button" onClick={() => openAsanaTask(t.gid)} className="flex min-h-14 w-full flex-col gap-1 bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 md:px-5">
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{t.client ?? t.project ?? "No project"}</span>
                    <span className="line-clamp-2 text-[15px] leading-snug text-fg">{t.name}</span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-[12px]">
                    <span className={`font-medium ${d.late ? "text-bad" : d.text === "Today" ? "text-warn" : "text-muted"}`}>{d.text}</span>
                    {t.section && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{t.section}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">No open Asana tasks assigned to you.</p>
      )}
      {tasks.length > limit && <p className="px-1 text-xs text-faint">{tasks.length - limit} more in Asana. Ask your assistant &quot;what&apos;s next on my Asana?&quot;</p>}
    </section>
  );
}
