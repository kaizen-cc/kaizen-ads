"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { ItemQuickActions } from "@/components/item-quick-actions";
import { capTab, primaryHref, subsLeft, TAB_LABEL, type ExecCard, type ExecTab } from "@/lib/exec-overview-core";
import { TranscriptButton } from "@/components/assistant-call-parts";
import { useVisualViewport } from "@/lib/use-visual-viewport";
import { asanaLabel, BLURB, TONE, chips, type Tone } from "./exec-blocks";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { nudgeLead, takeItOver } from "../../exec-actions";
import { delegateOptions } from "../../delegate-actions";
import { transferQuickItem } from "../../item-actions";
import { openAsanaTask } from "@/components/asana-task-sheet";
import { DraftActions } from "./emails-ready";
import { ItemContext } from "@/components/item-context";
import { SubItems } from "@/components/sub-items";
import { AsanaItemActions } from "@/components/asana-item-actions";
import { closeLocally, useClosed } from "@/lib/closed-items";
import { deferClear } from "@/lib/undo";

// The executive Overview's blocks (owner, Nov 23 2026), under the Wrapped hero: Needs me, Escalated, Accounts, Pulse
// and (the owner) System, each a designed block with its own color, a big number, one line and its sub-chips. A tap
// opens the block right there with its items (5, then "N more"), fully workable in place; a tap again folds it. The open
// block lives in the address (?block=), so back folds it again.

const EMPTY: Record<ExecTab, { title: string; line: string }> = {
  needs: { title: "You're clear", line: "No replies, promises, tasks or approvals on you right now." },
  escalated: { title: "Nothing stuck past a lead", line: "Your leads are moving everything. Fires would show here the moment they happen." },
  accounts: { title: "Your accounts are handled", line: "Nothing else in your lines is off target without someone on it. Ad accounts in trouble are in the step-ins above." },
  asana: { title: "Nothing open in Asana", line: "No open Asana tasks are assigned to you." },
  pulse: { title: "Quiet", line: "Nothing to report across the agency." },
  system: { title: "All systems normal", line: "Checks passing, fixes merged, feedback flowing." },
};

const CALM: Tone = { accent: "#5be3a5", glow: "rgba(40,180,120,0.32)" };

const ACCENT: Record<ExecCard["severity"], string> = { fire: "bg-bad", critical: "bg-bad/70", high: "bg-warn", normal: "bg-ink/20" };

/** One block: a list of items (Needs me, Escalated…) or a panel the role already had (Clients, Setup, Tracking…) */
export type BlockDef = {
  id: string;
  label: string;
  blurb: string;
  tone: Tone;
  cards?: ExecCard[];
  panel?: React.ReactNode;
  /** The big number (items: how many; a panel: its own count, or none) */
  count?: number;
  chips?: string[];
  empty?: { title: string; line: string };
  /** Read only (Pulse): a note above its items, and its number isn't a to-do count */
  note?: string;
  /** One design per block: its own list (a lead's clients) stands for the items, which only count */
  cardsHidden?: boolean;
  /** A word in place of the big number ("Connect" while their own Asana isn't connected), never a ✓ */
  bigLabel?: string;
};

/**
 * Everyone's Overview blocks (owner, Nov 23 2026): designed blocks with their own color, a big number, one line and
 * sub-chips. A tap opens a block right there (its items, 5 then "N more", or its panel), a tap again folds it; the open
 * block is in the address (?block=, ?all=), so back folds it.
 */
/** Older addresses still open the right block: an anchor (#my-tasks, #next...) and ?tab= (a tab became a block) */
const HASH_BLOCK: Record<string, string[]> = {
  "my-tasks": ["asana"],
  next: ["p-next", "work"],
  sent: ["p-next"],
  "waiting-on-you": ["needs", "p-desk"],
  "reports-not-sent": ["p-desk"],
  "channel-health": ["p-desk"],
};

