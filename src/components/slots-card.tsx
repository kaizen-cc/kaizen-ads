"use client";

import { useState } from "react";
import { bookSlot, moreSlots } from "@/app/(team)/assistant/meeting-actions";
import type { CallSlots } from "@/lib/agent-call/core";

// Times for an internal call as cards (find_meeting_time), the same on a call, in the assistant's chat and in Kaizen
// AI: each slot shows the day, date, time range, length and who's on it. A tap opens the confirm step (title, who,
// Meet on); one more tap books it on the person's own calendar and sends the invite. More times shows the next batch.
// A spoken yes books it too: the card arrives again, booked.

type Option = CallSlots["options"][number];

const CalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
    <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
  </svg>
);

export function SlotsCard({ slots, onDismiss, onBooked, wide = true }: { slots: CallSlots; onDismiss?: () => void; /** Told once it's booked from here (so the assistant knows) */ onBooked?: (label: string) => void; wide?: boolean }) {
  const [s, setS] = useState(slots);
  const [pick, setPick] = useState<Option | null>(null);
  const [title, setTitle] = useState(slots.title);
  const [busy, setBusy] = useState<"book" | "more" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const who = s.attendees.join(", ");

  const book = async () => {
    if (!pick) return;
    setBusy("book");
    setErr(null);
    const r = await bookSlot(s.proposalId, pick.start, title.trim() || null);
    setBusy(null);
    if (!r.ok) return setErr(r.error);
    setS(r.slots);
    setPick(null);
    if (!r.already && r.slots.booked) onBooked?.(r.slots.booked.label);
  };
  const more = async () => {
    setBusy("more");
    setErr(null);
    const r = await moreSlots(s.proposalId);
    setBusy(null);
    if (!r.ok) return setErr(r.error);
    setS(r.slots);
  };

  return (
    <li className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-[16px] border border-line bg-surface p-3 shadow-sm ${wide ? "sm:col-span-2" : ""}`} aria-label={s.title}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${s.status === "booked" ? "bg-ok/15 text-ok" : "bg-brand-soft text-brand-text"}`}>
            <CalIcon />
          </span>
          <div className="min-w-0">
            <p className={`text-[11px] uppercase tracking-[0.14em] ${s.status === "booked" ? "text-ok" : "text-brand-text"}`}>{s.status === "booked" ? "Booked" : pick ? "Confirm the call" : "Pick a time"}</p>
            <p className="text-[14px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">{s.status === "booked" ? s.title : pick ? `${pick.day}, ${pick.date}` : s.title}</p>
            <p className="text-[12px] leading-snug text-muted [overflow-wrap:anywhere]">
              {s.minutes} min · with {who}
            </p>
          </div>
        </div>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label={`Hide ${s.title}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg md:h-8 md:w-8">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {s.status === "booked" && s.booked ? (
        <div className="grid gap-2">
          <p className="text-[13.5px] text-fg">
            {s.booked.label}. The invite went to {who}
            {s.booked.meet ? ", with a Google Meet link." : "."}
          </p>
          <div className="flex min-w-0 flex-wrap gap-2">
            {s.booked.link && (
              <a href={s.booked.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-9">
                Open in Calendar
              </a>
            )}
            {s.booked.meet && (
              <a href={s.booked.meet} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint md:min-h-9">
                Meet link
              </a>
            )}
          </div>
        </div>
      ) : pick ? (
        <div className="grid gap-3">
          <div className="rounded-[12px] border border-line bg-surface-2/40 px-3 py-2.5">
            <p className="text-[15px] font-semibold tabular-nums text-fg">{pick.range}</p>
            <p className="text-[12px] text-muted">
              {pick.day}, {pick.date} · {s.minutes} min
            </p>
          </div>
          <label className="grid gap-1">
            <span className="text-[12px] text-muted">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} className="min-h-11 w-full min-w-0 rounded-[12px] border border-line bg-surface px-3 text-[16px] text-fg outline-none focus:border-faint md:min-h-9 md:text-[13.5px]" />
          </label>
          <div className="grid gap-1 text-[12.5px] text-muted">
            <p>
              <span className="text-faint">Who:</span> you, {who}
            </p>
            <p className="flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
              Google Meet link on
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy !== null} onClick={() => setPick(null)} className="inline-flex min-h-11 items-center rounded-full px-4 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50 md:min-h-9">
              Other times
            </button>
            <button type="button" disabled={busy !== null || !title.trim()} onClick={book} className="inline-flex min-h-11 items-center rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 md:min-h-9">
              {busy === "book" ? "Booking…" : "Book and send invite"}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          {s.options.length ? (
            <ul className="grid min-w-0 gap-2" aria-label="Times that work">
              {s.options.map((o) => (
                <li key={o.start}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setErr(null);
                      setPick(o);
                    }}
                    className="flex min-h-14 w-full min-w-0 items-center justify-between gap-3 rounded-[12px] border border-line bg-surface-2/40 px-3 py-2 text-left transition hover:border-faint active:scale-[0.99] disabled:opacity-50"
                  >
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-fg">{o.day}</span>
                      <span className="block text-[12px] text-muted">{o.date}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[14px] font-semibold tabular-nums text-fg">{o.range}</span>
                      <span className="block text-[11.5px] text-faint">{s.minutes} min</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No more times that work for everyone in the next two weeks. Try a shorter call, or ask for other days.</p>
          )}
          {s.more && (
            <button type="button" disabled={busy !== null} onClick={more} className="inline-flex min-h-11 items-center justify-self-start rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9">
              {busy === "more" ? "Looking…" : "More times"}
            </button>
          )}
        </div>
      )}

      {err && (
        <p role="alert" className="text-[12px] text-bad [overflow-wrap:anywhere]">
          {err}
        </p>
      )}
    </li>
  );
}
