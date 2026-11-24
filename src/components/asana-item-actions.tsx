"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { asanaAssignees, asanaTask, commentAsanaTask, saveAsanaTask, subtaskAsanaTask } from "@/app/(team)/asana-task-actions";
import { quickDue, type TaskDetail } from "@/lib/asana-live-core";
import { describe } from "@/lib/asana-due";
import { deferClear } from "@/lib/undo";

// An Asana task on the Overview, the recap and its sheet (owner, Nov 24 2026: the generic Done / Later / Hand off didn't
// fit an Asana task). Its own context (project and section, the description, subtasks to tick, who assigned it, the
// latest comment) and Asana's own actions, all written back to Asana as the person (their own token when connected):
// Open in Asana (new tab), Complete (with Undo), Due date (Tomorrow / Next week / pick), Comment (a story on the task),
// Reassign (anyone on the team, found in Kaizen's workspace by their work email). The client's page only when the task
// maps to a client.

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export function AsanaItemActions({ itemKey, gid, url, title, clientSlug = null, dark = false, onGone, onBack, initial = null }: { itemKey: string; gid: string; url: string | null; title: string; clientSlug?: string | null; dark?: boolean; onGone?: () => void; onBack?: () => void; /** Already read: shown without asking Asana again */ initial?: TaskDetail | null }) {
  const router = useRouter();
  const [task, setTask] = useState<TaskDetail | null>(initial);
  const [canEdit, setCanEdit] = useState(true);
  const [panel, setPanel] = useState<"due" | "comment" | "reassign" | null>(null);
  const [comment, setComment] = useState("");
  const [people, setPeople] = useState<{ name: string; email: string; role: string }[] | null>(null);
  const [to, setTo] = useState("");
  const [pick, setPick] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  // Its context from Asana, read as them
  useEffect(() => {
    if (initial) return;
    let live = true;
    asanaTask(gid)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setTask(r.task);
          setCanEdit(r.canEdit);
        }
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [gid, initial]);
  const c = dark
    ? { text: "text-white/85", muted: "text-white/55", box: "border-white/10 bg-white/[0.05]", pill: "border border-white/25 text-white/85 hover:bg-white/10", primary: "bg-white text-black hover:bg-white/90", done: "border border-[#5be3a5]/50 text-[#5be3a5] hover:bg-[#5be3a5]/10", field: "border-white/20 text-white" }
    : { text: "text-fg", muted: "text-muted", box: "border-line bg-ink/[0.02]", pill: "border border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg", primary: "bg-brand text-white hover:bg-brand/90", done: "bg-fg text-bg hover:bg-ink/85", field: "border-ink/15 text-fg" };
  const pill = `inline-flex min-h-11 items-center rounded-full px-3.5 text-[13px] transition-colors disabled:opacity-50 sm:min-h-8 sm:px-3 sm:text-[12px]`;
  const field = `h-11 w-full rounded-[12px] border bg-transparent px-3 text-[16px] outline-none sm:h-9 sm:text-[13px] ${c.field}`;
  const link = url ?? task?.url ?? `https://app.asana.com/0/0/${gid}`;

  const complete = () => {
    onGone?.();
    deferClear({
      keys: [itemKey],
      label: "Completed in Asana",
      commit: async () => {
        const r = await saveAsanaTask(gid, { completed: true });
        if (r.ok) router.refresh();
        return r;
      },
      onUndo: onBack,
    });
  };
  const setDue = (due: string | null) =>
    start(async () => {
      setNote(null);
      const r = await saveAsanaTask(gid, { due });
      if (!r.ok) return setNote(r.error);
      setTask(r.task);
      setPanel(null);
      setNote(due ? `Due ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} in Asana` : "No due date in Asana");
      router.refresh();
    });
  const post = () =>
    start(async () => {
      setNote(null);
      const r = await commentAsanaTask(gid, comment);
      if (!r.ok) return setNote(r.error);
      setTask(r.task);
      setComment("");
      setPanel(null);
      setNote("Commented in Asana");
    });
  const reassign = () => {
    const p = people?.find((x) => x.email === to);
    if (!p) return;
    setPanel(null);
    onGone?.();
    deferClear({
      keys: [itemKey],
      label: `Reassigned to ${p.name.split(" ")[0]} in Asana`,
      commit: async () => {
        const r = await saveAsanaTask(gid, { assignee: p.email, assigneeName: p.name });
        if (r.ok) router.refresh();
        return r;
      },
      onUndo: onBack,
    });
  };
  const tick = (sub: string, done: boolean) =>
    start(async () => {
      setTask((t) => (t ? { ...t, subtasks: t.subtasks.map((s) => (s.gid === sub ? { ...s, completed: done } : s)) } : t));
      const r = await subtaskAsanaTask(gid, { tick: { gid: sub, done } });
      if (r.ok) setTask(r.task);
      else {
        setTask((t) => (t ? { ...t, subtasks: t.subtasks.map((s) => (s.gid === sub ? { ...s, completed: !done } : s)) } : t));
        setNote(r.error);
      }
    });
  const last = task?.comments.at(-1) ?? null;
  const notes = task?.notes.replace(/\s+/g, " ").trim() ?? "";

  return (
    <div className="grid w-full gap-3" onClick={(e) => e.stopPropagation()}>
      {/* Its context from Asana */}
      {task && (
        <div className={`grid gap-2 text-[13px] leading-relaxed ${c.text}`}>
          {(task.project || task.section || task.assignedBy) && (
            <p className={`text-[12.5px] ${c.muted}`}>
              {[task.project, task.section?.name].filter(Boolean).join(" · ")}
              {task.assignedBy ? `${task.project || task.section ? " · " : ""}assigned by ${task.assignedBy}` : ""}
            </p>
          )}
          {/* About two lines; links as short labels ("Loom video", "Attachment") that open in a new tab, never raw addresses */}
          {notes && (
            <p className="line-clamp-2 [overflow-wrap:anywhere]">
              {describe(notes).map((p, i) =>
                p.href ? (
                  <a key={i} href={p.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {p.text} ↗
                  </a>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </p>
          )}
          {task.subtasks.length > 0 && (
            <ul className="grid gap-1" aria-label="Subtasks">
              {task.subtasks.slice(0, 8).map((s) => (
                <li key={s.gid}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:min-h-8">
                    <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--brand)]" checked={s.completed} disabled={!canEdit || busy} onChange={(e) => tick(s.gid, e.target.checked)} />
                    <span className={`[overflow-wrap:anywhere] ${s.completed ? `line-through ${c.muted}` : ""}`}>{s.name}</span>
                  </label>
                </li>
              ))}
              {task.subtasks.length > 8 && <li className={`text-[12px] ${c.muted}`}>{task.subtasks.length - 8} more in Asana</li>}
            </ul>
          )}
          {last && (
            <div className={`grid gap-0.5 rounded-[14px] border px-3 py-2 ${c.box}`}>
              <span className={`text-[11.5px] ${c.muted}`}>
                {last.by ?? "Someone"} · {when(last.at)}
                {task.comments.length > 1 ? ` · ${task.comments.length} comments` : ""}
              </span>
              <span className="line-clamp-3 [overflow-wrap:anywhere]">
                {describe(last.text, 300).map((p, i) =>
                  p.href ? (
                    <a key={i} href={p.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                      {p.text} ↗
                    </a>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
              </span>
            </div>
          )}
        </div>
      )}
      {/* Asana's own actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        <a href={link} target="_blank" rel="noreferrer" className={`${pill} font-medium ${c.primary}`}>
          Open in Asana ↗
        </a>
        {canEdit && (
          <>
            <button type="button" onClick={complete} className={`${pill} font-medium ${c.done}`}>
              ✓ Complete
            </button>
            <button type="button" aria-expanded={panel === "due"} onClick={() => setPanel(panel === "due" ? null : "due")} className={`${pill} ${c.pill}`}>
              Due date
            </button>
            <button type="button" aria-expanded={panel === "comment"} onClick={() => setPanel(panel === "comment" ? null : "comment")} className={`${pill} ${c.pill}`}>
              Comment
            </button>
            <button
              type="button"
              aria-expanded={panel === "reassign"}
              onClick={() => {
                setPanel(panel === "reassign" ? null : "reassign");
                if (!people) asanaAssignees().then(setPeople).catch(() => setPeople([]));
              }}
              className={`${pill} ${c.pill}`}
            >
              Reassign
            </button>
          </>
        )}
        {clientSlug && (
          <Link href={`/clients/${clientSlug}`} className={`${pill} ${c.pill}`}>
            Client page
          </Link>
        )}
      </div>
      {panel === "due" && (
        <div className={`grid gap-2 rounded-2xl border p-3 sm:max-w-sm ${c.box}`}>
          <div className="flex flex-wrap gap-1.5">
            {["tomorrow", "next week"].map((w) => (
              <button key={w} type="button" disabled={busy} onClick={() => setDue(quickDue(w))} className={`${pill} ${c.pill}`}>
                {w === "tomorrow" ? "Tomorrow" : "Next week"}
              </button>
            ))}
          </div>
          <label className={`grid gap-1 text-[12px] ${c.muted}`}>
            Or pick a date
            <input type="date" value={pick} onChange={(e) => setPick(e.target.value)} className={field} />
          </label>
          <button type="button" disabled={busy || !pick} onClick={() => setDue(pick)} className={`${pill} justify-center font-medium ${c.done}`}>
            {busy ? "Saving..." : "Set due date"}
          </button>
        </div>
      )}
      {panel === "comment" && (
        <div className={`grid gap-2 rounded-2xl border p-3 ${c.box}`}>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="A comment on the task in Asana" className={`w-full rounded-[12px] border bg-transparent p-3 text-[16px] leading-relaxed outline-none sm:text-[14px] ${c.field}`} />
          <button type="button" disabled={busy || !comment.trim()} onClick={post} className={`${pill} justify-center justify-self-start font-medium ${c.done}`}>
            {busy ? "Posting..." : "Post in Asana"}
          </button>
        </div>
      )}
      {panel === "reassign" && (
        <div className={`grid gap-2 rounded-2xl border p-3 sm:max-w-sm ${c.box}`}>
          <label className={`grid gap-1 text-[12px] ${c.muted}`}>
            Assign it in Asana to
            <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
              <option value="">{people ? "Pick a teammate" : "Loading..."}</option>
              {(people ?? []).map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!to} onClick={reassign} className={`${pill} justify-center font-medium ${c.done}`}>
            Reassign
          </button>
        </div>
      )}
      {note && <p className={`text-[12.5px] ${c.muted}`}>{note}</p>}
      <span className="sr-only">{title}</span>
    </div>
  );
}