const subscribeHash = (on: () => void) => {
  window.addEventListener("hashchange", on);
  return () => window.removeEventListener("hashchange", on);
};

export function Blocks({ blocks }: { blocks: BlockDef[] }) {
  const asked = useParam("block");
  const tab = useParam("tab");
  // The address's anchor, read the same on the server (none) and in the browser, so nothing jumps on load
  const anchor = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1) || null, () => null);
  const [leftAnchor, setLeftAnchor] = useState(false);
  const hash = leftAnchor ? null : anchor;
  // What closed on this page counts at once (a Done, a group's last item): src/lib/closed-items.ts
  const closed = useClosed();
  const ids = blocks.map((b) => b.id);
  const alias = (x: string | null) => (x ? (ids.includes(x) ? x : ids.includes(`p-${x}`) ? `p-${x}` : null) : null);
  const open = asked ?? alias(tab) ?? (hash ? ((HASH_BLOCK[hash] ?? []).find((id) => ids.includes(id)) ?? null) : null);
  // Opened from an anchor: bring the thing it names into view once the block has opened
  useEffect(() => {
    if (hash && open) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
  }, [hash, open]);
  const toggle = (id: string) => {
    setLeftAnchor(true);
    if (open === id) {
      if (asked) closeParams("block", "all");
      else pushParams({ tab: null, all: null });
    } else pushParams({ block: id, all: null, tab: null });
  };
  // An item opened on its own (?item=<key>): its sheet, whichever block or "more" it's in
  const itemKey = useParam("item");
  const sheetCard = itemKey && !closed.has(itemKey) ? blocks.flatMap((b) => b.cards ?? []).find((c) => c.key === itemKey) : undefined;
  const sheetView = sheetCard ? subsLeft(sheetCard, closed) : null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sheetView && <ItemSheet card={sheetView} />}
      <style>{`@keyframes block-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
      {blocks.map((bl, i) => {
        const listed = bl.cards && (bl.count == null || bl.count === bl.cards.length);
        const count = listed ? (bl.cards ?? []).filter((c) => !closed.has(c.key) && subsLeft(c, closed) !== null).length : (bl.count ?? bl.cards?.length);
        const calm = count === 0 && !bl.bigLabel;
        const tone = calm ? CALM : bl.tone;
        const isOpen = open === bl.id;
        return (
          <section
            key={bl.id}
            id={`block-${bl.id}`}
            style={{ ["--glow" as string]: tone.glow, ["--accent" as string]: tone.accent, animation: `block-in .45s ${0.05 * i}s cubic-bezier(.2,.8,.2,1) both` }}
            className={`relative isolate overflow-hidden rounded-[26px] border bg-deep shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] transition-colors ${isOpen ? "border-ink/15 md:col-span-2" : "border-ink/[0.07] hover:border-ink/15"}`}
          >
            <span aria-hidden className={`pointer-events-none absolute -left-16 -top-24 -z-10 h-[260px] w-[260px] rounded-full blur-[80px] ${calm ? "opacity-40" : "opacity-80"}`} style={{ background: "var(--glow)" }} />
            <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 -z-10 h-px opacity-60" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
            <button type="button" onClick={() => toggle(bl.id)} aria-expanded={isOpen} className="group grid min-h-[170px] w-full content-between gap-5 p-6 text-left md:min-h-[200px] md:p-7">
              <span className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink/60">{bl.label}</span>
                <span className={`grid h-9 w-9 place-items-center rounded-full border border-ink/10 text-ink/50 transition duration-300 group-hover:border-ink/30 group-hover:text-fg ${isOpen ? "rotate-90" : "group-hover:translate-x-0.5"}`}>→</span>
              </span>
              <span className="grid gap-3">
                <span className="flex items-end gap-3">
                  {bl.bigLabel ? (
                    <span className="font-display text-4xl leading-none tracking-tight md:text-5xl" style={{ color: "var(--accent)" }}>
                      {bl.bigLabel}
                    </span>
                  ) : (
                    count != null && (
                      <span className="tabular font-display text-6xl leading-none tracking-tight md:text-7xl" style={{ color: "var(--accent)" }}>
                        {calm ? "✓" : count}
                      </span>
                    )
                  )}
                  <span className="min-w-0 pb-1.5 text-[15px] leading-snug text-ink/80">{calm && bl.empty ? bl.empty.title : bl.blurb}</span>
                </span>
                {(bl.chips ?? []).length > 0 && (
                  <span className="flex flex-wrap gap-1.5">
                    {(bl.chips ?? []).map((c) => (
                      <span key={c} className="rounded-full bg-ink/[0.06] px-2.5 py-1 text-[11.5px] text-ink/65">
                        {c}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-ink/[0.07] p-3 md:p-5" style={{ animation: "block-in .3s cubic-bezier(.2,.8,.2,1) both" }}>
                {/* The block's items, then what the role already had for it, folded in (their clients, the board) */}
                {!bl.cardsHidden && (bl.cards?.length || !bl.panel) && <BlockItems id={bl.id} cards={bl.cards ?? []} empty={bl.empty?.line ?? "Nothing here right now."} note={bl.note} />}
                {bl.panel && <div className={bl.cards?.length && !bl.cardsHidden ? "mt-5 border-t border-ink/[0.07] pt-5" : ""}>{bl.panel}</div>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** An exec's blocks: Needs me, Escalated, Accounts, Next for me in Asana, Pulse and (the owner) System */
export function ExecBlocks({ tabs, owner }: { tabs: Record<ExecTab, ExecCard[]>; owner: boolean }) {
  const order: ExecTab[] = owner ? ["needs", "escalated", "accounts", "asana", "pulse", "system"] : ["needs", "escalated", "accounts", "asana", "pulse"];
  return (
    <Blocks
      blocks={order.map((t) => ({
        id: t,
        label: TAB_LABEL[t],
        blurb: BLURB[t],
        tone: TONE[t],
        cards: tabs[t],
        // Pulse is a read: its number is the clients on fire, never a to-do count
        count: t === "pulse" ? tabs[t].filter((c) => c.severity === "fire").length : tabs[t].length,
        chips: chips(t, tabs[t]),
        empty: EMPTY[t],
        note: t === "pulse" ? "The agency at a glance. Nothing here is a to-do." : undefined,
        ...asanaLabel(t, tabs[t]),
      }))}
    />
  );
}

function BlockItems({ id, cards, empty, note }: { id: string; cards: ExecCard[]; empty: string; note?: string }) {
  // "N more" lives in the address too (?all=<block>)
  const all = useParam("all") === id;
  // Closed on this page: gone now, a group recounted (src/lib/closed-items.ts)
  const closed = useClosed();
  cards = cards.flatMap((c) => {
    if (closed.has(c.key)) return [];
    const v = subsLeft(c, closed);
    return v ? [v] : [];
  });
  const { shown, more } = capTab(cards);
  const list = all ? cards : shown;
  if (!cards.length) return <p className="px-2 py-4 text-sm text-ink/60">{empty}</p>;
  return (
    <div className="grid gap-3">
      {note && <p className="px-1 text-sm text-ink/55">{note}</p>}
      <ul className="grid gap-3">
        {list.map((c) => (
          <li key={c.key}>
            <Card card={c} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => pushParams({ all: all ? null : id })} className="min-h-11 justify-self-start rounded-full border border-ink/15 px-4 text-sm text-ink/70 hover:border-ink/30 hover:text-fg">
          {all ? "Show fewer" : `${more} more`}
        </button>
      )}
    </div>
  );
}

/**
 * One item opened on its own (owner, Nov 24 2026: "Open it" landed back on the Overview): everything on it (the full
 * ask, who asked and where, the call's transcript when allowed, the conversation, its own items), comments, Done, Later,
 * transfer and due date. Full screen on a phone, a panel on a computer; it lives in the address (?item=), so Back closes it.
 */
function ItemSheet({ card }: { card: ExecCard }) {
  const vv = useVisualViewport();
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams("item");
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 md:items-center md:p-6" role="dialog" aria-modal="true" aria-label={card.title} onClick={() => closeParams("item")}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={vv ? { height: vv.height, marginTop: vv.top } : undefined}
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg md:h-auto md:max-h-[85vh] md:max-w-2xl md:rounded-[24px] md:border md:border-line"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] md:px-5 md:pt-4">
          <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-faint">{TAB_LABEL[card.tab] ?? "Item"}</span>
          <button type="button" onClick={() => closeParams("item")} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-[18px] text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(16px,env(safe-area-inset-bottom))] md:p-5">
          <Card card={card} sheet />
        </div>
      </div>
    </div>
  );
}

function Card({ card, sheet = false }: { card: ExecCard; sheet?: boolean }) {
  // Gone when it's closed on this page (src/lib/closed-items.ts): counts drop with it, and Undo brings it back in place
  const closed = useClosed();
  const setGone = (v: boolean) => v && closeLocally(card.key);
  const [composing, setComposing] = useState(false);
  if (closed.has(card.key)) return null;
  const readOnly = card.tab === "pulse";
  const escalated = card.tab === "escalated";
  // Its main action: a real destination, else its own sheet (opened in place here; nothing when it's the sheet already)
  const href = primaryHref(card);
  const ownSheet = href.includes(`item=${encodeURIComponent(card.key)}`);
  const hasAction = Boolean(card.action.label || card.action.href);
  return (
    <article className="relative overflow-hidden rounded-[22px] border border-line bg-surface p-4 pl-5 md:p-5 md:pl-6">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${ACCENT[card.severity]}`} />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          {card.client && card.kind !== "fire" && card.kind !== "stuck" && <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{card.client}</p>}
          <h3 className={`text-[15.5px] font-medium leading-snug ${card.severity === "fire" ? "text-bad" : "text-fg"}`}>{card.title}</h3>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{card.detail}</p>
          {(sheet || escalated) && card.source && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
              {/* Where it was said: Slack, Gmail, Asana open in a new tab; a page of Kaizen OS in this one */}
              {card.source.href && /^https?:/.test(card.source.href) ? (
                <a href={card.source.href} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-fg underline underline-offset-2 sm:min-h-0">
                  {card.source.label} ↗
                </a>
              ) : card.source.href ? (
                <Link href={card.source.href} className="inline-flex min-h-11 items-center text-fg underline underline-offset-2 sm:min-h-0">
                  {escalated ? card.source.label : "Open the conversation"}
                </Link>
              ) : (
                card.source.label !== card.detail && <span>{card.source.label}</span>
              )}
              {card.source.transcriptCallId && <TranscriptButton callId={card.source.transcriptCallId} label="The call's transcript" className="min-h-11 rounded-full border border-line px-3 text-[13px] text-fg hover:bg-surface-2 sm:min-h-8 sm:text-[12px]" />}
            </div>
          )}
          {card.context?.length ? (
            <div className="mt-3">
              <ItemContext lines={card.context} />
            </div>
          ) : null}
          {card.subs?.length ? (
            <div className="mt-3">
              <SubItems id={card.key} subs={card.subs} noun={(card.subs[0].key.startsWith("safety:") ? "calls" : "reminders")} />
            </div>
          ) : null}
        </div>
        {card.stat && card.kind !== "asana" && <span className="tabular shrink-0 rounded-full bg-bad-soft px-2.5 py-1 text-[12px] text-bad">{card.stat}</span>}
      </div>
      {/* The recommended move, said plainly (what Nudge does and to whom) */}
      {!readOnly && card.hint && <p className="mt-3 text-[12.5px] leading-relaxed text-muted">{card.hint}</p>}
      {/* An Asana task: Asana's own actions and context, written back to Asana (src/components/asana-item-actions.tsx) */}
      {!readOnly && card.kind === "asana" && /^asana:\d+$/.test(card.key) ? (
        <div className="mt-3">
          <AsanaItemActions itemKey={card.key} gid={card.key.slice("asana:".length)} url={card.stat ?? null} title={card.title} clientSlug={card.clientSlug ?? null} onGone={() => sheet && closeParams("item")} />
        </div>
      ) : !readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {card.emailDraft ? (
            <DraftActions d={card.emailDraft} />
          ) : card.kind === "asana" ? (
            <AsanaOpen gid={card.key.slice("asana:".length)} url={card.stat ?? null} />
          ) : escalated && card.lead && card.draft ? (
            <button type="button" onClick={() => setComposing((v) => !v)} aria-expanded={composing} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]">
              {composing ? "Close" : card.action.label || "Nudge the lead"}
            </button>
          ) : (
            hasAction &&
            (ownSheet ? (
              !sheet && (
                <button type="button" onClick={() => pushParams({ item: card.key })} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]">
                  {card.action.label || "Open it"}
                </button>
              )
            ) : (
              <Go href={href} label={card.action.label || "Open it"} />
            ))
          )}
          <ItemQuickActions
            inline
            item={{ key: card.key, snap: { topic: card.tab, client: card.client ?? "", title: card.title, clientId: card.clientId }, href: card.action.href }}
            hide={escalated ? ["delegate"] : []}
            onGone={(how) => {
              if (how === "comment" || how === "delegate") return;
              setGone(true);
              // Done from its sheet: back to the Overview
              if (sheet) closeParams("item");
            }}
            extra={<Extras card={card} onTaken={() => setGone(true)} />}
          />
          {composing && card.lead && card.draft && <Compose card={card} onSent={() => setComposing(false)} />}
        </div>
      )}
    </article>
  );
}

