"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { businessDuration, stageInfo, type Priority } from "@/lib/stages";
import { assignTicket, commentTicket, deleteTicket, setTicketDue, setTicketPriority, type ActionResult, type TicketEvent } from "./actions";
import type { Person, Ticket } from "./types";

// The ticket's Activity, behind "More": its settings (who has it, due, priority), what happened, and comments.

/** Comment text with its links as short, clickable labels instead of long raw URLs (an Ads Manager link reads
 *  "Open in Ads Manager") */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((part, i) => {
    if (!/^https?:\/\//.test(part)) return part;
    let label = part;
    try {
      const u = new URL(part);
      label = u.pathname.startsWith("/adsmanager") ? "Open in Ads Manager" : u.hostname.replace(/^www\./, "");
    } catch {}
    return (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-2 hover:underline">
        {label} ↗
      </a>
    );
  });
}

export const fmtDate = (iso: string) =>
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
      if (e.data.action === "deleted") return <span className="text-bad">deleted the ticket</span>;
      if (e.data.action === "restored") return <span className="text-ok">restored the ticket</span>;
      return (
        <>
          moved it to <span className="text-fg">{e.toStage ? stageInfo(e.toStage).label : "another stage"}</span>
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
    case "upload":
      if (e.data.action === "rejoined")
        return (
          <>
            rejoined <span className="text-fg">#{String(e.data.from)}</span>, the client-approved part, now that both are in the same stage
          </>
        );
      if (e.data.action === "counts" && e.data.auto)
        return (
          <>
            counts went up to <span className="text-fg">{String(e.data.new)} new{Number(e.data.variations) ? ` + ${String(e.data.variations)} var.` : ""}</span>{" "}
            <span className="text-faint">(more designs were added than asked for)</span>
          </>
        );
      if (e.data.action === "counts")
        return (
          <>
            changed the ticket to{" "}
            <span className="text-fg">
              {String(e.data.new)} new{Number(e.data.variations) ? ` + ${String(e.data.variations)} variation${Number(e.data.variations) === 1 ? "" : "s"}` : ""}
            </span>{" "}
            <span className="text-faint">
              (was {String(e.data.from_new)} new{Number(e.data.from_variations) ? ` + ${String(e.data.from_variations)}` : ""})
            </span>
          </>
        );
      return e.data.version ? (
        <>
          uploaded <span className="text-fg">v{e.data.version}</span> of {e.data.design}
        </>
      ) : (
        `uploaded ${String(e.data.designs) === "1" ? "a design" : `${e.data.designs} designs`}`
      );
    case "review":
      switch (e.data.action ?? e.data.decision) {
        case "approve":
          return <>approved the creative</>;
        case "changes":
          return <>sent the creative back with changes</>;
        case "dismissed":
          return (
            <>
              dismissed an AI <span className={e.data.severity === "block" ? "text-bad" : "text-warn"}>{e.data.severity === "block" ? "must fix" : "heads up"}</span> on the request
            </>
          );
        case "ai_fixed":
          return <>let the AI fix a review note on the request</>;
        case "continued_past_similar":
          return (
            <>
              went ahead although <span className="text-fg">#{e.data.ticket}</span> looked similar
            </>
          );
        case "stronger_brief":
          return <>used the AI&apos;s stronger brief</>;
        case "client_split":
          return (
            <>
              split off what the client approved on <span className="text-fg">#{String(e.data.from)}</span> to launch it first
            </>
          );
        case "client_approved":
          return (
            <>
              <span className="text-ok">client approved</span>
              {e.data.by_name ? <span className="text-faint"> · {String(e.data.by_name)}</span> : null}
            </>
          );
        case "client_revise":
          return (
            <>
              <span className="text-warn">client asked for changes</span> to the {Array.isArray(e.data.targets) ? (e.data.targets as string[]).join(" and ") : "ad"}
              {e.data.by_name ? <span className="text-faint"> · {String(e.data.by_name)}</span> : null}
            </>
          );
        default:
          return "reviewed it";
      }
    case "client_notice":
      // A post or reminder to the client, customer success taking it on, or the automatic approval
      return <span className={e.data.action === "escalated" ? "text-warn" : e.data.action === "auto_approved" ? "text-ok" : undefined}>{String(e.data.line ?? "notified the client")}</span>;
    case "copy":
      if (e.data.action === "revised_for_client") return e.data.scope === "rewrite" ? "rewrote the copy for the client's notes (AI)" : "amended the copy for the client's notes (AI)";
      return e.data.action === "drafted" ? "drafted the copy with the AI" : e.data.action === "redrafted" ? "rewrote the copy with the AI" : e.data.action === "reused" ? "reused approved copy" : "approved the copy";
  }
}

const sectionTitle = "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint";
const control =
  "h-9 w-full min-w-0 rounded-brand border border-transparent bg-transparent px-2.5 text-sm text-fg outline-none transition-colors hover:border-line hover:bg-surface-2 focus:border-brand-text/60 disabled:opacity-60 max-md:h-11 max-md:border-line/60 max-md:bg-surface";

