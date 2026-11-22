"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ackCallNotice, endCall, openAssistantChat, startCall, switchCallMode, takeChatHeadsUps, type ChatHeadsUp, type ThreadLine } from "@/app/(team)/settings/call-actions";
import { assistantCallNotes, audioUploadSlot, callUploadSlots, callUploadsDone, screenFrameSaved, screenFrameSlot } from "@/app/(team)/assistant/actions";
import { lookPlan } from "@/lib/agent-call/call-context";
import { openPlan } from "@/lib/agent-call/open-link";
import { canShareScreen, grabFrame, startScreenShare, stopScreenShare } from "@/lib/agent-call/screen-share";
import { CALL_LIMIT_SECONDS, type CallCard, type CallProgress, type EndTrigger, type LearnedItem, type StallState, type UploadAsk } from "@/lib/agent-call/core";
import { ChatSession, type ChatLine } from "@/lib/agent-call/chat-engine";
import type { TalkMode } from "@/lib/agent-call/modality";
import { Call, chime, type Line, type Phase, type Speaker } from "@/lib/agent-call/engine";
import { ASSISTANT_KEY, ASSISTANT_LABEL } from "@/lib/assistant/core";
import type { CallNotes } from "@/lib/assistant/notes";
import type { JobView } from "@/lib/assistant/team";
import { createClient } from "@/lib/supabase/client";
import { assistantTintOf, cleanAssistantName } from "@/lib/agent-look";
import { captureFrames } from "@/lib/uploads/video-prep";
import { AgentGlyph, RecordingNotice } from "./assistant-call-parts";
import { FullScreenCall, FullScreenSummary, Huddle, HuddleSummary, SwitchAsk, type AgentRef, type CallView, type SummaryView } from "./agent-call-views";
import { ChatWidget, type ChatView } from "./assistant-chat-views";

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
  /** Call my assistant (from the side menu); a chat that's open carries on as the call */
  startAssistant: () => void;
  /** Chat with my assistant: the same conversation and pipeline as a call, typed; a call that's on carries on as the chat */
  startAssistantChat: () => void;
  /** Answer the assistant's ring: a call that opens with the heads-up (call it from the tap itself) */
  answerHeadsUp: (id: string) => void;
  /** New heads-ups while the chat is open: written into it straight away */
  pullHeadsUps: () => void;
  /** Whether the conversation going now is a call or a chat */
  talk: TalkMode | null;
  /** The agent on the line (or whose summary is open), if any */
  activeRole: string | null;
  /** A call is being set up or running */
  live: boolean;
  /** This person's own assistant color (their pick on the Assistant page, else the default) */
  assistantTint: string;
  /** Shown straight away when they pick another (saved by the Assistant page) */
  setAssistantTint: (hex: string | null) => void;
  /** What this person calls their assistant (null: the default, "Assistant") */
  assistantName: string | null;
  /** Shown straight away when they rename it (saved by the Assistant page) */
  setAssistantName: (name: string | null) => void;
};

const CallCtx = createContext<Ctx>({ start: () => undefined, startAssistant: () => undefined, startAssistantChat: () => undefined, answerHeadsUp: () => undefined, pullHeadsUps: () => undefined, talk: null, activeRole: null, live: false, assistantTint: assistantTintOf(null), setAssistantTint: () => undefined, assistantName: null, setAssistantName: () => undefined });

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

type Stage = "idle" | "call" | "chat" | "summary";

/** The conversation's lines from the server, as the chat shows them (ids from `from` up) */
const chatLinesOf = (rows: ThreadLine[], from = 0): ChatLine[] => rows.map((l, i) => ({ id: from + i + 1, who: l.who, text: l.text, speaker: l.speaker }));

/** An urgent heads-up in the chat: a card to open the item */
const headsUpCard = (h: ChatHeadsUp): CallCard => ({ id: `heads-up-${h.id}`, title: h.title, detail: "Urgent, on your board", href: h.href ?? "/pipeline", external: false, cta: "Open it" });

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"].includes(el.tagName) || el.getAttribute("role") === "button";
};

/** The assistant on a call, in its person's own color */
const assistantRef = (tint: string, name: string | null, context?: AgentRef["context"]): AgentRef => ({ roleKey: ASSISTANT_KEY, label: name || ASSISTANT_LABEL, tint, icon: (size) => <AgentGlyph icon="spark" tint={tint} size={size} />, ...(context ? { context } : {}) });

