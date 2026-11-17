"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ackCallNotice, endCall, startCall } from "@/app/(team)/settings/call-actions";
import { assistantCallNotes, audioUploadSlot, callUploadSlots, callUploadsDone, screenFrameSaved, screenFrameSlot } from "@/app/(team)/assistant/actions";
import { lookPlan } from "@/lib/agent-call/call-context";
import { canShareScreen, grabFrame, startScreenShare, stopScreenShare } from "@/lib/agent-call/screen-share";
import { CALL_LIMIT_SECONDS, type CallCard, type LearnedItem, type StallState, type UploadAsk } from "@/lib/agent-call/core";
import { Call, chime, type Line, type Phase, type Speaker } from "@/lib/agent-call/engine";
import { ASSISTANT_KEY, ASSISTANT_LABEL } from "@/lib/assistant/core";
import type { CallNotes } from "@/lib/assistant/notes";
import { createClient } from "@/lib/supabase/client";
import { assistantTintOf } from "@/lib/agent-look";
import { captureFrames } from "@/lib/uploads/video-prep";
import { AgentGlyph, RecordingNotice } from "./assistant-call-parts";
import { FullScreenCall, FullScreenSummary, Huddle, HuddleSummary, SwitchAsk, type AgentRef, type CallView, type SummaryView } from "./agent-call-views";

// A call with an AI agent lives here, above every page (like uploads do), so it survives moving around the app: the
// microphone, the audio, the listening connection and the turn loop belong to this provider, not to the page that
// pressed the button. Phones show it as the full screen call (minimised to a pill when the call opens a screen);
// computers as the huddle (a small panel bottom right). Only one call at a time: starting another asks to leave the
// current one. The assistant's calls add a specialist on the line, link cards, an upload panel and screens it opens.
// Before anyone's first call, the notice that calls are recorded and may be reviewed is shown and acknowledged.
// A call started from a chat in the app carries where it came from (the client, the report, the Kaizen AI thread).
// "Take a look": when the agent wants to see the screen, a computer shares it (the browser's own picker the first
// time, then a still of it on each look, uploaded with the call's files); a phone gets the upload panel for a
// screenshot. Sharing stops on hang-up.

type Ctx = {
  /** Start a call with an agent (call it from the click itself: browsers only play sound after a tap). `agent.context`: where it's started from */
  start: (agent: AgentRef) => void;
  /** Call my assistant (from the side menu) */
  startAssistant: () => void;
  /** The agent on the line (or whose summary is open), if any */
  activeRole: string | null;
  /** A call is being set up or running */
  live: boolean;
  /** This person's own assistant color (their pick on the Assistant page, else the default) */
  assistantTint: string;
  /** Shown straight away when they pick another (saved by the Assistant page) */
  setAssistantTint: (hex: string | null) => void;
};

const CallCtx = createContext<Ctx>({ start: () => undefined, startAssistant: () => undefined, activeRole: null, live: false, assistantTint: assistantTintOf(null), setAssistantTint: () => undefined });

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

/** The assistant on a call, in its person's own color */
const assistantRef = (tint: string, context?: AgentRef["context"]): AgentRef => ({ roleKey: ASSISTANT_KEY, label: ASSISTANT_LABEL, tint, icon: (size) => <AgentGlyph icon="spark" tint={tint} size={size} />, ...(context ? { context } : {}) });

/** The hidden debug overlay (?calldebug=1): the noise floor, the threshold, the listening and whose turn it is */
const subscribeNone = () => () => undefined;
const debugOn = () => /[?&]calldebug=1/.test(window.location.search);

