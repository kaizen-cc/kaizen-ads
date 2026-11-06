"use client";

import { DraftReply } from "@/components/draft-reply";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import { BriefPreviewButton } from "@/components/quick-brief-sheet";
import type { Resolved, Tier, TodayItem, TopicKey } from "@/lib/today";
import { bucketsOf, countLooks, isOpenMark, lookHeadline, openOf, rowStat, topicGroups, TIER_ORDER, type Bucket } from "@/lib/today-counts";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { acknowledge, setItem } from "./actions";
import { DoneBurst } from "@/components/done-burst";
import { ScorecardView } from "@/components/production";
import type { Scorecard } from "@/lib/production";

// The daily recap as a story, one screen per topic: "6 accounts are off target", each client in a row with the number
// that matters. Pick a client to see its overview right there and act on it, save the whole topic for later, or deep
// dive through them one by one. Topics play most critical first; any topic can be jumped to. Arrows or space move on.

type Card = { kind: "intro" } | { kind: "score" } | { kind: "resolved"; rs: Resolved[] } | { kind: "topic"; topic: TopicKey; items: TodayItem[] } | { kind: "end" };
type Mark = "seen" | "saved" | "done" | "dismissed";

const TIER: Record<Tier, { label: string; glow: string; accent: string; chip: string }> = {
  critical: { label: "Critical", glow: "rgba(200,16,46,0.55)", accent: "#ff4d5e", chip: "bg-[#c8102e] text-white" },
  high: { label: "Important", glow: "rgba(224,150,40,0.45)", accent: "#f2b14c", chip: "bg-[#e0962a] text-black" },
  normal: { label: "Worth a look", glow: "rgba(90,110,255,0.35)", accent: "#9aa8ff", chip: "bg-white/15 text-white" },
};

