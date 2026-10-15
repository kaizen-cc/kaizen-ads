"use client";

import { PersonAvatar } from "@/components/person-avatar";
import { tintFor } from "@/lib/colors";
import { businessDuration, FORMAT_LABEL, health, type Health } from "@/lib/stages";
import type { Ticket } from "./types";

const STAMP: Record<Health, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad shadow-[0_0_18px_-4px_rgba(224,80,92,0.7)]",
};
const EDGE: Record<Health, string> = { ok: "before:bg-transparent", warn: "before:bg-warn", bad: "before:bg-bad" };

export function FormatIcon({ format, size = 14 }: { format: Ticket["format"]; size?: number }) {
  const d =
    format === "video"
      ? "M4 6h11v12H4zM15 10l5-3v10l-5-3"
      : format === "carousel"
        ? "M7 5h10v14H7zM3 7v10M21 7v10"
        : "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-label={FORMAT_LABEL[format]}>
      <path d={d} />
    </svg>
  );
}

export function ClientTag({ name, small = false }: { name: string; small?: boolean }) {
  const tint = tintFor(name);
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full font-medium ${small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"}`}
      style={{ background: `${tint}1f`, color: tint }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tint }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function TimeStamp({ ticket, label = false }: { ticket: Ticket; label?: boolean }) {
  const h = health(ticket.minutesOver, ticket.stage);
  const text = businessDuration(ticket.minutesInStage);
  const title =
    h === "ok"
      ? `${text} in this stage · within turnaround`
      : `${text} in this stage · ${businessDuration(ticket.minutesOver)} over turnaround`;
  return (
    <span title={title} className={`tabular inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STAMP[h]}`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" />
      </svg>
      {text}
      {label && h !== "ok" && <span className="font-normal opacity-80">· {businessDuration(ticket.minutesOver)} over</span>}
    </span>
  );
}

export function TicketCard({
  ticket,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  ticket: Ticket;
  onOpen: () => void;
  dragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const h = health(ticket.minutesOver, ticket.stage);
  return (
    <button
      type="button"
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`group relative grid w-full gap-2.5 overflow-hidden rounded-brand border border-line bg-surface p-3 text-left transition duration-150 before:absolute before:inset-y-0 before:left-0 before:w-[3px] hover:-translate-y-px hover:border-faint hover:shadow-[0_10px_30px_-12px_rgba(0,0,0,0.8)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text ${EDGE[h]} ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <ClientTag name={ticket.clientName} small />
        <span className="flex shrink-0 items-center gap-1.5 text-faint">
          {ticket.priority !== "normal" && (
            <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${ticket.priority === "urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
              {ticket.priority}
            </span>
          )}
          <FormatIcon format={ticket.format} />
        </span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-snug">{ticket.title}</p>
      {ticket.parentNumber && <p className="-mt-1 text-[11px] text-ok">Client-approved part of #{ticket.parentNumber}</p>}
      {((ticket.internalRounds ?? 0) > 0 || (ticket.clientRounds ?? 0) > 0) && (
        <p className="-mt-1 flex flex-wrap gap-1 text-[10.5px]" title="Revision rounds: sent back by the Head of Creative (internal) and by the client">
          {(ticket.internalRounds ?? 0) > 0 && <span className="rounded-full bg-surface-2 px-1.5 py-px text-muted">{ticket.internalRounds} internal rev</span>}
          {(ticket.clientRounds ?? 0) > 0 && (
            <span className={`rounded-full px-1.5 py-px ${(ticket.clientRounds ?? 0) >= 2 ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand-text"}`}>
              client round {ticket.clientRounds}
            </span>
          )}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          {ticket.assigneeName ? (
            <>
              <PersonAvatar name={ticket.assigneeName} size={20} />
              <span className="truncate">{ticket.assigneeName.split(" ")[0]}</span>
            </>
          ) : ticket.stage === "copy" ? (
            <span className="text-[#9aa7f0]">AI writing</span>
          ) : (
            <span className="text-faint">Unassigned</span>
          )}
        </span>
        <TimeStamp ticket={ticket} />
      </div>
    </button>
  );
}