/** Under More: take it over (Escalated), the client's page */
function Extras({ card, onTaken }: { card: ExecCard; onTaken: () => void }) {
  const router = useRouter();
  const pending = false;
  const [error, setError] = useState<string | null>(null);
  const pill = "inline-flex min-h-11 items-center rounded-full border border-ink/15 px-3.5 text-[13px] text-ink/75 hover:border-ink/35 hover:text-fg sm:min-h-8 sm:px-3 sm:text-[12px]";
  return (
    <>
      {card.tab === "escalated" && card.nudgeIds?.length ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            // Taken once the Undo window closes (src/lib/undo.ts)
            onTaken();
            deferClear({
              keys: [card.key],
              label: "Taken: it's yours now",
              commit: async () => {
                const r = await takeItOver(card.nudgeIds ?? []);
                if (r.ok) router.refresh();
                return r;
              },
              onError: setError,
            });
          }}
          className={pill}
        >
          {pending ? "Taking it..." : "Take it"}
        </button>
      ) : null}
      {card.tab === "escalated" && card.itemKey ? <Reassign card={card} pill={pill} /> : null}
      {card.clientSlug && (
        <Link href={`/clients/${card.clientSlug}`} className={pill}>
          Client page
        </Link>
      )}
      {error && <span className="text-[12px] text-bad">{error}</span>}
    </>
  );
}

