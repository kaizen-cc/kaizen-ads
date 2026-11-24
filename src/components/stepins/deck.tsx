"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Stepin } from "@/lib/stepins/act";
import type { Flagged } from "@/lib/stepins/flagged";
import { FlaggedList } from "./flagged-list";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { assignStepin, commentOnStepin, handleStepin, refreshStepins, reopenStepin } from "@/app/(team)/stepins/actions";

// The executives' step-ins: a hero banner in the Wrapped language (dark glow, big display number, the handwritten
// accent), but in its own violet so it isn't the "Your day" hero, over a deck of client cards that swipes on a phone
// and fans out on a desktop. Each card is the shared, living item: the hole, numbers vs target and trend, what the team
// has and hasn't done, who owns it, the suggested step-in, who's handling it and by when, and every exec's comments.
// Story mode (?story=stepins) walks the deck one card at a time for Monday morning.

const VIOLET = "#b892ff";
const GLOW = "rgba(140,90,255,0.42)";
const KIND_LABEL: Record<string, string> = { fire: "Fire", account: "Off target", email: "Email red", escalated: "Stuck past the lead" };

type Person = { id: string; name: string };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  return { pending, msg, run };
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const TREND: Record<string, { t: string; c: string }> = { better: { t: "↗ improving", c: "#5be3a5" }, worse: { t: "↘ getting worse", c: "#ff6b78" }, flat: { t: "→ flat", c: "" } };