/** The hidden debug overlay (?calldebug=1): the noise floor, the threshold, the listening and whose turn it is */
const subscribeNone = () => () => undefined;
/** The browser's time zone, so the agent greets them by their own clock ("good evening" at 8pm where they are) */
const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};
const debugOn = () => /[?&]calldebug=1/.test(window.location.search);

export function AgentCallProvider({ assistantColor = null, assistantName: givenName = null, meId = null, children }: { assistantColor?: string | null; assistantName?: string | null; /** Who's signed in: their chat draft and window size are kept per person */ meId?: string | null; children: React.ReactNode }) {
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
  /** The phone stopped the call's audio while it was in the background: shown until it's back */
  const [awayPaused, setAwayPaused] = useState(false);
  const [switchTo, setSwitchTo] = useState<AgentRef | null>(null);
  const [team, setTeam] = useState<Speaker[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  /** What the agent is working on right now (a step bar while it works) */
  const [progress, setProgress] = useState<CallProgress | null>(null);
  /** Other agents joined or a job ran on this call (its notes are written, as on the assistant's calls) */
  const teamed = useRef(false);
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
  // The chat: its lines (and the last few of the conversation before), an answer being written, opening or moving over
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [earlier, setEarlier] = useState<ChatLine[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatConnecting, setChatConnecting] = useState(false);
  const [noticeTalk, setNoticeTalk] = useState<TalkMode>("voice");
  const [switchTalk, setSwitchTalk] = useState<TalkMode>("voice");
  const debug = useSyncExternalStore(subscribeNone, debugOn, () => false);
  // Their own assistant color: from their profile, changed at once when they pick another
  const [tint, setTint] = useState(() => assistantTintOf(assistantColor));
  const [seenColor, setSeenColor] = useState(assistantColor);
  if (seenColor !== assistantColor) {
    setSeenColor(assistantColor);
    setTint(assistantTintOf(assistantColor));
  }
  // And the name they gave it, the same way
  const [name, setName] = useState<string | null>(givenName);
  const [seenName, setSeenName] = useState(givenName);
  if (seenName !== givenName) {
    setSeenName(givenName);
    setName(givenName);
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
  const chat = useRef<ChatSession | null>(null);
  const chatLinesRef = useRef<ChatLine[]>([]);
  const callId = useRef<string | null>(null);
  const startedRef = useRef<number | null>(null);
  const stageRef = useRef<Stage>("idle");
  const mutedRef = useRef(false);
  const desktopRef = useRef(desktop);

  useEffect(() => {
    stageRef.current = stage;
    desktopRef.current = desktop;
    chatLinesRef.current = chatLines;
  }, [stage, desktop, chatLines]);

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

  /**
   * Ends the call or the chat. `quiet` skips the wrap-up (leaving one to start another). `how`: what ended it (the
   * button, the agent's goodbye, the chat's close, the time limit), kept so the next one greets them right
   */
  const hangUp = useCallback(
    async (quiet = false, how?: EndTrigger) => {
      const id = callId.current;
      const wasChat = stageRef.current === "chat";
      const trigger: EndTrigger = how ?? (wasChat ? "chat_close" : "button");
      stopShare();
      chat.current?.close();
      chat.current = null;
      setChatBusy(false);
      setChatConnecting(false);
      const spent = startedRef.current ? (Date.now() - startedRef.current) / 1000 : 0;
      const wasAssistant = agent?.roleKey === ASSISTANT_KEY;
      const wasTeam = teamed.current;
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
      if (!wasChat) chime("end");
      if (quiet) {
        setStage("idle");
        void endCall(id, trigger).then(() => router.refresh());
        return;
      }
      setStage("summary");
      setSummary(null);
      setLastCall(id);
      setNotes(null);
      const r = await endCall(id, trigger);
      if (r.ok) {
        setLearned(r.learned);
        setSummary({ seconds: r.seconds, canReview: r.canReview, skills: r.skills });
      } else setSummary({ seconds: spent, canReview: false, skills: {} });
      // The notes are written for the assistant's calls and any call where agents worked a job together
      if (wasAssistant || wasTeam) void fetchNotes(id);
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
      if ((n - startedAt) / 1000 >= CALL_LIMIT_SECONDS) void hangUpRef.current(false, "limit");
    }, 1000);
    return () => clearInterval(t);
  }, [stage, startedAt]);

  // Closing the app (the provider going away) hangs up
  useEffect(
    () => () => {
      const id = callId.current;
      if (id && (call.current || chat.current)) void endCall(id, "unload");
      call.current?.close();
      chat.current?.close();
    },
    [],
  );

  // Switching apps, tabs or windows never ends the call: the engine is told when the page goes out of sight and comes
  // back (pagehide and pageshow too: a phone may freeze the page and restore it), and quietly picks up (away.ts)
  useEffect(() => {
    if (stage !== "call") return;
    const sync = () => call.current?.setAway(document.visibilityState === "hidden");
    const hide = () => call.current?.setAway(true);
    const show = () => call.current?.setAway(false);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("focus", show);
    document.addEventListener("freeze", hide);
    document.addEventListener("resume", show);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("focus", show);
      document.removeEventListener("freeze", hide);
      document.removeEventListener("resume", show);
      setAwayPaused(false);
    };
  }, [stage]);

  // Phones: the call takes the whole screen (unless minimised to its pill), and the page behind doesn't scroll
  const fullScreen = !desktop && stage !== "idle" && !((stage === "call" || stage === "chat") && minimized);
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

  /**
   * Opens a screen the agent asked for (or a card's Open) through the app's router, so the call stays up; the screen
   * already showing is refreshed rather than pushed again. On phones the call shrinks to its pill so the screen shows.
   */
  const openHref = useCallback(
    (href: string) => {
      const plan = openPlan({ href }, window.location);
      if (plan.how === "tab") window.open(plan.href, "_blank", "noopener,noreferrer");
      else if (plan.how === "refresh") router.refresh();
      else router.push(plan.href, { scroll: true });
      if (!desktopRef.current) setMinimized(true);
    },
    [router],
  );

  /** The same conversation moved to the other mode (the agent's switch_mode, or the buttons) */
  const switchRef = useRef<(to: TalkMode) => void>(() => undefined);

  /**
   * Starts a call. `carry`: the conversation going on in the chat continues as this call (same conversation, its
   * lines kept, the agent picks up where it was instead of greeting), and what's on screen with it (cards, the job,
   * who's on) stays.
   */
  const dial = useCallback(
    (a: AgentRef, before?: Promise<unknown>, carry?: { callId: string; lines: Line[] }, headsUp?: string) => {
      setAgent(a);
      setError(null);
      setLines(carry?.lines ?? []);
      if (!carry) setLearned([]);
      setPartial("");
      setMuted(false);
      mutedRef.current = false;
      setPhase("connecting");
      setEars(null);
      setSummary(null);
      setLastCall(null);
      setMinimized(false);
      setStartedAt(null);
      if (!carry) {
        setTeam([]);
        setJob(null);
        teamed.current = false;
        setCards([]);
        setUploadAsk(null);
        stopShare();
      }
      setNotes(null);
      setStall(null);
      setCanSend(false);
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
        onTeam: (l) => {
          setTeam(l);
          if (l.length) teamed.current = true;
        },
        onJob: (j) => {
          setJob(j);
          if (j) teamed.current = true;
        },
        onProgress: setProgress,
        onNavigate: openHref,
        // A draft card is replaced by its newer self (sent, saved as a Gmail draft); a link card by the same link
        onCard: (card) => setCards((cur) => [...cur.filter((x) => (card.draft ? x.draft?.id !== card.draft.id : x.href !== card.href || Boolean(x.draft))), card].slice(-6)),
        onUpload: (ask) => {
          setUploadAsk(ask);
          setMinimized(false);
        },
        onLook: () => lookRef.current(),
        onEnd: () => void hangUpRef.current(false, "agent_end"),
        onSwitch: (to) => switchRef.current(to),
        onAway: (paused) => setAwayPaused(paused),
        onAudioPart: (part) => {
          if (id) void uploadAudio(id, part);
        },
      });
      c.prime();
      c.context = a.context ?? null;
      call.current = c;
      void (async () => {
        await before;
        const r = carry
          ? await switchCallMode(carry.callId, "voice").then((x) => (x.ok ? { ok: true as const, callId: carry.callId, greeting: x.line, sttToken: x.sttToken } : x))
          : await startCall(a.roleKey, { ...(headsUp ? { headsUp } : {}), tz: localTimeZone() });
        // Left before it picked up
        if (call.current !== c) {
          if (r.ok && !carry) void endCall(r.callId, "button");
          return;
        }
        if (!r.ok) {
          c.close();
          call.current = null;
          // The first call: the recording notice comes first
          if ("needsNotice" in r && r.needsNotice) {
            setStage("idle");
            setNoticeTalk("voice");
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
          // A chat moved over stays open (it can be picked up again in the chat); a new call is closed
          if (!carry) {
            void endCall(r.callId, "error");
            callId.current = null;
          }
        }
      })();
    },
    [openHref, uploadAudio, stopShare],
  );

  /** The chat with the assistant: its window, then its conversation (the open one picked up, else a new one) */
  const makeChat = useCallback(
    (firstId: number) =>
      new ChatSession(
        {
          onLine: (l) =>
            setChatLines((cur) => {
              const i = cur.findIndex((x) => x.id === l.id);
              if (i < 0) return [...cur, l].slice(-200);
              const next = cur.slice();
              next[i] = l;
              return next;
            }),
          onBusy: setChatBusy,
          onError: setError,
          onLearned: (items) => setLearned((cur) => [...cur, ...items]),
          onTeam: (l) => {
            setTeam(l);
            if (l.length) teamed.current = true;
          },
          onJob: (j) => {
            setJob(j);
            if (j) teamed.current = true;
          },
          onProgress: setProgress,
          onNavigate: openHref,
          onCard: (card) => setCards((cur) => [...cur.filter((x) => (card.draft ? x.draft?.id !== card.draft.id : x.href !== card.href || Boolean(x.draft))), card].slice(-6)),
          onUpload: (ask) => {
            setUploadAsk(ask);
            setMinimized(false);
          },
          onLook: () => lookRef.current(),
          onEnd: () => void hangUpRef.current(false, "agent_end"),
          onSwitch: (to) => switchRef.current(to),
        },
        firstId,
      ),
    [openHref],
  );

  /** The chat being opened or moved to (a later one makes an earlier one's answer stale) */
  const chatToken = useRef<object | null>(null);
  const openChat = useCallback(
    (a: AgentRef, before?: Promise<unknown>) => {
      call.current?.close();
      call.current = null;
      chat.current?.close();
      chat.current = null;
      setAgent(a);
      setError(null);
      setChatLines([]);
      setEarlier([]);
      setLearned([]);
      setLines([]);
      setTeam([]);
      setJob(null);
      teamed.current = false;
      setCards([]);
      setUploadAsk(null);
      setNotes(null);
      setSummary(null);
      setLastCall(null);
      setMinimized(false);
      setChatBusy(false);
      setChatConnecting(true);
      stopShare();
      setStage("chat");
      const token = {};
      chatToken.current = token;
      void (async () => {
        await before;
        const r = await openAssistantChat({ tz: localTimeZone() });
        if (chatToken.current !== token || stageRef.current !== "chat") {
          if (r.ok && !r.resumed) void endCall(r.callId, "chat_close");
          return;
        }
        setChatConnecting(false);
        if (!r.ok) {
          if (r.needsNotice) {
            setStage("idle");
            setNoticeTalk("text");
            setNotice(a);
            return;
          }
          setError(r.error);
          return;
        }
        const shown = chatLinesOf(r.lines);
        setChatLines(shown);
        if (r.headsUps?.length) setCards(r.headsUps.map(headsUpCard));
        setEarlier(chatLinesOf(r.earlier, -1000));
        const s = makeChat(shown.length);
        s.callId = r.callId;
        s.context = a.context ?? null;
        chat.current = s;
        callId.current = r.callId;
        setLiveId(r.callId);
        startedRef.current = Date.parse(r.startedAt) || Date.now();
      })();
    },
    [makeChat, stopShare],
  );

  /** A call carries on as the chat: the same conversation, its lines, and the agent picks up where it was */
  const toChat = useCallback(() => {
    const id = callId.current;
    const a = agent;
    if (!id || !a) return;
    call.current?.close();
    call.current = null;
    setPhase("connecting");
    setPartial("");
    setMinimized(false);
    setChatBusy(false);
    setChatConnecting(true);
    setEarlier([]);
    setChatLines(lines.map((l, i) => ({ id: i + 1, who: l.who, text: l.text, speaker: l.speaker ?? null })));
    setStage("chat");
    const token = {};
    chatToken.current = token;
    void (async () => {
      const r = await switchCallMode(id, "text");
      if (chatToken.current !== token) return;
      setChatConnecting(false);
      if (!r.ok) return setError(r.error);
      const shown = chatLinesOf(r.lines);
      setChatLines(shown);
      const s = makeChat(shown.length);
      s.callId = id;
      s.context = a.context ?? null;
      chat.current = s;
    })();
  }, [agent, lines, makeChat]);

  const chatSend = useCallback((text: string) => chat.current?.send(text), []);
  /**
   * A message with screenshots or files they pasted, dropped or attached in the chat (Nov 22 2026: paste a screenshot
   * for context). Uploaded with the call's files (described, so later turns know them), then sent with the message:
   * the first picture is seen with this turn, the rest are listed for it.
   */
  const chatSendFiles = useCallback(async (text: string, files: File[]) => {
    const id = callId.current;
    const c = chat.current;
    const live = call.current;
    if (!id || (!c && !live) || !files.length) return;
    const previews = files.filter((f) => f.type.startsWith("image/")).map((f) => URL.createObjectURL(f));
    setUploading(`Adding ${files.length === 1 ? (files[0].name || "your screenshot") : `${files.length} files`}…`);
    try {
      const named = await Promise.all(files.map((f, i) => fitPicture(f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}${i ? `-${i + 1}` : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }))));
      const slots = await callUploadSlots(
        id,
        named.map((f) => ({ name: f.name, mime: f.type || "application/octet-stream", bytes: f.size, frames: 0 })),
      );
      if (!slots.ok) throw new Error(slots.error);
      const supabase = createClient();
      await Promise.all(
        named.map(async (f, i) => {
          const { error } = await supabase.storage.from("ai-files").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, f, { contentType: f.type || "application/octet-stream" });
          if (error) throw new Error(`${f.name} didn't upload.`);
        }),
      );
      const done = await callUploadsDone(
        id,
        named.map((f, i) => ({ path: slots.slots[i].path, name: f.name, mime: f.type || "application/octet-stream", bytes: f.size })),
        "files",
        null,
      );
      if (!done.ok) throw new Error(done.error);
      const pic = named.findIndex((f) => f.type.startsWith("image/"));
      const names = done.files.map((f) => f.name).join(", ");
      const said = `${text.trim() || (pic >= 0 ? "Take a look at this." : "Take a look at what I just added.")}

(Attached: ${names}.${pic >= 0 && done.files.length > 1 ? ` The first picture is shown with this message; the others are described with the files from this conversation.` : ""})`;
      const frame = pic >= 0 ? (done.files[pic]?.path ?? null) : null;
      // In the chat with its previews; on a voice call (typed or pasted there) as a short note on the transcript
      if (c) c.sendWithPictures(text.trim() || (previews.length ? "" : `📎 ${names}`), said, frame, previews);
      else {
        previews.forEach((u) => URL.revokeObjectURL(u));
        live?.inject(said, `${text.trim() ? `${text.trim()} ` : ""}📎 ${names}`, frame);
      }
    } catch (e) {
      previews.forEach((u) => URL.revokeObjectURL(u));
      setError(e instanceof Error ? e.message : "The file didn't go through.");
      throw e;
    } finally {
      setUploading(null);
    }
  }, []);
  const chatStop = useCallback(() => chat.current?.stop(), []);

  /** The chat carries on as a call (from the tap itself: browsers only play sound after one) */
  const toVoice = useCallback(() => {
    const id = callId.current;
    const a = agent;
    if (!id || !a || chatConnecting) return;
    chat.current?.close();
    chat.current = null;
    chatToken.current = null;
    setChatBusy(false);
    // The chat so far shows as the call's transcript (ids below the call's own)
    const carried: Line[] = chatLinesRef.current
      .filter((l) => !l.note && l.text.trim())
      .slice(-30)
      .map((l, i, all) => ({ id: i - all.length - 1, who: l.who, text: l.text, ...(l.speaker ? { speaker: l.speaker } : {}) }));
    dial(a, undefined, { callId: id, lines: carried });
  }, [agent, chatConnecting, dial]);

  useEffect(() => {
    switchRef.current = (to) => {
      if (to === "text" && stageRef.current === "call") toChat();
      // The agent asked to move to a call: on a computer that can start now; a phone needs the tap (the Call button)
      else if (to === "voice" && stageRef.current === "chat") toVoice();
    };
  }, [toChat, toVoice]);

  const start = useCallback(
    (a: AgentRef) => {
      if (stageRef.current === "call" || stageRef.current === "chat") {
        // One conversation at a time: on the same agent it just opens it again (now about where it was pressed)
        if (agent?.roleKey === a.roleKey) {
          if (a.context && call.current) call.current.context = a.context;
          if (a.context && chat.current) chat.current.context = a.context;
          // Calling the assistant while chatting with it: the chat carries on as the call
          if (stageRef.current === "chat") return toVoice();
          return setMinimized(false);
        }
        setSwitchTalk("voice");
        return setSwitchTo(a);
      }
      dial(a);
    },
    [agent, dial, toVoice],
  );

  const startAssistant = useCallback(() => start(assistantRef(tint, name)), [start, tint, name]);
  const startAssistantChat = useCallback(() => {
    const a = assistantRef(tint, name);
    if (stageRef.current === "chat") return setMinimized(false);
    if (stageRef.current === "call") {
      // On a call with the assistant: it carries on as the chat; with another agent, leave it first
      if (agent?.roleKey === ASSISTANT_KEY) return toChat();
      setSwitchTalk("text");
      return setSwitchTo(a);
    }
    openChat(a);
  }, [agent, openChat, tint, name, toChat]);
  /** The ring answered: the assistant's call, opening with the heads-up (a call already on is left as it is) */
  const answerHeadsUp = useCallback(
    (id: string) => {
      if (stageRef.current === "call" || stageRef.current === "chat") return;
      dial(assistantRef(tint, name), undefined, undefined, id);
    },
    [dial, tint, name],
  );
  /** Heads-ups that came while the chat is open: their lines and cards appear in it */
  const pullHeadsUps = useCallback(() => {
    const id = callId.current;
    if (stageRef.current !== "chat" || !id) return;
    void takeChatHeadsUps(id).then((r) => {
      if (!r.ok || !r.headsUps.length || callId.current !== id) return;
      const base = 1_000_000 + (Date.now() % 1_000_000);
      setChatLines((cur) => [...cur, ...chatLinesOf(r.lines, base)].slice(-200));
      setCards((cur) => [...cur.filter((c) => !r.headsUps.some((h) => c.id === `heads-up-${h.id}`)), ...r.headsUps.map(headsUpCard)].slice(-6));
      setMinimized(false);
    });
  }, []);
  const setAssistantTint = useCallback((hex: string | null) => setTint(assistantTintOf(hex)), []);
  const setAssistantName = useCallback((n: string | null) => setName(cleanAssistantName(n)), []);

  const leaveAndStart = () => {
    const next = switchTo;
    setSwitchTo(null);
    if (!next) return;
    void hangUp(true);
    if (switchTalk === "text") openChat(next);
    else dial(next);
  };

  /** The notice read: saved, and the call starts on this same tap */
  const acceptNotice = () => {
    const a = notice;
    setNotice(null);
    if (!a) return;
    if (noticeTalk === "text") openChat(a, ackCallNotice());
    else dial(a, ackCallNotice());
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
      (chat.current ?? call.current)?.inject("(Here's my screen right now. Take a look at what I asked about.)", "Shared my screen", slot.path);
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
      if (lookWaiting.current) (chat.current ?? call.current)?.inject("(I didn't share my screen.)", "Didn't share the screen");
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
        (chat.current ?? call.current)?.inject("(Here's a screenshot of my screen. Take a look at what I asked about.)", "Uploaded a screenshot", shot?.path ?? null);
        return;
      }
      const names = done.files.map((f) => f.name).join(", ");
      const staged = done.launch ? " They're also staged with the launch in progress." : "";
      (chat.current ?? call.current)?.inject(`(I just uploaded ${done.files.length === 1 ? "a file" : `${done.files.length} files`} on the call: ${names}. Confirm you got them and say briefly what they are.${staged})`, `Uploaded ${done.files.length === 1 ? names : `${done.files.length} files`}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload didn't go through.");
    } finally {
      setUploading(null);
    }
  }, [uploadAsk]);

  const ctx = useMemo<Ctx>(
    () => ({ start, startAssistant, startAssistantChat, answerHeadsUp, pullHeadsUps, talk: stage === "call" ? "voice" : stage === "chat" ? "text" : null, activeRole: stage === "idle" ? null : (agent?.roleKey ?? null), live: stage === "call" || stage === "chat", assistantTint: tint, setAssistantTint, assistantName: name, setAssistantName }),
    [start, startAssistant, startAssistantChat, answerHeadsUp, pullHeadsUps, stage, agent, tint, setAssistantTint, name, setAssistantName],
  );

  // The assistant always shows in its person's current color (even one picked mid-call)
  const shown = agent?.roleKey === ASSISTANT_KEY ? assistantRef(tint, name, agent.context) : agent;
  const cancelLook = useCallback(() => {
    lookWaiting.current = false;
    setShareAsk(false);
  }, []);
  // Sharing the screen for a look, the same on a call and in the chat
  const screenControls = { can: canShare && desktop, sharing, asked: shareAsk, looking, onShare: () => void share(), onStop: stopShare, onCancel: cancelLook };
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
        awayPaused,
        onMute: toggleMute,
        onHangUp: () => void hangUp(),
        canSend,
        onSend: () => call.current?.sendNow(),
        onType: (text) => call.current?.sendText(text),
        onTypeFiles: (text, files) => chatSendFiles(text, files),
        stall,
        onRetry: () => call.current?.retry(),
        callId: liveId,
        debug,
        team,
        job,
        progress,
        cards,
        uploadAsk,
        uploading,
        onOpenCard: (c) => (c.external ? window.open(c.href, "_blank", "noopener,noreferrer") : openHref(c.href)),
        onDismissCard: (cid) => setCards((cur) => cur.filter((x) => x.id !== cid)),
        onUpload: (files) => void uploadFiles(files),
        onCloseUpload: () => setUploadAsk(null),
        onMinimize: () => setMinimized(true),
        onToChat: shown.roleKey === ASSISTANT_KEY ? toChat : undefined,
        screen: screenControls,
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

  const chatView: ChatView | null =
    shown && stage === "chat"
      ? {
          agent: shown,
          meId,
          lines: chatLines,
          earlier,
          busy: chatBusy,
          connecting: chatConnecting,
          error,
          learned,
          team,
          job,
          progress,
          cards,
          uploadAsk,
          uploading,
          callId: liveId,
          screen: screenControls,
          onSend: chatSend,
          onSendFiles: chatSendFiles,
          onStop: chatStop,
          onClose: () => void hangUp(false, "chat_close"),
          onCall: () => toVoice(),
          onLink: openHref,
          onOpenCard: (c) => (c.external ? window.open(c.href, "_blank", "noopener,noreferrer") : openHref(c.href)),
          onDismissCard: (cid) => setCards((cur) => cur.filter((x) => x.id !== cid)),
          onUpload: (files) => void uploadFiles(files),
          onCloseUpload: () => setUploadAsk(null),
        }
      : null;

  const screen =
    stage === "chat" && shown ? (
      <ChatWidget v={chatView as ChatView} minimized={minimized} phone={!desktop} onMinimize={() => setMinimized(true)} onExpand={() => setMinimized(false)} />
    ) : view && sum && stage === "call" ? (
      desktop || minimized ? (
        <Huddle v={view} minimized={minimized} phone={!desktop} onMinimize={() => setMinimized(true)} onExpand={() => setMinimized(false)} />
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

/**
 * A picture the model can read with the turn: PNG, JPEG or WebP under ~4MB. A big retina screenshot or another kind of
 * image (a GIF, HEIC the browser can draw) is redrawn as a JPEG at most 2000px wide; anything else is left as it is.
 */
async function fitPicture(f: File): Promise<File> {
  if (!f.type.startsWith("image/")) return f;
  if (/^image\/(png|jpeg|webp)$/.test(f.type) && f.size <= 4_000_000) return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.86));
    if (!blob) return f;
    return new File([blob], f.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return f;
  }
}
