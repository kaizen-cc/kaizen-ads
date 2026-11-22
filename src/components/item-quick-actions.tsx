"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { delegateOptions } from "@/app/(team)/delegate-actions";
import { delegateQuickItem, doneQuickItem, snoozeQuickItem, type QuickSnap } from "@/app/(team)/item-actions";
import { CommentButton } from "./item-comments";

// The same four quick actions on every Overview and Today item, wherever it's drawn: Done, Snooze to tomorrow,
// Delegate and Comment. Each one takes the item off this person's screen at once (onGone) and the server's word follows.

export type QuickItem = { key: string; snap: QuickSnap; href?: string | null; dueAt?: string | null; comments?: number; waiting?: boolean };
type Which = "done" | "snooze" | "delegate" | "comment";

const pill = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors sm:min-h-8 sm:px-3 sm:text-[12px] disabled:opacity-50";

export function ItemQuickActions({ item, onGone, hide = [], compact = false, tone = "auto" }: { item: QuickItem; onGone?: (how: Which, note?: string) => void; hide?: Which[]; compact?: boolean; tone?: "auto" | "dark" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (how: Which, fn: () => Promise<unknown>, note?: string) =>
    start(async () => {
      onGone?.(how, note);
      await fn();
      router.refresh();
    });
  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? "" : "pt-1"}`} onClick={(e) => e.stopPropagation()}>
      {!hide.includes("done") && (
        <button type="button" disabled={pending} onClick={() => run("done", () => doneQuickItem(item.key, item.snap))} className={`${pill} bg-fg font-medium text-bg hover:bg-ink/85`}>
          ✓ Done
        </button>
      )}
      {!hide.includes("snooze") && (
        <button type="button" disabled={pending} title="Hide it until tomorrow; it comes back on its own" onClick={() => run("snooze", () => snoozeQuickItem(item.key, item.snap), "Back tomorrow")} className={`${pill} border border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg`}>
          Snooze to tomorrow
        </button>
      )}
      {!hide.includes("delegate") && <DelegatePicker item={item} open={open} setOpen={setOpen} onDone={(to) => onGone?.("delegate", `Delegated to ${to}`)} />}
      {!hide.includes("comment") && <CommentButton tone={tone} target={{ key: item.key, clientId: item.snap.clientId, title: [item.snap.client, item.snap.title].filter(Boolean).join(": "), href: item.href ?? null, dueAt: item.dueAt ?? null }} count={item.comments ?? 0} waiting={item.waiting ?? false} />}
    </div>
  );
}

/** Delegate: pick a teammate (the client's seat holders first), an optional note and due date */
function DelegatePicker({ item, open, setOpen, onDone }: { item: QuickItem; open: boolean; setOpen: (o: boolean) => void; onDone: (to: string) => void }) {
  const router = useRouter();
  const [people, setPeople] = useState<{ id: string; name: string; role: string; onClient: boolean }[] | null>(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () => {
    setOpen(!open);
    if (!people) delegateOptions(item.snap.clientId).then(setPeople).catch(() => setPeople([]));
  };
  const send = () =>
    start(async () => {
      const r = await delegateQuickItem({ key: item.key, snap: item.snap, to, note, due, href: item.href ?? null });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      onDone(r.to);
      router.refresh();
    });
  // The form sits in the flow under the buttons (never floating), so a card or detail panel that clips its overflow grows
  // or scrolls to fit it instead of cutting it off; it's brought into view when it opens
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) form.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const field = "h-11 rounded-brand border border-ink/15 bg-transparent px-2 text-[14px] text-fg sm:h-9 sm:text-[13px]";
  return (
    <span className="contents">
      <button type="button" onClick={toggle} aria-expanded={open} className={`${pill} border border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg`}>
        Delegate
      </button>
      {open && (
        <div ref={form} className="order-last mt-1 grid w-full basis-full scroll-my-4 gap-2 rounded-2xl border border-ink/15 bg-deep p-3 sm:max-w-sm">
          <label className="grid gap-1 text-[12px] text-ink/60">
            Who
            <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
              <option value="">{people ? "Pick a teammate" : "Loading..."}</option>
              {(people ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.onClient ? " (on this client)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-ink/60">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={field} />
          </label>
          <label className="grid gap-1 text-[12px] text-ink/60">
            Due (optional)
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
          </label>
          {error && <p className="text-[12px] text-[var(--bad)]">{error}</p>}
          <button type="button" disabled={!to || pending} onClick={send} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:h-9">
            {pending ? "Sending..." : "Hand it over"}
          </button>
        </div>
      )}
    </span>
  );
}
