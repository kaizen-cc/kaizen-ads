"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ackCallNotice, endCall, startCall } from "@/app/(team)/settings/call-actions";
import { assistantCallNotes, audioUploadSlot, callUploadSlots, callUploadsDone } from "@/app/(team)/assistant/actions";
import { CALL_LIMIT_SECONDS, type CallCard, type LearnedItem, type UploadAsk } from "@/lib/agent-call/core";
import { Call, chime, type Line, type Phase, type Speaker } from "@/lib/agent-call/engine";
import { ASSISTANT_KEY, ASSISTANT_LABEL } from "@/lib/assistant/core";
import type { CallNotes } from "@/lib/assistant/notes";
import { createClient } from "@/lib/supabase/client";
import { ASSISTANT_TINT } from "@/lib/agent-look";
import { captureFrames } from "@/lib/uploads/video-prep";
import { AgentGlyph, RecordingNotice } from "./assistant-call-parts";
import { FullScreenCall, FullScreenSummary, Huddle, HuddleSummary, SwitchAsk, type AgentRef, type CallView, type SummaryView } from "./agent-call-views";

// A call with an AI agent lives here, above every page (like uploads do), so it survives moving around the app: the
// microphone, the audio, the listening connection and the turn loop belong to this provider, not to the page that
// pressed the button. Phones show it as the full screen call (minimised to a pill when the call opens a screen);
// computers as the huddle (a small panel bottom right). Only one call at a time: starting another asks to leave the
// current one. The assistant's calls add a specialist on the line, link cards, an upload panel and screens it opens.
// Before anyone's first call, the notice that calls are recorded and may be reviewed is shown and acknowledged.

type Ctx = {
  /** Start a call with an agent (call it from the click itself: browsers only play sound after a tap) */
  start: (agent: AgentRef) => void;
  /** Call my assistant (from the side menu) */
  startAssistant: () => void;
  /** The agent on the line (or whose summary is open), if any */
  activeRole: string | null;
  /** A call is being set up or running */
  live: boolean;
};

const CallCtx = createContext<Ctx>({ start: () => undefined, startAssistant: () => undefined, activeRole: null, live: false });

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

