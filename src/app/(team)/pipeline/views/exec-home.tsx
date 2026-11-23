"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ItemQuickActions } from "@/components/item-quick-actions";
import { capTab, TAB_LABEL, type ExecCard, type ExecTab } from "@/lib/exec-overview-core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { nudgeLead, takeItOver } from "../../exec-actions";

// The executive Overview's blocks (owner, Nov 23 2026), under the Wrapped hero: Needs me, Escalated, Accounts, Pulse
// and (the owner) System, each a designed block with its own color, a big number, one line and its sub-chips. A tap
// opens the block right there with its items (5, then "N more"), fully workable in place; a tap again folds it. The open
// block lives in the address (?block=), so back folds it again.

const EMPTY: Record<ExecTab, { title: string; line: string }> = {
  needs: { title: "You're clear", line: "No replies, promises, tasks or approvals on you right now." },
  escalated: { title: "Nothing stuck past a lead", line: "Your leads are moving everything. Fires would show here the moment they happen." },
  accounts: { title: "Your accounts are handled", line: "Nothing in your lines is off target without someone already on it." },
  pulse: { title: "Quiet", line: "Nothing to report across the agency." },
  system: { title: "All systems normal", line: "Checks passing, fixes merged, feedback flowing." },
};

const BLURB: Record<ExecTab, string> = {
  needs: "Replies, promises, tasks and approvals on you",
  escalated: "Stuck 48 hours past a lead, and fires",
  accounts: "Your lines, off target, nothing in motion",
  pulse: "The agency at a glance, nothing to do",
  system: "Kaizen OS itself: checks, fixes, feedback",
};

type Tone = { accent: string; glow: string };
const TONE: Record<ExecTab, Tone> = {
  needs: { accent: "#ff6b78", glow: "rgba(178,30,44,0.45)" },
  escalated: { accent: "#ff4d5e", glow: "rgba(200,16,46,0.5)" },
  accounts: { accent: "#f2b14c", glow: "rgba(224,150,40,0.4)" },
  pulse: { accent: "#9aa8ff", glow: "rgba(90,110,255,0.3)" },
  system: { accent: "#5be3a5", glow: "rgba(40,180,120,0.32)" },
};
const CALM: Tone = { accent: "#5be3a5", glow: "rgba(40,180,120,0.32)" };

const ACCENT: Record<ExecCard["severity"], string> = { fire: "bg-bad", critical: "bg-bad/70", high: "bg-warn", normal: "bg-ink/20" };

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The sub-chips under a block's number: what it holds, in a few words */
function chips(tab: ExecTab, cards: ExecCard[]): string[] {
  const count = (f: (c: ExecCard) => boolean) => cards.filter(f).length;
  if (tab === "needs")
    return [
      count((c) => c.kind === "owed") && n(count((c) => c.kind === "owed"), "reply", "replies"),
      count((c) => c.kind === "said") && n(count((c) => c.kind === "said"), "promise", "promises"),
      count((c) => c.kind === "asana" || c.kind === "mine" || c.kind === "taken") && n(count((c) => c.kind === "asana" || c.kind === "mine" || c.kind === "taken"), "task", "tasks"),
      count((c) => c.kind === "approval") && n(count((c) => c.kind === "approval"), "approval", "approvals"),
    ].filter((x): x is string => Boolean(x));
  if (tab === "escalated")
    return [
      count((c) => c.kind === "team") && n(count((c) => c.kind === "team"), "team card", "team cards"),
      count((c) => c.kind === "stuck") && n(count((c) => c.kind === "stuck"), "client", "clients"),
      count((c) => c.severity === "fire") && n(count((c) => c.severity === "fire"), "fire", "fires"),
    ].filter((x): x is string => Boolean(x));
  if (tab === "accounts") {
    const by = new Map<string, number>();
    for (const c of cards) by.set(c.line ?? "other", (by.get(c.line ?? "other") ?? 0) + 1);
    const L: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", email: "Email", social: "Social", creative: "Creative" };
    return [...by.entries()].map(([l, k]) => `${k} ${L[l] ?? l}`);
  }
  if (tab === "pulse")
    return [count((c) => c.severity === "fire") && n(count((c) => c.severity === "fire"), "client on fire", "clients on fire"), count((c) => c.key.startsWith("pulse:team:")) && n(count((c) => c.key.startsWith("pulse:team:")), "lead", "leads"), "this week"].filter((x): x is string => Boolean(x));
  return [
    count((c) => c.key.startsWith("system:check:")) && n(count((c) => c.key.startsWith("system:check:")), "check failing", "checks failing"),
    count((c) => c.key.startsWith("system:fix:")) && n(count((c) => c.key.startsWith("system:fix:")), "fix to look at", "fixes to look at"),
    count((c) => c.key.startsWith("system:triage:")) && "feedback stuck",
  ].filter((x): x is string => Boolean(x));
}

