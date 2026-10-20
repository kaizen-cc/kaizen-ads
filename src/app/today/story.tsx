"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import type { Resolved, Tier, TodayItem, TopicKey } from "@/lib/today";
import { acknowledge, setItem } from "./actions";

// The daily recap as a story, one screen per topic: "6 accounts are off target", each client in a row with the number
// that matters. Pick a client to see its overview right there and act on it, save the whole topic for later, or deep
// dive through them one by one. Topics play most critical first; any topic can be jumped to. Arrows or space move on.

type Card = { kind: "intro" } | { kind: "resolved"; r: Resolved } | { kind: "topic"; topic: TopicKey; items: TodayItem[] } | { kind: "end" };
type Mark = "seen" | "saved" | "done" | "dismissed";

const TIER: Record<Tier, { label: string; glow: string; accent: string; chip: string }> = {
  critical: { label: "Critical", glow: "rgba(200,16,46,0.55)", accent: "#ff4d5e", chip: "bg-[#c8102e] text-white" },
  high: { label: "Important", glow: "rgba(224,150,40,0.45)", accent: "#f2b14c", chip: "bg-[#e0962a] text-black" },
  normal: { label: "Worth a look", glow: "rgba(90,110,255,0.35)", accent: "#9aa8ff", chip: "bg-white/15 text-white" },
};

/** What a topic's screen says, in one line. */
function headline(topic: TopicKey, n: number) {
  const s = (one: string, many: string) => (n === 1 ? one : many);
  switch (topic) {
    case "mine":
      return `${n} ${s("thing is", "things are")} on you today`;
    case "promises":
      return `${n} ${s("promise to a client hasn't", "promises to clients haven't")} started`;
    case "onboarding":
      return `${n} new ${s("client needs", "clients need")} you`;
    case "accounts":
      return `${n} ${s("account is", "accounts are")} having issues`;
    case "work":
      return `${n} ${s("piece of work is", "pieces of work are")} running late`;
    case "briefs":
      return `${n} ${s("brief is", "briefs are")} waiting on a decision`;
    case "ads":
      return `${n} ${s("ad is", "ads are")} wearing out`;
    case "allotments":
      return `${n} ${s("client is", "clients are")} off their creative allotment`;
  }
}

