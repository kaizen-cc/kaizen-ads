"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionButton } from "@/components/action-form";
import { restoreTicket } from "@/app/(team)/board/actions";

export type DeletedTicket = {
  id: string;
  number: number;
  title: string;
  client: string;
  clientSlug: string;
  format: string;
  stage: string;
  stageLabel: string;
  newCount: number;
  variations: number;
  deletedAt: string;
  deletedBy: string | null;
  reason: string | null;
  createdAt: string;
  brief: string | null;
  angle: string | null;
  audience: string | null;
  sizes: string[];
  refs: string[];
  landing: string | null;
  priority: string | null;
  origin: { kind: string; label: string; link?: string | null } | null;
  designs: number;
  copy: number;
  path: { to: string; at: string }[];
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** A deleted ticket: open it to read the brief and where it got to, then bring it back as it was or start it again as a new ticket. */
export function DeletedTicketRow({ t }: { t: DeletedTicket }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`overflow-hidden rounded-[14px] border bg-surface transition-colors ${open ? "border-faint/60" : "border-line hover:border-faint/50"}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="grid w-full gap-1 px-4 py-4 text-left active:bg-surface-2/60 md:px-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="grid min-w-0 gap-1">
          <p className="truncate text-sm font-medium">
            <span className="text-faint">#{t.number}</span> {t.title}
          </p>
          <p className="text-xs text-muted [overflow-wrap:anywhere]">
            {t.client} · <span className="capitalize">{t.format}</span> · {t.newCount} new{t.variations ? ` + ${t.variations} var.` : ""} · was in <span className="text-fg">{t.stageLabel}</span>
          </p>
          <p className="text-xs text-faint [overflow-wrap:anywhere]">
            Deleted {when(t.deletedAt)}
            {t.deletedBy ? ` by ${t.deletedBy}` : ""}
            {t.reason && <span className="text-muted"> · &ldquo;{t.reason}&rdquo;</span>}
          </p>
        </div>
        <span className="text-xs text-muted">{open ? "Close" : "Open"}</span>
      </button>

      {open && (
        <div className="grid gap-6 border-t border-line bg-bg/40 px-4 py-5 md:px-5 md:py-6">
          {/* Where it got to */}
          <div className="grid gap-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Where it got to</p>
            <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <li className="rounded-full border border-line px-2.5 py-1 text-muted">Requested {when(t.createdAt)}</li>
              {t.path.map((p, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="text-faint">→</span>
                  <span className={`rounded-full border px-2.5 py-1 ${i === t.path.length - 1 ? "border-fg/40 text-fg" : "border-line text-muted"}`}>
                    {p.to} · {when(p.at)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-[11px] text-faint">
              {t.designs} {t.designs === 1 ? "design version" : "design versions"} uploaded · {t.copy ? "copy written" : "no copy yet"}
            </p>
          </div>

          {/* The brief */}
          <div className="grid min-w-0 gap-4 rounded-[14px] border border-line bg-surface p-4 md:p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["Angle", t.angle],
                  ["Audience", t.audience],
                  ["Sizes", t.sizes.map((s) => s.replace("x", ":")).join(", ")],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid gap-0.5">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-faint">{k}</p>
                  <p className="text-sm [overflow-wrap:anywhere]">{v || "—"}</p>
                </div>
              ))}
            </div>
            {t.origin && (
              <p className="text-xs text-muted [overflow-wrap:anywhere]">
                Built on: {t.origin.label}
                {t.origin.link && (
                  <a href={t.origin.link} target="_blank" rel="noreferrer" className="ml-1 inline-flex min-h-11 items-center text-fg hover:underline md:min-h-0">
                    See it ↗
                  </a>
                )}
              </p>
            )}
            <div className="grid gap-1">
              <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Brief</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{t.brief || "No brief written."}</p>
            </div>
            {(t.refs.length > 0 || t.landing) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {t.landing && (
                  <a href={t.landing} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full border border-line px-3.5 text-muted hover:text-fg md:h-auto md:px-2.5 md:py-1">
                    Landing page ↗
                  </a>
                )}
                {t.refs.map((r, i) => (
                  <a key={r} href={r} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full border border-line px-3.5 text-muted hover:text-fg md:h-auto md:px-2.5 md:py-1">
                    Reference {i + 1} ↗
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Bring it back */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid content-between gap-3 rounded-[14px] border border-line bg-surface p-4">
              <div className="grid gap-1">
                <p className="font-heading text-[15px]">Pick it back up</p>
                <p className="text-xs leading-relaxed text-muted">Back in {t.stageLabel}, exactly as it was: files, copy, comments and history.</p>
              </div>
              <ActionButton action={restoreTicket.bind(null, t.id)} label="Restore" confirmText={`Restore #${t.number} to ${t.stageLabel}?`} />
            </div>
            <div className="grid content-between gap-3 rounded-[14px] border border-line bg-surface p-4">
              <div className="grid gap-1">
                <p className="font-heading text-[15px]">New ticket, same brief</p>
                <p className="text-xs leading-relaxed text-muted">Starts fresh through creative with this brief as it is. Opens on the review step.</p>
              </div>
              <Link href={`/requests/new?from=${t.id}&brief=same`} className="inline-flex h-11 items-center justify-center rounded-full bg-fg px-4 text-sm text-bg hover:bg-fg/90 md:h-auto md:justify-self-start md:py-1.5">
                Start it again →
              </Link>
            </div>
            <div className="grid content-between gap-3 rounded-[14px] border border-line bg-surface p-4">
              <div className="grid gap-1">
                <p className="font-heading text-[15px]">New ticket, update the brief</p>
                <p className="text-xs leading-relaxed text-muted">Everything filled in from this one, ready to change before it goes to the team.</p>
              </div>
              <Link href={`/requests/new?from=${t.id}`} className="inline-flex h-11 items-center justify-center rounded-full border border-line px-4 text-sm hover:border-fg/30 md:h-auto md:justify-self-start md:py-1.5">
                Edit and start →
              </Link>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
