"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { delegateOptions } from "@/app/(team)/delegate-actions";
import { delegateQuickItem, doneQuickItem, dueQuickItem, snoozeQuickItem, takeOverQuickItem, transferQuickItem, type QuickSnap } from "@/app/(team)/item-actions";
import { CommentButton } from "./item-comments";

// The quick actions on every Overview and Today item, kept simple (Nov 22 2026: too many choices per item): only Done and
// Later show; everything else (Hand off, Comment, and whatever the item adds, like the client page or "Not for me") sits
// behind one "⋯ More" that opens in the flow under the buttons, never floating, so a card that clips can't cut it off.
// Each action takes the item off this person's screen at once (onGone) and the server's word follows.

export type QuickItem = { key: string; snap: QuickSnap; href?: string | null; dueAt?: string | null; comments?: number; waiting?: boolean };
type Which = "done" | "snooze" | "delegate" | "comment";

const pill = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors sm:min-h-8 sm:px-3 sm:text-[12px] disabled:opacity-50";

export function ItemQuickActions({
  item,
  onGone,
  hide = [],
  compact = false,
  tone = "auto",
  later,
  extra,
  inline = false,
}: {
  item: QuickItem;
  onGone?: (how: Which, note?: string) => void;
  hide?: Which[];
  compact?: boolean;
  tone?: "auto" | "dark";
  /** Replaces the plain "Later" (snooze to tomorrow), e.g. the story's own Save for later */
  later?: { label: string; on: boolean; run: () => void };
  /** More choices for the "⋯ More" panel */
  extra?: ReactNode;
  /** Its buttons join the parent's row (the parent's flex-wrap), so More's panel opens full width under it */
  inline?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const run = (how: Which, fn: () => Promise<unknown>, note?: string) =>
    start(async () => {
      onGone?.(how, note);
      await fn();
      router.refresh();
    });
  const dark = tone === "dark";
  const quiet = dark ? "border border-white/25 text-white/85 hover:bg-white/10" : "border border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg";
  // A thread already going (or waiting on the client) is worth seeing without opening More
  const talk = (item.comments ?? 0) > 0 || item.waiting;
  return (
    <div className={inline ? "contents" : `flex flex-wrap items-center gap-1.5 ${compact ? "" : "pt-1"}`} onClick={(e) => e.stopPropagation()}>
      {!hide.includes("done") && (
        <button type="button" disabled={pending} onClick={() => run("done", () => doneQuickItem(item.key, item.snap))} className={`${pill} font-medium ${dark ? "border border-[#5be3a5]/50 text-[#5be3a5] hover:bg-[#5be3a5]/10" : "bg-fg text-bg hover:bg-ink/85"}`}>
          ✓ Done
        </button>
      )}
      {later ? (
        <button type="button" onClick={later.run} title="Off your screen for now; it comes back tomorrow if it's still open" className={`${pill} ${later.on ? (dark ? "border border-white bg-white/15 text-white" : "border border-fg bg-ink/10 text-fg") : quiet}`}>
          {later.on ? "Later ✓" : later.label}
        </button>
      ) : (
        !hide.includes("snooze") && (
          <button type="button" disabled={pending} title="Off your screen until tomorrow; it comes back on its own" onClick={() => run("snooze", () => snoozeQuickItem(item.key, item.snap), "Back tomorrow")} className={`${pill} ${quiet}`}>
            Later
          </button>
        )
      )}
      <button type="button" aria-expanded={more} aria-label="More choices" onClick={() => setMore(!more)} className={`${pill} ${more ? (dark ? "bg-white/15 text-white" : "bg-ink/10 text-fg") : dark ? "text-white/70 hover:text-white" : "text-ink/60 hover:text-fg"}`}>
        {more ? "Less" : "⋯ More"}
        {!more && talk && <span className={`rounded-full px-1.5 text-[10.5px] ${item.waiting ? "bg-[#f2b14c]/20 text-[#f2b14c]" : dark ? "bg-white/15" : "bg-ink/10"}`}>{item.waiting ? "waiting on client" : `💬 ${item.comments}`}</span>}
      </button>
      {more && (
        <div className={`order-last mt-1 flex w-full basis-full flex-wrap items-center gap-1.5 rounded-2xl p-2 ${dark ? "bg-white/[0.06]" : "bg-ink/[0.04]"}`}>
          <TaskControls item={item} tone={tone} onGone={(note) => onGone?.("delegate", note)} />
          {!hide.includes("delegate") && <DelegatePicker item={item} open={open} setOpen={setOpen} tone={tone} onDone={(to) => onGone?.("delegate", `Handed to ${to}`)} />}
          {!hide.includes("comment") && <CommentButton tone={tone} target={{ key: item.key, clientId: item.snap.clientId, title: [item.snap.client, item.snap.title].filter(Boolean).join(": "), href: item.href ?? null, dueAt: item.dueAt ?? null }} count={item.comments ?? 0} waiting={item.waiting ?? false} />}
          {extra}
        </div>
      )}
    </div>
  );
}

/** Delegate: pick a teammate (the client's seat holders first), an optional note and due date */
function DelegatePicker({ item, open, setOpen, onDone, tone = "auto" }: { item: QuickItem; open: boolean; setOpen: (o: boolean) => void; onDone: (to: string) => void; tone?: "auto" | "dark" }) {
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
      <button type="button" onClick={toggle} aria-expanded={open} className={`${pill} border ${tone === "dark" ? "border-white/25 text-white/85 hover:bg-white/10" : "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg"}`}>
        Hand off
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

/** Linked escalation items and read-only cards aren't tasks of their own: no owner to transfer or date to change */
const LINKED = /^(lead|esc|step|pulse|system|approve):/;

/**
 * Items are living tasks (owner, Nov 23 2026): Transfer owner (it moves to the teammate, leaves this day, shows on
 * theirs, logged) and Change due date (the ladder's clock counts from it). A lead's linked item instead offers Take it
 * over (the teammate's item becomes theirs).
 */
function TaskControls({ item, tone = "auto", onGone }: { item: QuickItem; tone?: "auto" | "dark"; onGone: (note: string) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState<"transfer" | "due" | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; onClient: boolean }[] | null>(null);
  const [to, setTo] = useState("");
  const [due, setDue] = useState(item.dueAt ? item.dueAt.slice(0, 10) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const quiet = `${pill} border ${tone === "dark" ? "border-white/25 text-white/85 hover:bg-white/10" : "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg"}`;
  const field = "h-11 rounded-brand border border-ink/15 bg-transparent px-2 text-[16px] text-fg sm:h-9 sm:text-[13px]";
  const snap = { ...item.snap, href: item.href ?? null };
  if (item.key.startsWith("lead:"))
    return (
      <>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await takeOverQuickItem(item.key);
              if (!r.ok) return setError(r.error);
              onGone("Taken over: it's yours now");
              router.refresh();
            })
          }
          className={quiet}
        >
          {pending ? "Taking it over..." : "Take it over"}
        </button>
        {error && <span className="text-[12px] text-[var(--bad)]">{error}</span>}
      </>
    );
  if (LINKED.test(item.key)) return null;
  const toggle = (w: "transfer" | "due") => {
    setError(null);
    setOpen(open === w ? null : w);
    if (w === "transfer" && !people) delegateOptions(item.snap.clientId).then(setPeople).catch(() => setPeople([]));
  };
  return (
    <>
      <button type="button" onClick={() => toggle("transfer")} aria-expanded={open === "transfer"} className={quiet}>
        Transfer owner
      </button>
      <button type="button" onClick={() => toggle("due")} aria-expanded={open === "due"} className={quiet}>
        Change due date
      </button>
      {open && (
        <div className="order-last mt-1 grid w-full basis-full gap-2 rounded-2xl border border-ink/15 bg-deep p-3 sm:max-w-sm">
          {open === "transfer" ? (
            <label className="grid gap-1 text-[12px] text-ink/60">
              New owner (it leaves your day and shows on theirs)
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
          ) : (
            <label className="grid gap-1 text-[12px] text-ink/60">
              Due (escalation counts from this date)
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
            </label>
          )}
          {error && <p className="text-[12px] text-[var(--bad)]">{error}</p>}
          <button
            type="button"
            disabled={pending || (open === "transfer" ? !to : !due)}
            onClick={() =>
              start(async () => {
                if (open === "transfer") {
                  const r = await transferQuickItem({ key: item.key, snap, to });
                  if (!r.ok) return setError(r.error);
                  onGone(`Transferred to ${r.to}`);
                } else {
                  const r = await dueQuickItem({ key: item.key, snap, due });
                  if (!r.ok) return setError(r.error);
                  setOpen(null);
                }
                router.refresh();
              })
            }
            className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:h-9"
          >
            {pending ? "Saving..." : open === "transfer" ? "Transfer" : "Save date"}
          </button>
        </div>
      )}
    </>
  );
}