export function Story({
  firstName,
  greeting,
  items,
  resolved,
  counts,
  topics,
  startTopic,
  home = "/pipeline",
  demo = false,
}: {
  firstName: string;
  greeting: string;
  items: TodayItem[];
  resolved: Resolved[];
  counts: Record<Tier, number>;
  topics: Record<TopicKey, { label: string; blurb: string }>;
  startTopic: TopicKey | null;
  /** Where Close and the end card go: the person's home */
  home?: string;
  /** Design preview: nothing is saved */
  demo?: boolean;
}) {
  const router = useRouter();
  // Topics, most critical first (the most urgent item in each decides), each with its items most urgent first
  const groups = useMemo(() => {
    const m = new Map<TopicKey, TodayItem[]>();
    for (const i of items) m.set(i.topic, [...(m.get(i.topic) ?? []), i]);
    return [...m.entries()].map(([topic, list]) => ({ topic, items: list.sort((a, b) => b.score - a.score) })).sort((a, b) => b.items[0].score - a.items[0].score);
  }, [items]);
  const [first, setFirst] = useState<TopicKey | null>(startTopic);
  const cards: Card[] = useMemo(() => {
    const ordered = first ? [...groups.filter((g) => g.topic === first), ...groups.filter((g) => g.topic !== first)] : groups;
    return [{ kind: "intro" }, ...resolved.map((r) => ({ kind: "resolved" as const, r })), ...ordered.map((g) => ({ kind: "topic" as const, ...g })), { kind: "end" }];
  }, [groups, resolved, first]);
  const [at, setAt] = useState(startTopic ? 1 + resolved.length : 0);
  const [mine, setMine] = useState<Record<string, Mark>>(() => Object.fromEntries(items.map((i) => [i.key, i.state === "new" ? "seen" : i.state])));
  const [sheet, setSheet] = useState<TodayItem | null>(null);
  const [picker, setPicker] = useState(false);
  const card = cards[Math.min(at, cards.length - 1)];

  const snap = (i: TodayItem) => ({ topic: i.topic, client: i.client, title: i.title, clientId: i.clientId });
  // Everything on a screen that's been shown counts as seen (once); a "taken care of" card is read once
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (card.kind === "topic")
      for (const i of card.items)
        if (!shown.current.has(i.key)) {
          shown.current.add(i.key);
          if (!demo) void setItem(i.key, "seen", { topic: i.topic, client: i.client, title: i.title, clientId: i.clientId });
        }
    if (card.kind === "resolved" && !shown.current.has(card.r.key)) {
      shown.current.add(card.r.key);
      if (!demo) void acknowledge(card.r.key);
    }
  }, [card, demo]);

  const go = useCallback((n: number) => setAt((a) => Math.max(0, Math.min(cards.length - 1, a + n))), [cards.length]);
  const choose = async (i: TodayItem, status: "saved" | "done" | "dismissed") => {
    const next = demo ? (status === "saved" && mine[i.key] === "saved" ? "seen" : status) : await setItem(i.key, status, snap(i));
    setMine((m) => ({ ...m, [i.key]: (next ?? status) as Mark }));
  };
  const saveAll = async (list: TodayItem[]) => {
    for (const i of list) if (mine[i.key] !== "saved") await choose(i, "saved");
  };
  const jump = (topic: TopicKey) => {
    setFirst(topic);
    setAt(1 + resolved.length);
    setPicker(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || (e.target as HTMLElement)?.closest("input, textarea, [contenteditable], [data-own-keys]")) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") setPicker(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const byTopic = groups.map((g) => [g.topic, { n: g.items.length, critical: g.items.filter((i) => i.tier === "critical").length }] as [TopicKey, { n: number; critical: number }]);
  const saved = items.filter((i) => mine[i.key] === "saved");
  const acted = items.filter((i) => mine[i.key] === "done").length;
  const tone = card.kind === "topic" ? TIER[card.items[0].tier] : card.kind === "resolved" ? { glow: "rgba(40,180,120,0.35)", accent: "#5be3a5" } : { glow: "rgba(200,16,46,0.35)", accent: "#ff4d5e" };

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-[#07060a] text-white [color-scheme:dark]">
      <style>{`@keyframes card-in { from { opacity: 0; transform: translateY(18px) scale(.985) } to { opacity: 1; transform: none } } @keyframes glow { 0%,100% { transform: translate(-10%,-10%) scale(1) } 50% { transform: translate(6%,4%) scale(1.15) } }`}</style>
      {/* The colour of what's on screen: red for critical, amber for important, blue for the rest, green for done */}
      <div aria-hidden className="pointer-events-none absolute -left-1/4 -top-1/4 h-[90vh] w-[90vh] rounded-full blur-[140px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 14s ease-in-out infinite" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-1/3 right-0 h-[70vh] w-[70vh] rounded-full opacity-60 blur-[160px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 18s ease-in-out infinite reverse" }} />

      {/* Progress, and the way out */}
      <header className="relative z-10 grid gap-3 px-4 pt-4 md:px-8 md:pt-6">
        <div className="flex gap-1.5">
          {cards.map((c, n) => (
            <button key={n} type="button" aria-label={`Screen ${n + 1}`} onClick={() => setAt(n)} className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <span className="block h-full rounded-full bg-white transition-all duration-300" style={{ width: n <= at ? "100%" : "0%", opacity: n === at ? 1 : 0.6 }} />
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-white/60">
          <span>{card.kind === "topic" ? topics[card.topic].label : card.kind === "resolved" ? "Since you last looked" : "Today"}</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPicker((p) => !p)} className="rounded-full border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10">
              Jump to a topic
            </button>
            <Link href={home} className="rounded-full border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10">
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

      <main className="relative z-10 grid h-[calc(100%-110px)] place-items-center overflow-y-auto px-4 pb-6 md:px-8">
        <div key={`${at}:${first}`} className="grid w-full max-w-6xl gap-8 py-8" style={{ animation: "card-in .45s cubic-bezier(.2,.8,.2,1) both" }}>
          {card.kind === "intro" && (
            <div className="grid max-w-4xl gap-8">
              <div className="grid gap-3">
                <p className="text-sm uppercase tracking-[0.24em] text-white/50">Your day</p>
                <h1 className="font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
                  {greeting}, {firstName}.
                </h1>
                <p className="max-w-xl text-lg text-white/70">
                  {items.length ? `${items.length} things across your clients today, in ${groups.length} ${groups.length === 1 ? "topic" : "topics"}${counts.critical ? `. ${counts.critical} critical` : ""}. Most critical first.` : "Nothing needs you today. Every client is in good hands."}
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
                <button type="button" onClick={() => (items.length || resolved.length ? go(1) : router.push(home))} className="h-12 rounded-full bg-white px-7 text-[15px] font-semibold text-black hover:bg-white/90">
                  {items.length || resolved.length ? "Start" : "Back to your home"}
                </button>
                <span className="self-center text-xs text-white/40">→ or space to move on</span>
              </div>
            </div>
          )}

          {card.kind === "resolved" && (
            <div className="grid max-w-4xl gap-6">
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

          {card.kind === "topic" && (
            <TopicScreen
              key={card.topic}
              topic={card.topic}
              list={card.items}
              mine={mine}
              label={topics[card.topic].label}
              onChoose={(i, s) => void choose(i, s)}
              onAct={(i) => setSheet(i)}
              onSaveAll={() => void saveAll(card.items)}
              onNext={() => go(1)}
            />
          )}

          {card.kind === "end" && (
            <div className="grid max-w-4xl gap-8">
              <div className="grid gap-3">
                <p className="text-sm uppercase tracking-[0.24em] text-white/50">That&apos;s today</p>
                <h2 className="font-display text-5xl leading-tight tracking-tight md:text-7xl">{acted ? `${acted} handled.` : "All caught up."}</h2>
                <p className="text-lg text-white/70">
                  {saved.length ? `${saved.length} saved for later. They're on your list below and on your home page, and come back tomorrow if they're still open.` : "Nothing saved for later."}
                </p>
              </div>
              {saved.length > 0 && (
                <ul className="grid gap-2 md:max-w-2xl">
                  {saved.map((s) => (
                    <li key={s.key}>
                      <button type="button" onClick={() => setAt(cards.findIndex((c) => c.kind === "topic" && c.topic === s.topic))} className="flex w-full items-center gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] px-4 py-3 text-left hover:bg-white/[0.08]">
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
                <button type="button" onClick={() => router.push(home)} className="h-12 rounded-full bg-white px-7 text-[15px] font-semibold text-black">
                  Back to your home
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
              if (!demo) void setItem(sheet.key, "done", snap(sheet));
              setSheet(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One topic on one screen: the headline, every client in it with the number that matters, and the selected client's
 * overview beside the list. Deep dive steps through them one at a time on the same screen.
 */
function TopicScreen({
  topic,
  list,
  mine,
  label,
  onChoose,
  onAct,
  onSaveAll,
  onNext,
}: {
  topic: TopicKey;
  list: TodayItem[];
  mine: Record<string, Mark>;
  label: string;
  onChoose: (i: TodayItem, s: "saved" | "done" | "dismissed") => void;
  onAct: (i: TodayItem) => void;
  onSaveAll: () => void;
  onNext: () => void;
}) {
  const live = list.filter((i) => mine[i.key] !== "dismissed" && mine[i.key] !== "done");
  const [selected, setSelected] = useState<string | null>(null);
  const [dive, setDive] = useState<number | null>(null);
  const current = dive != null ? live[Math.min(dive, live.length - 1)] : (live.find((i) => i.key === selected) ?? null);
  const critical = list.filter((i) => i.tier === "critical").length;
  const t = TIER[list[0].tier];
  const allSaved = live.length > 0 && live.every((i) => mine[i.key] === "saved");
  const nextInDive = () => {
    if (dive == null) return;
    if (dive + 1 >= live.length) {
      setDive(null);
      onNext();
    } else setDive(dive + 1);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
      {/* The topic, and everyone in it */}
      <div className="grid gap-6">
        <div className="grid gap-3">
          <p className="text-sm uppercase tracking-[0.24em] text-white/50">
            {label}
            {critical ? <span style={{ color: TIER.critical.accent }}> · {critical} critical</span> : null}
          </p>
          <h2 className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
            <span style={{ color: t.accent }}>{list.length}</span> {headline(topic, list.length).replace(/^\d+\s/, "")}
          </h2>
        </div>
        <ul className="grid gap-1.5" data-own-keys>
          {list.map((i, n) => {
            const m = mine[i.key];
            const gone = m === "dismissed" || m === "done";
            const on = current?.key === i.key;
            return (
              <li key={i.key}>
                <button
                  type="button"
                  disabled={gone}
                  onClick={() => {
                    setDive(null);
                    setSelected(on ? null : i.key);
                  }}
                  className={`group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[16px] border px-4 py-3 text-left transition-colors ${on ? "border-white/40 bg-white/[0.1]" : "border-white/10 bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.07]"} ${gone ? "opacity-40" : ""}`}
                  style={{ animation: `card-in .4s ${0.04 * n}s cubic-bezier(.2,.8,.2,1) both` }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: TIER[i.tier].accent, boxShadow: `0 0 12px ${TIER[i.tier].accent}` }} />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-medium">{i.client}</span>
                      {m === "saved" && <span className="shrink-0 rounded-full bg-white/15 px-1.5 py-px text-[10px]">Saved</span>}
                      {m === "done" && <span className="shrink-0 rounded-full bg-[#5be3a5]/20 px-1.5 py-px text-[10px] text-[#5be3a5]">Handled</span>}
                      {i.carried && <span className="shrink-0 text-[10px] text-white/45">from before</span>}
                    </span>
                    <span className="truncate text-xs text-white/55">{i.title}</span>
                  </span>
                  <span className="text-right">
                    <span className="tabular block font-display text-xl leading-none" style={{ color: TIER[i.tier].accent }}>
                      {i.stat.value}
                    </span>
                    <span className="block max-w-[150px] truncate text-[10.5px] text-white/45">{i.stat.label}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2.5">
          {live.length > 0 && (
            <button type="button" onClick={() => setDive(0)} className="inline-flex h-12 items-center rounded-full bg-white px-6 text-[15px] font-semibold text-black hover:bg-white/90">
              Deep dive, one by one
            </button>
          )}
          {live.length > 0 && (
            <button type="button" onClick={onSaveAll} disabled={allSaved} className={`h-12 rounded-full border px-5 text-sm ${allSaved ? "border-white bg-white/15" : "border-white/25 text-white/85 hover:bg-white/10"}`}>
              {allSaved ? "All saved ✓" : `Save ${live.length === 1 ? "it" : `all ${live.length}`} for later`}
            </button>
          )}
          <button type="button" onClick={onNext} className="h-12 rounded-full px-4 text-sm text-white/60 hover:text-white">
            Next topic →
          </button>
        </div>
      </div>

      {/* The selected client, or the next one in the deep dive */}
      <div className="lg:sticky lg:top-4">
        {current ? (
          <Overview
            key={current.key}
            i={current}
            status={mine[current.key]}
            dive={dive != null ? { at: Math.min(dive, live.length - 1) + 1, of: live.length } : null}
            onChoose={(s) => {
              onChoose(current, s);
              if (dive != null && s !== "saved") nextInDive();
            }}
            onAct={() => (current.action.suggestion ? onAct(current) : undefined)}
            onNext={dive != null ? nextInDive : null}
          />
        ) : (
          <div className="hidden min-h-[360px] place-items-center rounded-[28px] border border-dashed border-white/12 p-10 text-center lg:grid">
            <div className="grid gap-2">
              <span className="font-display text-[120px] leading-none tracking-tight opacity-90" style={{ color: t.accent }}>
                {list.length}
              </span>
              <p className="text-sm text-white/55">Pick a client to see what&apos;s going on and act on it, or deep dive through them one by one.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One client's overview inside its topic: the number, the story, the evidence, and what to do. */
function Overview({ i, status, dive, onChoose, onAct, onNext }: { i: TodayItem; status?: Mark; dive: { at: number; of: number } | null; onChoose: (s: "saved" | "done" | "dismissed") => void; onAct: () => void; onNext: (() => void) | null }) {
  const t = TIER[i.tier];
  const primary = "inline-flex h-11 items-center rounded-full bg-white px-5 text-sm font-semibold text-black hover:bg-white/90";
  return (
    <div className="relative grid gap-5 overflow-hidden rounded-[28px] border border-white/12 bg-black/40 p-6 backdrop-blur-xl md:p-8" style={{ animation: "card-in .35s cubic-bezier(.2,.8,.2,1) both" }}>
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-[240px] w-[240px] rounded-full blur-[80px]" style={{ background: t.glow }} />
      <div className="relative flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${t.chip}`}>{t.label}</span>
        <span className="text-xs uppercase tracking-[0.16em] text-white/55">{i.client}</span>
        {dive && <span className="ml-auto text-xs text-white/45">{dive.at} of {dive.of}</span>}
      </div>
      <div className="relative flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="font-display text-6xl leading-none tracking-tight tabular md:text-7xl" style={{ color: t.accent }}>
          {i.stat.value}
        </span>
        <span className="pb-1.5 text-sm text-white/60">{i.stat.label}</span>
      </div>
      <h3 className="relative font-heading text-2xl leading-snug">{i.title}</h3>
      <p className="relative text-[15px] leading-relaxed text-white/75">{i.story}</p>
      {i.evidence.length > 0 && (
        <ul className="relative grid gap-1.5">
          {i.evidence.map((e, n) => (
            <li key={n} className="flex gap-2 text-sm text-white/60">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-white/40" />
              {e}
            </li>
          ))}
        </ul>
      )}
      <p className="relative text-xs text-white/45">Why it&apos;s here: {i.why}</p>
      <div className="relative flex flex-wrap items-center gap-2">
        {i.action.suggestion ? (
          <button type="button" onClick={onAct} className={primary}>
            {i.action.label}
          </button>
        ) : (
          <a href={i.action.href} target="_blank" rel="noreferrer" onClick={() => onChoose("done")} className={primary}>
            {i.action.label} ↗
          </a>
        )}
        {i.alt && (
          <a href={i.alt.href} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full border border-white/25 px-4 text-sm text-white/85 hover:bg-white/10">
            {i.alt.label} ↗
          </a>
        )}
        <button type="button" onClick={() => onChoose("saved")} className={`h-11 rounded-full border px-4 text-sm ${status === "saved" ? "border-white bg-white/15" : "border-white/25 text-white/85 hover:bg-white/10"}`}>
          {status === "saved" ? "Saved ✓" : "Save for later"}
        </button>
        <button type="button" onClick={() => onChoose("dismissed")} className="h-11 rounded-full px-3 text-sm text-white/50 hover:text-white">
          Not for me
        </button>
        {onNext && (
          <button type="button" onClick={onNext} className="ml-auto h-11 rounded-full px-3 text-sm text-white/70 hover:text-white">
            Next →
          </button>
        )}
      </div>
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
          <span className="text-[11px] text-white/45">
            {c.critical ? `${c.critical} critical · ` : ""}
            {topics[t].blurb}
          </span>
        </button>
      ))}
    </div>
  );
}
