"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { markBibleReviewed } from "../next-actions";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import { initials } from "@/lib/initials";
import type { NextForMe, NextItem } from "@/lib/next-for-me";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "./suggested-briefs";
import { SaveIdeaStar } from "@/components/save-idea-star";

// Next for me, drawn to sit under the recap hero: a lit header with today's numbers in one strip, then each group as
// its own card with a colored accent, and rows that lead with the client. The accents are the hero's colors, set as
// --accent inline so the light theme swaps in its darker versions (globals.css).

type Key = keyof Omit<NextForMe, "stats">;
type Icon = "bolt" | "split" | "book" | "eye" | "calendar";

const SECTIONS: { key: Key; title: string; hint: string; accent: string; glow: string; icon: Icon }[] = [
  { key: "now", title: "Now", hint: "Late, due today, or waiting on you", accent: "#ff4d5e", glow: "rgba(200,16,46,0.45)", icon: "bolt" },
  { key: "decide", title: "To decide", hint: "Briefs the AI suggests for your clients", accent: "#9aa8ff", glow: "rgba(90,110,255,0.32)", icon: "split" },
  { key: "bibles", title: "Brand Bibles to review", hint: "Read each one, then mark it reviewed", accent: "#ff6b78", glow: "rgba(178,30,44,0.4)", icon: "book" },
  { key: "watch", title: "Keep an eye on", hint: "Your accounts and clients", accent: "#f2b14c", glow: "rgba(224,150,40,0.35)", icon: "eye" },
  { key: "coming", title: "Coming up", hint: "On you, not due yet", accent: "#5be3a5", glow: "rgba(40,180,120,0.3)", icon: "calendar" },
];
// Sections that only show when they have something in them (the rest fold into the "All clear" line when empty)
const OPTIONAL = new Set<string>(["bibles", "coming"]);