const ASSISTANT: AgentRef = { roleKey: ASSISTANT_KEY, label: ASSISTANT_LABEL, tint: ASSISTANT_TINT, icon: (size) => <AgentGlyph icon="spark" tint={ASSISTANT_TINT} size={size} /> };

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
  const [guest, setGuest] = useState<Speaker | null>(null);
  const [cards, setCards] = useState<CallCard[]>([]);
  const [uploadAsk, setUploadAsk] = useState<UploadAsk | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [notice, setNotice] = useState<AgentRef | null>(null);
  const [notes, setNotes] = useState<CallNotes | null | "none">(null);
  const call = useRef<Call | null>(null);
  const callId = useRef<string | null>(null);
  const startedRef = useRef<number | null>(null);
  const stageRef = useRef<Stage>("idle");
  const mutedRef = useRef(false);
  const desktopRef = useRef(desktop);

  useEffect(() => {
    stageRef.current = stage;
    desktopRef.current = desktop;
  }, [stage, desktop]);

  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const left = CALL_LIMIT_SECONDS - elapsed;

  /** The assistant's notes, once they're written (a few seconds after the call) */
  const fetchNotes = useCallback(async (id: string) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const r = await assistantCallNotes(id).catch(() => null);
      if (r?.ok && r.notes) return setNotes(r.notes);
    }
    setNotes("none");
  }, []);

  /** Ends the call. `quiet` skips the wrap-up (leaving one call to start another) */
  const hangUp = useCallback(
    async (quiet = false) => {
      const id = callId.current;
      const spent = startedRef.current ? (Date.now() - startedRef.current) / 1000 : 0;
      const wasAssistant = agent?.roleKey === ASSISTANT_KEY;
      call.current?.close();
      call.current = null;
      callId.current = null;
      startedRef.current = null;
      setUploadAsk(null);
      if (!id) {
        setStage("idle");
        return;
      }
      chime("end");
      if (quiet) {
        setStage("idle");
        void endCall(id).then(() => router.refresh());
        return;
      }
      setStage("summary");
      setSummary(null);
      setLastCall(id);
      setNotes(null);
      const r = await endCall(id);
      if (r.ok) {
        setLearned(r.learned);
        setSummary({ seconds: r.seconds, canReview: r.canReview, skills: r.skills });
      } else setSummary({ seconds: spent, canReview: false, skills: {} });
      if (wasAssistant) void fetchNotes(id);
      router.refresh();
    },
    [router, agent, fetchNotes],
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

  // Phones: the call takes the whole screen (unless minimised to its pill), and the page behind doesn't scroll
  const fullScreen = !desktop && stage !== "idle" && !(stage === "call" && minimized);
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

  /** One recorded part of the call, straight to private storage */
  const uploadAudio = useCallback(async (id: string, part: { blob: Blob; index: number; startSeconds: number; mime: string }) => {
    try {
      const slot = await audioUploadSlot(id, part.index, part.startSeconds);
      if (!slot.ok) return;
      await createClient().storage.from("call-audio").uploadToSignedUrl(slot.path, slot.token, part.blob, { contentType: part.mime.split(";")[0] });
    } catch {
      // A part that didn't save is lost; the call goes on
    }
  }, []);

  /** Opens a screen the agent asked for; on phones the call shrinks to its pill so the screen shows */
  const openHref = useCallback(
    (href: string) => {
      router.push(href);
      if (!desktopRef.current) setMinimized(true);
    },
    [router],
  );

  const dial = useCallback(
    (a: AgentRef, before?: Promise<unknown>) => {
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
      setGuest(null);
      setCards([]);
      setUploadAsk(null);
      setNotes(null);
      setStage("call");
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser can't use the microphone here.");
        return;
      }
      // Made on the tap itself, so the browser lets it play sound
      let id: string | null = null;
      const c = new Call({
        onPhase: setPhase,
        onLine: (l) => setLines((cur) => [...cur.slice(-40), l]),
        onPartial: setPartial,
        onLearned: (items) => setLearned((cur) => [...cur, ...items]),
        onError: setError,
        onEars: setEars,
        onGuest: setGuest,
        onNavigate: openHref,
        onCard: (card) => setCards((cur) => [...cur.filter((x) => x.href !== card.href), card].slice(-6)),
        onUpload: (ask) => {
          setUploadAsk(ask);
          setMinimized(false);
        },
        onEnd: () => void hangUpRef.current(),
        onAudioPart: (part) => {
          if (id) void uploadAudio(id, part);
        },
      });
      c.prime();
      call.current = c;
      void (async () => {
        await before;
        const r = await startCall(a.roleKey);
        // Left before it picked up
        if (call.current !== c) {
          if (r.ok) void endCall(r.callId);
          return;
        }
        if (!r.ok) {
          c.close();
          call.current = null;
          // The first call: the recording notice comes first
          if (r.needsNotice) {
            setStage("idle");
            setNotice(a);
            return;
          }
          setError(r.error);
          return;
        }
        id = r.callId;
        callId.current = r.callId;
        c.callId = r.callId;
        const t0 = Date.now();
        startedRef.current = t0;
        setStartedAt(t0);
        setNow(t0);
        try {
          chime("connect");
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
    [openHref, uploadAudio],
  );

  const start = useCallback(
    (a: AgentRef) => {
      if (stageRef.current === "call") {
        // One call at a time: on the same agent it just opens the call again
        if (agent?.roleKey === a.roleKey) return setMinimized(false);
        return setSwitchTo(a);
      }
      dial(a);
    },
    [agent, dial],
  );

  const startAssistant = useCallback(() => start(ASSISTANT), [start]);

  const leaveAndStart = () => {
    const next = switchTo;
    setSwitchTo(null);
    if (!next) return;
    void hangUp(true);
    dial(next);
  };

  /** The notice read: saved, and the call starts on this same tap */
  const acceptNotice = () => {
    const a = notice;
    setNotice(null);
    if (!a) return;
    dial(a, ackCallNotice());
  };

  /** Files the assistant asked for: up to storage (videos with a few frames), read, then the assistant is told */
  const uploadFiles = useCallback(async (files: File[]) => {
    const id = callId.current;
    const ask = uploadAsk;
    if (!id || !files.length) return;
    setUploading(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
    try {
      const frames = await Promise.all(
        files.map(async (f) => {
          if (!f.type.startsWith("video/")) return [];
          const url = URL.createObjectURL(f);
          const all = await captureFrames(url).catch(() => []);
          URL.revokeObjectURL(url);
          return [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]].filter((x, i, arr) => x && arr.indexOf(x) === i);
        }),
      );
      const slots = await callUploadSlots(
        id,
        files.map((f, i) => ({ name: f.name, mime: f.type || "application/octet-stream", bytes: f.size, frames: frames[i].length })),
      );
      if (!slots.ok) throw new Error(slots.error);
      const supabase = createClient();
      await Promise.all(
        files.map(async (f, i) => {
          const s = slots.slots[i];
          const { error } = await supabase.storage.from("ai-files").uploadToSignedUrl(s.path, s.token, f, { contentType: f.type || "application/octet-stream" });
          if (error) throw new Error(`${f.name} didn't upload.`);
          await Promise.all(frames[i].map((fr, k) => (s.frames[k] ? supabase.storage.from("ai-files").uploadToSignedUrl(s.frames[k].path, s.frames[k].token, fr.blob, { contentType: "image/jpeg" }) : null)));
        }),
      );
      setUploading("Reading them…");
      const done = await callUploadsDone(
        id,
        files.map((f, i) => ({ path: slots.slots[i].path, name: f.name, mime: f.type || "application/octet-stream", bytes: f.size, frames: frames[i].map((fr, k) => ({ path: slots.slots[i].frames[k]?.path ?? "", ms: fr.ms })).filter((x) => x.path) })),
        ask?.purpose ?? "files",
        ask?.client ?? null,
      );
      if (!done.ok) throw new Error(done.error);
      setUploadAsk(null);
      const names = done.files.map((f) => f.name).join(", ");
      call.current?.inject(`(I just uploaded ${done.files.length === 1 ? "a file" : `${done.files.length} files`} on the call: ${names}. Confirm you got them and say briefly what they are.)`, `Uploaded ${done.files.length === 1 ? names : `${done.files.length} files`}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload didn't go through.");
    } finally {
      setUploading(null);
    }
  }, [uploadAsk]);

  const ctx = useMemo<Ctx>(() => ({ start, startAssistant, activeRole: stage === "idle" ? null : (agent?.roleKey ?? null), live: stage === "call" }), [start, startAssistant, stage, agent]);

  const view: CallView | null = agent
    ? {
        agent,
        phase,
        lines,
        partial,
        learned,
        error,
        muted,
        ears,
        elapsed,
        left,
        call,
        onMute: toggleMute,
        onHangUp: () => void hangUp(),
        guest,
        cards,
        uploadAsk,
        uploading,
        onOpenCard: (c) => (c.external ? window.open(c.href, "_blank", "noopener,noreferrer") : openHref(c.href)),
        onDismissCard: (cid) => setCards((cur) => cur.filter((x) => x.id !== cid)),
        onUpload: (files) => void uploadFiles(files),
        onCloseUpload: () => setUploadAsk(null),
        onMinimize: () => setMinimized(true),
      }
    : null;
  const sum: SummaryView | null = agent
    ? {
        agent,
        summary,
        learned,
        callId: lastCall,
        notes: agent.roleKey === ASSISTANT_KEY ? notes : undefined,
        onDone: () => {
          setStage("idle");
          setSummary(null);
          setLastCall(null);
        },
      }
    : null;

  const screen =
    view && sum && stage === "call" ? (
      desktop || minimized ? (
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
            {notice && <RecordingNotice onAccept={acceptNotice} onCancel={() => setNotice(null)} />}
          </>,
          document.body,
        )}
    </CallCtx.Provider>
  );
}