export function ExecBlocks({ tabs, owner }: { tabs: Record<ExecTab, ExecCard[]>; owner: boolean }) {
  const order: ExecTab[] = owner ? ["needs", "escalated", "accounts", "pulse", "system"] : ["needs", "escalated", "accounts", "pulse"];
  const open = useParam("block");
  const toggle = (t: ExecTab) => {
    if (open === t) closeParams("block", "all");
    else pushParams({ block: t, all: null });
  };
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <style>{`@keyframes block-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
      {order.map((t, i) => {
        const cards = tabs[t];
        // Pulse is a read: its number is the clients on fire, never a to-do count
        const count = t === "pulse" ? cards.filter((c) => c.severity === "fire").length : cards.length;
        const calm = count === 0;
        const tone = calm ? CALM : TONE[t];
        const isOpen = open === t;
        return (
          <section
            key={t}
            id={`block-${t}`}
            style={{ ["--glow" as string]: tone.glow, ["--accent" as string]: tone.accent, animation: `block-in .45s ${0.06 * i}s cubic-bezier(.2,.8,.2,1) both` }}
            className={`relative isolate overflow-hidden rounded-[26px] border bg-deep shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] transition-colors ${isOpen ? "border-ink/15 md:col-span-2" : "border-ink/[0.07] hover:border-ink/15"}`}
          >
            <span aria-hidden className={`pointer-events-none absolute -left-16 -top-24 -z-10 h-[260px] w-[260px] rounded-full blur-[80px] ${calm ? "opacity-40" : "opacity-80"}`} style={{ background: "var(--glow)" }} />
            <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 -z-10 h-px opacity-60" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
            <button type="button" onClick={() => toggle(t)} aria-expanded={isOpen} className="group grid min-h-[170px] w-full content-between gap-5 p-6 text-left md:min-h-[200px] md:p-7">
              <span className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink/60">{TAB_LABEL[t]}</span>
                <span className={`grid h-9 w-9 place-items-center rounded-full border border-ink/10 text-ink/50 transition duration-300 group-hover:border-ink/30 group-hover:text-fg ${isOpen ? "rotate-90" : "group-hover:translate-x-0.5"}`}>→</span>
              </span>
              <span className="grid gap-3">
                <span className="flex items-end gap-3">
                  <span className="tabular font-display text-6xl leading-none tracking-tight md:text-7xl" style={{ color: "var(--accent)" }}>
                    {calm ? "✓" : count}
                  </span>
                  <span className="min-w-0 pb-1.5 text-[15px] leading-snug text-ink/80">{calm ? EMPTY[t].title : BLURB[t]}</span>
                </span>
                {chips(t, cards).length > 0 && (
                  <span className="flex flex-wrap gap-1.5">
                    {chips(t, cards).map((c) => (
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
                <BlockItems tab={t} cards={cards} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BlockItems({ tab, cards }: { tab: ExecTab; cards: ExecCard[] }) {
  // "N more" lives in the address too (?all=<block>)
  const all = useParam("all") === tab;
  const { shown, more } = capTab(cards);
  const list = all ? cards : shown;
  if (!cards.length) return <p className="px-2 py-4 text-sm text-ink/60">{EMPTY[tab].line}</p>;
  return (
    <div className="grid gap-3">
      {tab === "pulse" && <p className="px-1 text-sm text-ink/55">The agency at a glance. Nothing here is a to-do.</p>}
      <ul className="grid gap-3">
        {list.map((c) => (
          <li key={c.key}>
            <Card card={c} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => pushParams({ all: all ? null : tab })} className="min-h-11 justify-self-start rounded-full border border-ink/15 px-4 text-sm text-ink/70 hover:border-ink/30 hover:text-fg">
          {all ? "Show fewer" : `${more} more`}
        </button>
      )}
    </div>
  );
}

function Card({ card }: { card: ExecCard }) {
  const [gone, setGone] = useState(false);
  const [composing, setComposing] = useState(false);
  if (gone) return null;
  const readOnly = card.tab === "pulse";
  const escalated = card.tab === "escalated";
  return (
    <article className="relative overflow-hidden rounded-[22px] border border-line bg-surface p-4 pl-5 md:p-5 md:pl-6">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${ACCENT[card.severity]}`} />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          {card.client && card.kind !== "fire" && card.kind !== "stuck" && <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{card.client}</p>}
          <h3 className={`text-[15.5px] font-medium leading-snug ${card.severity === "fire" ? "text-bad" : "text-fg"}`}>{card.title}</h3>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{card.detail}</p>
        </div>
        {card.stat && <span className="tabular shrink-0 rounded-full bg-bad-soft px-2.5 py-1 text-[12px] text-bad">{card.stat}</span>}
      </div>
      {!readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {escalated && card.lead && card.draft ? (
            <button type="button" onClick={() => setComposing((v) => !v)} aria-expanded={composing} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]">
              {composing ? "Close" : "Nudge the lead"}
            </button>
          ) : (
            card.action.href && (
              <Go href={card.action.href} label={card.action.label} />
            )
          )}
          <ItemQuickActions
            inline
            item={{ key: card.key, snap: { topic: card.tab, client: card.client ?? "", title: card.title, clientId: card.clientId }, href: card.action.href }}
            hide={escalated ? ["delegate"] : []}
            onGone={(how) => how !== "comment" && how !== "delegate" && setGone(true)}
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
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const pill = "inline-flex min-h-11 items-center rounded-full border border-ink/15 px-3.5 text-[13px] text-ink/75 hover:border-ink/35 hover:text-fg sm:min-h-8 sm:px-3 sm:text-[12px]";
  return (
    <>
      {card.tab === "escalated" && card.nudgeIds?.length ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await takeItOver(card.nudgeIds ?? []);
              if (!r.ok) return setError(r.error);
              onTaken();
              router.refresh();
            })
          }
          className={pill}
        >
          {pending ? "Taking it..." : "Take it"}
        </button>
      ) : null}
      {card.clientSlug && (
        <Link href={`/clients/${card.clientSlug}`} className={pill}>
          Client page
        </Link>
      )}
      {error && <span className="text-[12px] text-bad">{error}</span>}
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
