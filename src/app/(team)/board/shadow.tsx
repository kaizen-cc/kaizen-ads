"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { ShadowTicket } from "@/lib/asana";
import { stageInfo } from "@/lib/stages";

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** An Asana task on the board: an outline card, not a ticket yet. It moves when it moves in Asana. */
export function ShadowCard({ s, onOpen }: { s: ShadowTicket; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid gap-2 rounded-brand border border-dashed border-faint/50 bg-transparent p-3 text-left transition-colors hover:border-fg/40 hover:bg-surface/40 max-md:p-3.5 max-md:active:bg-surface/40"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted md:text-[10px]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#f06a6a]" />
          In Asana
        </span>
        {s.priority && /high|urgent/i.test(s.priority) && <span className="rounded-full bg-bad-soft px-1.5 py-0.5 text-[11px] text-bad md:text-[10px]">{s.priority}</span>}
      </span>
      <span className="line-clamp-3 text-[13px] leading-snug text-muted">{s.name}</span>
      {s.section && s.section.trim().toLowerCase() !== stageInfo(s.stage).label.toLowerCase() && <span className="text-[11px] text-faint md:text-[10px]">Asana: {s.section}</span>}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
        <span className="truncate">{s.clientName ?? (s.clientRef ? `Client ${s.clientRef}` : "Client not matched")}</span>
        {s.assignee && <span>· {s.assignee.split(" ")[0]}</span>}
        {s.dueOn && <span>· due {day(s.dueOn)}</span>}
      </span>
    </button>
  );
}

/** The Asana task in full, and the way into Kaizen Ads at the stage it's reached. */
export function ShadowSheet({ s, canMigrate, onClose }: { s: ShadowTicket; canMigrate: boolean; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const fields = Object.entries(s.fields);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="grid h-full w-full max-w-xl content-start gap-6 overflow-y-auto border-l border-line bg-bg p-6 animate-[drawer-right_.25s_ease] max-md:border-l-0 max-md:overscroll-contain max-md:px-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-2 max-md:min-w-0 max-md:[overflow-wrap:anywhere]">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-[#f06a6a]" />
              Mirrored from Asana · not a Kaizen Ads ticket yet
            </span>
            <h2 className="font-heading text-xl leading-snug">{s.name}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-2 text-lg text-faint hover:text-fg max-md:-mr-2 max-md:grid max-md:h-11 max-md:w-11 max-md:shrink-0 max-md:place-items-center max-md:px-0 max-md:text-2xl" aria-label="Close">
            ×
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line text-sm max-md:[overflow-wrap:anywhere]">
          {[
            ["Asana column", s.section ?? "—"],
            ["Lands in", stageInfo(s.stage).label],
            ["Client", s.clientName ?? (s.clientRef ? `Client ID ${s.clientRef} (not matched)` : "Not matched")],
            ["Assigned", s.assignee ?? "Nobody"],
            ["Due", s.dueOn ? day(s.dueOn) : "—"],
            ["Format", s.format ?? "—"],
          ].map(([k, v]) => (
            <div key={k} className="grid gap-0.5 bg-surface px-4 py-3">
              <dt className="text-[11px] text-faint">{k}</dt>
              <dd className="capitalize-first">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-3 rounded-[14px] border border-line bg-surface p-4">
          <p className="text-sm font-medium">Move it into Kaizen Ads</p>
          <p className="text-[13px] leading-relaxed text-muted">
            It becomes a real ticket in <b className="text-fg">{stageInfo(s.stage).label}</b>, where it&apos;s up to in Asana. The request form opens filled in from this task and asks only for what&apos;s
            missing for that stage. After that it&apos;s worked here, with the AI, turnarounds and the allotment.
          </p>
          {canMigrate ? (
            <Link href={`/requests/new?asana=${s.gid}`} className="justify-self-start rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover max-md:grid max-md:h-12 max-md:w-full max-md:place-items-center max-md:justify-self-stretch">
              Migrate to Kaizen Ads →
            </Link>
          ) : (
            <p className="text-xs text-faint">The person it&apos;s assigned to, a lead or an exec can migrate it.</p>
          )}
        </div>

        {s.notes && (
          <div className="grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-faint">The request in Asana</p>
            <p className="whitespace-pre-wrap rounded-[12px] border border-line bg-surface p-4 text-[13px] leading-relaxed text-muted">{s.notes}</p>
          </div>
        )}
        {fields.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Asana fields</p>
            <dl className="grid gap-1 text-[13px]">
              {fields.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 max-md:[overflow-wrap:anywhere] md:grid-cols-[140px_minmax(0,1fr)]">
                  <dt className="text-faint">{k}</dt>
                  <dd className="text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {s.moves.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Moves seen in Asana</p>
            <ul className="grid gap-1 text-xs text-muted">
              {s.moves
                .slice()
                .reverse()
                .map((m, i) => (
                  <li key={i}>
                    {new Date(m.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: {m.from ?? "?"} → {m.to ?? "?"}
                  </li>
                ))}
            </ul>
          </div>
        )}
        <a href={s.url} target="_blank" rel="noreferrer" className="justify-self-start text-sm text-muted hover:text-fg max-md:py-3">
          Open in Asana ↗
        </a>
      </aside>
    </div>
  );
}
