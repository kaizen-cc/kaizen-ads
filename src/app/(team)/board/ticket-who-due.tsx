"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TeammatePicker } from "@/components/teammate-picker";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { dueChips, fromEtLocal, toEtLocal } from "@/lib/ticket-edit-core";
import { assignTicket, setTicketDue, type ActionResult } from "./actions";
import { fmtDate } from "./ticket-activity";
import type { Person, Ticket } from "./types";

// "with Nelson · Due Mon, Nov 30" on a ticket, editable right there like Asana (owner, Nov 26 2026): a tap opens the
// teammate picker or the date and time with quick picks, and it saves on change. Leads, execs and the person it's with
// can edit; everyone else reads it. The sheet is in the address (?tedit=who|due), so Back closes it.

export function TicketWhoDue({ ticket, people, who, canEdit, run }: { ticket: Ticket; people: Person[]; who: string | null; canEdit: boolean; run: (fn: () => Promise<ActionResult>, after?: () => void) => void }) {
  const open = useParam("tedit");
  // What was just picked shows at once; the ticket catches up when the board reloads
  const [shown, setShown] = useState<{ who?: { id: string | null; name: string | null }; due?: string | null }>({});
  const [seen, setSeen] = useState({ a: ticket.assigneeId, d: ticket.stageDueAt });
  if (seen.a !== ticket.assigneeId || seen.d !== ticket.stageDueAt) {
    setSeen({ a: ticket.assigneeId, d: ticket.stageDueAt });
    setShown({});
  }
  const name = shown.who ? shown.who.name : who;
  const assigneeId = shown.who ? shown.who.id : ticket.assigneeId;
  const due = shown.due !== undefined ? shown.due : ticket.stageDueAt;
  const close = () => closeParams("tedit");

  const pick = (id: string) => {
    if (!id || id === assigneeId) return close();
    const p = people.find((x) => x.id === id);
    setShown((s) => ({ ...s, who: { id, name: p?.name ?? null } }));
    close();
    run(() => assignTicket(ticket.id, id));
  };
  const setDue = (iso: string | null) => {
    setShown((s) => ({ ...s, due: iso }));
    run(() => setTicketDue(ticket.id, iso));
  };

  const chip = "inline-flex min-h-11 items-center gap-1 rounded-full px-2 -mx-2 text-muted underline decoration-dotted decoration-line underline-offset-4 transition-colors hover:bg-surface-2 hover:text-fg md:min-h-7";
  // By role, then name (the board's people carry their role's label)
  const sorted = useMemo(() => [...people].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)), [people]);
  return (
    <>
      {canEdit ? (
        <button type="button" onClick={() => pushParams({ tedit: "who" })} className={chip} aria-label={name ? `With ${name}. Change who it's with` : "Assign someone"}>
          {name ? <>with {name}</> : "Assign someone"}
        </button>
      ) : (
        name && <span className="text-muted">with {name}</span>
      )}
      {canEdit ? (
        <button type="button" onClick={() => pushParams({ tedit: "due" })} className={`${chip} tabular`} aria-label={due ? `Due ${fmtDate(due)}. Change the due date` : "Set a due date"}>
          {due ? <>Due {fmtDate(due)}</> : "Set due date"}
        </button>
      ) : (
        due && <span className="tabular text-muted">Due {fmtDate(due)}</span>
      )}
      {canEdit && open === "who" && (
        <Sheet title={`Who's #${ticket.number} with?`} onClose={close}>
          <TeammatePicker people={sorted} value={assigneeId ?? ""} onChange={pick} label="Hand it to" />
          <p className="text-[12px] text-muted">They get a notice that it&apos;s on them, and the Asana task follows.</p>
        </Sheet>
      )}
      {canEdit && open === "due" && <DueSheet number={ticket.number} due={due} onSet={setDue} onClose={close} />}
    </>
  );
}

function DueSheet({ number, due, onSet, onClose }: { number: number; due: string | null; onSet: (iso: string | null) => void; onClose: () => void }) {
  const chips = useMemo(() => dueChips(new Date(), due), [due]);
  const [value, setValue] = useState(toEtLocal(due));
  // Saves on change: a typed date and time settles for a moment before it's written (not on every digit)
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  const typed = (v: string) => {
    setValue(v);
    if (timer.current) window.clearTimeout(timer.current);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return;
    timer.current = window.setTimeout(() => {
      const iso = fromEtLocal(v);
      if (iso !== due) onSet(iso);
    }, 700);
  };
  const same = (iso: string) => due && Math.abs(Date.parse(iso) - Date.parse(due)) < 60_000;
  return (
    <Sheet title={`When is #${number} due?`} onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={Boolean(same(c.iso))}
            onClick={() => {
              setValue(toEtLocal(c.iso));
              onSet(c.iso);
              onClose();
            }}
            className={`min-h-11 rounded-full border px-4 text-[14px] transition-colors md:min-h-9 md:text-[13px] ${same(c.iso) ? "border-fg bg-fg text-bg" : "border-line text-fg hover:bg-surface-2"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <label className="grid gap-1 text-[12px] text-muted">
        Date and time (Eastern)
        <input type="datetime-local" value={value} onChange={(e) => typed(e.target.value)} className="h-11 w-full min-w-0 rounded-brand border border-line bg-transparent px-3 text-[16px] text-fg outline-none focus:border-fg/40 md:text-[14px]" />
      </label>
      <div className="flex items-center gap-3">
        {due && (
          <button
            type="button"
            onClick={() => {
              setValue("");
              onSet(null);
              onClose();
            }}
            className="min-h-11 rounded-full px-3 text-[14px] text-muted hover:bg-surface-2 hover:text-fg md:min-h-9 md:text-[13px]"
          >
            Clear due date
          </button>
        )}
        <button type="button" onClick={onClose} className="ml-auto min-h-11 rounded-full bg-fg px-5 text-[14px] font-medium text-bg md:min-h-9 md:text-[13px]">
          Done
        </button>
      </div>
      <p className="text-[12px] text-muted">Saved as you pick. The Asana task&apos;s due date follows.</p>
    </Sheet>
  );
}

/** Full screen on a phone (safe areas respected), a small centred card on a computer */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[100] grid md:place-items-center md:bg-black/40 md:p-6" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid content-start gap-4 overflow-y-auto overscroll-contain bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] text-fg max-md:h-dvh md:w-full md:max-w-md md:rounded-[20px] md:border md:border-line md:p-5 md:shadow-2xl" style={{ animation: "who-due-in .25s cubic-bezier(.2,.8,.2,1) both" }}>
        <style>{`@keyframes who-due-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-heading text-[18px] leading-tight">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
