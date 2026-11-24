"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { applyDirection, closeDirection, loadDirectionChange, myAsanaReady, undoDirection, type Choice } from "@/app/(team)/direction/actions";
import { asanaConnectHref } from "@/lib/asana-connect";
import { applyPreview } from "@/lib/direction-feedback-core";
import { BACK_STAGES, CHANGE_KIND_LABEL, SOURCE_LABEL, actionLabel, lineOf, stageLabel, isAsana, type TaskKind } from "@/lib/direction-core";
import type { ChangeTask, ChangeView } from "@/lib/direction-changes";
import { closeParams, useParam } from "@/lib/url-state";
import { toast } from "./toasts";

// A client changed direction: what changed (was, now, in their words, where and when), every open task it touches
// grouped by where it sits, each with why and what to do (send back to a stage, add the note, keep, stop) chosen
// already, and one Apply. Opened from anywhere by ?direction=<id> (a notification, Next for me, a board flag, the client
// page), so back closes it. Apply all first says what it will do (comments posted as you in Asana with the client's full
// feedback, where each task goes back to, nothing to the client), asks to connect Asana when theirs isn't, and offers Undo.

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : null;

const BOARD: Record<TaskKind, string> = { creative: "Creative", asana_creative: "Creative · Asana", email: "Email", asana_email: "Email · Asana" };

/** What a row's dropdown holds: send back to a stage, add the note where it is, keep, stop */
function optionsFor(t: ChangeTask): { value: string; label: string }[] {
  const line = lineOf(t.kind);
  const back = (BACK_STAGES[line] as string[]).filter((s) => s !== t.stage).map((s) => ({ value: `to:${s}`, label: `Send back to ${stageLabel(t.kind, s)}` }));
  return [...back, { value: "note", label: t.fix === "brief" ? "Update the brief, leave it here" : "Add the note, leave it here" }, { value: "keep", label: "Keep as is" }, { value: "stop", label: "Stop it" }];
}
const defaultFor = (t: ChangeTask) => (t.fix === "stop" ? "stop" : t.suggested ? `to:${t.suggested}` : "note");
const toChoice = (taskId: string, v: string): Choice => (v.startsWith("to:") ? { taskId, how: "send_back", to: v.slice(3) } : v === "note" ? { taskId, how: "send_back", to: null } : { taskId, how: v === "keep" ? "keep" : "stop" });
const doneLabel = (t: ChangeTask) =>
  t.action === "sent_back" ? (t.toStage ? `Sent back to ${stageLabel(t.kind, t.toStage)}` : "Note added") : t.action === "kept" ? "Kept as is" : t.action === "stopped" ? "Stopped" : "";

export function DirectionSheet() {
  const id = useParam("direction");
  if (!id) return null;
  return <Sheet key={id} id={id} />;
}