export function AgentCallProvider({ assistantColor = null, children }: { assistantColor?: string | null; children: React.ReactNode }) {
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
  const [sharing, setSharing] = useState(false);
  const [shareAsk, setShareAsk] = useState(false);
  const [looking, setLooking] = useState(false);
  const [stall, setStall] = useState<StallState>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [canSend, setCanSend] = useState(false);
  const debug = useSyncExternalStore(subscribeNone, debugOn, () => false);
  // Their own assistant color: from their profile, changed at once when they pick another
  const [tint, setTint] = useState(() => assistantTintOf(assistantColor));
  const [seenColor, setSeenColor] = useState(assistantColor);
  if (seenColor !== assistantColor) {
    setSeenColor(assistantColor);
    setTint(assistantTintOf(assistantColor));
  }
  const shareStream = useRef<MediaStream | null>(null);
  /** The look that's waiting for the screen to be shared */
  const lookWaiting = useRef(false);
  /** The latest look handler, for the call's hooks (made once, when the call is dialled) */
  const lookRef = useRef<() => void>(() => undefined);
  const canShare = useSyncExternalStore(
    () => () => undefined,
    () => canShareScreen(),
    () => false,
  );
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

  /** Stops sharing the screen (the button, the browser's own Stop, or the call ending) */
  const stopShare = useCallback(() => {
    stopScreenShare(shareStream.current);
    shareStream.current = null;
    lookWaiting.current = false;
    setSharing(false);
    setShareAsk(false);
    setLooking(false);
  }, []);

  /** Ends the call. `quiet` skips the wrap-up (leaving one call to start another) */
  const hangUp = useCallback(
    async (quiet = false) => {
      const id = callId.current;
      stopShare();
      const spent = startedRef.current ? (Date.now() - startedRef.current) / 1000 : 0;
      const wasAssistant = agent?.roleKey === ASSISTANT_KEY;
      call.current?.close();
      call.current = null;
      callId.current = null;
      setLiveId(null);
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
    [router, agent, fetchNotes, stopShare],
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

  // Computers: Space mutes and Enter sends what's been heard (when you aren't typing or on a button), Esc minimises (it doesn't hang up)
  useEffect(() => {
    if (stage !== "call" || !desktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space" || e.key === " ") {
        if (typing(e.target)) return;
        e.preventDefault();
        if (!e.repeat) toggleMute();
      } else if (e.key === "Enter") {
        if (typing(e.target) || e.repeat) return;
        e.preventDefault();
        call.current?.sendNow();
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
      const slot = await audioUploadSlot(id, part.index, part.startSeconds, part.mime);
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
      setStall(null);
      setCanSend(false);
      stopShare();
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
        onStall: setStall,
        onCanSend: setCanSend,
        onGuest: setGuest,
        onNavigate: openHref,
        onCard: (card) => setCards((cur) => [...cur.filter((x) => x.href !== card.href), card].slice(-6)),
        onUpload: (ask) => {
          setUploadAsk(ask);
          setMinimized(false);
        },
        onLook: () => lookRef.current(),
        onEnd: () => void hangUpRef.current(),
        onAudioPart: (part) => {
          if (id) void uploadAudio(id, part);
        },
      });
      c.prime();
      c.context = a.context ?? null;
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
        setLiveId(r.callId);
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
    [openHref, uploadAudio, stopShare],
  );

  const start = useCallback(
    (a: AgentRef) => {
      if (stageRef.current === "call") {
        // One call at a time: on the same agent it just opens the call again (now about where it was pressed)
        if (agent?.roleKey === a.roleKey) {
          if (a.context && call.current) call.current.context = a.context;
          return setMinimized(false);
        }
        return setSwitchTo(a);
      }
      dial(a);
    },
    [agent, dial],
  );

  const startAssistant = useCallback(() => start(assistantRef(tint)), [start, tint]);
  const setAssistantTint = useCallback((hex: string | null) => setTint(assistantTintOf(hex)), []);

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

  /** A still of the shared screen: up with the call's files, then sent to the agent as a turn with the picture */
  const sendFrame = useCallback(async () => {
    const id = callId.current;
    const stream = shareStream.current;
    if (!id || !stream) return;
    setLooking(true);
    try {
      const blob = await grabFrame(stream);
      if (!blob) {
        stopShare();
        setError("Sharing stopped, so I couldn't take a look.");
        return;
      }
      const slot = await screenFrameSlot(id);
      if (!slot.ok) throw new Error(slot.error);
      const { error } = await createClient().storage.from("ai-files").uploadToSignedUrl(slot.path, slot.token, blob, { contentType: "image/jpeg" });
      if (error) throw new Error("The screenshot didn't upload.");
      await screenFrameSaved(id, slot.path, blob.size);
      call.current?.inject("(Here's my screen right now. Take a look at what I asked about.)", "Shared my screen", slot.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't take a look.");
    } finally {
      setLooking(false);
    }
  }, [stopShare]);

  /** Share the screen: the browser's own picker (from the tap). A look that was waiting for it goes ahead */
  const share = useCallback(async () => {
    setShareAsk(false);
    if (shareStream.current) return;
    try {
      const stream = await startScreenShare();
      shareStream.current = stream;
      // The browser's own "Stop sharing" ends it too
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (shareStream.current === stream) stopShare();
      });
      setSharing(true);
      if (lookWaiting.current) {
        lookWaiting.current = false;
        void sendFrame();
      }
    } catch {
      // The picker was closed: a look that waited on it is told, so the agent doesn't wait on a picture
      if (lookWaiting.current) call.current?.inject("(I didn't share my screen.)", "Didn't share the screen");
      lookWaiting.current = false;
    }
  }, [sendFrame, stopShare]);

  /** The agent wants to see the screen: a still of what's shared, the ask to share, or (phones) the upload panel */
  const look = useCallback(() => {
    const plan = lookPlan({ desktop: desktopRef.current, canShare: canShareScreen(), sharing: Boolean(shareStream.current) });
    setMinimized(false);
    if (plan === "grab") return void sendFrame();
    if (plan === "ask_share") {
      lookWaiting.current = true;
      setShareAsk(true);
      return;
    }
    setUploadAsk({ purpose: "screen", client: null, note: "Take a screenshot of what you want me to see, then upload it here." });
  }, [sendFrame]);
  useEffect(() => {
    lookRef.current = look;
  }, [look]);

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
      // A screenshot for a look (phones): the agent sees the picture with the turn
      if (ask?.purpose === "screen") {
        const shot = done.files.find((f, i) => files[i]?.type.startsWith("image/")) ?? done.files[0];
        call.current?.inject("(Here's a screenshot of my screen. Take a look at what I asked about.)", "Uploaded a screenshot", shot?.path ?? null);
        return;
      }
      const names = done.files.map((f) => f.name).join(", ");
      const staged = done.launch ? " They're also staged with the launch in progress." : "";
      call.current?.inject(`(I just uploaded ${done.files.length === 1 ? "a file" : `${done.files.length} files`} on the call: ${names}. Confirm you got them and say briefly what they are.${staged})`, `Uploaded ${done.files.length === 1 ? names : `${done.files.length} files`}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload didn't go through.");
    } finally {
      setUploading(null);
    }
  }, [uploadAsk]);

  const ctx = useMemo<Ctx>(() => ({ start, startAssistant, activeRole: stage === "idle" ? null : (agent?.roleKey ?? null), live: stage === "call", assistantTint: tint, setAssistantTint }), [start, startAssistant, stage, agent, tint, setAssistantTint]);

  // The assistant always shows in its person's current color (even one picked mid-call)
  const shown = agent?.roleKey === ASSISTANT_KEY ? assistantRef(tint, agent.context) : agent;
  const view: CallView | null = shown
    ? {
        agent: shown,
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
        canSend,
        onSend: () => call.current?.sendNow(),
        onType: (text) => call.current?.sendText(text),
        stall,
        onRetry: () => call.current?.retry(),
        callId: liveId,
        debug,
        guest,
        cards,
        uploadAsk,
        uploading,
        onOpenCard: (c) => (c.external ? window.open(c.href, "_blank", "noopener,noreferrer") : openHref(c.href)),
        onDismissCard: (cid) => setCards((cur) => cur.filter((x) => x.id !== cid)),
        onUpload: (files) => void uploadFiles(files),
        onCloseUpload: () => setUploadAsk(null),
        onMinimize: () => setMinimized(true),
        screen: {
          can: canShare && desktop,
          sharing,
          asked: shareAsk,
          looking,
          onShare: () => void share(),
          onStop: stopShare,
          onCancel: () => {
            lookWaiting.current = false;
            setShareAsk(false);
          },
        },
      }
    : null;
  const sum: SummaryView | null = shown
    ? {
        agent: shown,
        summary,
        learned,
        callId: lastCall,
        notes: shown.roleKey === ASSISTANT_KEY ? notes : undefined,
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
