"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { closeParams, pushParams, replaceParams } from "@/lib/url-state";
import { parseCompletedFilters } from "@/lib/ticket-completion";
import { FORMAT_LABEL, type Format } from "@/lib/stages";
import { completedTickets, type CompletedTicket } from "./ticket-done-actions";
import { ClientTag, FormatIcon } from "./ticket-card";
import type { ClientOption } from "./types";

const fmtDay = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(iso));
const RANGES: [string, string][] = [
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["all", "All time"],
];

/**
 * Completed tasks: a log of the tickets that went live (or were completed by hand), newest first, with search and
 * filters by client, format and date, all in the address. Each one opens read-only.
 */
export function CompletedLog({ clients, onOpen, onClose }: { clients: ClientOption[]; onOpen: (t: CompletedTicket) => void; onClose: () => void }) {
  const params = useSearchParams();
  const f = parseCompletedFilters((k) => params.get(k));
  const [rows, setRows] = useState<CompletedTicket[] | null>(null);
  const key = `${f.q}|${f.client ?? ""}|${f.format ?? ""}|${f.range}`;

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => void completedTickets(parseCompletedFilters((k) => new URLSearchParams(window.location.search).get(k))).then((r) => live && setRows(r)), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !new URLSearchParams(window.location.search).has("t") && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const chip = (on: boolean) => `min-h-11 shrink-0 rounded-full px-3.5 text-xs transition-colors md:min-h-9 ${on ? "bg-fg text-bg" : "border border-line text-muted hover:border-faint hover:text-fg"}`;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Completed tasks">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <aside className="relative flex h-full w-full max-w-[640px] flex-col border-l border-line bg-bg shadow-2xl animate-[drawer-right_.25s_cubic-bezier(.2,.8,.2,1)] max-md:border-l-0">
        <header className="grid gap-3 border-b border-line px-7 pb-4 pt-5 max-md:px-4 max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-heading text-[22px] leading-tight">Completed tasks</h2>
              <p className="text-xs text-muted">Tickets that went live, newest first. Each opens read-only.</p>
            </div>
            <button onClick={onClose} aria-label="Close completed tasks" className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
              ✕
            </button>
          </div>
          <input
            defaultValue={f.q}
            onChange={(e) => replaceParams({ cq: e.target.value || null })}
            placeholder="Search title or #"
            aria-label="Search completed tasks"
            className="h-11 w-full rounded-full border border-line bg-surface px-4 text-sm outline-none placeholder:text-faint focus:border-brand-text max-md:text-base"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Client"
              value={f.client ?? ""}
              onChange={(e) => pushParams({ cclient: e.target.value || null })}
              className="h-11 min-w-0 max-w-[50%] rounded-full border border-line bg-surface px-3.5 text-xs text-fg outline-none md:h-9"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1">
              {(["image", "video", "carousel"] as Format[]).map((x) => (
                <button key={x} type="button" aria-pressed={f.format === x} onClick={() => pushParams({ cformat: f.format === x ? null : x })} className={chip(f.format === x)}>
                  {FORMAT_LABEL[x]}
                </button>
              ))}
            </div>
          </div>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1" role="radiogroup" aria-label="When">
            {RANGES.map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={f.range === k} onClick={() => pushParams({ crange: k === "30" ? null : k })} className={chip(f.range === k)}>
                {l}
              </button>
            ))}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:px-4">
          {rows === null ? (
            <ul className="grid gap-2">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-16 animate-pulse rounded-[14px] bg-surface" />
              ))}
            </ul>
          ) : rows.length === 0 ? (
            <div className="grid place-items-center gap-1 py-16 text-center">
              <p className="font-heading text-lg">Nothing completed here</p>
              <p className="text-sm text-muted">Try another client, format or a longer stretch of time.</p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {rows.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onOpen(t)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-faint">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-ok/15 text-ok">
                      <FormatIcon format={t.format} />
                    </span>
                    <span className="grid min-w-0 gap-1">
                      <span className="truncate text-sm font-medium">{t.title}</span>
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                        <span className="tabular text-faint">#{t.number}</span>
                        <ClientTag name={t.clientName} small />
                      </span>
                    </span>
                    <span className="tabular text-xs text-faint">{fmtDay(t.completedAt)}</span>
                  </button>
                </li>
              ))}
              {rows.length >= 200 && <li className="pt-2 text-center text-xs text-faint">The 200 most recent: search or filter to find older ones.</li>}
            </ul>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** Close the log and everything it holds in the address */
export const closeCompleted = () => closeParams("completed", "cq", "cclient", "cformat", "crange");
