"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition } from "react";
import { applyDirection, directionHeadsUp, logDirectionChange } from "@/app/(team)/direction/actions";
import { SOURCE_LABEL, actionLabel, type ChangeLineId, type TaskKind } from "@/lib/direction-core";
import type { ChangeLine, TaskFlag } from "@/lib/direction-changes";
import { pushParams } from "@/lib/url-state";
import { toast } from "./toasts";

// A client changing direction, where the work is: a flag on each board card it touches (creative and email, Kaizen
// and Asana), a banner in the ticket with the client's words and what to do, the client page's list with a way to log
// one, and the request form's heads-up. Each opens the change's sheet (?direction=<id>, src/components/direction-sheet).

const Flags = createContext<Record<string, TaskFlag>>({});

/** The board's flags, read once on the server (pending tasks on open changes, by "<kind>:<ref>") */
export function DirectionFlagsProvider({ flags, children }: { flags: Record<string, TaskFlag>; children: React.ReactNode }) {
  return <Flags.Provider value={flags}>{children}</Flags.Provider>;
}

/** On a board card: a small amber flag (not a button: the card itself is one) */
export function DirectionChip({ kind, refId }: { kind: TaskKind; refId: string }) {
  const f = useContext(Flags)[`${kind}:${refId}`];
  if (!f) return null;
  return (
    <span title={`${f.scope === "revision" ? "Revision asked" : "Client changed direction"}: ${f.summary}`} className={`-mt-0.5 inline-flex max-w-full items-center gap-1.5 justify-self-start rounded-full px-2 py-0.5 text-[11px] font-medium ${f.verdict === "affected" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
      </svg>
      <span className="truncate">{f.scope === "revision" ? "Revision asked" : f.verdict === "affected" ? "Direction changed" : "Direction may have changed"}</span>
    </span>
  );
}

/** In the ticket (or the Asana task's sheet): the change, the client's words, and the one-tap fix */
export function DirectionBanner({ kind, refId }: { kind: TaskKind; refId: string }) {
  const f = useContext(Flags)[`${kind}:${refId}`];
  const router = useRouter();
  const [busy, start] = useTransition();
  const [gone, setGone] = useState(false);
  if (!f || gone) return null;
  const act = (how: "send_back" | "keep" | "stop") =>
    start(async () => {
      const r = await applyDirection([{ taskId: f.taskId, how, to: how === "send_back" ? f.suggested : null }]);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't apply it", body: r.error });
      if (r.failed.length) return toast({ tone: "bad", title: "It didn't go through", body: r.failed[0].error });
      setGone(true);
      toast({ tone: "ok", title: how === "send_back" ? actionLabel(kind, f.fix, f.suggested).replace(/^Send back/, "Sent back").replace(/^Update the brief|^Add the note/, "Note added") : how === "keep" ? "Kept as is" : "Stopped" });
      router.refresh();
    });
  const main = actionLabel(kind, f.fix, f.suggested);
  return (
    <div className="grid gap-2.5 rounded-[16px] border border-warn/40 bg-warn-soft/40 p-3.5 text-sm">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
        </svg>
        {f.scope === "revision" ? "The client asked for a revision" : "The client changed direction"}
      </p>
      <p className="font-medium leading-snug">{f.summary}</p>
      {f.quote && <p className="leading-relaxed text-muted">&ldquo;{f.quote}&rdquo;</p>}
      {f.why && <p className="text-xs leading-relaxed text-faint">For this one: {f.why}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {f.fix !== "stop" && (
          <button type="button" disabled={busy} onClick={() => act("send_back")} className="h-10 rounded-full bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60 max-md:h-11">
            {busy ? "…" : main}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => act("keep")} className="h-10 rounded-full border border-line px-4 text-sm text-muted hover:border-faint hover:text-fg disabled:opacity-60 max-md:h-11">
          Keep as is
        </button>
        {f.fix === "stop" && (
          <button type="button" disabled={busy} onClick={() => act("stop")} className="h-10 rounded-full border border-bad/40 px-4 text-sm text-bad hover:bg-bad-soft disabled:opacity-60 max-md:h-11">
            Stop it
          </button>
        )}
        <button type="button" onClick={() => pushParams({ direction: f.changeId })} className="h-10 px-2 text-sm text-muted underline decoration-line underline-offset-4 hover:text-fg max-md:h-11">
          Every task it touches
        </button>
      </div>
    </div>
  );
}

const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/**
 * The client page, in one team's "Client changes" tab: that team's open direction changes, then the revisions asked on
 * its pieces in progress (kept apart: a revision edits one piece, a change moves the work), and a way to log one heard
 * anywhere (a call, a WhatsApp), kept with this team.
 */
export function ClientDirection({ clientId, client, lines: all, canLog, line = null }: { clientId: string; client: string; lines: ChangeLine[]; canLog: boolean; line?: ChangeLineId | null }) {
  const lines = all.filter((l) => l.scope !== "revision");
  const revisions = all.filter((l) => l.scope === "revision");
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState("");
  const [busy, start] = useTransition();
  const router = useRouter();
  if (!all.length && !canLog) return null;
  const log = () =>
    start(async () => {
      const r = await logDirectionChange(clientId, said, line);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't log it", body: r.error });
      setSaid("");
      setOpen(false);
      toast({ tone: "ok", title: r.tasks.length ? `${r.tasks.length === 1 ? "1 task" : `${r.tasks.length} tasks`} flagged` : "Logged", body: r.tasks.length ? "Check each one and apply." : `No open task for ${client} is touched by it.` });
      pushParams({ direction: r.id });
      router.refresh();
    });
  return (
    <section className="grid gap-2">
      {!all.length && <p className="text-sm text-faint">Nothing open. When {client} changes what this team&apos;s work should say or show, it lands here with the pieces it touches.</p>}
      {lines.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => pushParams({ direction: l.id })}
          className={`group grid gap-1 rounded-[14px] border px-4 py-3 text-left transition hover:-translate-y-px ${l.withClient ? "border-bad/40 bg-bad-soft/40" : "border-warn/40 bg-warn-soft/40"}`}
        >
          <span className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">
            <span>Client changed direction · {SOURCE_LABEL[l.source]} · {ago(l.saidAt ?? l.createdAt)}</span>
            <span className="font-medium normal-case tracking-normal text-fg">{l.pending ? `${l.pending} of ${l.total} to adapt` : "Nothing left to adapt"} →</span>
          </span>
          <span className="text-[15px] font-medium leading-snug">{l.summary}</span>
          {l.quote && <span className="line-clamp-2 text-sm text-muted">&ldquo;{l.quote}&rdquo;</span>}
        </button>
      ))}
      {revisions.length > 0 && (
        <div className="grid gap-2 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Revisions on pieces in progress</p>
          {revisions.map((l) => (
            <button key={l.id} type="button" onClick={() => pushParams({ direction: l.id })} className="grid gap-0.5 rounded-[12px] border border-line bg-surface px-4 py-2.5 text-left transition hover:border-faint">
              <span className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
                <span>Revision · {SOURCE_LABEL[l.source]} · {ago(l.saidAt ?? l.createdAt)}</span>
                <span className="text-fg">{l.pending ? `${l.pending} of ${l.total} to change` : "Done"} →</span>
              </span>
              <span className="text-sm leading-snug">{l.summary}</span>
            </button>
          ))}
        </div>
      )}
      {canLog &&
        (open ? (
          <div className="grid gap-2 rounded-[14px] border border-line bg-surface p-3">
            <label className="grid gap-1.5 text-xs font-medium text-muted">
              What did {client} change?
              <textarea
                autoFocus
                value={said}
                onChange={(e) => setSaid(e.target.value)}
                rows={3}
                maxLength={3000}
                placeholder="e.g. On today's call: evergreen creative only from now on, nothing tied to a team. The spring offer ends Friday."
                className="w-full resize-none rounded-[12px] border border-line bg-bg px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-faint"
              />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="h-11 px-3 text-sm text-muted hover:text-fg">
                Cancel
              </button>
              <button type="button" disabled={busy || said.trim().length < 8} onClick={log} className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                {busy ? "Checking their open work…" : "Flag their open work"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="inline-flex h-11 w-fit items-center gap-2 rounded-full border border-dashed border-line px-4 text-sm text-muted transition hover:border-faint hover:text-fg md:h-9">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
            </svg>
            Client changed direction
          </button>
        ))}
    </section>
  );
}

/** The request form: tasks already flagged for this client, to adapt before asking for something new (never a block) */
export function DirectionHeadsUp({ clientId }: { clientId: string }) {
  const [h, setH] = useState<Awaited<ReturnType<typeof directionHeadsUp>>>(null);
  useEffect(() => {
    let live = true;
    directionHeadsUp(clientId).then((x) => live && setH(x));
    return () => {
      live = false;
    };
  }, [clientId]);
  if (!h) return null;
  return (
    <section className="grid gap-2 rounded-[14px] border border-warn/40 bg-[radial-gradient(120%_140%_at_0%_0%,var(--warn-soft),transparent_60%)] p-4">
      <p className="text-sm leading-relaxed">
        <span className="font-medium">
          {h.pending === 1 ? "1 task" : `${h.pending} tasks`} for this client {h.pending === 1 ? "was" : "were"} flagged after &ldquo;{h.summary}&rdquo;.
        </span>{" "}
        <span className="text-muted">Adapt {h.pending === 1 ? "it" : "them"} instead of a new request?</span>
      </p>
      {h.titles.length > 0 && <p className="line-clamp-2 text-xs text-faint">{h.titles.join(" · ")}</p>}
      <button type="button" onClick={() => pushParams({ direction: h.id })} className="h-11 w-fit rounded-full border border-warn/40 px-4 text-sm text-fg hover:bg-warn-soft md:h-9">
        See the flagged tasks
      </button>
    </section>
  );
}