/**
 * Escalated with one item: give the item itself to someone else (it leaves the owner's day, shows on theirs, the ladder
 * starts over from them). Written after the Undo window like every clear (src/lib/undo.ts).
 */
function Reassign({ card, pill }: { card: ExecCard; pill: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; onClient: boolean }[] | null>(null);
  const [to, setTo] = useState("");
  const toggle = () => {
    setOpen(!open);
    if (!people) delegateOptions(card.clientId).then(setPeople).catch(() => setPeople([]));
  };
  const go = () => {
    const name = people?.find((p) => p.id === to)?.name ?? "them";
    setOpen(false);
    deferClear({
      keys: [card.key],
      label: `Reassigned to ${name}`,
      commit: async () => {
        const r = await transferQuickItem({ key: card.itemKey ?? card.key, snap: { topic: "needs", client: card.client ?? "", title: card.title, clientId: card.clientId, href: card.action.href }, to });
        if (r.ok) router.refresh();
        return r;
      },
    });
  };
  return (
    <>
      <button type="button" onClick={toggle} aria-expanded={open} className={pill}>
        Reassign
      </button>
      {open && (
        <div className="order-last mt-1 grid w-full basis-full gap-2 rounded-2xl border border-ink/15 bg-deep p-3 sm:max-w-sm">
          <label className="grid gap-1 text-[12px] text-ink/60">
            Give it to (it leaves their day and starts fresh with the new owner)
            <select value={to} onChange={(e) => setTo(e.target.value)} className="h-11 rounded-brand border border-ink/15 bg-transparent px-2 text-[16px] text-fg sm:h-9 sm:text-[13px]">
              <option value="">{people ? "Pick a teammate" : "Loading..."}</option>
              {(people ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.onClient ? " (on this client)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!to} onClick={go} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:h-9">
            Reassign
          </button>
        </div>
      )}
    </>
  );
}

/** The exec's nudge to the lead, drafted, editable, sent in Kaizen OS */
function Compose({ card, onSent }: { card: ExecCard; onSent: () => void }) {
  const router = useRouter();
  const [text, setText] = useState(card.draft ?? "");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="order-last mt-2 grid w-full basis-full gap-2 rounded-2xl border border-line bg-deep p-3">
      <label className="grid gap-1 text-[12px] text-muted">
        To {card.lead?.name} in Kaizen OS
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="rounded-brand border border-ink/15 bg-transparent p-2.5 text-[16px] leading-relaxed text-fg sm:text-[14px]" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !text.trim()}
          onClick={() =>
            start(async () => {
              const r = await nudgeLead({ nudgeIds: card.nudgeIds ?? [], leadId: card.lead?.id ?? "", text, client: card.client });
              if (!r.ok) return setNote(r.error);
              setNote("Sent. It's on their Overview and bell.");
              router.refresh();
              setTimeout(onSent, 1200);
            })
          }
          className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:min-h-9"
        >
          {pending ? "Sending..." : "Send"}
        </button>
        {note && <span className="text-[12.5px] text-muted">{note}</span>}
      </div>
    </div>
  );
}

/**
 * The card's main action. A link that always goes: in the app when it can, and if the address hasn't moved a moment
 * later (a heavy page, a navigation that didn't start), the browser loads it outright. Shows it's opening meanwhile.
 */
function Go({ href, label }: { href: string; label: string }) {
  const [going, setGoing] = useState(false);
  const external = /^https?:/.test(href);
  return (
    <Link
      href={href}
      prefetch={false}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      onClick={(e) => {
        if (external || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        setGoing(true);
        const from = window.location.href;
        window.setTimeout(() => {
          if (window.location.href === from) window.location.assign(href);
        }, 2500);
      }}
      className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]"
    >
      {going ? "Opening..." : label}
    </Link>
  );
}

/** An Asana task: its preview opens in place (done, due date, reassign, fields, subtasks, comments, written to Asana) */
function AsanaOpen({ gid, url }: { gid: string; url: string | null }) {
  return (
    <>
      <button type="button" onClick={() => openAsanaTask(gid)} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]">
        Open
      </button>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-ink/15 px-3.5 text-[13px] text-ink/75 hover:border-ink/35 hover:text-fg sm:min-h-8 sm:px-3 sm:text-[12px]">
          Open in Asana ↗
        </a>
      )}
    </>
  );
}

