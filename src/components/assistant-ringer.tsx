"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BEAT_MS, RING_MS, ringLeft, ringStep, type RingState } from "@/lib/assistant/ring-core";
import { setUnreadHeadsUps } from "@/lib/assistant/heads-up-store";
import { AgentGlyph } from "./assistant-call-parts";
import { useAgentCall } from "./agent-call-provider";

// The assistant calls you about urgent items. While a tab is in view the app says it's here every few seconds (the
// light poll the server uses for presence); when something urgent lands for them, the answer is a ring: an incoming
// call card in their assistant's own name and color ("Hedwig is calling"), a soft ring tone, Answer and Decline, at
// most ten seconds. Answer opens a normal assistant call that starts with the heads-up; Decline or no answer puts it
// in their assistant chat as unread (the badge on My Assistant). A chat that's open gets new heads-ups written in.

type HeadsUp = { id: string; line: string; href: string | null; items: { title: string; href: string | null }[] };
type Beat = { ring: HeadsUp | null; unread: { id: string }[] };

const post = (body: Record<string, unknown>) =>
  fetch("/api/assistant/heads-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Beat>) : null))
    .catch(() => null);

/** A soft two-note ring, every two seconds while it rings (silent when the browser won't play sound yet) */
function useRingTone(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let ctx: AudioContext | null = null;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    } catch {
      return;
    }
    const c = ctx;
    void c.resume().catch(() => undefined);
    const ring = () => {
      const t0 = c.currentTime + 0.02;
      [
        [587.33, 0],
        [880, 0.22],
        [587.33, 0.62],
        [880, 0.84],
      ].forEach(([f, d]) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = "sine";
        o.frequency.value = f;
        const at = t0 + d;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.07, at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
        o.connect(g).connect(c.destination);
        o.start(at);
        o.stop(at + 0.52);
      });
    };
    ring();
    const t = setInterval(ring, 2000);
    return () => {
      clearInterval(t);
      void c.close().catch(() => undefined);
    };
  }, [on]);
}

const subscribeVisible = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};

export function AssistantRinger() {
  const { live, talk, answerHeadsUp, pullHeadsUps, assistantTint: tint, assistantName } = useAgentCall();
  const pathname = usePathname();
  const [state, dispatch] = useReducer(ringStep, { phase: "idle" } as RingState);
  const [ring, setRing] = useState<HeadsUp | null>(null);
  const [now, setNow] = useState(0);
  const visible = useSyncExternalStore(
    subscribeVisible,
    () => document.visibilityState === "visible",
    () => true,
  );
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const liveRef = useRef(live);
  const talkRef = useRef(talk);
  const pathRef = useRef(pathname);
  const stateRef = useRef(state);
  useEffect(() => {
    liveRef.current = live;
    talkRef.current = talk;
    pathRef.current = pathname;
    stateRef.current = state;
  }, [live, talk, pathname, state]);

  const applyUnread = useCallback(
    (unread: { id: string }[]) => {
      setUnreadHeadsUps(unread.length);
      // The chat is open: new heads-ups are written into it now
      if (unread.length && talkRef.current === "text") pullHeadsUps();
    },
    [pullHeadsUps],
  );

  // The heartbeat: while the tab is in view, every few seconds (and as soon as it comes back into view)
  useEffect(() => {
    if (!visible) return;
    let stop = false;
    const tick = async () => {
      const r = await post({ action: "beat", visible: true, inCall: liveRef.current, path: pathRef.current });
      if (stop || !r) return;
      applyUnread(r.unread ?? []);
      if (r.ring && stateRef.current.phase === "idle" && !liveRef.current) {
        setRing(r.ring);
        dispatch({ type: "ring", id: r.ring.id, now: Date.now() });
      }
    };
    void tick();
    const t = setInterval(() => void tick(), BEAT_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [visible, applyUnread]);

  /** The ring ends (answered, declined, or ten seconds went by): told to the server once, then back to idle */
  const finish = useCallback(
    (e: { type: "answer" } | { type: "decline" } | { type: "tick"; now: number }) => {
      const next = ringStep(stateRef.current, e);
      if (next.phase !== "ended") return null;
      stateRef.current = { phase: "idle" };
      dispatch({ type: "reset" });
      setRing(null);
      void post({ action: "end", id: next.id, outcome: next.outcome }).then((r) => r && applyUnread(r.unread ?? []));
      return next;
    },
    [applyUnread],
  );

  // The ten seconds: a clock while it rings
  useEffect(() => {
    if (state.phase !== "ringing") return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      finish({ type: "tick", now: n });
    }, 250);
    return () => clearInterval(t);
  }, [state.phase, finish]);

  useRingTone(state.phase === "ringing");

  if (!mounted || state.phase !== "ringing" || !ring) return null;
  const who = assistantName || "Your assistant";
  const left = ringLeft(state, now || state.since);
  const frac = Math.min(1, Math.max(0, (now - state.since) / RING_MS));
  const first = ring.items[0]?.title ?? "Something urgent";
  // Answer opens the call from the tap itself (browsers only play sound after one)
  const answer = () => {
    if (finish({ type: "answer" })) answerHeadsUp(ring.id);
  };
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[95] flex justify-center px-4 pt-[max(12px,env(safe-area-inset-top))] md:pt-5">
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="ring-who"
        aria-describedby="ring-what"
        className="pointer-events-auto relative w-full max-w-[420px] overflow-hidden rounded-[26px] border border-line bg-surface/95 p-4 shadow-[0_28px_70px_-22px_rgba(0,0,0,0.65)] backdrop-blur-xl animate-[sheet-fade_.2s_ease-out]"
      >
        <span aria-hidden className="pointer-events-none absolute -left-10 -top-16 h-40 w-56 rounded-full opacity-30 blur-3xl" style={{ background: tint }} />
        <div className="relative flex items-center gap-3.5">
          <span className="relative grid shrink-0 place-items-center">
            <span aria-hidden className="absolute inset-0 animate-ping rounded-[16px] opacity-25" style={{ background: tint }} />
            <svg aria-hidden width="60" height="60" viewBox="0 0 60 60" className="absolute -inset-[6px] h-[60px] w-[60px] -rotate-90">
              <circle cx="30" cy="30" r="27" fill="none" stroke={tint} strokeOpacity={0.18} strokeWidth="2.5" />
              <circle cx="30" cy="30" r="27" fill="none" stroke={tint} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={2 * Math.PI * 27} strokeDashoffset={2 * Math.PI * 27 * frac} />
            </svg>
            <AgentGlyph icon="spark" tint={tint} size={48} />
          </span>
          <div className="min-w-0 flex-1">
            <p id="ring-who" className="text-[15px] font-semibold leading-tight text-fg">
              {who} is calling
            </p>
            <p id="ring-what" className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
              {ring.items.length > 1 ? `${ring.items.length} urgent things, starting with ${first}` : `Urgent: ${first}`}
            </p>
          </div>
          <span className="shrink-0 self-start text-[11px] tabular-nums text-faint" aria-hidden>
            {left}s
          </span>
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => finish({ type: "decline" })} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-bad-soft text-[14px] font-medium text-bad transition active:scale-[0.98] hover:brightness-95">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rotate-[135deg]">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            Decline
          </button>
          <button type="button" onClick={answer} autoFocus className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ok text-[14px] font-medium text-white transition active:scale-[0.98] hover:brightness-105">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            Answer
          </button>
        </div>
        <p className="relative mt-2.5 text-center text-[11px] text-faint">Not now? It&apos;ll wait in your chat.</p>
      </div>
    </div>,
    document.body,
  );
}