export function Story({
  firstName,
  greeting,
  items: itemsAtStart,
  resolved: resolvedAtStart,
  topics,
  home = "/pipeline",
  demo = false,
  score = null,
}: {
  /** Designers, editors and copywriters: their own scorecard, the second screen */
  score?: Scorecard | null;
  firstName: string;
  greeting: string;
  items: TodayItem[];
  resolved: Resolved[];
  topics: Record<TopicKey, { label: string; blurb: string }>;
  /** Where Close and the end card go: the person's home */
  home?: string;
  /** Design preview: nothing is saved */
  demo?: boolean;
}) {
  const router = useRouter();
  // The screens are fixed for this sitting: marking something done refreshes the page, and a list that changed under
  // you (a topic gone, a "taken care of" screen added) would shift every screen after it. What you did shows on the
  // item instead, and the next visit starts from the fresh list.
  const [items] = useState(itemsAtStart);
  const [resolved] = useState(resolvedAtStart);
  // Topics, most critical first (the most urgent item in each decides), each with its items most urgent first
  const groups = useMemo(() => topicGroups(items).map(({ topic, items }) => ({ topic, items })), [items]);
  // Counted by client (src/lib/today-counts.ts): everything about one client in a topic is one look, the same numbers
  // the Overview shows
  const looks = useMemo(() => countLooks(items), [items]);
  // Every screen is a place in the address (?topic= to play first, ?card= for the screen, ?item= for a brief open), so
  // the browser's back and forward move through the story like its own arrows
  const askedTopic = useParam("topic");
  const first = askedTopic && askedTopic in topics ? (askedTopic as TopicKey) : null;
  const cards: Card[] = useMemo(() => {
    const ordered = first ? [...groups.filter((g) => g.topic === first), ...groups.filter((g) => g.topic !== first)] : groups;
    return [{ kind: "intro" }, ...(score ? [{ kind: "score" as const }] : []), ...(resolved.length ? [{ kind: "resolved" as const, rs: resolved }] : []), ...ordered.map((g) => ({ kind: "topic" as const, ...g })), { kind: "end" }];
  }, [groups, resolved, first, score]);
  // Where the topics start: after the intro, the scorecard and what teammates took care of
  const lead = 1 + (score ? 1 : 0) + (resolved.length ? 1 : 0);
  const askedCard = useParam("card");
  const at = askedCard ? Math.max(0, Math.min(cards.length - 1, Number(askedCard) || 0)) : first ? lead : 0;
  // Moving to another screen leaves the client open on this one behind
  const setAt = (n: number) => pushParams({ card: String(n), pick: null, dive: null });
  const [mine, setMine] = useState<Record<string, Mark>>(() => Object.fromEntries(items.map((i) => [i.key, i.state === "new" ? "seen" : i.state])));
  const askedItem = useParam("item");
  const sheet = items.find((i) => i.key === askedItem) ?? null;
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
    if (card.kind === "resolved")
      for (const r of card.rs)
        if (!shown.current.has(r.key)) {
          shown.current.add(r.key);
          if (!demo) void acknowledge(r.key);
        }
  }, [card, demo]);

  const go = (n: number) => {
    const to = Math.max(0, Math.min(cards.length - 1, at + n));
    if (to !== at) setAt(to);
  };
  const choose = async (i: TodayItem, status: "saved" | "done" | "dismissed") => {
    const next = demo ? (status === "saved" && mine[i.key] === "saved" ? "seen" : status) : await setItem(i.key, status, snap(i));
    setMine((m) => ({ ...m, [i.key]: (next ?? status) as Mark }));
  };
  const saveAll = async (list: TodayItem[]) => {
    for (const i of list) if (mine[i.key] !== "saved") await choose(i, "saved");
  };
  const jump = (topic: TopicKey) => {
    pushParams({ topic, card: null, pick: null, dive: null });
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

  const byTopic = groups.map((g) => [g.topic, looks.byTopic[g.topic]] as [TopicKey, { n: number; critical: number }]);
  const saved = items.filter((i) => mine[i.key] === "saved");
  const acted = items.filter((i) => mine[i.key] === "done").length;
  const tone = card.kind === "topic" ? TIER[card.items[0].tier] : card.kind === "resolved" ? { glow: "rgba(40,180,120,0.35)", accent: "#5be3a5" } : { glow: "rgba(200,16,46,0.35)", accent: "#ff4d5e" };

  // Phones: swipe left or right to move between screens, like stories (not inside a client's overview or a field)
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const el = e.target as HTMLElement;
    swipe.current = sheet || el.closest("input, textarea, [data-no-swipe]") ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  return (
    // Phones: a column (progress, the screen, then back and next within thumb reach); desktop as it was
    <div className="force-dark fixed inset-0 z-40 flex flex-col overflow-hidden bg-[#07060a] text-white [color-scheme:dark] md:block">
      <style>{`@keyframes card-in { from { opacity: 0; transform: translateY(18px) scale(.985) } to { opacity: 1; transform: none } } @keyframes card-out { to { opacity: 0; transform: translateX(14px) } } @keyframes glow { 0%,100% { transform: translate(-10%,-10%) scale(1) } 50% { transform: translate(6%,4%) scale(1.15) } }`}</style>
      {/* The colour of what's on screen: red for critical, amber for important, blue for the rest, green for done */}
      <div aria-hidden className="pointer-events-none absolute -left-1/4 -top-1/4 h-[90vh] w-[90vh] rounded-full blur-[140px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 14s ease-in-out infinite" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-1/3 right-0 h-[70vh] w-[70vh] rounded-full opacity-60 blur-[160px] transition-colors duration-700" style={{ background: tone.glow, animation: "glow 18s ease-in-out infinite reverse" }} />

      {/* Progress, and the way out */}
      <header className="relative z-10 grid shrink-0 gap-3 px-4 pt-[calc(env(safe-area-inset-top)+12px)] md:px-8 md:pt-6">
        <div className="flex gap-1.5">
          {cards.map((c, n) => (
            <button key={n} type="button" aria-label={`Screen ${n + 1}`} onClick={() => setAt(n)} className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <span className="block h-full rounded-full bg-white transition-all duration-300" style={{ width: n <= at ? "100%" : "0%", opacity: n === at ? 1 : 0.6 }} />
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-white/60">
          <span className="min-w-0 truncate">{card.kind === "topic" ? topics[card.topic].label : card.kind === "resolved" ? "Since you last looked" : "Today"}</span>
          <span className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setPicker((p) => !p)} className="inline-flex h-11 items-center rounded-full border border-white/20 px-4 text-white/80 hover:bg-white/10 md:h-auto md:px-3 md:py-1.5">
              <span className="md:hidden">Topics</span>
              <span className="hidden md:inline">Jump to a topic</span>
            </button>
            <Link href={home} className="inline-flex h-11 items-center rounded-full border border-white/20 px-4 text-white/80 hover:bg-white/10 md:h-auto md:px-3 md:py-1.5">
              Close
            </Link>
          </span>
        </div>
      </header>

      {picker && (
        <div className="absolute inset-x-4 top-[calc(env(safe-area-inset-top)+96px)] z-30 mx-auto grid max-h-[70dvh] max-w-2xl gap-2 overflow-y-auto overscroll-contain rounded-[20px] border border-white/15 bg-black/90 p-4 backdrop-blur-xl md:inset-x-8 md:top-24 md:max-h-none md:overflow-visible md:bg-black/80">
          <p className="text-xs uppercase tracking-[0.18em] text-white/50">Jump to a topic · then the rest, most critical first</p>
          <TopicChoices byTopic={byTopic} topics={topics} onPick={jump} />
        </div>
      )}

      <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} className="relative z-10 grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain px-4 pb-6 md:h-[calc(100%-110px)] md:flex-none md:px-8">
        <div key={`${at}:${first}`} className="grid w-full max-w-6xl gap-6 py-5 md:gap-8 md:py-8" style={{ animation: "card-in .45s cubic-bezier(.2,.8,.2,1) both" }}>
          {card.kind === "intro" && (
            <div className="grid max-w-4xl gap-7 md:gap-8">
              <div className="grid gap-3">
                <p className="text-sm uppercase tracking-[0.24em] text-white/50">Your day</p>
                <h1 className="font-display text-5xl leading-[1.02] tracking-tight md:text-7xl">
                  {greeting}, {firstName}.
                </h1>
                <p className="max-w-xl text-[17px] leading-relaxed text-white/70 md:text-lg md:leading-normal">
                  {items.length ? `${looks.total} ${looks.total === 1 ? "thing" : "things"} to look at today (everything about a client gathered into one), in ${groups.length} ${groups.length === 1 ? "topic" : "topics"}${looks.byTier.critical ? `. ${looks.byTier.critical} critical` : ""}. Most critical first.` : "Nothing needs you today. Every client is in good hands."}
                  {resolved.length ? ` And ${resolved.length} ${resolved.length === 1 ? "thing a teammate took" : "things teammates took"} care of since you last looked.` : ""}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 md:max-w-2xl">
                {TIER_ORDER.map((t) => (
                  <div key={t} className="grid min-w-0 gap-1 rounded-[18px] border border-white/10 bg-white/[0.04] p-3.5 md:p-4">
                    <span className="font-display text-4xl tabular md:text-5xl" style={{ color: TIER[t].accent }}>
                      {looks.byTier[t]}
                    </span>
                    <span className="text-[10.5px] uppercase leading-tight tracking-[0.12em] text-white/60 md:text-xs md:leading-normal md:tracking-[0.14em]">{TIER[t].label}</span>
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
                <button type="button" onClick={() => (items.length || resolved.length ? go(1) : router.push(home))} className="h-14 w-full rounded-full bg-white px-7 text-base font-semibold text-black hover:bg-white/90 md:h-12 md:w-auto md:text-[15px]">
                  {items.length || resolved.length ? "Start" : "Back to your home"}
                </button>
                <span className="self-center text-xs text-white/40">
                  <span className="md:hidden">Or swipe to move on</span>
                  <span className="hidden md:inline">→ or space to move on</span>
                </span>
              </div>
            </div>
          )}

          {card.kind === "score" && score && (
            <div className="grid max-w-4xl gap-6">
              <p className="text-sm uppercase tracking-[0.24em] text-white/50">How you&apos;re doing</p>
              <ScorecardView s={score} own />
              <div>
                <button type="button" onClick={() => go(1)} className="h-11 rounded-full bg-white px-6 text-sm font-semibold text-black">
                  Next
                </button>
              </div>
            </div>
          )}

          {card.kind === "resolved" && (
            <div className="grid max-w-4xl gap-6">
              <p className="text-sm uppercase tracking-[0.24em] text-[#5be3a5]">Since you last looked</p>
              <h2 className="font-display text-4xl leading-tight tracking-tight md:text-6xl">Taken care of.</h2>
              <p className="max-w-2xl text-lg leading-relaxed text-white/70">
                {card.rs.length} {card.rs.length === 1 ? "thing that came up for you is" : "things that came up for you are"} handled. Nothing for you to do.
              </p>
              {/* Every one on this one screen, not a screen each */}
              <ul className="grid max-h-[46vh] gap-2 overflow-y-auto pr-1">
                {card.rs.map((r) => (
                  <li key={r.key} className="flex items-start gap-3 rounded-[16px] border border-white/10 bg-white/[0.04] px-4 py-3">
                    <span className="mt-0.5 shrink-0 text-[#5be3a5]" aria-hidden>
                      ✓
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-[15px] leading-snug text-white/90">{r.title}</span>
                      <span className="text-[13px] text-white/50">
                        {r.client}
                        {" · "}
                        {r.by ? `${r.by} ${r.what}` : `${r.what.charAt(0).toUpperCase()}${r.what.slice(1)}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
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
              onAct={(i) => pushParams({ item: i.key })}
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
                      <button type="button" onClick={() => setAt(cards.findIndex((c) => c.kind === "topic" && c.topic === s.topic))} className="flex w-full items-center gap-3 rounded-[14px] border border-white/10 bg-white/[0.04] px-4 py-3.5 text-left hover:bg-white/[0.08] active:bg-white/[0.08] md:py-3">
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
                <button type="button" onClick={() => router.push(home)} className="h-12 flex-1 rounded-full bg-white px-7 text-[15px] font-semibold text-black md:flex-none">
                  Back to your home
                </button>
                <button type="button" onClick={() => setAt(0)} className="h-12 flex-1 rounded-full border border-white/25 px-6 text-sm text-white/80 hover:bg-white/10 md:flex-none">
                  From the top
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Phones: back, where you are, and next, at the bottom within thumb reach (under a client's overview when one is open) */}
      <nav className="relative z-[5] flex shrink-0 items-center gap-3 border-t border-white/10 bg-black/40 px-4 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2.5 backdrop-blur-xl md:hidden" aria-label="Move through your recap">
        <button type="button" aria-label="Previous" disabled={at === 0} onClick={() => go(-1)} className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-white/15 text-2xl text-white/75 active:bg-white/10 disabled:opacity-30">
          ‹
        </button>
        <span className="tabular flex-1 text-center text-xs text-white/45">
          {Math.min(at, cards.length - 1) + 1} of {cards.length}
        </span>
        <button type="button" onClick={() => (card.kind === "end" ? router.push(home) : go(1))} className="h-12 shrink-0 rounded-full bg-white px-8 text-[15px] font-semibold text-black active:bg-white/90">
          {card.kind === "end" ? "Done" : "Next"}
        </button>
      </nav>

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
              closeParams("item");
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One topic on one screen: the headline, every client in it (all their items gathered under one row) with the number
 * that matters, and the selected client's overview beside the list. Deep dive steps through the clients one at a time.
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
  const open = (i: TodayItem) => isOpenMark(mine[i.key]);
  const live = list.filter(open);
  const buckets = useMemo(() => bucketsOf(list), [list]);
  const liveBuckets = buckets.filter((b) => b.items.some(open));
  // A client whose last open item was just marked done: a check plays where it was, then it leaves the list
  const [cheer, setCheer] = useState<{ key: string; client: string; title: string } | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const finish = (b: Bucket, i: TodayItem, s: "done" | "dismissed") => {
    if (s === "done") setCheer({ key: b.key, client: b.client, title: b.items.length > 1 ? `All ${b.items.length} handled` : i.title });
    setTimeout(() => {
      setLeft((l) => new Set(l).add(b.key));
      setCheer((c) => (c?.key === b.key ? null : c));
    }, s === "done" ? 1700 : 350);
  };
  // The client open (?pick=key) and the deep dive (?dive=n) are places too: back returns to the list.
  // The address catches up as a low-priority transition, so the click shows the overview at once from local state and
  // the address (back, forward, a pasted link) takes over again whenever it changes
  const urlPick = useParam("pick");
  const urlDive = useParam("dive");
  const [here, setHere] = useState({ pick: urlPick, dive: urlDive });
  const [seen, setSeen] = useState({ pick: urlPick, dive: urlDive });
  if (seen.pick !== urlPick || seen.dive !== urlDive) {
    setSeen({ pick: urlPick, dive: urlDive });
    setHere({ pick: urlPick, dive: urlDive });
  }
  const selected = here.pick;
  const setSelected = (key: string) => {
    setHere({ pick: key, dive: null });
    pushParams({ pick: key, dive: null });
  };
  const askedDive = here.dive;
  const dive = askedDive && liveBuckets.length ? Number(askedDive) || 0 : null;
  const setDive = (n: number | null) => {
    setHere({ pick: null, dive: n == null ? null : String(n) });
    pushParams({ dive: n == null ? null : String(n), pick: null });
  };
  // An old link may name an item rather than its client: open the client it belongs to
  const current = dive != null ? liveBuckets[Math.min(dive, liveBuckets.length - 1)] : (liveBuckets.find((b) => b.key === selected || b.items.some((i) => i.key === selected)) ?? null);
  const critical = buckets.filter((b) => b.tier === "critical").length;
  const t = TIER[list[0].tier];
  const allSaved = live.length > 0 && live.every((i) => mine[i.key] === "saved");
  const closeOverview = () => {
    setHere({ pick: null, dive: null });
    closeParams(dive != null ? "dive" : "pick", "pick", "dive");
  };
  const nextInDive = () => {
    if (dive == null) return;
    // The last one: on to the next screen (which leaves the dive behind)
    if (dive + 1 >= liveBuckets.length) onNext();
    else setDive(dive + 1);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
      {/* The topic, and every client in it */}
      <div className="grid gap-6">
        <div className="grid gap-3">
          <p className="text-sm uppercase tracking-[0.24em] text-white/50">
            {label}
            {critical ? <span style={{ color: TIER.critical.accent }}> · {critical} critical</span> : null}
          </p>
          <h2 className="font-display text-4xl leading-[1.05] tracking-tight md:text-6xl">
            <span style={{ color: t.accent }}>{buckets.length}</span> {lookHeadline(topic, buckets.length).replace(/^\d+\s/, "")}
          </h2>
          {live.length > buckets.length && <p className="text-sm text-white/50">{live.length} items in all, gathered by client so each one is a single look.</p>}
        </div>
        <ul className="grid gap-1.5" data-own-keys>
          {buckets
            .filter((b) => !left.has(b.key))
            .map((b, n) => {
              // One count for the row: its open items (the same the overview lists as open), and its big number says it
              const rest = openOf(b.items, mine);
              const gone = rest.length === 0;
              const handled = b.items.some((i) => mine[i.key] === "done");
              const lead = rest[0] ?? b.items[0];
              const stat = rowStat(rest, lead);
              const on = current?.key === b.key;
              const savedAll = rest.length > 0 && rest.every((i) => mine[i.key] === "saved");
              return (
                <li key={b.key} className={gone ? "pointer-events-none" : ""} style={gone ? { animation: "card-out .35s ease 1.35s both" } : undefined}>
                  <button
                    type="button"
                    disabled={gone}
                    onClick={() => (on ? closeOverview() : setSelected(b.key))}
                    className={`group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[16px] border px-4 py-3.5 text-left transition-colors md:py-3 ${gone && handled ? "border-[#5be3a5]/50 bg-[#5be3a5]/[0.08]" : on ? "border-white/40 bg-white/[0.1]" : "border-white/10 bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.07]"} ${gone && !handled ? "opacity-40" : ""}`}
                    style={{ animation: `card-in .4s ${0.04 * n}s cubic-bezier(.2,.8,.2,1) both` }}
                  >
                    {gone && handled ? (
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-[#5be3a5] text-[11px] font-bold text-black" style={{ animation: "card-in .35s cubic-bezier(.2,.8,.2,1.4) both" }}>
                        ✓
                      </span>
                    ) : (
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: TIER[b.tier].accent, boxShadow: `0 0 12px ${TIER[b.tier].accent}` }} />
                    )}
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[15px] font-medium">{b.client}</span>
                        {savedAll && <span className="shrink-0 rounded-full bg-white/15 px-1.5 py-px text-[10px]">Saved</span>}
                        {gone && handled && <span className="shrink-0 rounded-full bg-[#5be3a5]/20 px-1.5 py-px text-[10px] text-[#5be3a5]">Handled</span>}
                        {b.items.some((i) => i.carried) && <span className="shrink-0 text-[10px] text-white/45">from before</span>}
                      </span>
                      <span className="truncate text-xs text-white/55">
                        {lead.title}
                        {rest.length > 1 ? <span className="text-white/40"> · +{rest.length - 1} more</span> : null}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="tabular block font-display text-xl leading-none" style={{ color: TIER[b.tier].accent }}>
                        {stat.value}
                      </span>
                      <span title={stat.label} className="block max-w-[110px] truncate text-[10.5px] text-white/45 md:max-w-[150px]">{stat.label}</span>
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
        <div className="flex flex-wrap items-center gap-2.5">
          {liveBuckets.length > 0 && (
            <button type="button" onClick={() => setDive(0)} className="inline-flex h-12 w-full items-center justify-center rounded-full bg-white px-6 text-[15px] font-semibold text-black hover:bg-white/90 md:w-auto md:justify-start">
              Deep dive, one by one
            </button>
          )}
          {live.length > 0 && (
            <button type="button" onClick={onSaveAll} disabled={allSaved} className={`h-12 flex-1 rounded-full border px-5 text-sm md:flex-none ${allSaved ? "border-white bg-white/15" : "border-white/25 text-white/85 hover:bg-white/10"}`}>
              {allSaved ? "All saved ✓" : `Save ${liveBuckets.length === 1 ? "it" : `all ${liveBuckets.length}`} for later`}
            </button>
          )}
          <button type="button" onClick={onNext} className="h-12 rounded-full px-4 text-sm text-white/60 hover:text-white">
            Next topic →
          </button>
        </div>
      </div>

      {/* The selected client, or the next one in the deep dive. Phones: a sheet from the bottom over the list */}
      <div
        data-no-swipe={current ? "" : undefined}
        onClick={(e) => e.target === e.currentTarget && closeOverview()}
        className={current ? "fixed inset-0 z-[45] flex flex-col justify-end bg-black/60 backdrop-blur-sm md:static md:z-auto md:block md:bg-transparent md:backdrop-blur-none lg:sticky lg:top-4" : "lg:sticky lg:top-4"}
      >
        {cheer && (!current || dive == null) ? (
          <div className="grid min-h-[300px] place-items-center rounded-[28px] border border-[#5be3a5]/25 bg-[#5be3a5]/[0.05] p-10 text-center max-md:fixed max-md:inset-x-4 max-md:top-1/3 max-md:z-[46] max-md:bg-[#0d0c11]" style={{ animation: "card-in .3s cubic-bezier(.2,.8,.2,1) both" }}>
            <div className="grid gap-3">
              <DoneBurst label="Done" />
              <p className="text-sm text-white/60">
                {cheer.client} · {cheer.title}
              </p>
            </div>
          </div>
        ) : current ? (
          <div className="max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-[28px] bg-[#0d0c11] pb-[env(safe-area-inset-bottom)] md:max-h-none md:overflow-visible lg:max-h-[calc(100dvh-150px)] lg:overflow-y-auto lg:rounded-[28px] md:rounded-none md:bg-transparent md:pb-0 max-md:animate-[card-in_.3s_cubic-bezier(.2,.8,.2,1)_both]">
            <div className="sticky top-0 z-10 flex justify-end bg-[#0d0c11]/90 px-2 pt-2 backdrop-blur md:hidden">
              <button type="button" onClick={closeOverview} aria-label="Back to the list" className="grid h-11 w-11 place-items-center rounded-full text-white/60 active:bg-white/10">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <Overview
              key={current.key}
              b={current}
              mine={mine}
              dive={dive != null ? { at: Math.min(dive, liveBuckets.length - 1) + 1, of: liveBuckets.length } : null}
              onChoose={(i, s) => {
                onChoose(i, s);
                if (s === "saved") return;
                // The client's last open item: it leaves the list (and the deep dive moves on)
                if (!current.items.some((x) => x.key !== i.key && open(x))) {
                  finish(current, i, s);
                  if (dive != null) nextInDive();
                }
              }}
              onAct={(i) => (i.action.suggestion ? onAct(i) : undefined)}
              onNext={dive != null ? nextInDive : null}
            />
          </div>
        ) : (
          <div className="hidden min-h-[360px] place-items-center rounded-[28px] border border-dashed border-white/12 p-10 text-center lg:grid">
            <div className="grid gap-2">
              <span className="font-display text-[120px] leading-none tracking-tight opacity-90" style={{ color: t.accent }}>
                {buckets.length}
              </span>
              <p className="text-sm text-white/55">Pick a client to see everything that&apos;s waiting for them and act on it, or deep dive through them one by one.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One client's overview inside its topic. One item: the number, the story, the evidence, and what to do. Several:
 * the client once on top, then each item as its own fold (the most urgent open), each with its own actions.
 */
function Overview({ b, mine, dive, onChoose, onAct, onNext }: { b: Bucket; mine: Record<string, Mark>; dive: { at: number; of: number } | null; onChoose: (i: TodayItem, s: "saved" | "done" | "dismissed") => void; onAct: (i: TodayItem) => void; onNext: (() => void) | null }) {
  const t = TIER[b.tier];
  // The same open count as the client's row (src/lib/today-counts.ts); handled or set-aside items show greyed, uncounted
  const openItems = openOf(b.items, mine);
  const [expanded, setExpanded] = useState<string | null>(openItems[0]?.key ?? null);
  const single = b.items.length === 1;
  const unsaved = openItems.filter((i) => mine[i.key] !== "saved");
  return (
    <div className="relative grid gap-5 overflow-hidden rounded-[28px] border border-white/12 bg-black/40 p-5 pt-3 backdrop-blur-xl md:p-8" style={{ animation: "card-in .35s cubic-bezier(.2,.8,.2,1) both" }}>
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-[240px] w-[240px] rounded-full blur-[80px]" style={{ background: t.glow }} />
      <div className="relative flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${t.chip}`}>{t.label}</span>
        <span className="text-xs uppercase tracking-[0.16em] text-white/55">{b.client}</span>
        {dive && <span className="ml-auto text-xs text-white/45">{dive.at} of {dive.of}</span>}
      </div>
      {single ? (
        <ItemBody i={b.items[0]} status={mine[b.items[0].key]} big onChoose={(s) => onChoose(b.items[0], s)} onAct={() => onAct(b.items[0])} onNext={onNext} />
      ) : (
        <>
          <div className="relative flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="font-display text-6xl leading-none tracking-tight tabular md:text-7xl" style={{ color: t.accent }}>
              {openItems.length || b.items.length}
            </span>
            <span className="pb-1.5 text-sm text-white/60">{openItems.length ? `open for ${b.client}` : `handled for ${b.client}`}</span>
          </div>
          <ul className="relative grid gap-2">
            {b.items.map((i) => {
              const m = mine[i.key];
              const closed = m === "done" || m === "dismissed";
              const isOpen = expanded === i.key && !closed;
              const it = TIER[i.tier];
              return (
                <li key={i.key} className={`overflow-hidden rounded-[18px] border transition-colors ${isOpen ? "border-white/25 bg-white/[0.05]" : "border-white/10 bg-white/[0.025]"} ${closed ? "opacity-50" : ""}`}>
                  <button type="button" disabled={closed} onClick={() => setExpanded(isOpen ? null : i.key)} aria-expanded={isOpen} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left">
                    {m === "done" ? (
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-[#5be3a5] text-[11px] font-bold text-black">✓</span>
                    ) : (
                      <span className="h-2 w-2 rounded-full" style={{ background: it.accent }} />
                    )}
                    <span className="grid min-w-0 gap-0.5">
                      <span className={`text-[14.5px] leading-snug ${isOpen ? "" : "truncate"}`}>{i.title}</span>
                      <span className="truncate text-[11px] text-white/45">
                        {m === "done" ? "Handled" : m === "dismissed" ? "Set aside" : m === "saved" ? "Saved for later" : i.stat.label}
                      </span>
                    </span>
                    <span className="tabular font-display text-xl leading-none" style={{ color: it.accent }}>
                      {i.stat.value}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="grid gap-4 border-t border-white/10 px-4 pb-4 pt-4" style={{ animation: "card-in .25s cubic-bezier(.2,.8,.2,1) both" }}>
                      <ItemBody
                        i={i}
                        status={m}
                        onChoose={(s) => {
                          onChoose(i, s);
                          // On to the next open one for this client
                          if (s !== "saved") setExpanded(openItems.find((x) => x.key !== i.key)?.key ?? null);
                        }}
                        onAct={() => onAct(i)}
                        onNext={null}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="relative flex flex-wrap items-center gap-2">
            {unsaved.length > 1 && (
              <button type="button" onClick={() => unsaved.forEach((i) => onChoose(i, "saved"))} className="h-11 rounded-full border border-white/25 px-4 text-sm text-white/85 hover:bg-white/10">
                Save all {unsaved.length} for later
              </button>
            )}
            {onNext && (
              <button type="button" onClick={onNext} className="ml-auto h-11 rounded-full px-3 text-sm text-white/70 hover:text-white">
                Next client →
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One item: the story, the evidence, a drafted reply, why it's here, and what to do. */
function ItemBody({ i, status, big = false, onChoose, onAct, onNext }: { i: TodayItem; status?: Mark; big?: boolean; onChoose: (s: "saved" | "done" | "dismissed") => void; onAct: () => void; onNext: (() => void) | null }) {
  const t = TIER[i.tier];
  const primary = "inline-flex h-12 w-full items-center justify-center rounded-full bg-white px-5 text-[15px] font-semibold text-black hover:bg-white/90 md:h-11 md:w-auto md:justify-start md:text-sm";
  return (
    <>
      {big && (
        <>
          <div className="relative flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="font-display text-6xl leading-none tracking-tight tabular md:text-7xl" style={{ color: t.accent }}>
              {i.stat.value}
            </span>
            <span className="pb-1.5 text-sm text-white/60">{i.stat.label}</span>
          </div>
          <h3 className="relative font-heading text-2xl leading-snug">{i.title}</h3>
        </>
      )}
      <p className={`relative leading-relaxed text-white/75 ${big ? "text-[15px]" : "text-sm"}`}>{i.story}</p>
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
      {i.reply && (
        <div className="relative">
          <DraftReply id={i.reply.id} source={i.reply.source} url={i.reply.url} initial={i.reply.draft} channel={i.reply.channel} tone="dark" onSent={() => onChoose("done")} />
        </div>
      )}
      <p className="relative text-xs text-white/45">Why it&apos;s here: {i.why}</p>
      <div className="relative flex flex-wrap items-center gap-2">
        {i.action.suggestion ? (
          <button type="button" onClick={onAct} className={primary}>
            {i.action.label}
          </button>
        ) : i.action.brief && i.clientId ? (
          // Its quick preview right here (light, over the story); the full brief only if they choose it
          <span className="contents [color-scheme:normal]">
            <BriefPreviewButton previewKey={`today-${i.key}`.slice(0, 80)} clientId={i.clientId} source={i.action.brief.source} from={i.action.brief.from} className={primary} star="dark" wrapClassName="inline-flex items-center gap-2">
              {i.action.label}
            </BriefPreviewButton>
          </span>
        ) : (
          <a href={i.action.href} target="_blank" rel="noreferrer" onClick={() => onChoose("done")} className={primary}>
            {i.action.label} ↗
          </a>
        )}
        {i.alt && (
          <a href={i.alt.href} target="_blank" rel="noreferrer" className="inline-flex h-11 w-full items-center justify-center rounded-full border border-white/25 px-4 text-sm text-white/85 hover:bg-white/10 md:w-auto md:justify-start">
            {i.alt.label} ↗
          </a>
        )}
        <button type="button" onClick={() => onChoose("done")} className="h-11 flex-1 rounded-full border border-[#5be3a5]/50 px-4 text-sm text-[#5be3a5] hover:bg-[#5be3a5]/10 md:flex-none">
          ✓ Done
        </button>
        <button type="button" onClick={() => onChoose("saved")} className={`h-11 flex-1 rounded-full border px-4 text-sm md:flex-none ${status === "saved" ? "border-white bg-white/15" : "border-white/25 text-white/85 hover:bg-white/10"}`}>
          {status === "saved" ? "Saved ✓" : "Save for later"}
        </button>
        <button type="button" onClick={() => onChoose("dismissed")} className="h-11 rounded-full px-3 text-sm text-white/50 hover:text-white">
          {i.dismiss ?? "Not for me"}
        </button>
        {onNext && (
          <button type="button" onClick={onNext} className="ml-auto h-11 rounded-full px-3 text-sm text-white/70 hover:text-white">
            Next →
          </button>
        )}
      </div>
    </>
  );
}

function TopicChoices({ byTopic, topics, onPick }: { byTopic: [TopicKey, { n: number; critical: number }][]; topics: Record<TopicKey, { label: string; blurb: string }>; onPick: (t: TopicKey) => void }) {
  return (
    <div className="grid gap-2 md:flex md:flex-wrap">
      {byTopic.map(([t, c]) => (
        <button key={t} type="button" onClick={() => onPick(t)} className="group grid gap-0.5 rounded-[14px] border border-white/15 bg-white/[0.05] px-4 py-3 text-left transition-colors hover:border-white/40 hover:bg-white/10 active:bg-white/10 md:py-2.5">
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
