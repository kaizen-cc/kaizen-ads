"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ItemQuickActions } from "@/components/item-quick-actions";
import { capTab, TAB_LABEL, type ExecCard, type ExecTab, type HeaderPart } from "@/lib/exec-overview-core";
import { pushParams, useParam } from "@/lib/url-state";
import { nudgeLead, takeItOver } from "../../exec-actions";
import { OverviewTabs } from "./overview-tabs";

// The executive Overview (owner, Nov 23 2026): four tabs (the owner a fifth), opening on the one holding the most
// critical thing, a one-line header whose parts open their tabs, and at most 5 cards a tab with the rest behind
// "N more". Every card: the main action, Done and Later; the rest behind More. Pulse is read only.

const EMPTY: Record<ExecTab, { title: string; line: string }> = {
  needs: { title: "You're clear", line: "No replies, promises, tasks or approvals on you right now." },
  escalated: { title: "Nothing stuck past a lead", line: "Your leads are moving everything. Fires would show here the moment they happen." },
  accounts: { title: "Your accounts are handled", line: "Nothing in your lines is off target without someone already on it." },
  pulse: { title: "Quiet", line: "Nothing to report across the agency." },
  system: { title: "All systems normal", line: "Checks passing, fixes merged, feedback flowing." },
};

const ACCENT: Record<ExecCard["severity"], string> = { fire: "bg-bad", critical: "bg-bad/70", high: "bg-warn", normal: "bg-ink/20" };

export function ExecHome({ greeting, firstName, today, tabs, opening, owner, header }: { greeting: string; firstName: string; today: string; tabs: Record<ExecTab, ExecCard[]>; opening: ExecTab; owner: boolean; header: HeaderPart[] }) {
  const order: ExecTab[] = owner ? ["needs", "escalated", "accounts", "pulse", "system"] : ["needs", "escalated", "accounts", "pulse"];
  const fires = tabs.escalated.filter((c) => c.severity === "fire").length;
  const tone = (t: ExecTab) => (t === "escalated" && fires ? ("bad" as const) : t === "system" && tabs.system.some((c) => c.severity === "critical") ? ("bad" as const) : t === "needs" ? ("brand" as const) : ("warn" as const));
  return (
    <div className="mx-auto grid max-w-4xl gap-6 md:gap-8">
      <header className="grid gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{today}</p>
        <h1 className="font-heading text-3xl md:text-4xl">
          {greeting}, {firstName}
        </h1>
        {/* "3 need you · 2 stuck with leads · 1 account to step into": each part opens its tab */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-muted">
          {header.length ? (
            header.map((h, i) => (
              <span key={`${h.tab}-${i}`} className="inline-flex items-center gap-2">
                {i > 0 && <span aria-hidden className="text-faint">·</span>}
                <button type="button" onClick={() => pushParams({ tab: h.tab })} className={`min-h-11 underline-offset-4 hover:text-fg hover:underline md:min-h-0 ${h.text.includes("on fire") ? "font-medium text-bad" : ""}`}>
                  {h.text}
                </button>
              </span>
            ))
          ) : (
            <span>All clear. Nothing needs you, nothing is stuck, every account is handled.</span>
          )}
        </p>
      </header>
      <OverviewTabs
        initial={opening}
        tabs={order.map((t) => ({ id: t, label: TAB_LABEL[t], ...(t !== "pulse" && tabs[t].length ? { count: tabs[t].length, tone: tone(t) } : {}) }))}
        panels={Object.fromEntries(order.map((t) => [t, <TabPanel key={t} tab={t} cards={tabs[t]} />]))}
      />
    </div>
  );
}

function TabPanel({ tab, cards }: { tab: ExecTab; cards: ExecCard[] }) {
  // "N more" lives in the address (?all=<tab>), so back closes it again
  const all = useParam("all") === tab;
  const { shown, more } = capTab(cards);
  const list = all ? cards : shown;
  if (!cards.length)
    return (
      <div className="grid place-items-center gap-2 rounded-[22px] border border-line bg-surface px-6 py-14 text-center">
        <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft text-lg text-ok">
          ✓
        </span>
        <p className="font-heading text-xl">{EMPTY[tab].title}</p>
        <p className="max-w-sm text-sm text-muted">{EMPTY[tab].line}</p>
      </div>
    );
  return (
    <section className="grid gap-3" aria-label={TAB_LABEL[tab]}>
      {tab === "pulse" && <p className="text-sm text-muted">The agency at a glance. Nothing here is a to-do.</p>}
      <ul className="grid gap-3">
        {list.map((c) => (
          <li key={c.key}>
            <Card card={c} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => pushParams({ all: all ? null : tab })} className="min-h-11 justify-self-start rounded-full border border-line px-4 text-sm text-muted hover:border-ink/30 hover:text-fg">
          {all ? "Show fewer" : `${more} more`}
        </button>
      )}
    </section>
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
              <Link href={card.action.href} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand/90 sm:min-h-8 sm:text-[12px]">
                {card.action.label}
              </Link>
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
