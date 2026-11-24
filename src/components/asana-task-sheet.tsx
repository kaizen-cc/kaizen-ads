"use client";

import { ASANA_CONNECT_SAY, asanaConnectHref } from "@/lib/asana-connect";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { asanaTask, commentAsanaTask, saveAsanaTask, subtaskAsanaTask } from "@/app/(team)/asana-task-actions";
import { quickDue, type AsanaPatch, type TaskDetail } from "@/lib/asana-live-core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// An Asana task, opened over any page (?task=<gid>, so back closes it): every field, the due date in one tap, subtasks,
// comments and attachments, written straight back to Asana. Changes show at once and are put back if Asana refuses.

export function openAsanaTask(gid: string) {
  pushParams({ task: gid });
}

export function AsanaTaskSheet() {
  const gid = useParam("task");
  if (!gid) return null;
  return <Sheet key={gid} gid={gid} />;
}

const field = "w-full rounded-[12px] border border-line bg-transparent px-3 text-[16px] text-fg outline-none focus:border-faint md:text-[14px]";
const label = "grid gap-1 text-[12px] text-muted";
const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

function Sheet({ gid }: { gid: string }) {
  const router = useRouter();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; notes: string }>({ name: "", notes: "" });
  const [comment, setComment] = useState("");
  const [sub, setSub] = useState("");
  const [busy, start] = useTransition();

  useEffect(() => {
    let live = true;
    asanaTask(gid).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.error);
      setTask(r.task);
      setCanEdit(r.canEdit);
      setDraft({ name: r.task.name, notes: r.task.notes });
    });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("task");
    window.addEventListener("keydown", esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      live = false;
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = was;
    };
  }, [gid]);

  // Optimistic: shown at once, put back when Asana refuses
  const save = (patch: AsanaPatch, shown: Partial<TaskDetail>) => {
    if (!task) return;
    const before = task;
    setTask({ ...task, ...shown });
    setError(null);
    start(async () => {
      const r = await saveAsanaTask(gid, patch);
      if (!r.ok) {
        setTask(before);
        setError(r.error);
        return;
      }
      setTask(r.task);
      router.refresh();
    });
  };
  const after = (p: Promise<{ ok: true; task: TaskDetail } | { ok: false; error: string }>, undo?: () => void) =>
    start(async () => {
      const r = await p;
      if (!r.ok) {
        undo?.();
        return setError(r.error);
      }
      setTask(r.task);
    });

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-stretch md:justify-end" role="dialog" aria-modal="true" aria-label="Asana task">
      <button type="button" aria-label="Close" onClick={() => closeParams("task")} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative grid max-h-[92dvh] w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.6)] animate-[sheet-up_.32s_cubic-bezier(.2,.8,.2,1)] md:max-h-none md:w-[560px] md:rounded-none md:rounded-l-[26px] md:border-y-0 md:border-r-0 md:animate-[drawer-right_.32s_cubic-bezier(.2,.8,.2,1)]">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 pb-4 pt-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{task?.project ?? "Asana"}{task?.section ? ` · ${task.section.name}` : ""}</p>
            <h2 className="mt-1 font-heading text-[19px] leading-snug text-fg [overflow-wrap:anywhere]">{task?.name ?? (error ? "Couldn't open it" : "Loading…")}</h2>
          </div>
          <button type="button" onClick={() => closeParams("task")} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink/60 hover:bg-ink/[0.06] hover:text-fg">
            ✕
          </button>
        </header>
        <div className="grid content-start gap-5 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {error && (
            <p className="flex flex-wrap items-center gap-2 rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">
              <span className="min-w-0 flex-1">{error}</span>
              {error === ASANA_CONNECT_SAY && (
                <a href={asanaConnectHref(`${window.location.pathname}${window.location.search}`)} className="inline-flex h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover md:h-9">
                  Connect Asana
                </a>
              )}
            </p>
          )}
          {task && (
            <>
              {/* Due date in one tap */}
              <section className="grid gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Due {task.due ?? "not set"}</p>
                <div className="flex flex-wrap gap-2">
                  {(["today", "tomorrow"] as const).map((w) => {
                    const d = quickDue(w)!;
                    return (
                      <button key={w} type="button" disabled={!canEdit || busy} onClick={() => save({ due: d }, { due: d })} className={`min-h-11 rounded-full border px-4 text-[13px] capitalize disabled:opacity-50 md:min-h-9 ${task.due === d ? "border-fg bg-fg text-bg" : "border-line text-muted hover:text-fg"}`}>
                        {w}
                      </button>
                    );
                  })}
                  <input type="date" aria-label="Pick a due date" disabled={!canEdit || busy} value={task.due ?? ""} onChange={(e) => e.target.value && save({ due: e.target.value }, { due: e.target.value })} className={`${field} h-11 w-auto md:h-9`} />
                  <a href={task.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
                    Open in Asana ↗
                  </a>
                </div>
              </section>

              {/* Done, and the column it sits in */}
              <section className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!canEdit || busy} onClick={() => save({ completed: !task.completed }, { completed: !task.completed })} className={`min-h-11 rounded-full px-4 text-[13px] font-medium disabled:opacity-50 md:min-h-9 ${task.completed ? "bg-ok-soft text-ok" : "bg-fg text-bg"}`}>
                  {task.completed ? "✓ Completed (reopen)" : "Mark complete"}
                </button>
                {task.sections.length > 0 && (
                  <select aria-label="Section" disabled={!canEdit || busy} value={task.section?.gid ?? ""} onChange={(e) => { const s = task.sections.find((x) => x.gid === e.target.value); if (s) save({ section: s.gid, sectionName: s.name }, { section: s }); }} className={`${field} h-11 w-auto md:h-9`}>
                    {task.sections.map((s) => (
                      <option key={s.gid} value={s.gid}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                <span className="text-[12px] text-faint">{task.assignee?.name ? `Assigned to ${task.assignee.name}` : "Unassigned"}</span>
              </section>

              {/* Name, description, start date, assignee */}
              {editing ? (
                <section className="grid gap-3">
                  <label className={label}>
                    Name
                    <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} h-11`} />
                  </label>
                  <label className={label}>
                    Description
                    <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={6} className={`${field} py-2`} />
                  </label>
                  <label className={label}>
                    Start date
                    <input type="date" value={task.start ?? ""} onChange={(e) => save({ start: e.target.value || null }, { start: e.target.value || null })} className={`${field} h-11 w-auto`} />
                  </label>
                  <label className={label}>
                    Reassign (their work email)
                    <input
                      placeholder={task.assignee?.email ?? "name@kaizenmarketing.agency"}
                      onKeyDown={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (e.key === "Enter" && v.includes("@")) save({ assignee: v, assigneeName: v }, { assignee: { name: v, email: v } });
                      }}
                      className={`${field} h-11`}
                    />
                  </label>
                  <div className="flex gap-2">
                    <button type="button" disabled={busy} onClick={() => { save({ name: draft.name, notes: draft.notes }, { name: draft.name, notes: draft.notes }); setEditing(false); }} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
                      Save to Asana
                    </button>
                    <button type="button" onClick={() => setEditing(false)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
                      Cancel
                    </button>
                  </div>
                </section>
              ) : (
                <section className="grid gap-2">
                  {task.notes ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg/90">{task.notes}</p> : <p className="text-[13px] text-faint">No description.</p>}
                  {task.start && <p className="text-[12px] text-faint">Starts {task.start}</p>}
                  {canEdit && (
                    <button type="button" onClick={() => setEditing(true)} className="justify-self-start rounded-full border border-line px-4 py-2 text-[13px] text-muted hover:text-fg">
                      Edit details
                    </button>
                  )}
                </section>
              )}

              {/* Custom fields */}
              {task.fields.length > 0 && (
                <section className="grid gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Fields</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {task.fields.map((f) => (
                      <label key={f.gid} className={label}>
                        {f.name}
                        {f.kind === "enum" ? (
                          <select disabled={!canEdit || busy} value={String(f.value ?? "")} onChange={(e) => save({ fields: { [f.gid]: e.target.value || null } }, { fields: task.fields.map((x) => (x.gid === f.gid ? { ...x, value: e.target.value || null } : x)) })} className={`${field} h-11 md:h-9`}>
                            <option value="">None</option>
                            {f.options.map((o) => (
                              <option key={o.gid} value={o.gid}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        ) : f.kind === "other" ? (
                          <span className="text-[13px] text-fg">{f.display ?? "None"}</span>
                        ) : (
                          <input
                            type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                            disabled={!canEdit || busy}
                            defaultValue={f.value == null ? "" : String(f.value)}
                            onBlur={(e) => {
                              const v = e.target.value;
                              if (v === String(f.value ?? "")) return;
                              const value = f.kind === "number" ? (v === "" ? null : Number(v)) : f.kind === "date" ? { date: v || null } : v || null;
                              save({ fields: { [f.gid]: value } }, {});
                            }}
                            className={`${field} h-11 md:h-9`}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </section>
              )}

              {/* Subtasks */}
              <section className="grid gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Subtasks</p>
                <ul className="grid gap-0.5">
                  {task.subtasks.map((s) => (
                    <li key={s.gid}>
                      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[10px] px-1 py-1.5 text-[14px] hover:bg-ink/[0.04] md:min-h-8">
                        <input
                          type="checkbox"
                          disabled={!canEdit || busy}
                          checked={s.completed}
                          onChange={(e) => {
                            const done = e.target.checked;
                            const before = task;
                            setTask({ ...task, subtasks: task.subtasks.map((x) => (x.gid === s.gid ? { ...x, completed: done } : x)) });
                            after(subtaskAsanaTask(gid, { tick: { gid: s.gid, done } }), () => setTask(before));
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                        />
                        <span className={s.completed ? "text-ink/40 line-through" : "text-fg"}>{s.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <div className="flex gap-2">
                    <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Add a subtask" className={`${field} h-11 md:h-9`} onKeyDown={(e) => e.key === "Enter" && sub.trim() && (after(subtaskAsanaTask(gid, { add: sub })), setSub(""))} />
                    <button type="button" disabled={!sub.trim() || busy} onClick={() => { after(subtaskAsanaTask(gid, { add: sub })); setSub(""); }} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
                      Add
                    </button>
                  </div>
                )}
              </section>

              {/* Attachments */}
              {task.attachments.length > 0 && (
                <section className="grid gap-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Attachments</p>
                  {task.attachments.map((a) => (
                    <a key={a.gid} href={a.url ?? task.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 rounded-[10px] px-2 text-[13.5px] text-fg hover:bg-ink/[0.05] md:min-h-8">
                      📎 <span className="truncate">{a.name}</span>
                    </a>
                  ))}
                </section>
              )}

              {/* Comments */}
              <section className="grid gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Comments</p>
                <ul className="grid gap-2">
                  {task.comments.map((c) => (
                    <li key={c.gid} className="grid gap-0.5">
                      <span className="text-[11.5px] text-faint">
                        {c.by ?? "Someone"} · {fmt(c.at)}
                      </span>
                      <span className="whitespace-pre-wrap rounded-[14px] bg-ink/[0.05] px-3 py-2 text-[14px] text-fg">{c.text}</span>
                    </li>
                  ))}
                  {!task.comments.length && <li className="text-[13px] text-faint">No comments yet.</li>}
                </ul>
                {canEdit && (
                  <div className="grid gap-2">
                    <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Add a comment (posted to Asana with your name)" className={`${field} py-2`} />
                    <button type="button" disabled={!comment.trim() || busy} onClick={() => { after(commentAsanaTask(gid, comment)); setComment(""); }} className="min-h-11 justify-self-end rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
                      Comment
                    </button>
                  </div>
                )}
              </section>
              {!canEdit && <p className="text-[12px] text-faint">Read only: you can change tasks that are yours, on clients you work on, or your team&apos;s.</p>}
              <p className="text-[11.5px] text-faint">Changes go straight to Asana with a comment saying they were made by you in Kaizen OS.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