export function StepinsHero({ cards, compact = false, people, canRefresh = false, flagged = [] }: { cards: Stepin[]; compact?: boolean; people: Person[]; canRefresh?: boolean; flagged?: Flagged[] }) {
  const story = useParam("story") === "stepins";
  const open = cards.filter((c) => c.status === "open");
  const fires = open.filter((c) => c.fire).length;
  const mine = open.filter((c) => !c.handler).length;
  const refresh = useAct();
  // On the Overview it folds to one slim row (?stepins=1 opens it, so back folds it again). It opens on its own only
  // for a fire nobody is handling; closing that one is ?stepins=0. The /stepins page is always open.
  const param = useParam("stepins");
  const autoOpen = open.some((c) => c.fire && !c.handler);
  const expanded = !compact || param === "1" || (autoOpen && param !== "0");
  const toggle = () => (expanded ? (autoOpen ? pushParams({ stepins: "0" }) : closeParams("stepins")) : pushParams({ stepins: "1" }));
  if (!expanded) return <SlimRow cards={open} flagged={flagged.length} onOpen={toggle} story={story} people={people} />;
  return (
    <section className="relative isolate grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 overflow-hidden rounded-[26px] border border-ink/[0.08] bg-deep p-4 shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] md:p-7" aria-label="This week's step-ins">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-28 -z-10 h-[320px] w-[320px] rounded-full blur-[100px]" style={{ background: GLOW }} />
      <span aria-hidden className="pointer-events-none absolute -bottom-32 -left-10 -z-10 h-[240px] w-[240px] rounded-full bg-[rgba(255,77,94,0.16)] blur-[110px]" />
      <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 -z-10 h-px opacity-70" style={{ background: `linear-gradient(90deg, transparent, ${VIOLET}, transparent)` }} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid min-w-0 gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: VIOLET }}>
            This week&apos;s step-ins · {open.length} account{open.length === 1 ? "" : "s"}
          </p>
          <p className="font-display text-[28px] leading-tight tracking-tight text-fg sm:text-4xl">
            {open.length ? (
              <>
                {open.length} where an exec steps in
                {fires > 0 && <span className="text-[#ff4d5e]">, {fires} on fire</span>}
              </>
            ) : (
              "Nothing needs an exec this week"
            )}
          </p>
          <p className="text-[13.5px] text-ink/60">{open.length ? `${mine ? `${mine} with nobody handling yet. ` : "Each one has someone on it. "}Everything else is with the leads.` : "Your leads are handling every account in your lines."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {compact && (
            <button type="button" onClick={toggle} aria-expanded="true" className="inline-flex h-11 items-center gap-2 rounded-full border border-ink/15 px-4 text-[14px] text-fg hover:border-ink/30">
              Fold <span aria-hidden className="-rotate-90">→</span>
            </button>
          )}
          {open.length > 0 && (
            <button type="button" onClick={() => pushParams({ story: "stepins" })} className="inline-flex h-11 items-center gap-2 rounded-full px-5 text-[14px] font-semibold text-deep transition-opacity hover:opacity-90" style={{ background: VIOLET }}>
              ▶ Monday story
            </button>
          )}
          {compact ? (
            <Link href="/stepins" className="inline-flex h-11 items-center rounded-full border border-ink/15 px-5 text-[14px] text-fg hover:border-ink/30">
              All step-ins
            </Link>
          ) : (
            canRefresh && (
              <button type="button" disabled={refresh.pending} onClick={() => refresh.run(refreshStepins)} className="inline-flex h-11 items-center rounded-full border border-ink/15 px-5 text-[14px] text-fg hover:border-ink/30 disabled:opacity-50">
                {refresh.pending ? "Checking every account…" : "Check now"}
              </button>
            )
          )}
        </div>
      </div>
      {refresh.msg && <p className={`text-[12.5px] ${refresh.msg.ok ? "text-ink/60" : "text-bad"}`}>{refresh.msg.text}</p>}
      {open.length > 0 && <Deck cards={compact ? open.slice(0, 8) : open} people={people} />}
      <FlaggedList rows={flagged} people={people} />
      {story && open.length > 0 && <Story cards={open} people={people} />}
    </section>
  );
}

/** The folded section: one slim violet row with the top account, its most urgent pill, and the two small buttons */
function SlimRow({ cards, flagged, onOpen, story, people }: { cards: Stepin[]; flagged: number; onOpen: () => void; story: boolean; people: Person[] }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const top = cards[0];
  const overdue = (c: Stepin) => Boolean(c.handler && c.dueOn && c.dueOn < today);
  const pill = !top
    ? { t: "All clear", c: "bg-ok-soft text-ok" }
    : top.fire && !top.handler
      ? { t: "Fire · nobody on it", c: "bg-bad-soft text-bad" }
      : cards.some(overdue)
        ? { t: "Overdue", c: "bg-bad-soft text-bad" }
        : cards.some((c) => !c.handler)
          ? { t: `${cards.filter((c) => !c.handler).length} nobody handling`, c: "bg-warn-soft text-warn" }
          : { t: cards.length === 1 && top.handler ? `${top.handler.label.split(" ")[0]} handling` : "All handled", c: "bg-ok-soft text-ok" };
  const what = top
    ? `${top.card.client.name} (${top.handler ? `${top.handler.label.split(" ")[0]} handling${top.dueOn ? `, ${overdue(top) ? "overdue since" : "due"} ${day(`${top.dueOn}T12:00:00Z`)}` : ""}` : (KIND_LABEL[top.reasons[0]?.kind ?? ""] ?? "needs an exec").toLowerCase()})${cards.length > 1 ? ` + ${cards.length - 1} more` : ""}`
    : "Nothing needs an exec this week";
  return (
    <section className="relative isolate grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-hidden rounded-[22px] border border-ink/[0.08] bg-deep px-4 py-3.5 md:flex md:items-center md:gap-4 md:px-5" aria-label="This week's step-ins">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 -z-10 h-[180px] w-[180px] rounded-full blur-[70px]" style={{ background: GLOW }} />
      <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 -z-10 h-px opacity-70" style={{ background: `linear-gradient(90deg, transparent, ${VIOLET}, transparent)` }} />
      <button type="button" onClick={onOpen} aria-expanded="false" className="group flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left">
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.2em]" style={{ color: VIOLET }}>
            This week&apos;s step-ins · {cards.length} account{cards.length === 1 ? "" : "s"}
            {flagged ? ` · ${flagged} flagged` : ""}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="line-clamp-2 min-w-0 text-[14px] leading-snug text-fg">{what}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${pill.c}`}>{pill.t}</span>
          </span>
        </span>
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink/10 text-ink/60 transition group-hover:text-fg">→</span>
      </button>
      <span className="flex shrink-0 gap-2">
        {cards.length > 0 && (
          <button type="button" onClick={() => pushParams({ story: "stepins" })} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[12.5px] font-semibold text-deep hover:opacity-90 md:min-h-9" style={{ background: VIOLET }}>
            ▶ Monday story
          </button>
        )}
        <Link href="/stepins" className="inline-flex min-h-11 items-center rounded-full border border-ink/15 px-3.5 text-[12.5px] text-fg hover:border-ink/30 md:min-h-9">
          All step-ins
        </Link>
      </span>
      {story && cards.length > 0 && <Story cards={cards} people={people} />}
    </section>
  );
}

/** Swipes on a phone (scroll snap), fans out a little on a desktop */
function Deck({ cards, people }: { cards: Stepin[]; people: Person[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const go = (i: number) => {
    const el = ref.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  };
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = (el.children[0] as HTMLElement | undefined)?.offsetWidth ?? 1;
          setAt(Math.round(el.scrollLeft / (w + 12)));
        }}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto overflow-y-visible px-4 pb-2 [touch-action:pan-x_pan-y] md:-mx-7 md:px-7"
      >
        {cards.map((c, i) => (
          <div key={c.id} id={`s-${c.clientId}`} className="w-[92%] min-w-0 shrink-0 snap-center sm:w-[70%] sm:snap-start lg:w-[46%]" style={{ transform: i === at ? "none" : "scale(0.97)", transition: "transform .3s cubic-bezier(.2,.8,.2,1)" }}>
            <StepinCardView s={c} people={people} />
          </div>
        ))}
      </div>
      {cards.length > 1 && (
        <div className="flex items-center justify-between gap-3">
          <span className="flex gap-1.5" aria-hidden>
            {cards.map((c, i) => (
              <span key={c.id} className={`h-1.5 rounded-full transition-all ${i === at ? "" : "bg-ink/20"}`} style={{ width: i === at ? 20 : 6, ...(i === at ? { background: VIOLET } : {}) }} />
            ))}
          </span>
          <span className="flex gap-1.5">
            <button type="button" aria-label="Previous" onClick={() => go(Math.max(0, at - 1))} className="grid h-11 w-11 place-items-center rounded-full border border-ink/15 text-ink/70 hover:text-fg md:h-9 md:w-9">
              ←
            </button>
            <button type="button" aria-label="Next" onClick={() => go(Math.min(cards.length - 1, at + 1))} className="grid h-11 w-11 place-items-center rounded-full border border-ink/15 text-ink/70 hover:text-fg md:h-9 md:w-9">
              →
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function StepinCardView({ s, people, big = false }: { s: Stepin; people: Person[]; big?: boolean }) {
  const c = s.card;
  const { pending, msg, run } = useAct();
  const [comment, setComment] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [who, setWho] = useState(s.handler?.id ?? "");
  const [due, setDue] = useState(s.dueOn ?? "");
  const [closing, setClosing] = useState(false);
  const [why, setWhy] = useState("");
  const top = [...s.reasons].sort((a, b) => (a.kind === "fire" ? -1 : b.kind === "fire" ? 1 : 0))[0];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const overdue = Boolean(s.handler && s.dueOn && s.dueOn < today && s.status === "open");
  const handlerFirst = s.handler?.label.split(" ")[0] ?? "";
  return (
    <article className={`relative grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-hidden break-words rounded-[22px] border bg-surface p-4 md:p-5 ${s.fire ? "border-bad/40" : "border-line"} ${big ? "md:p-7" : ""}`}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: s.fire ? "#ff4d5e" : VIOLET }} />
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <Link href={`/clients/${c.client.slug}`} className="block truncate font-heading text-[21px] leading-tight hover:underline">
            {c.client.name}
          </Link>
          {s.handler ? (
            <p className={`mt-0.5 text-[12.5px] font-medium ${overdue ? "text-bad" : "text-ok"}`}>
              Handling: {s.handler.label}
              {s.dueOn ? ` · ${overdue ? "overdue since" : "due"} ${day(`${s.dueOn}T12:00:00Z`)}` : ""}
            </p>
          ) : null}
          <p className="mt-0.5 text-[12.5px] text-muted">{c.owners.length ? `Account on ${c.owners.map((o) => `${o.name.split(" ")[0]} (${o.role})`).join(" · ")}` : "No owner seated"}</p>
        </div>
        <span className="flex flex-wrap gap-1">
          {s.handler && s.status === "open" ? (
            <>
              {s.fire && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[10.5px] font-medium text-bad">Fire</span>}
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${overdue ? "bg-bad-soft text-bad" : "bg-ok-soft text-ok"}`}>
                {handlerFirst} handling{overdue ? " · overdue" : ""}
              </span>
            </>
          ) : (
            [...new Set(s.reasons.map((r) => r.kind))].map((k) => (
              <span key={k} className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${k === "fire" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                {KIND_LABEL[k]}
              </span>
            ))
          )}
        </span>
      </header>

      {top && (
        <div className="grid content-start gap-1">
          <p className={`text-[15.5px] font-medium leading-snug ${top.kind === "fire" ? "text-bad" : "text-fg"}`}>{top.title}</p>
          {top.detail && <p className="text-[13px] leading-relaxed text-muted">{top.detail}</p>}
          {s.reasons.slice(1).map((r, i) => (
            <p key={i} className="text-[12.5px] text-muted">
              Also: {r.title}
            </p>
          ))}
        </div>
      )}

      {c.kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {c.kpis.map((k, i) => (
            <div key={i} className="grid gap-1 rounded-[14px] bg-bg p-3">
              <span className="text-[11px] text-muted">
                {k.platform}
                {k.label ? ` · ${k.label}` : ""}
              </span>
              <span className={`tabular font-display text-[22px] leading-none ${k.worse != null && k.worse > 0.15 ? "text-bad" : "text-fg"}`}>{k.value == null ? "–" : k.roas ? `${k.value.toFixed(2)}x` : `$${k.value >= 100 ? Math.round(k.value) : k.value.toFixed(2)}`}</span>
              <span className="text-[11px] text-muted">
                vs {k.target == null ? "no target" : k.roas ? `${k.target.toFixed(2)}x` : `$${k.target}`}
                {k.trend && (
                  <span style={TREND[k.trend].c ? { color: TREND[k.trend].c } : undefined} className="ml-1 text-muted">
                    {TREND[k.trend].t}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {(c.team.done.length > 0 || c.team.notDone.length > 0 || c.team.lastUpdateDays != null) && (
        <div className="grid items-start gap-3 text-[13px] md:grid-cols-2">
          <div className="grid content-start gap-1">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">The team did</p>
            {c.team.done.length ? c.team.done.map((d, i) => <p key={i}>· {d}</p>) : <p className="text-muted">Nothing on record this week</p>}
          </div>
          <div className="grid content-start gap-1">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Hasn&apos;t done</p>
            {c.team.notDone.length ? c.team.notDone.map((d, i) => <p key={i}>· {d}</p>) : <p className="text-muted">No open promises</p>}
            {c.team.lastUpdateDays != null && <p className={c.team.lastUpdateDays >= 5 ? "text-bad" : "text-muted"}>Last update to the client {c.team.lastUpdateDays} days ago</p>}
          </div>
        </div>
      )}

      <div className="rounded-[14px] p-3.5" style={{ background: "rgba(140,90,255,0.10)" }}>
        <p className="font-display text-[17px] leading-snug" style={{ color: VIOLET }}>
          Step in: <span className="font-sans text-[14.5px] font-medium text-fg">{c.step}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        {!s.handler && s.status === "open" && <span className="rounded-full bg-warn-soft px-2.5 py-1 text-warn">Nobody handling yet</span>}
        {s.status !== "open" && <span className="rounded-full bg-bg px-2.5 py-1 text-muted">{s.status === "handled" ? `Handled by ${s.handledBy ?? "an exec"}` : "Recovered"}</span>}
        {s.reopenedAt && s.status === "open" && <span className="text-muted">Reopened {day(s.reopenedAt)}</span>}
      </div>

      {s.comments.length > 0 && (
        <ul className="grid gap-2 border-t border-line pt-3">
          {s.comments.slice(-6).map((m) => (
            <li key={m.id} className="text-[13px] leading-snug">
              <span className="font-medium">{m.author ?? "Kaizen OS"}</span> <span className="text-faint">· {day(m.at)}</span>
              <p className={m.kind === "comment" ? "text-fg" : "text-muted"}>{m.body}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2">
        <div className="flex min-w-0 gap-2">
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Context, “I'll take this”, “Kyle handles”…" className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg px-4 text-[13.5px] text-fg outline-none focus:border-faint md:min-h-9" />
          <button type="button" disabled={pending || !comment.trim()} onClick={() => run(() => commentOnStepin(s.id, comment), () => setComment(""))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40 md:min-h-9">
            Send
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {s.status === "open" ? (
            <>
              <button type="button" disabled={pending} onClick={() => setAssigning((v) => !v)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
                Who&apos;s handling · due
              </button>
              <button type="button" disabled={pending} onClick={() => setClosing((v) => !v)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
                Mark handled
              </button>
            </>
          ) : (
            <button type="button" disabled={pending} onClick={() => run(() => reopenStepin(s.id))} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
              Reopen
            </button>
          )}
        </div>
        {assigning && (
          <div className="flex flex-wrap gap-2">
            <select value={who} onChange={(e) => setWho(e.target.value)} className="min-h-11 min-w-0 max-w-full flex-1 rounded-full border border-line bg-bg px-3 text-[13px] text-fg md:min-h-9 md:flex-none">
              <option value="">Pick who</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="min-h-11 rounded-full border border-line bg-bg px-3 text-[13px] text-fg md:min-h-9" />
            <button type="button" disabled={pending || (!who && !due)} onClick={() => run(() => assignStepin(s.id, who || null, due || null), () => setAssigning(false))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40 md:min-h-9">
              Save
            </button>
          </div>
        )}
        {closing && (
          <div className="flex min-w-0 flex-wrap gap-2">
            <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What was done (optional)" className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg px-4 text-[13px] text-fg outline-none focus:border-faint md:min-h-9" />
            <button type="button" disabled={pending} onClick={() => run(() => handleStepin(s.id, why), () => setClosing(false))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
              Handled
            </button>
          </div>
        )}
        {msg && <p className={`text-[12px] ${msg.ok ? "text-muted" : "text-bad"}`}>{msg.text}</p>}
      </div>
    </article>
  );
}

/** Monday morning: one card at a time, full screen, tap or arrow keys to move */
function Story({ cards, people }: { cards: Stepin[]; people: Person[] }) {
  const [i, setI] = useState(0);
  const close = () => closeParams("story");
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeParams("story");
      if (e.key === "ArrowRight") setI((x) => Math.min(cards.length - 1, x + 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [cards.length]);
  const s = cards[i];
  return (
    <div role="dialog" aria-modal="true" aria-label="Monday step-ins story" className="fixed inset-0 z-50 grid h-[100dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-2 bg-deep/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-xl md:p-8">
      <span aria-hidden className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[420px] w-[420px] -translate-x-1/2 rounded-full blur-[130px]" style={{ background: GLOW }} />
      <div className="grid gap-3">
        <div className="flex gap-1">
          {cards.map((c, k) => (
            <span key={c.id} className={`h-1 flex-1 rounded-full ${k <= i ? "" : "bg-ink/20"}`} style={k <= i ? { background: VIOLET } : undefined} />
          ))}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: VIOLET }}>
            Step-in {i + 1} of {cards.length}
          </p>
          <button type="button" onClick={close} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full border border-ink/15 text-ink/70 hover:text-fg">
            ✕
          </button>
        </div>
      </div>
      <div className="mx-auto min-h-0 w-full max-w-2xl overflow-y-auto overscroll-contain py-2">
        <StepinCardView key={s.id} s={s} people={people} big />
      </div>
      <div className="mx-auto flex w-full max-w-2xl gap-2">
        <button type="button" disabled={i === 0} onClick={() => setI(i - 1)} className="h-12 flex-1 rounded-full border border-ink/15 text-[15px] text-fg disabled:opacity-30">
          Back
        </button>
        {i < cards.length - 1 ? (
          <button type="button" onClick={() => setI(i + 1)} className="h-12 flex-[2] rounded-full text-[15px] font-semibold text-deep" style={{ background: VIOLET }}>
            Next account
          </button>
        ) : (
          <button type="button" onClick={close} className="h-12 flex-[2] rounded-full text-[15px] font-semibold text-deep" style={{ background: VIOLET }}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
