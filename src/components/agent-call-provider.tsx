"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { endCall, startCall } from "@/app/(team)/settings/call-actions";
import { CALL_LIMIT_SECONDS, type LearnedItem } from "@/lib/agent-call/core";
import { Call, type Line, type Phase } from "@/lib/agent-call/engine";
import { FullScreenCall, FullScreenSummary, Huddle, HuddleSummary, SwitchAsk, type AgentRef, type CallView, type SummaryView } from "./agent-call-views";

// A call with an AI agent lives here, above every page (like uploads do), so it survives moving around the app: the
// microphone, the audio, the listening connection and the turn loop belong to this provider, not to the page that
// pressed the button. Phones show it as the full screen call; computers as the huddle (a small panel bottom right).
// Only one call at a time: starting another asks to leave the current one.

type Ctx = {
  /** Start a call with an agent (call it from the click itself: browsers only play sound after a tap) */
  start: (agent: AgentRef) => void;
  /** The agent on the line (or whose summary is open), if any */
  activeRole: string | null;
  /** A call is being set up or running */
  live: boolean;
};

const CallCtx = createContext<Ctx>({ start: () => undefined, activeRole: null, live: false });

export const useAgentCall = () => useContext(CallCtx);

const DESKTOP = "(min-width: 768px)";
const subscribeDesktop = (cb: () => void) => {
  const m = window.matchMedia(DESKTOP);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Computers (md and up) get the huddle; phones the full screen */
const useDesktop = () =>
  useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );

type Stage = "idle" | "call" | "summary";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"].includes(el.tagName) || el.getAttribute("role") === "button";
};