export function TicketActivity({
  ticket,
  people,
  history,
  pending,
  run,
  canDelete,
  readOnly = false,
  onClose,
}: {
  ticket: Ticket;
  people: Person[];
  history: TicketEvent[] | null;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, after?: () => void) => void;
  canDelete: boolean;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 max-md:gap-5">
      <section className="grid gap-3">
        <h3 className={sectionTitle}>Details</h3>
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm max-md:grid-cols-[96px_minmax(0,1fr)] max-md:gap-x-3 max-md:gap-y-2">
          <dt className="text-muted">Assigned to</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <PersonAvatar name={ticket.assigneeName ?? "?"} size={22} muted={!ticket.assigneeName} />
            <select aria-label="Assigned to" value={ticket.assigneeId ?? ""} disabled={pending || readOnly} onChange={(e) => run(() => assignTicket(ticket.id, e.target.value || null))} className={control}>
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
              disabled={pending || !ticket.stageDueAt || readOnly}
              onBlur={(e) => e.target.value && e.target.value !== toLocalInput(ticket.stageDueAt) && run(() => setTicketDue(ticket.id, fromLocalInput(e.target.value)))}
              className={control}
            />
          </dd>

          <dt className="text-muted">Priority</dt>
          <dd className="flex gap-1 px-1 py-1 max-md:px-0">
            {(["normal", "high", "urgent"] as Priority[]).map((p) => (
              <button
                key={p}
                disabled={pending || readOnly}
                onClick={() => p !== ticket.priority && run(() => setTicketPriority(ticket.id, p))}
                aria-pressed={ticket.priority === p}
                className={`h-7 rounded-full px-3 text-xs capitalize transition-colors disabled:opacity-60 max-md:h-11 max-md:flex-1 max-md:text-sm ${
                  ticket.priority === p ? (p === "urgent" ? "bg-bad-soft text-bad" : p === "high" ? "bg-warn-soft text-warn" : "bg-surface-2 text-fg") : "text-faint hover:bg-surface-2 hover:text-fg"
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
            ["Revisions", (ticket.internalRounds ?? 0) > 0 || (ticket.clientRounds ?? 0) > 0 ? `${ticket.internalRounds ?? 0} internal, ${ticket.clientRounds ?? 0} client` : null],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className={`flex h-9 min-w-0 items-center truncate px-2.5 ${k === "Revisions" && (ticket.clientRounds ?? 0) >= 2 ? "text-warn" : ""}`}>{v ?? <span className="text-faint">None</span>}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-4">
        <h3 className={sectionTitle}>Activity</h3>
        {history === null ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : (
          <ol className="relative grid gap-5 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line">
            {history.map((e) => (
              <li key={e.id} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                {e.actor ? (
                  <PersonAvatar name={e.actor} size={28} />
                ) : (
                  <span className="relative grid h-7 w-7 place-items-center rounded-full border border-line bg-surface">
                    <Image src="/kaizen-mark.png" alt="Kaizen Ads" width={18} height={18} />
                  </span>
                )}
                <div className="grid min-w-0 gap-1.5 pt-1">
                  <p className="text-sm leading-snug text-muted">
                    <span className="font-medium text-fg">{e.actor ?? "Kaizen Ads"}</span> {describe(e)}
                    <span className="ml-2 whitespace-nowrap text-xs text-faint">{fmtDate(e.at)}</span>
                  </p>
                  {e.body && <p className="whitespace-pre-wrap rounded-[8px] bg-surface px-3.5 py-2.5 text-sm leading-relaxed">{linkify(e.body)}</p>}
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
            className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-surface px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 max-md:h-11"
          />
          <button disabled={pending || !comment.trim()} className="h-10 rounded-brand bg-surface-2 px-4 text-sm hover:bg-line disabled:opacity-50 max-md:h-11">
            Post
          </button>
        </form>
      </section>

      <div className="grid gap-3 border-t border-line pt-5">
        <Link href={`/clients/${ticket.clientSlug}`} className="justify-self-start text-xs text-muted hover:text-fg max-md:py-3">
          {ticket.clientName} client page →
        </Link>
        {canDelete && !readOnly && <DeleteTicket ticket={ticket} onDeleted={onClose} />}
      </div>
    </div>
  );
}

/** Execs and leads: delete the ticket, with a reason. It goes to Settings → Deleted, where it can be restored. */
function DeleteTicket({ ticket, onDeleted }: { ticket: Ticket; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="justify-self-start text-xs text-faint hover:text-bad max-md:-my-3 max-md:py-3">
        Delete ticket
      </button>
    );
  return (
    <section className="grid gap-3 rounded-[12px] border border-bad/30 bg-bad-soft/30 p-4">
      <p className="text-sm font-medium">
        Delete #{ticket.number} · {ticket.title}?
      </p>
      <p className="text-xs text-muted">It disappears from the board, the client&apos;s page and portal, and gives its creative back to the allotment. An exec or lead can restore it from Settings → Deleted.</p>
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? e.g. Duplicate of #1044"
        className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-bad/60 max-md:h-11"
      />
      <div className="flex items-center gap-2 max-md:[&>button]:h-11 max-md:[&>button]:flex-1">
        <button
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await deleteTicket(ticket.id, reason);
            setBusy(false);
            if (!r.ok) return setError(r.error);
            onDeleted();
            router.refresh();
          }}
          className="h-9 max-md:h-11 rounded-brand bg-bad px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Delete ticket"}
        </button>
        <button onClick={() => (setOpen(false), setReason(""))} className="h-9 max-md:h-11 rounded-brand px-3 text-sm text-muted hover:text-fg">
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
