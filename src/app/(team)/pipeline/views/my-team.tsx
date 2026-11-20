"use client";

import type { TeamMember } from "@/lib/my-team";
import { MakerTasks } from "./maker-tasks";
import { pushParams, useParam } from "@/lib/url-state";

// "My team" (the lead video editor, the lead graphic designer, the Head of Creative): one card per teammate with what's
// on them, overdue and briefs in progress at a glance; tap someone for their whole plate (?person=<id>, so back
// returns to the team). Each task opens where it lives.

const ROLE: Record<string, string> = { video_editor: "Video editor", graphic_designer: "Graphic designer", lead_video_editor: "Lead video editor", lead_graphic_designer: "Lead graphic designer" };

export function MyTeam({ team }: { team: TeamMember[] }) {
  const person = useParam("person");
  const open = team.find((m) => m.id === person) ?? null;
  if (!team.length) return <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">Nobody on your team yet.</p>;
  const overdue = team.reduce((n, m) => n + m.overdue, 0);
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">My team</h2>
        <span className="text-xs text-faint">
          {team.length} {team.length === 1 ? "person" : "people"}
          {overdue ? ` · ${overdue} overdue` : " · nothing overdue"}
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {team.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => pushParams({ person: open?.id === m.id ? null : m.id })}
              aria-pressed={open?.id === m.id}
              className={`grid w-full gap-2 rounded-[18px] border bg-surface p-4 text-left transition-colors hover:border-faint ${open?.id === m.id ? "border-ink/30" : "border-line"}`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-heading text-[16px] text-fg">{m.name}</span>
                <span className="shrink-0 text-[11px] text-faint">{ROLE[m.role] ?? m.role}</span>
              </span>
              <span className="flex flex-wrap gap-1.5 text-[12px]">
                <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{m.tasks.length} open</span>
                <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{m.onThem} on them now</span>
                {m.overdue > 0 && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-bad">{m.overdue} overdue</span>}
                {m.briefs.length > 0 && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{m.briefs.length} brief{m.briefs.length === 1 ? "" : "s"} in progress</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="grid gap-4 rounded-[22px] border border-line bg-deep p-4 md:p-5">
          <MakerTasks tasks={open.tasks} title={`${open.name.split(" ")[0]}'s tasks`} empty={`Nothing assigned to ${open.name.split(" ")[0]} right now.`} />
          {open.briefs.length > 0 && (
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Briefs in progress</p>
              <ul className="grid gap-1">
                {open.briefs.map((b) => (
                  <li key={b.id} className="flex min-h-11 items-center justify-between gap-3 rounded-[12px] bg-ink/[0.04] px-3 py-2 text-[13.5px]">
                    <span className="min-w-0 truncate text-fg">
                      {b.client ? `${b.client}: ` : ""}
                      {b.title}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-faint">{new Date(b.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