export function AgentCallProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const desktop = useDesktop();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [stage, setStage] = useState<Stage>("idle");
  const [agent, setAgent] = useState<AgentRef | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [learned, setLearned] = useState<LearnedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [ears, setEars] = useState<"scribe" | "browser" | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [summary, setSummary] = useState<{ seconds: number; canReview: boolean; skills: Record<string, string> } | null>(null);
  const [lastCall, setLastCall] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [switchTo, setSwitchTo] = useState<AgentRef | null>(null);
  const call = useRef<Call | null>(null);
  const callId = useRef<string | null>(null);
  const startedRef = useRef<number | null>(null);
  const stageRef = useRef<Stage>("idle");
  const mutedRef = useRef(false);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const left = CALL_LIMIT_SECONDS - elapsed;

  /** Ends the call. `quiet` skips the "What I learned" sheet (leaving one call to start another) */
  const hangUp = useCallback(
    async (quiet = false) => {
      const id = callId.current;
      const spent = startedRef.current ? (Date.now() - startedRef.current) / 1000 : 0;
      call.current?.close();
      call.current = null;
      callId.current = null;
      startedRef.current = null;
      if (!id) {
        setStage("idle");
        return;
      }
      if (quiet) {
        setStage("idle");
        void endCall(id).then(() => router.refresh());
        return;
      }
      setStage("summary");
      setSummary(null);
      setLastCall(id);
      const r = await endCall(id);
      if (r.ok) {
        setLearned(r.learned);
        setSummary({ seconds: r.seconds, canReview: r.canReview, skills: r.skills });
      } else setSummary({ seconds: spent, canReview: false, skills: {} });
      router.refresh();
    },
    [router],
  );
  const hangUpRef = useRef(hangUp);
  useEffect(() => {
    hangUpRef.current = hangUp;
  }, [hangUp]);

  // The clock, and hanging up at the limit
  useEffect(() => {
    if (stage !== "call" || !startedAt) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if ((n - startedAt) / 1000 >= CALL_LIMIT_SECONDS) void hangUpRef.current();
    }, 1000);
    return () => clearInterval(t);
  }, [stage, startedAt]);

  // Closing the app (the provider going away) hangs up
  useEffect(
    () => () => {
      const id = callId.current;
      if (id && call.current) void endCall(id);
      call.current?.close();
    },
    [],
  );

  // Phones: the call takes the whole screen, and the page behind doesn't scroll
  const fullScreen = !desktop && stage !== "idle";
  useEffect(() => {
    if (!fullScreen) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = was;
    };
  }, [fullScreen]);

  const toggleMute = useCallback(() => {
    const m = !mutedRef.current;
    mutedRef.current = m;
    setMuted(m);
    call.current?.setMuted(m);
  }, []);

  // Computers: Space mutes (when you aren't typing or on a button), Esc minimises (it doesn't hang up)
  useEffect(() => {
    if (stage !== "call" || !desktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space" || e.key === " ") {
        if (typing(e.target)) return;
        e.preventDefault();
        if (!e.repeat) toggleMute();
      } else if (e.key === "Escape") {
        setMinimized(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, desktop, toggleMute]);

  const dial = useCallback(
    (a: AgentRef) => {
      setAgent(a);
      setError(null);
      setLines([]);
      setLearned([]);
      setPartial("");
      setMuted(false);
      mutedRef.current = false;
      setPhase("connecting");
      setEars(null);
      setSummary(null);
      setLastCall(null);
      setMinimized(false);
      setStartedAt(null);
      setStage("call");
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser can't use the microphone here.");
        return;
      }
      // Made on the tap itself, so the browser lets it play sound
      const c = new Call({
        onPhase: setPhase,
        onLine: (l) => setLines((cur) => [...cur.slice(-40), l]),
        onPartial: setPartial,
        onLearned: (items) => setLearned((cur) => [...cur, ...items]),
        onError: setError,
        onEars: setEars,
      });
      c.prime();
      call.current = c;
      void (async () => {
        const r = await startCall(a.roleKey);
        // Left before it picked up
        if (call.current !== c) {
          if (r.ok) void endCall(r.callId);
          return;
        }
        if (!r.ok) {
          c.close();
          call.current = null;
          setError(r.error);
          return;
        }
        callId.current = r.callId;
        c.callId = r.callId;
        const t0 = Date.now();
        startedRef.current = t0;
        setStartedAt(t0);
        setNow(t0);
        try {
          await c.open(r.greeting, r.sttToken);
        } catch (e) {
          const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
          setError(denied ? "Allow the microphone to talk to the agent." : "Couldn't start the call. Try again.");
          c.close();
          call.current = null;
          void endCall(r.callId);
          callId.current = null;
        }
      })();
    },
    [],
  );

  const start = useCallback(
    (a: AgentRef) => {
      if (stageRef.current === "call") {
        // One call at a time: on the same agent it just opens the huddle again
        if (agent?.roleKey === a.roleKey) return setMinimized(false);
        return setSwitchTo(a);
      }
      dial(a);
    },
    [agent, dial],
  );

  const leaveAndStart = () => {
    const next = switchTo;
    setSwitchTo(null);
    if (!next) return;
    void hangUp(true);
    dial(next);
  };

  const ctx = useMemo<Ctx>(() => ({ start, activeRole: stage === "idle" ? null : (agent?.roleKey ?? null), live: stage === "call" }), [start, stage, agent]);

  const view: CallView | null = agent
    ? { agent, phase, lines, partial, learned, error, muted, ears, elapsed, left, call, onMute: toggleMute, onHangUp: () => void hangUp() }
    : null;
  const sum: SummaryView | null = agent
    ? {
        agent,
        summary,
        learned,
        callId: lastCall,
        onDone: () => {
          setStage("idle");
          setSummary(null);
          setLastCall(null);
        },
      }
    : null;

  const screen =
    view && sum && stage === "call" ? (
      desktop ? (
        <Huddle v={view} minimized={minimized} onMinimize={() => setMinimized(true)} onExpand={() => setMinimized(false)} />
      ) : (
        <FullScreenCall v={view} />
      )
    ) : sum && stage === "summary" ? (
      desktop ? (
        <HuddleSummary s={sum} />
      ) : (
        <FullScreenSummary s={sum} />
      )
    ) : null;

  return (
    <CallCtx.Provider value={ctx}>
      {children}
      {mounted &&
        createPortal(
          <>
            {screen}
            {switchTo && agent && <SwitchAsk current={agent.label} next={switchTo.label} onStay={() => setSwitchTo(null)} onLeave={leaveAndStart} />}
          </>,
          document.body,
        )}
    </CallCtx.Provider>
  );
}