function Sheet({ id }: { id: string }) {
  const router = useRouter();
  const [change, setChange] = useState<ChangeView | null | undefined>(undefined);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Choice[] | null>(null);
  const [asanaReady, setAsanaReady] = useState<boolean | null>(null);

  const reload = () => loadDirectionChange(id).then((c) => setChange(c));
  useEffect(() => {
    let live = true;
    loadDirectionChange(id).then((c) => live && setChange(c));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("direction");
    window.addEventListener("keydown", esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = was;
    };
  }, []);

  const pending = useMemo(() => (change?.tasks ?? []).filter((t) => t.action === "pending"), [change]);
  const total = change?.tasks.length ?? 0;
  const acted = total - pending.length;
  const handled = change?.status === "handled" || (total > 0 && pending.length === 0);
  const groups = useMemo(() => {
    const m = new Map<string, ChangeTask[]>();
    for (const t of change?.tasks ?? []) m.set(t.stageLabel, [...(m.get(t.stageLabel) ?? []), t]);
    return [...m.entries()];
  }, [change]);
  const pick = (t: ChangeTask) => picks[t.id] ?? defaultFor(t);

  const here = () => (typeof window === "undefined" ? "/pipeline" : `${window.location.pathname}${window.location.search}`);
  const undo = (ids: string[]) =>
    start(async () => {
      const r = await undoDirection(ids);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't undo it", body: r.error, ...("connect" in r && r.connect ? { actions: [{ label: "Connect Asana", href: asanaConnectHref(here()), primary: true }] } : {}) });
      toast({ tone: r.failed.length ? "warn" : "ok", title: r.undone === 1 ? "Undone" : `${r.undone} undone`, body: r.failed.length ? r.failed.join(" · ").slice(0, 300) : "The comments are off and every task is back where it was." });
      await reload();
      router.refresh();
    });
  const run = (choices: Choice[], row: string | null) => {
    if (!choices.length) return;
    setRowBusy(row);
    start(async () => {
      const r = await applyDirection(choices, note || null);
      setRowBusy(null);
      setPreview(null);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't apply it", body: r.error, ...(r.connect ? { actions: [{ label: "Connect Asana", href: asanaConnectHref(here()), primary: true }] } : {}) });
      const again = r.acted.length ? [{ label: "Undo", run: () => undo(r.acted) }] : [];
      if (r.failed.length) toast({ tone: "bad", title: `${r.failed.length === 1 ? "One task" : `${r.failed.length} tasks`} didn't go through`, body: r.failed.map((f) => `${f.title}: ${f.error}`).join(" · ").slice(0, 300), actions: again, ms: 15000 });
      else if (r.handled) toast({ tone: "ok", title: "All handled", body: "Every flagged task has its new direction.", actions: again, ms: 15000 });
      else toast({ tone: "ok", title: r.done === 1 ? "Done" : `${r.done} done`, actions: again, ms: 15000 });
      await reload();
      router.refresh();
    });
  };
  // Apply all: say what it will do first; Asana work needs their own Asana connected
  const askApply = (choices: Choice[]) => {
    setPreview(choices);
    const hasAsana = (change?.tasks ?? []).some((t) => isAsana(t.kind) && choices.some((c) => c.taskId === t.id && c.how !== "keep"));
    setAsanaReady(hasAsana ? null : true);
    if (hasAsana) void myAsanaReady().then(setAsanaReady);
  };
  const close = (status: "dismissed" | "handled") =>
    start(async () => {
      const r = await closeDirection(id, status);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't close it", body: r.error });
      toast({ tone: "ok", title: status === "dismissed" ? "Dismissed: not a change of direction" : "Marked handled" });
      await reload();
      router.refresh();
    });

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-stretch md:justify-end" role="dialog" aria-modal="true" aria-label="Client changed direction">
      <button type="button" aria-label="Close" onClick={() => closeParams("direction")} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative grid max-h-[94dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.6)] animate-[sheet-up_.32s_cubic-bezier(.2,.8,.2,1)] md:max-h-none md:w-[580px] md:rounded-none md:rounded-l-[26px] md:border-y-0 md:border-r-0 md:animate-[drawer-right_.32s_cubic-bezier(.2,.8,.2,1)]">
        {change === undefined ? (
          <div className="row-span-3 grid min-h-[40dvh] place-items-center p-8 text-sm text-faint">Loading the change…</div>
        ) : change === null ? (
          <div className="row-span-3 grid min-h-[40dvh] place-items-center gap-3 p-8 text-center text-sm text-muted">
            <p>This change isn&apos;t one you can see, or it&apos;s gone.</p>
            <button type="button" onClick={() => closeParams("direction")} className="h-11 rounded-full border border-line px-5 text-sm hover:border-faint">
              Close
            </button>
          </div>
        ) : (
          <>
            <header className={`relative isolate grid gap-3 overflow-hidden border-b border-line px-5 pb-5 pt-4 md:px-7 md:pt-6`}>
              <span aria-hidden className={`pointer-events-none absolute -right-16 -top-24 -z-10 h-56 w-56 rounded-full blur-[80px] ${handled ? "bg-ok/25" : change.status === "dismissed" ? "bg-surface-2" : "bg-warn/25"}`} />
              <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-line md:hidden" aria-hidden />
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                    <span className={`relative grid h-2 w-2 place-items-center`}>
                      {!handled && change.status === "open" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60" />}
                      <span className={`relative h-2 w-2 rounded-full ${handled ? "bg-ok" : change.status === "dismissed" ? "bg-faint" : "bg-warn"}`} />
                    </span>
                    {change.scope === "revision" ? "Revision on a piece" : `${CHANGE_KIND_LABEL[change.kind]} change`}
                    <span className="font-normal normal-case tracking-normal">·</span>
                    <Link href={`/clients/${change.client.slug}`} className="font-medium normal-case tracking-normal text-muted hover:text-fg">
                      {change.client.name}
                    </Link>
                  </span>
                  <h2 className="font-heading text-[22px] leading-tight [overflow-wrap:anywhere] md:text-[26px]">{change.summary}</h2>
                </div>
                <button type="button" onClick={() => closeParams("direction")} aria-label="Close" className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-faint hover:bg-surface-2 hover:text-fg">
                  ×
                </button>
              </div>
              {(change.was || change.now) && (
                <div className="grid items-center gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                  <span className="rounded-[12px] border border-line bg-surface px-3 py-2 text-muted line-through decoration-faint/60">{change.was || "Before"}</span>
                  <span aria-hidden className="justify-self-center text-faint max-sm:rotate-90">→</span>
                  <span className="rounded-[12px] border border-ok/40 bg-ok-soft px-3 py-2 text-fg">{change.now || "Now"}</span>
                </div>
              )}
              {change.quote && (
                <figure className="grid gap-1.5 rounded-[14px] border-l-2 border-warn bg-warn-soft/40 px-4 py-3">
                  <blockquote className="text-[15px] leading-relaxed">&ldquo;{change.quote}&rdquo;</blockquote>
                  <figcaption className="flex flex-wrap items-center gap-x-2 text-xs text-faint">
                    <span>{SOURCE_LABEL[change.source]}</span>
                    {when(change.saidAt) && <span>· {when(change.saidAt)}</span>}
                    {change.createdBy && <span>· logged by {change.createdBy.split(" ")[0]}</span>}
                    {change.url && (
                      <a href={change.url} target="_blank" rel="noreferrer" className="text-muted underline decoration-line underline-offset-4 hover:text-fg">
                        Open the message
                      </a>
                    )}
                  </figcaption>
                </figure>
              )}
              {total > 0 && (
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className={handled ? "font-medium text-ok" : "text-muted"}>{handled ? "All handled" : `${acted} of ${total} handled`}</span>
                    <span className="text-faint">{pending.filter((t) => t.withClient).length ? `${pending.filter((t) => t.withClient).length} with the client now` : ""}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className={`h-full rounded-full transition-[width] duration-500 ${handled ? "bg-ok" : "bg-brand"}`} style={{ width: `${total ? Math.round((acted / total) * 100) : 0}%` }} />
                  </div>
                </div>
              )}
            </header>

            <div className="grid content-start gap-5 overflow-y-auto overscroll-contain px-5 py-5 md:px-7">
              {handled && (
                <div className="flex items-center gap-3 rounded-[16px] border border-ok/40 bg-ok-soft px-4 py-3 text-sm animate-[step-in_.45s_cubic-bezier(.2,.8,.2,1)]">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ok text-bg">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                  <span>Every flagged task has the new direction. Nothing old goes to the client.</span>
                </div>
              )}
              {change.status === "dismissed" && <p className="rounded-[14px] bg-surface-2 px-4 py-3 text-sm text-muted">Dismissed: not a change of direction. The tasks were left as they were.</p>}
              {!total && change.status === "open" && (
                <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No open task for {change.client.name} is touched by this. Keep it in mind for new requests, then mark it handled.</p>
              )}
              {groups.map(([label, tasks]) => (
                <section key={label} className="grid gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                    {label} <span className="font-normal tracking-normal">· {tasks.length}</span>
                  </p>
                  <ul className="grid gap-2">
                    {tasks.map((t) => (
                      <TaskRow key={t.id} t={t} value={pick(t)} onPick={(v) => setPicks((p) => ({ ...p, [t.id]: v }))} busy={busy && rowBusy === t.id} disabled={busy || change.status !== "open"} onApply={() => run([toChoice(t.id, pick(t))], t.id)} />
                    ))}
                  </ul>
                </section>
              ))}
              {change.status === "open" && pending.length > 0 && (
                <label className="grid gap-1.5 text-xs font-medium text-muted">
                  A note for the makers (optional)
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={600} placeholder="Anything to add: what to keep, what to swap first" className="w-full resize-none rounded-[12px] border border-line bg-surface px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-faint" />
                </label>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 md:px-7">
              {preview && change.status === "open" ? (
                <ApplyPreview
                  tasks={preview.map((c) => {
                    const t = (change.tasks ?? []).find((x) => x.id === c.taskId);
                    return { title: t?.title ?? "", asana: t ? isAsana(t.kind) : false, how: c.how, to: c.to && t ? stageLabel(t.kind, c.to) : null };
                  })}
                  asanaReady={asanaReady}
                  connectHref={asanaConnectHref(here())}
                  busy={busy}
                  onApply={() => run(preview, null)}
                  onBack={() => setPreview(null)}
                />
              ) : change.status === "open" ? (
                <>
                  <button type="button" disabled={busy} onClick={() => close(pending.length ? "dismissed" : "handled")} className="h-11 rounded-full px-3 text-sm text-muted hover:text-fg disabled:opacity-50">
                    {pending.length ? "Not a change: dismiss" : "Mark handled"}
                  </button>
                  {pending.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => askApply(pending.map((t) => toChoice(t.id, pick(t))))}
                      className="h-12 min-w-[10rem] rounded-full bg-brand px-6 text-sm font-medium text-white shadow-[0_10px_30px_-12px_var(--color-brand)] transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-60 max-sm:flex-1"
                    >
                      {busy && !rowBusy ? "Applying…" : `Apply ${pending.length === 1 ? "it" : `all ${pending.length}`}`}
                    </button>
                  )}
                </>
              ) : (
                <button type="button" onClick={() => closeParams("direction")} className="ml-auto h-11 rounded-full border border-line px-5 text-sm hover:border-faint">
                  Close
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** What Apply all will do, said before it happens; Connect when their own Asana isn't connected */
function ApplyPreview({ tasks, asanaReady, connectHref, busy, onApply, onBack }: { tasks: { title: string; asana: boolean; how: "send_back" | "keep" | "stop"; to: string | null }[]; asanaReady: boolean | null; connectHref: string; busy: boolean; onApply: () => void; onBack: () => void }) {
  const lines = applyPreview(tasks);
  const asana = tasks.some((t) => t.asana && t.how !== "keep");
  const blocked = asana && asanaReady === false;
  return (
    <div className="grid w-full gap-3 animate-[step-in_.25s_cubic-bezier(.2,.8,.2,1)]">
      <div className="grid gap-1.5">
        <p className="text-sm font-semibold text-fg">This will:</p>
        <ul className="grid gap-1 text-sm text-muted">
          {lines.map((l) => (
            <li key={l} className="flex gap-2">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span className={l === "Nothing goes to the client" ? "font-medium text-fg" : ""}>{l}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-faint [overflow-wrap:anywhere]">
          {tasks
            .filter((t) => t.how !== "keep")
            .map((t) => t.title)
            .slice(0, 6)
            .join(" · ")}
          {tasks.filter((t) => t.how !== "keep").length > 6 ? ` · and ${tasks.filter((t) => t.how !== "keep").length - 6} more` : ""}
        </p>
      </div>
      {blocked && (
        <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-warn/40 bg-warn-soft px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1">Connect your Asana first, so the comments go in as you.</span>
          <a href={connectHref} className="inline-flex h-11 items-center rounded-full bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover md:h-9">
            Connect Asana
          </a>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onBack} disabled={busy} className="h-11 rounded-full px-4 text-sm text-muted hover:text-fg disabled:opacity-50">
          Back
        </button>
        <button type="button" onClick={onApply} disabled={busy || blocked || (asana && asanaReady === null)} className="h-12 min-w-[10rem] rounded-full bg-brand px-6 text-sm font-medium text-white shadow-[0_10px_30px_-12px_var(--color-brand)] transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-60 max-sm:flex-1">
          {busy ? "Applying…" : asana && asanaReady === null ? "Checking Asana…" : "Apply"}
        </button>
      </div>
      <p className="text-xs text-faint">You can undo it right after.</p>
    </div>
  );
}

function TaskRow({ t, value, onPick, onApply, busy, disabled }: { t: ChangeTask; value: string; onPick: (v: string) => void; onApply: () => void; busy: boolean; disabled: boolean }) {
  const done = t.action !== "pending";
  return (
    <li className={`grid gap-2.5 rounded-[16px] border p-3.5 transition ${done ? "border-ok/30 bg-ok-soft/40" : t.withClient ? "border-bad/40 bg-surface" : "border-line bg-surface"}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={t.href} className="min-w-0 text-[15px] font-medium leading-snug [overflow-wrap:anywhere] hover:underline hover:decoration-line hover:underline-offset-4">
          {t.title}
        </Link>
        {done ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            {doneLabel(t)}
          </span>
        ) : (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${t.verdict === "affected" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>{t.verdict === "affected" ? "Affected" : "Maybe"}</span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
        <span className="rounded-full border border-line px-1.5 py-px">{BOARD[t.kind]}</span>
        {t.withClient && !done && <span className="rounded-full bg-bad-soft px-1.5 py-px text-bad">With the client now</span>}
        {done && t.actedBy && <span>by {t.actedBy.split(" ")[0]}</span>}
        {isAsana(t.kind) && t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" className="hover:text-fg">
            Open in Asana
          </a>
        )}
      </p>
      {t.why && <p className="text-sm leading-relaxed text-muted">{t.why}</p>}
      {!done && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <select
            value={value}
            disabled={disabled}
            onChange={(e) => onPick(e.target.value)}
            aria-label={`What to do with ${t.title}`}
            className="h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-sm text-fg outline-none focus:border-faint disabled:opacity-60"
          >
            {optionsFor(t).map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === defaultFor(t) ? `${o.label} (suggested)` : o.label}
              </option>
            ))}
          </select>
          <button type="button" disabled={disabled} onClick={onApply} className="h-11 rounded-[12px] border border-line px-4 text-sm text-muted transition hover:border-faint hover:text-fg disabled:opacity-50">
            {busy ? "…" : "Do it now"}
          </button>
        </div>
      )}
      {!done && <span className="sr-only">Suggested: {actionLabel(t.kind, t.fix, t.suggested)}</span>}
    </li>
  );
}
