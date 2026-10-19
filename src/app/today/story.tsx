"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import type { Resolved, Tier, TodayItem, TopicKey } from "@/lib/today";
import { acknowledge, setItem } from "./actions";

// The daily recap as a story: an opening card (today in numbers, and every topic to jump into), then anything a
// teammate took care of since, then each item most critical first, then a closing card with your list. Arrows or
// space move through it; S saves, D dismisses. Jumping to a topic plays that topic's items first, then carries on
// with everything else in order of how critical it is.

type Card = { kind: "intro" } | { kind: "resolved"; r: Resolved } | { kind: "item"; item: TodayItem } | { kind: "end" };

const TIER: Record<Tier, { label: string; glow: string; accent: string; chip: string }> = {
  critical: { label: "Critical", glow: "rgba(200,16,46,0.55)", accent: "#ff4d5e", chip: "bg-[#c8102e] text-white" },
  high: { label: "Important", glow: "rgba(224,150,40,0.45)", accent: "#f2b14c", chip: "bg-[#e0962a] text-black" },
  normal: { label: "Worth a look", glow: "rgba(90,110,255,0.35)", accent: "#9aa8ff", chip: "bg-white/15 text-white" },
};

export function Story({
  firstName,
  greeting,
  items,
  resolved,
  counts,
  topics,
  startTopic,
  demo = false,
}: {
  firstName: string;
  greeting: string;
  items: TodayItem[];
  resolved: Resolved[];
  counts: Record<Tier, number>;
  topics: Record<TopicKey, { label: string; blurb: string }>;
  startTopic: TopicKey | null;
  /** Design preview: nothing is saved */
  demo?: boolean;
}) {
  const router = useRouter();
  // The play order: most critical first, or a chosen topic first and then the rest in order
  const orderFor = useCallback(
    (topic: TopicKey | null, viewed: Set<string> = new Set()) => {
      const rest = items.filter((i) => !viewed.has(i.key));
      return topic ? [...rest.filter((i) => i.topic === topic), ...rest.filter((i) => i.topic !== topic)] : rest;
    },
    [items],
  );
  const [order, setOrder] = useState<TodayItem[]>(() => orderFor(startTopic));
  const [viewedItems, setViewedItems] = useState<TodayItem[]>([]);
  const cards: Card[] = useMemo(() => [{ kind: "intro" }, ...resolved.map((r) => ({ kind: "resolved" as const, r })), ...viewedItems.map((item) => ({ kind: "item" as const, item })), ...order.filter((i) => !viewedItems.some((v) => v.key === i.key)).map((item) => ({ kind: "item" as const, item })), { kind: "end" }], [resolved, order, viewedItems]);
  const [at, setAt] = useState(startTopic ? 1 + resolved.length : 0);
  const [mine, setMine] = useState<Record<string, "seen" | "saved" | "done" | "dismissed">>(() => Object.fromEntries(items.map((i) => [i.key, i.state === "new" ? "seen" : i.state])));
  const [sheet, setSheet] = useState<TodayItem | null>(null);
  const [picker, setPicker] = useState(false);
  const card = cards[Math.min(at, cards.length - 1)];

  const snap = (i: TodayItem) => ({ topic: i.topic, client: i.client, title: i.title, clientId: i.clientId });
  // Mark what's been shown: seen (once), and remember it was viewed so a topic jump doesn't replay it
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (card.kind === "item" && !shown.current.has(card.item.key)) {
      shown.current.add(card.item.key);
      if (!demo) void setItem(card.item.key, "seen", snap(card.item));
    }
    if (card.kind === "resolved" && !shown.current.has(card.r.key)) {
      shown.current.add(card.r.key);
      if (!demo) void acknowledge(card.r.key);
    }
  }, [card, demo]);

  const go = useCallback((n: number) => setAt((a) => Math.max(0, Math.min(cards.length - 1, a + n))), [cards.length]);
  const choose = async (i: TodayItem, status: "saved" | "done" | "dismissed") => {
    const next = demo ? (status === "saved" && mine[i.key] === "saved" ? "seen" : status) : await setItem(i.key, status, snap(i));
    setMine((m) => ({ ...m, [i.key]: next ?? status }));
    if (status !== "saved" || next === "saved") go(1);
  };
  const jump = (topic: TopicKey) => {
    // What's been played stays where it is; the chosen topic plays next, then everything else by criticality
    const played = cards.slice(0, at + 1).filter((c): c is { kind: "item"; item: TodayItem } => c.kind === "item").map((c) => c.item);
    const playedKeys = new Set(played.map((p) => p.key));
    setViewedItems(played);
    setOrder(orderFor(topic, playedKeys));
    setAt(1 + resolved.length + played.length);
    setPicker(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") setPicker(false);
      else if (card.kind === "item" && (e.key === "s" || e.key === "S")) void choose(card.item, "saved");
      else if (card.kind === "item" && (e.key === "d" || e.key === "D")) void choose(card.item, "dismissed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const byTopic = useMemo(() => {
    const m = new Map<TopicKey, { n: number; critical: number }>();
    for (const i of items) {
      const t = m.get(i.topic) ?? { n: 0, critical: 0 };
      t.n++;
      if (i.tier === "critical") t.critical++;
      m.set(i.topic, t);
    }
    return [...m.entries()].sort((a, b) => b[1].critical - a[1].critical || (items.findIndex((i) => i.topic === a[0]) - items.findIndex((i) => i.topic === b[0])));
  }, [items]);
  const saved = items.filter((i) => mine[i.key] === "saved");
  const acted = items.filter((i) => mine[i.key] === "done").length;
  const tone = card.kind === "item" ? TIER[card.item.tier] : card.kind === "resolved" ? { glow: "rgba(40,180,120,0.35)", accent: "#5be3a5" } : { glow: "rgba(200,16,46,0.35)", accent: "#ff4d5e" };

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-[#07060a] text-white [color-scheme:dark]">
      <style>{`@keyframes card-in { from { opacity: 0; transform: translateY(18px) scale(.985) } to { opacity: 1; transform: none } } @keyframes glow { 0%,100% { transform: translate(-10%,-10%) scale(1) } 50% { transform: translate(6%,4%) scale(1.15) } }`}</style>
      {/* The colour of what's on screen: red for critical, amber for important, blue for the rest, green for done */}
      <div aria-hidden className="pointer-events-none absolute -left-1/4 -top-1/4 h-[90vh] w-[90vh] rounded-full blur-[140px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 14s ease-in-out infinite" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-1/3 right-0 h-[70vh] w-[70vh] rounded-full opacity-60 blur-[160px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 18s ease-in-out infinite reverse" }} />

      {/* Progress, and the way out */}
      <header className="relative z-10 grid gap-3 px-4 pt-4 md:px-8 md:pt-6">
        <div className="flex gap-1">
          {cards.map((c, n) => (
            <button key={n} type="button" aria-label={`Card ${n + 1}`} onClick={() => setAt(n)} className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <span className="block h-full rounded-full bg-white transition-all duration-300" style={{ width: n < at ? "100%" : n === at ? "100%" : "0%", opacity: n === at ? 1 : 0.7 }} />
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-white/60">
          <span>
            {card.kind === "item" ? `${topics[card.item.topic].label} · ${at - resolved.length} of ${items.length}` : card.kind === "resolved" ? "Since you last looked" : "Today"}
          </span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPicker((p) => !p)} className="rounded-full border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10">
              Jump to a topic
            </button>
            <Link href="/pipeline" className="rounded-full border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10">
              Close
            </Link>
          </span>
        </div>
      </header>

      {picker && (
        <div className="absolute inset-x-4 top-24 z-30 mx-auto grid max-w-2xl gap-2 rounded-[20px] border border-white/15 bg-black/80 p-4 backdrop-blur-xl md:inset-x-8">
          <p className="text-xs uppercase tracking-[0.18em] text-white/50">Jump to a topic · then the rest, most critical first</p>
          <TopicChoices byTopic={byTopic} topics={topics} onPick={jump} />
        </div>
      )}

      {/* The card */}
      <main className="relative z-10 grid h-[calc(100%-140px)] place-items-center overflow-y-auto px-4 pb-6 md:px-8" onClick={(e) => (e.target === e.currentTarget ? go(1) : undefined)}>
        <div key={at} className="grid w-full max-w-4xl gap-8 py-8" style={{ animation: "card-in .45s cubic-bezier(.2,.8,.2,1) both" }}>
          {card.kind === "intro" && (
            <div className="grid gap-8">
              <div className="grid gap-3">
                <p className="text-sm uppercase tracking-[0.24em] text-white/50">Your day</p>
                <h1 className="font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
                  {greeting}, {firstName}.
                </h1>
                <p className="max-w-xl text-lg text-white/70">
                  {items.length ? `${items.length} things across your clients today${counts.critical ? `, ${counts.critical} critical` : ""}. Most critical first.` : "Nothing needs you today. Every client is in good hands."}
                  {resolved.length ? ` And ${resolved.length} ${resolved.length === 1 ? "thing a teammate took" : "things teammates took"} care of since you last looked.` : ""}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 md:max-w-2xl">
                {(["critical", "high", "normal"] as const).map((t) => (
                  <div key={t} className="grid gap-1 rounded-[18px] border border-white/10 bg-white/[0.04] p-4">
                    <span className="font-display text-5xl tabular" style={{ color: TIER[t].accent }}>
                      {counts[t]}
                    </span>
                    <span className="text-xs uppercase tracking-[0.14em] text-white/60">{TIER[t].label}</span>
                  </div>
                ))}
              </div>
              {items.length > 0 && (
                <div className="grid gap-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/50">Start with a topic, or just press start</p>
                  <TopicChoices byTopic={byTopic} topics={topics} onPick={jump} />
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => go(1)} className="h-12 rounded-full bg-white px-7 text-[15px] font-semibold text-black hover:bg-white/90">
                  {items.length || resolved.length ? "Start" : "Back to the Overview"}
                </button>
                <span className="self-center text-xs text-white/40">→ or space to move on · S to save for later · D to dismiss</span>
              </div>
            </div>
          )}

          {card.kind === "resolved" && (
            <div className="grid gap-6">
              <p className="text-sm uppercase tracking-[0.24em] text-[#5be3a5]">Since you last looked · {card.r.client}</p>
              <h2 className="font-display text-4xl leading-tight tracking-tight md:text-6xl">Taken care of.</h2>
              <p className="max-w-2xl text-xl leading-relaxed text-white/80">
                &ldquo;{card.r.title}&rdquo; came up for you. {card.r.by ? `${card.r.by} ${card.r.what}.` : `${card.r.what.charAt(0).toUpperCase()}${card.r.what.slice(1)}.`}
              </p>
              <p className="text-sm text-white/50">Nothing for you to do. It&apos;s in motion.</p>
              <div>
                <button type="button" onClick={() => go(1)} className="h-11 rounded-full bg-white px-6 text-sm font-semibold text-black">
                  Next
                </button>
              </div>
            </div>
          )}

          {card.kind === "item" && <ItemCard i={card.item} status={mine[card.item.key]} topicLabel={topics[card.item.topic].label} onChoose={(s) => void choose(card.item, s)} onAct={() => (card.item.action.suggestion ? setSheet(card.item) : undefined)} />}

          {card.kind === "end" && (
            <div className="grid gap-8">
              <div className="grid gap-3">
                <p className="text-sm uppercase tracking-[0.24em] text-white/50">That&apos;s today</p>
                <h2 className="font-display text-5xl leading-tight tracking-tight md:text-7xl">{acted ? `${acted} handled.` : "All caught up."}</h2>
                <p className="text-lg text-white/70">
                  {saved.length ? `${saved.length} saved for later. They're on your list below and on the Overview, and come back tomorrow if they're still open.` : "Nothing saved for later."}
                </p>
              </div>
              {saved.length > 0 && (
                <ul className="grid gap-2 md:max-w-2xl">
                  {saved.map((s) => (
                    <li key={s.key}>
                      <button type="button" onClick={() => setAt(cards.findIndex((c) => c.kind === "item" && c.item.key === s.key))} className="flex w-full items-center gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] px-4 py-3 text-left hover:bg-white/[0.08]">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TIER[s.tier].accent }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{s.title}</span>
                          <span className="block text-xs text-white/50">
                            {s.client} · {topics[s.topic].label}
                          </span>
                        </span>
                        <span className="text-white/40">→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => router.push("/pipeline")} className="h-12 rounded-full bg-white px-7 text-[15px] font-semibold text-black">
                  Back to the Overview
                </button>
                <button type="button" onClick={() => setAt(0)} className="h-12 rounded-full border border-white/25 px-6 text-sm text-white/80 hover:bg-white/10">
                  From the top
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Back and forward, for a mouse */}
      <button type="button" aria-label="Previous" onClick={() => go(-1)} className="absolute left-2 top-1/2 z-20 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full text-2xl text-white/40 hover:bg-white/10 hover:text-white md:grid">
        ‹
      </button>
      <button type="button" aria-label="Next" onClick={() => go(1)} className="absolute right-2 top-1/2 z-20 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full text-2xl text-white/40 hover:bg-white/10 hover:text-white md:grid">
        ›
      </button>

      {sheet?.action.suggestion && (
        <div className="relative z-50 [color-scheme:normal]">
          <SuggestionSheet
            s={sheet.action.suggestion}
            onClose={() => {
              setMine((m) => ({ ...m, [sheet.key]: "done" }));
              void setItem(sheet.key, "done", snap(sheet));
              setSheet(null);
              go(1);
            }}
          />
        </div>
      )}
    </div>
  );
}

function TopicChoices({ byTopic, topics, onPick }: { byTopic: [TopicKey, { n: number; critical: number }][]; topics: Record<TopicKey, { label: string; blurb: string }>; onPick: (t: TopicKey) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {byTopic.map(([t, c]) => (
        <button key={t} type="button" onClick={() => onPick(t)} className="group grid gap-0.5 rounded-[14px] border border-white/15 bg-white/[0.05] px-4 py-2.5 text-left transition-colors hover:border-white/40 hover:bg-white/10">
          <span className="flex items-center gap-2 text-sm font-medium">
            {c.critical > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[#ff4d5e]" />}
            {topics[t].label}
            <span className="tabular text-white/50">{c.n}</span>
          </span>
          <span className="text-[11px] text-white/45">{c.critical ? `${c.critical} critical · ` : ""}{topics[t].blurb}</span>
        </button>
      ))}
    </div>
  );
}

function ItemCard({ i, status, topicLabel, onChoose, onAct }: { i: TodayItem; status?: string; topicLabel: string; onChoose: (s: "saved" | "done" | "dismissed") => void; onAct: () => void }) {
  const t = TIER[i.tier];
  const actButton = "inline-flex h-12 items-center rounded-full bg-white px-6 text-[15px] font-semibold text-black hover:bg-white/90";
  return (
    <div className={`grid items-center gap-8 ${i.image ? "md:grid-cols-[minmax(0,1fr)_280px]" : ""}`}>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${t.chip}`}>{t.label}</span>
          <span className="text-xs uppercase tracking-[0.18em] text-white/50">
            {topicLabel} · {i.client}
          </span>
          {i.carried && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-white/70">Still open from before</span>}
          {status === "saved" && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] text-white">Saved for later</span>}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <span className="font-display text-7xl leading-none tracking-tight tabular md:text-8xl" style={{ color: t.accent }}>
            {i.stat.value}
          </span>
          <span className="pb-2 text-base text-white/60">{i.stat.label}</span>
        </div>
        <h2 className="max-w-3xl font-heading text-3xl leading-tight md:text-4xl">{i.title}</h2>
        <p className="max-w-2xl text-lg leading-relaxed text-white/75">{i.story}</p>
        {i.evidence.length > 0 && (
          <ul className="grid max-w-2xl gap-1.5">
            {i.evidence.map((e, n) => (
              <li key={n} className="flex gap-2 text-sm text-white/60">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-white/40" />
                {e}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-white/45">
          Why it&apos;s {i.tier === "critical" ? "up first" : "here"}: {i.why}
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {i.action.suggestion ? (
            <button type="button" onClick={onAct} className={actButton}>
              {i.action.label}
            </button>
          ) : (
            <a href={i.action.href} target="_blank" rel="noreferrer" onClick={() => onChoose("done")} className={actButton}>
              {i.action.label} ↗
            </a>
          )}
          <button type="button" onClick={() => onChoose("saved")} className={`h-12 rounded-full border px-5 text-sm ${status === "saved" ? "border-white bg-white/15 text-white" : "border-white/25 text-white/85 hover:bg-white/10"}`}>
            {status === "saved" ? "Saved ✓" : "Save for later"}
          </button>
          <button type="button" onClick={() => onChoose("dismissed")} className="h-12 rounded-full px-4 text-sm text-white/50 hover:text-white">
            Not for me
          </button>
        </div>
      </div>
      {i.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={i.image} alt="" className="hidden aspect-[4/5] w-full rounded-[20px] object-cover shadow-[0_40px_80px_-30px_rgba(0,0,0,0.8)] md:block" />
      )}
    </div>
  );
}