// Which sections someone folded away, remembered per person in this browser (kz:next:closed:<their id>). Before the
// browser has said (the server render), every section is open.
const listeners = new Set<() => void>();
const keyOf = (me: string) => `kz:next:closed:${me}`;
const readClosed = (me: string) => {
  try {
    return localStorage.getItem(keyOf(me)) ?? "";
  } catch {
    return "";
  }
};
const writeClosed = (me: string, keys: string[]) => {
  try {
    localStorage.setItem(keyOf(me), keys.join(","));
  } catch {
    /* private window: what's folded just isn't remembered */
  }
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function useClosed(me: string) {
  const raw = useSyncExternalStore(subscribe, () => readClosed(me), () => "");
  return raw ? raw.split(",") : [];
}

const KIND: Record<NextItem["kind"], string> = {
  sprint: "Sprint",
  ticket: "Ticket",
  review: "Review",
  launch: "Launch",
  brief: "AI brief",
  promise: "Promised on a call",
  first_round: "First round",
  refresh: "Refresh brief",
  kpi: "KPI",
  fatigue: "Ad wearing out",
  intake: "Onboarding",
  client: "Client",
  task: "Plan task",
  bible: "Brand Bible",
};

/** The short title a row leads with, plus a sprint's progress (done of total) when it has one. */
function shortOf(it: NextItem): { title: string; sub?: string; progress?: { done: number; total: number } } {
  if (it.kind === "sprint") {
    const m = it.title.match(/(\d+) of (\d+)/);
    const who = it.title.match(/with (.+?):/)?.[1];
    if (m) {
      const done = Number(m[1]);
      const total = Number(m[2]);
      return { title: who ? `Sprint ${done} of ${total} done` : `Your sprint: ${done} of ${total} done`, sub: who ? `with ${who}` : undefined, progress: { done, total } };
    }
  }
  if (it.kind === "bible") {
    const v = it.title.match(/v(\S+)$/)?.[1];
    return { title: v ? `Brand Bible v${v} to review` : "Brand Bible to review" };
  }
  return { title: it.title };
}

/** How the "when" chip reads: late in red, due or stale in amber, everything else calm. A sprint not checked today is stale. */
function whenTone(it: NextItem): "bad" | "warn" | "calm" {
  if (!it.when) return "calm";
  if (it.tone === "bad") return "bad";
  if (it.tone === "warn") return "warn";
  if (it.kind === "sprint" && /^Checked /.test(it.when) && it.when !== "Checked today") return "warn";
  return "calm";
}

const CHIP = {
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  calm: "bg-ink/[0.06] text-ink/60",
  ok: "bg-ok-soft text-ok",
} as const;

/** Everything on one person: the numbers up top, then calm cards that fold away. Briefs open right here; everything else goes where it lives. */
export function NextList({ data, me }: { data: NextForMe; me: string }) {
  const router = useRouter();
  const closed = useClosed(me);
  const toggle = (key: string) => writeClosed(me, closed.includes(key) ? closed.filter((k) => k !== key) : [...closed, key]);
  // The brief open is in the address (?todo=id), so back closes it and a link opens it. Its own param, not ?brief:
  // the suggested briefs in the Overview's themes above use that one, and the same brief can be in both
  const openId = useParam("todo");
  const sheet = (openId && SECTIONS.flatMap((x) => data[x.key]).find((it) => it.suggestion?.id === openId)?.suggestion) || null;
  // Bibles marked reviewed leave the list at once; the page catches up behind it
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [, startReview] = useTransition();
  const review = (it: NextItem) => {
    if (!it.bible) return;
    const b = it.bible;
    setReviewed((r) => [...r, it.id]);
    startReview(async () => {
      const r = await markBibleReviewed(b.clientId, b.version);
      if (!r.ok) setReviewed((x) => x.filter((id) => id !== it.id));
      else router.refresh();
    });
  };
  const bibles = data.bibles.filter((it) => !reviewed.includes(it.id));
  const itemsOf = (k: Key) => (k === "bibles" ? bibles : data[k]);
  const total = data.now.length + data.decide.length + data.watch.length + bibles.length;
  const shown = SECTIONS.filter((s) => itemsOf(s.key).length > 0);
  const clear = SECTIONS.filter((s) => !itemsOf(s.key).length && !OPTIONAL.has(s.key));

  // A number in the strip jumps to the card it counts (and opens it if it was folded)
  const jump = (k: Key) => {
    if (closed.includes(k)) toggle(k);
    document.getElementById(`next-card-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="grid gap-4">
      <style>{`@keyframes next-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
      <Header data={data} onJump={jump} />

      {total === 0 && data.coming.length === 0 ? (
        <p className="flex items-center gap-2.5 px-1 text-[13px] text-ink/55">
          <Check />
          New work, briefs to decide and anything off on your accounts land here as they come in.
        </p>
      ) : (
        <>
          {shown.map((s, i) => (
            <Group key={s.key} s={s} index={i} items={itemsOf(s.key)} open={!closed.includes(s.key)} onToggle={() => toggle(s.key)} onBrief={(b) => pushParams({ todo: b.id })} onReviewed={review} />
          ))}
          {clear.length > 0 && (
            <p className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-full border border-ink/[0.07] px-4 py-2 text-[13px] text-ink/55" style={{ animation: `next-in .45s ${0.06 * shown.length}s cubic-bezier(.2,.8,.2,1) both` }}>
              <Check />
              <span className="text-ink/75">All clear:</span>
              {clear.map((s, i) => (
                <span key={s.key}>
                  {s.title}
                  {i < clear.length - 1 && <span className="pl-2.5 text-ink/30">·</span>}
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {sheet && <SuggestionSheet s={sheet} onClose={() => closeThen(() => router.refresh(), "todo")} />}
    </div>
  );
}

/** The lit header: the kicker, a strong title, and the four numbers as one strip (or a single "You're clear"). */
function Header({ data, onJump }: { data: NextForMe; onJump: (k: Key) => void }) {
  const n = data.now.length + data.decide.length;
  const { onMe, late, dueToday, toDecide } = data.stats;
  const allZero = !onMe && !late && !dueToday && !toDecide;
  const stats: { label: string; n: number; color: string; to: Key }[] = [
    { label: "Late", n: late, color: "text-[#ff4d5e]", to: "now" },
    { label: "Due today", n: dueToday, color: "text-[#f2b14c]", to: "now" },
    { label: "On you", n: onMe, color: "text-brand-text", to: "now" },
    { label: "To decide", n: toDecide, color: "text-[#9aa8ff]", to: "decide" },
  ];
  return (
    <div className="relative grid gap-6 overflow-hidden rounded-[24px] border border-line bg-deep p-5 md:flex md:items-end md:justify-between md:p-7" style={{ animation: "next-in .45s cubic-bezier(.2,.8,.2,1) both" }}>
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-32 h-[300px] w-[300px] rounded-full blur-[110px]" style={{ background: late ? "rgba(200,16,46,0.4)" : allZero ? "rgba(40,180,120,0.22)" : "rgba(90,110,255,0.28)" }} />
      <div className="relative grid min-w-0 gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/50">Next for me</p>
        <h2 id="next-title" className="font-display text-3xl leading-tight tracking-tight text-fg md:text-4xl">
          {n ? (
            <>
              {n} {n === 1 ? "thing needs" : "things need"} you{late > 0 && <span className="text-[#ff4d5e]">, {late} late</span>}
            </>
          ) : (
            "Nothing waiting on you"
          )}
        </h2>
        <p className="text-sm text-ink/55">Your tickets, decisions and accounts in one place, most urgent first.</p>
      </div>
      {allZero ? (
        <div className="relative flex items-center gap-3 md:text-right">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ok-soft text-[#5be3a5] md:order-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5 10 17 19 7.5" />
            </svg>
          </span>
          <span className="grid">
            <span className="font-display text-2xl tracking-tight text-[#5be3a5]">You&apos;re clear</span>
            <span className="text-[12px] text-ink/50">Nothing late, due today or waiting on a decision</span>
          </span>
        </div>
      ) : (
        <div className="relative grid grid-cols-4 gap-1 md:flex md:gap-2">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onJump(s.to)}
              disabled={!s.n}
              className="grid min-h-11 content-start justify-items-start rounded-[12px] px-2 py-1 text-left transition-colors enabled:hover:bg-ink/[0.05] md:justify-items-end md:px-3 md:text-right"
            >
              <span className={`tabular font-display text-4xl leading-none tracking-tight md:text-5xl ${s.n ? s.color : "text-ink/20"}`}>{s.n}</span>
              <span className={`pt-1.5 text-[10px] uppercase tracking-[0.14em] ${s.n ? "text-ink/55" : "text-ink/30"}`}>{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Check() {
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-soft text-[#5be3a5]">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5 10 17 19 7.5" />
      </svg>
    </span>
  );
}

function GroupIcon({ name }: { name: Icon }) {
  const paths: Record<Icon, React.ReactNode> = {
    bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
    split: (
      <>
        <path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6" />
        <path d="M18 3v6a6 6 0 0 1-3 5.2" />
        <path d="m3 6 3-3 3 3M15 6l3-3 3 3" />
      </>
    ),
    book: (
      <>
        <path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 22h13" />
        <path d="M9 7h6" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
        <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      </>
    ),
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}

// One quiet tint per client, picked from the name, so the same client reads the same everywhere in the list
const TINTS = ["#b21e2c", "#7a4f9a", "#2f6f8f", "#3f7d5a", "#9a6a2f", "#5a5a8f", "#8f3f6a"];
function ClientChip({ name, size = 40 }: { name: string; size?: number }) {
  const tint = TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
  return (
    <span aria-hidden style={{ width: size, height: size, background: tint, fontSize: size * 0.34 }} className="grid shrink-0 place-items-center rounded-[12px] font-semibold tracking-wide text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]">
      {initials(name) || "?"}
    </span>
  );
}

/** Items in order, gathered by client where a client has several (first appearance keeps the urgency order). */
function byClient(items: NextItem[]) {
  const m = new Map<string, NextItem[]>();
  for (const it of items) m.set(it.client, [...(m.get(it.client) ?? []), it]);
  return [...m.entries()];
}

type Handlers = { onBrief: (s: OpenSuggestion) => void; onReviewed: (it: NextItem) => void };

function Group({ s, index, items, open, onToggle, ...h }: { s: (typeof SECTIONS)[number]; index: number; items: NextItem[]; open: boolean; onToggle: () => void } & Handlers) {
  const urgent = items.filter((it) => it.tone === "bad").length;
  const clients = byClient(items);
  return (
    <section
      id={`next-card-${s.key}`}
      aria-labelledby={`next-h-${s.key}`}
      style={{ ["--accent" as string]: s.accent, ["--glow" as string]: s.glow, animation: `next-in .45s ${0.06 * (index + 1)}s cubic-bezier(.2,.8,.2,1) both` }}
      className="relative isolate scroll-mt-24 overflow-hidden rounded-[22px] border border-ink/[0.07] bg-deep"
    >
      <span aria-hidden className="pointer-events-none absolute -left-16 -top-24 -z-10 h-[200px] w-[200px] rounded-full blur-[80px]" style={{ background: "var(--glow)", opacity: open ? 0.55 : 0.3 }} />
      <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 h-px opacity-70" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
      <h3 id={`next-h-${s.key}`}>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`next-${s.key}`} className="group flex min-h-16 w-full items-center gap-3.5 px-4 py-4 text-left md:px-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]" style={{ color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
            <GroupIcon name={s.icon} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="font-heading text-[17px] tracking-tight text-fg md:text-lg">{s.title}</span>
              <span className="tabular rounded-full px-2 py-0.5 text-[11.5px] font-semibold" style={{ color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}>
                {items.length}
              </span>
              {!open && urgent > 0 && <span className="tabular rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{urgent} late</span>}
            </span>
            <span className="truncate text-[12.5px] text-ink/50">{s.hint}</span>
          </span>
          {!open && (
            <span aria-hidden className="hidden -space-x-2 sm:flex">
              {clients.slice(0, 3).map(([c]) => (
                <span key={c} className="rounded-[10px] ring-2 ring-[var(--deep)]">
                  <ClientChip name={c} size={26} />
                </span>
              ))}
            </span>
          )}
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink/45 transition-colors group-hover:bg-ink/[0.06] group-hover:text-fg">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-300 ${open ? "" : "-rotate-90"}`}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </button>
      </h3>
      {/* Folds by animating the row height from 0 to its content (grid rows 0fr to 1fr), so it opens and closes smoothly */}
      <div id={`next-${s.key}`} inert={!open} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
        <div className="min-h-0 overflow-hidden">
          <ul className="grid divide-y divide-ink/[0.06] border-t border-ink/[0.06]">
            {clients.map(([client, its]) =>
              its.length === 1 ? (
                <Row key={its[0].id} it={its[0]} showClient {...h} />
              ) : (
                <li key={client} className="grid">
                  <div className="flex items-center gap-3 px-4 pb-1 pt-4 md:px-5">
                    <ClientChip name={client} />
                    <span className="grid min-w-0">
                      <span className="truncate text-[15px] font-semibold text-fg">{client}</span>
                      <span className="text-[12px] text-ink/45">{its.length} things</span>
                    </span>
                  </div>
                  <ul className="grid divide-y divide-ink/[0.04] sm:pl-[52px]">
                    {its.map((it) => (
                      <Row key={it.id} it={it} showClient={false} {...h} />
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Row({ it, showClient, onBrief, onReviewed }: { it: NextItem; showClient: boolean } & Handlers) {
  const [more, setMore] = useState(false);
  const short = shortOf(it);
  const tone = whenTone(it);
  const late = it.tone === "bad";
  const long = it.why.length > 64;
  const go = it.suggestion ? () => onBrief(it.suggestion!) : undefined;
  const chips = (
    <>
      {it.when && <span className={`tabular shrink-0 rounded-full px-2 py-0.5 text-[11px] ${CHIP[tone]}`}>{it.when}</span>}
      {it.chip && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${it.chip.tone === "ok" ? CHIP.ok : CHIP.calm}`}>{it.chip.label}</span>}
    </>
  );
  const titleCls = "min-w-0 text-left text-[14px] leading-snug text-ink/85 transition-colors hover:text-fg";
  const titleBody = (
    <>
      {short.title}
      {short.sub && <span className="text-ink/45"> {short.sub}</span>}
    </>
  );
  const title = go ? (
    <button type="button" onClick={go} className={titleCls}>
      {titleBody}
    </button>
  ) : (
    <Link href={it.href ?? "#"} className={titleCls}>
      {titleBody}
    </Link>
  );
  const actionCls = `inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-colors sm:min-h-9 sm:w-auto ${late ? "bg-fg text-bg hover:bg-ink/85" : "border border-ink/15 bg-ink/[0.04] text-ink/85 hover:border-ink/30 hover:bg-ink/[0.08] hover:text-fg"}`;
  const action = go ? (
    <button type="button" onClick={go} className={actionCls}>
      {it.action} <span aria-hidden>→</span>
    </button>
  ) : (
    <Link href={it.href ?? "#"} className={actionCls}>
      {it.action} <span aria-hidden>→</span>
    </Link>
  );
  return (
    <li className="relative">
      {late && <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-[var(--bad)]" />}
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 md:px-5">
        <div className="flex min-w-0 flex-1 gap-3">
          {showClient && <ClientChip name={it.client} />}
          <div className="grid min-w-0 flex-1 gap-1">
            {showClient ? (
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-[15px] font-semibold text-fg">{it.client}</span>
                <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink/40">{KIND[it.kind]}</span>
                {chips}
              </p>
            ) : (
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] uppercase tracking-[0.12em] text-ink/40">
                {KIND[it.kind]}
                {chips}
              </p>
            )}
            {title}
            {short.progress && (
              <span className="flex items-center gap-2 pt-0.5" aria-label={`${short.progress.done} of ${short.progress.total} done`}>
                <span className="h-1.5 w-28 overflow-hidden rounded-full bg-ink/10">
                  <span
                    className="block h-full rounded-full transition-[width] duration-500"
                    style={{ ["--accent" as string]: late ? "#ff4d5e" : tone === "warn" ? "#f2b14c" : "#5be3a5", background: "var(--accent)", width: `${short.progress.total ? Math.max(4, (short.progress.done / short.progress.total) * 100) : 0}%` }}
                  />
                </span>
                <span className="tabular text-[11px] text-ink/45">{short.progress.total ? Math.round((short.progress.done / short.progress.total) * 100) : 0}%</span>
              </span>
            )}
            {long ? (
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} title={more ? undefined : it.why} className="group/why flex min-w-0 items-start gap-1.5 text-left text-[12.5px] leading-relaxed text-ink/50 hover:text-ink/70">
                <span className={`min-w-0 ${more ? "" : "line-clamp-1"}`}>{it.why}</span>
                <span aria-hidden className={`shrink-0 pt-0.5 text-ink/35 transition-transform duration-200 ${more ? "rotate-180" : ""}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
                <span className="sr-only">{more ? "Show less" : "Show more"}</span>
              </button>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-ink/50">{it.why}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row sm:items-center">
          {it.suggestion && (
            <span className="hidden sm:inline-flex">
              <SaveIdeaStar source={{ kind: "suggestion", id: it.suggestion.id }} from={{ kicker: KIND[it.kind], label: it.title }} clientId={it.suggestion.clientId} clientName={it.client} size="sm" />
            </span>
          )}
          {it.bible && (
            // A Brand Bible: open it to read, or mark it reviewed right here (it leaves the list at once)
            <button type="button" onClick={() => onReviewed(it)} className="order-2 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] text-ink/55 transition-colors hover:bg-ink/[0.06] hover:text-fg sm:order-none sm:min-h-9">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12.5 10 17 19 7.5" />
              </svg>
              Mark reviewed
            </button>
          )}
          {action}
          {it.suggestion && (
            <span className="flex justify-center sm:hidden">
              <SaveIdeaStar source={{ kind: "suggestion", id: it.suggestion.id }} from={{ kicker: KIND[it.kind], label: it.title }} clientId={it.suggestion.clientId} clientName={it.client} size="sm" />
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
