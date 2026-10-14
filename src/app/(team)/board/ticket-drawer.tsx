"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { BOARD_ORDER, FORMAT_LABEL, PHASE_LABEL, businessDuration, health, stageInfo, type Phase, type Priority, type Stage } from "@/lib/stages";
import { assignTicket, commentTicket, moveTicket, setTicketDue, setTicketPriority, ticketHistory, type TicketEvent } from "./actions";
import { ClientTag, FormatIcon, TimeStamp } from "./ticket-card";
import type { Person, Ticket } from "./types";

const PHASES: Phase[] = ["brief", "make", "review", "client", "launch"];

// "Send back" moves where the flow allows going backwards.
const BACK: Partial<Record<Stage, { to: Stage; label: string }>> = {
  internal_review: { to: "in_production", label: "Send back to creative" },
  client_review: { to: "client_revision", label: "Client asked for changes" },
  ready_for_launch: { to: "client_review", label: "Back to client" },
};

const DEMO_HISTORY = (t: Ticket): TicketEvent[] => [
  { id: "d1", kind: "created", fromStage: null, toStage: "requested", actor: t.buyerName, body: null, data: {}, at: t.createdAt },
  { id: "d2", kind: "stage", fromStage: "requested", toStage: "in_production", actor: t.creativeName, body: null, data: {}, at: t.stageEnteredAt },
  { id: "d3", kind: "comment", fromStage: null, toStage: null, actor: "Jesus", body: "Lead with the price. The calzone should be cut open so you see the cheese pull.", data: {}, at: t.stageEnteredAt },
];

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));

/** datetime-local value in New York time. */
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** New York wall time → ISO (handles EST/EDT). */
function fromLocalInput(v: string) {
  const guess = new Date(`${v}:00Z`);
  const ny = new Date(guess.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (utc.getTime() - ny.getTime())).toISOString();
}

function describe(e: TicketEvent) {
  switch (e.kind) {
    case "created":
      return "created this request";
    case "stage":
      return (
        <>
          moved it to <span className="text-fg">{e.toStage ? stageInfo(e.toStage).label : "—"}</span>
        </>
      );
    case "assign":
      return e.data.toName ? (
        <>
          assigned it to <span className="text-fg">{e.data.toName}</span>
        </>
      ) : (
        "unassigned it"
      );
    case "due":
      return <>changed the due date{e.data.to ? <> to <span className="text-fg">{fmtDate(e.data.to)}</span></> : null}</>;
    case "priority":
      return (
        <>
          set priority to <span className="text-fg">{e.data.to}</span>
        </>
      );
    case "comment":
      return "commented";
  }
}

export function TicketDrawer({
  ticket,
  people,
  onClose,
  onOptimisticMove,
  demo = false,
}: {
  ticket: Ticket;
  people: Person[];
  onClose: () => void;
  onOptimisticMove: (id: string, stage: Stage) => void;
  demo?: boolean; // design preview: sample history, no server calls
}) {
  const [history, setHistory] = useState<TicketEvent[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const info = stageInfo(ticket.stage);
  const back = BACK[ticket.stage];
  const h = health(ticket.minutesOver, ticket.stage);

  const reload = () =>
    demo
      ? Promise.resolve().then(() => setHistory(DEMO_HISTORY(ticket)))
      : ticketHistory(ticket.id).then(setHistory);
  // The board remounts this drawer per ticket (key), so history starts empty for each one
  useEffect(() => {
    reload();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      if (demo) {
        after?.();
        return;
      }
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
      else {
        after?.();
        reload();
      }
    });

  const move = (stage: Stage) => {
    onOptimisticMove(ticket.id, stage);
    run(() => moveTicket(ticket.id, stage, moveNote), () => setMoveNote(""));
  };

  const currentPhaseIndex = PHASES.indexOf(info.phase);

  const section = "grid gap-3";
  const sectionTitle = "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint";
  const control =
    "h-9 w-full min-w-0 rounded-brand border border-transparent bg-transparent px-2.5 text-sm text-fg outline-none transition-colors hover:border-line hover:bg-surface-2 focus:border-brand-text/60 disabled:opacity-60";
  const counts =
    [ticket.newCount && `${ticket.newCount} new`, ticket.variationCount && `${ticket.variationCount} variation${ticket.variationCount === 1 ? "" : "s"}`].filter(Boolean).join(" + ") ||
    `${ticket.quantity} creative${ticket.quantity === 1 ? "" : "s"}`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Ticket ${ticket.number}`}>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <aside className="relative flex h-full w-full max-w-[600px] flex-col border-l border-line bg-bg shadow-2xl animate-[drawer-right_.25s_cubic-bezier(.2,.8,.2,1)]">
        {/* Header: who, what, and where it is in the journey */}
        <header className="grid gap-5 border-b border-line px-7 pb-6 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <ClientTag name={ticket.clientName} />
              <span className="tabular text-xs text-faint">#{ticket.number}</span>
              {ticket.priority !== "normal" && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ticket.priority === "urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                  {ticket.priority === "urgent" ? "Urgent" : "High"}
                </span>
              )}
            </div>
            <button onClick={onClose} className="-mr-2 grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close ticket">
              ✕
            </button>
          </div>

          <div className="grid gap-2.5">
            <h2 className="font-heading text-[26px] leading-tight">{ticket.title}</h2>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5 text-fg">
                <FormatIcon format={ticket.format} /> {FORMAT_LABEL[ticket.format]}
              </span>
              <span className="text-faint">·</span>
              <span>{counts}</span>
              {ticket.angleName && (
                <>
                  <span className="text-faint">·</span>
                  <span>{ticket.angleName}</span>
                </>
              )}
            </p>
          </div>

          {/* Journey: five phases, current one lit */}
          <div className="grid grid-cols-5 gap-1.5">
            {PHASES.map((p, i) => (
              <div key={p} className="grid gap-1.5">
                <div
                  className={`h-1 rounded-full ${
                    i < currentPhaseIndex ? "bg-fg/40" : i === currentPhaseIndex ? (h === "bad" ? "bg-bad" : h === "warn" ? "bg-warn" : "bg-brand") : "bg-surface-2"
                  }`}
                />
                <span className={`text-[11px] ${i === currentPhaseIndex ? "text-fg" : "text-faint"}`}>{PHASE_LABEL[p]}</span>
              </div>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid content-start gap-9 px-7 py-7">
          {/* Where it is and what happens next */}
          <section className="overflow-hidden rounded-[10px] border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <p className="font-medium">{info.label}</p>
                <p className="mt-0.5 text-xs text-muted">{ticket.stageDueAt ? <>Due {fmtDate(ticket.stageDueAt)}</> : "No turnaround in this stage"}</p>
              </div>
              <div className="flex items-center gap-2">
                <TimeStamp ticket={ticket} label />
                {ticket.stage !== "launched" && (
                  <select
                    aria-label="Move to any stage"
                    value=""
                    disabled={pending}
                    onChange={(e) => e.target.value && move(e.target.value as Stage)}
                    className="h-8 rounded-full border border-line bg-bg px-3 text-xs text-muted hover:border-faint hover:text-fg"
                  >
                    <option value="">Move to…</option>
                    {BOARD_ORDER.filter((s) => s !== ticket.stage).map((s) => (
                      <option key={s} value={s}>
                        {stageInfo(s).label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            {ticket.stage !== "launched" && (
              <div className="grid gap-3 border-t border-line px-5 py-4">
                <input
                  value={moveNote}
                  onChange={(e) => setMoveNote(e.target.value)}
                  placeholder="Add a note with this move (optional)"
                  aria-label="Note for this move"
                  className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {info.next && (
                    <button
                      disabled={pending}
                      onClick={() => move(info.next!)}
                      className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:bg-brand-hover disabled:opacity-60"
                    >
                      {info.nextLabel} →
                    </button>
                  )}
                  {back && (
                    <button disabled={pending} onClick={() => move(back.to)} className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:border-faint hover:text-fg disabled:opacity-60">
                      ↩ {back.label}
                    </button>
                  )}
                </div>
              </div>
            )}
            {error && <p className="border-t border-line px-5 py-3 text-sm text-brand-text">{error}</p>}
          </section>

          {/* Properties: label on the left, editable value on the right */}
          <section className={section}>
            <h3 className={sectionTitle}>Details</h3>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Assigned to</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <PersonAvatar name={ticket.assigneeName ?? "?"} size={22} muted={!ticket.assigneeName} />
                <select
                  aria-label="Assigned to"
                  value={ticket.assigneeId ?? ""}
                  disabled={pending}
                  onChange={(e) => run(() => assignTicket(ticket.id, e.target.value || null))}
                  className={control}
                >
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.role}
                    </option>
                  ))}
                </select>
              </dd>

              <dt className="text-muted">Due (ET)</dt>
              <dd className="min-w-0">
                <input
                  type="datetime-local"
                  aria-label="Due date, Eastern time"
                  defaultValue={toLocalInput(ticket.stageDueAt)}
                  key={ticket.stageDueAt ?? "none"}
                  disabled={pending || !ticket.stageDueAt}
                  onBlur={(e) => e.target.value && e.target.value !== toLocalInput(ticket.stageDueAt) && run(() => setTicketDue(ticket.id, fromLocalInput(e.target.value)))}
                  className={control}
                />
              </dd>

              <dt className="text-muted">Priority</dt>
              <dd className="flex gap-1 px-1 py-1">
                {(["normal", "high", "urgent"] as Priority[]).map((p) => (
                  <button
                    key={p}
                    disabled={pending}
                    onClick={() => p !== ticket.priority && run(() => setTicketPriority(ticket.id, p))}
                    aria-pressed={ticket.priority === p}
                    className={`h-7 rounded-full px-3 text-xs capitalize transition-colors disabled:opacity-60 ${
                      ticket.priority === p
                        ? p === "urgent"
                          ? "bg-bad-soft text-bad"
                          : p === "high"
                            ? "bg-warn-soft text-warn"
                            : "bg-surface-2 text-fg"
                        : "text-faint hover:bg-surface-2 hover:text-fg"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </dd>

              {[
                ["Creative", ticket.creativeName],
                ["Media buyer", ticket.buyerName],
                ["Requested", fmtDate(ticket.createdAt)],
                ["In this stage", `${businessDuration(ticket.minutesInStage)} business time`],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="flex h-9 min-w-0 items-center truncate px-2.5">{v ?? <span className="text-faint">—</span>}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Brief */}
          <section className={section}>
            <h3 className={sectionTitle}>Brief</h3>
            {(ticket.audience || ticket.sizes.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {ticket.sizes.map((s) => (
                  <span key={s} className="tabular rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                    {s.replace("x", ":")}
                  </span>
                ))}
                {ticket.audience && <span className="text-muted">{ticket.audience}</span>}
              </div>
            )}
            {ticket.brief ? (
              <p className="whitespace-pre-wrap rounded-[10px] border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted">{ticket.brief}</p>
            ) : (
              <p className="text-sm text-faint">No brief written.</p>
            )}
            {ticket.refs.length > 0 && (
              <ul className="grid gap-1.5">
                {ticket.refs.map((r) => (
                  <li key={r} className="truncate text-sm">
                    <a href={r} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                      {r}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Deliverables */}
          <section className={section}>
            <div className="flex items-baseline justify-between">
              <h3 className={sectionTitle}>Deliverables</h3>
              <span className="text-xs text-faint">{ticket.quantity} expected</span>
            </div>
            <div className="grid place-items-center gap-1 rounded-[10px] border border-dashed border-line px-6 py-9 text-center">
              <p className="text-sm text-muted">Uploads land here</p>
              <p className="text-xs text-faint">Drag-and-drop uploads with versions arrive in the next step.</p>
            </div>
          </section>

          {/* Activity */}
          <section className="grid gap-4">
            <h3 className={sectionTitle}>Activity</h3>
            {history === null ? (
              <p className="text-xs text-faint">Loading…</p>
            ) : (
              <ol className="relative grid gap-5 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line">
                {history.map((e) => (
                  <li key={e.id} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    {e.actor ? <PersonAvatar name={e.actor} size={28} /> : <span className="h-7 w-7 rounded-full bg-surface-2" />}
                    <div className="grid min-w-0 gap-1.5 pt-1">
                      <p className="text-sm leading-snug text-muted">
                        <span className="font-medium text-fg">{e.actor ?? "Kaizen Ads"}</span> {describe(e)}
                        <span className="ml-2 whitespace-nowrap text-xs text-faint">{fmtDate(e.at)}</span>
                      </p>
                      {e.body && <p className="whitespace-pre-wrap rounded-[8px] bg-surface px-3.5 py-2.5 text-sm leading-relaxed">{e.body}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) run(() => commentTicket(ticket.id, comment), () => setComment(""));
              }}
              className="mt-1 flex gap-2"
            >
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Write a comment…"
                aria-label="Comment"
                className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-surface px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
              <button disabled={pending || !comment.trim()} className="h-10 rounded-brand bg-surface-2 px-4 text-sm hover:bg-line disabled:opacity-50">
                Post
              </button>
            </form>
          </section>

          <Link href={`/clients/${ticket.clientSlug}`} className="border-t border-line pt-5 text-xs text-muted hover:text-fg">
            {ticket.clientName} client page →
          </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}
