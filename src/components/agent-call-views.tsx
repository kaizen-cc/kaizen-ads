"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import { reviewCallLearnings, undoLearning } from "@/app/(team)/settings/call-actions";
import { field } from "@/components/ui";
import { CALL_LIMIT_SECONDS, clock, keyOf, statusOf, type LearnedItem, type StallState } from "@/lib/agent-call/core";
import type { Call, CallDebug, Line, Phase, Speaker } from "@/lib/agent-call/engine";
import type { CallCard, UploadAsk } from "@/lib/agent-call/core";
import type { CallNotes } from "@/lib/assistant/notes";
import type { JobView } from "@/lib/assistant/team";
import type { CallContext } from "@/lib/agent-call/call-context";
import { CardsStrip, JobStrip, NotesBlock, RecordedMark, ScreenIcon, ShareAsk, SharingBar, TeamChips, TranscriptButton, UploadPanel } from "./assistant-call-parts";

// The two ways a call is shown. On phones it takes the whole screen; on computers it is a huddle: a small panel
// docked bottom right that stays while you move around the app, and shrinks to a pill. Both read the same state,
// which the call provider owns (so the call itself never lives in a screen).

export type AgentRef = {
  roleKey: string;
  label: string;
  tint: string;
  /** The agent's icon at a given size */
  icon: (size: number) => ReactNode;
  /** Where the call was started from (a client, a report, a Kaizen AI thread), sent with every turn */
  context?: CallContext | null;
};

export type CallView = {
  agent: AgentRef;
  phase: Phase;
  lines: Line[];
  partial: string;
  learned: LearnedItem[];
  error: string | null;
  muted: boolean;
  ears: "scribe" | "browser" | null;
  elapsed: number;
  left: number;
  call: RefObject<Call | null>;
  /** The phone stopped the audio while the call was in the background (it picks up on return) */
  awayPaused?: boolean;
  onMute: () => void;
  onHangUp: () => void;
  /** Assistant calls: the specialist on the line, link cards, the upload panel */
  team?: Speaker[];
  /** The job the agents are working on (launching ads, an email request…) */
  job?: JobView | null;
  cards?: CallCard[];
  uploadAsk?: UploadAsk | null;
  uploading?: string | null;
  onOpenCard?: (c: CallCard) => void;
  onDismissCard?: (id: string) => void;
  onUpload?: (files: File[]) => void;
  onCloseUpload?: () => void;
  /** Phones: shrink the call to its pill (to see a screen it opened) */
  onMinimize?: () => void;
  /** Computers: sharing the screen for a look (whether it can, it is, it's asked, a look is being taken) */
  screen?: { can: boolean; sharing: boolean; asked: boolean; looking: boolean; onShare: () => void; onStop: () => void; onCancel: () => void };
  /** Send what's been heard now (and whether there's anything to send), or a typed turn */
  canSend?: boolean;
  onSend?: () => void;
  onType?: (text: string) => void;
  /** A long turn sent, a slow answer being retried, or one that didn't go through (with Retry) */
  stall?: StallState;
  onRetry?: () => void;
  /** The call's id once it's picked up (for the transcript) */
  callId?: string | null;
  /** The hidden debug overlay (?calldebug=1) */
  debug?: boolean;
};

export type SummaryView = {
  agent: AgentRef;
  summary: { seconds: number; canReview: boolean; skills: Record<string, string> } | null;
  learned: LearnedItem[];
  callId: string | null;
  /** The assistant's notes (undefined for other agents; null while they're written; "none" when there are none) */
  notes?: CallNotes | null | "none";
  onDone: () => void;
};

const PHASE_LABEL: Record<Phase, string> = { connecting: "Calling…", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };

export const PhoneIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export const HeadsetIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
    <path d="M21 16a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3zM3 16a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z" />
    <path d="M21 18v1a3 3 0 0 1-3 3h-4" />
  </svg>
);

const MicIcon = ({ size = 24, off = false }: { size?: number; off?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    {off && <path d="m3 3 18 18" />}
  </svg>
);

/** The live waveform: bars from the latest levels, in the agent's colour while it speaks */
export function Wave({ call, phase, tint, className = "h-16 w-full max-w-sm", bars = 48 }: { call: RefObject<Call | null>; phase: Phase; tint: string; className?: string; bars?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    if (!g) return;
    const levels: number[] = new Array(bars).fill(0);
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--color-faint").trim() || "#888";
    const brand = getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() || "#888";
    let raf = 0;
    const draw = () => {
      const lv = call.current?.sample() ?? 0;
      levels.push(Math.min(1, lv * 9));
      levels.shift();
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr) el.width = w * dpr;
      if (el.height !== h * dpr) el.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const bar = w / levels.length;
      g.fillStyle = phase === "speaking" ? tint : phase === "listening" ? brand : muted;
      levels.forEach((v, i) => {
        const bh = Math.max(3, v * h);
        const x = i * bar + bar * 0.25;
        g.globalAlpha = 0.35 + 0.65 * (i / levels.length);
        g.beginPath();
        g.roundRect(x, (h - bh) / 2, bar * 0.5, bh, bar * 0.25);
        g.fill();
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [call, phase, tint, bars]);
  return <canvas ref={canvas} aria-hidden className={className} />;
}

const status = (v: Pick<CallView, "muted" | "phase" | "stall" | "awayPaused">) =>
  v.awayPaused ? "Paused while you were away" : v.muted ? "Muted" : v.phase === "thinking" && v.stall === "slow" ? "Still working…" : v.phase === "thinking" && v.stall === "long" ? "Got it, thinking…" : PHASE_LABEL[v.phase];

const KeyboardIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9" />
  </svg>
);

const SendIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);

/**
 * Send now: the live caption of what will be sent, and a Send button that sends it without waiting for the pause
 * (noise, or the pause just isn't caught). Type instead opens a small input for loud places or a missed turn. When an
 * answer didn't go through, this is where it says so, with Retry.
 */
function SendBar({ v, compact }: { v: CallView; compact: boolean }) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  if (!v.onSend || v.phase === "connecting") return null;
  if (v.stall === "failed" && v.phase === "listening" && !v.partial && !typing)
    return (
      <div role="alert" className="flex items-center gap-2 rounded-[18px] border border-bad/25 bg-bad/[0.06] p-1.5 pl-3.5">
        <p className="min-w-0 flex-1 text-[13.5px] leading-snug">That didn&apos;t go through.</p>
        <button type="button" onClick={() => setTyping(true)} aria-label="Type instead" title="Type instead" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">
          <KeyboardIcon size={16} />
        </button>
        <button type="button" onClick={v.onRetry} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-brand px-4 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.97] md:min-h-9">
          Retry
        </button>
      </div>
    );
  if (typing)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          v.onType?.(draft);
          setDraft("");
          setTyping(false);
        }}
        className="flex items-center gap-1.5 rounded-[18px] border border-line bg-surface p-1.5"
      >
        <label className="sr-only" htmlFor="call-type">
          Type what you want to say
        </label>
        <input
          id="call-type"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setTyping(false)}
          enterKeyHint="send"
          autoComplete="off"
          placeholder="Type it instead"
          className="h-11 min-w-0 flex-1 rounded-full bg-transparent px-3 text-[16px] text-fg outline-none placeholder:text-faint md:h-9 md:text-[14px]"
        />
        <button type="button" onClick={() => setTyping(false)} aria-label="Back to talking" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <button type="submit" disabled={!draft.trim()} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.97] disabled:opacity-40 md:min-h-9">
          Send
          <SendIcon size={14} />
        </button>
      </form>
    );
  const hint = v.muted ? "Muted. Unmute to talk, or type it." : v.phase === "listening" ? "Listening. It sends when you pause, or tap Send." : "";
  const caption = v.partial || hint;
  const sendButton = (
    <button
      type="button"
      onClick={v.onSend}
      disabled={!v.canSend}
      title={compact ? "Send what I heard now (Enter)" : "Send what I heard now"}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.97] disabled:opacity-35 md:min-h-9"
    >
      Send
      <SendIcon size={14} />
    </button>
  );
  if (compact)
    return (
      <div className="flex items-center gap-1 rounded-[16px] border border-line bg-surface-2/40 p-1 pl-3">
        <p aria-live="polite" className={`line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug ${v.partial ? "text-fg" : "text-faint"}`}>
          {caption}
        </p>
        <button type="button" onClick={() => setTyping(true)} aria-label="Type instead" title="Type instead" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <KeyboardIcon size={16} />
        </button>
        {sendButton}
      </div>
    );
  return (
    <div className="grid gap-1.5 rounded-[20px] border border-line bg-surface/80 p-2 pl-3.5 backdrop-blur">
      <p aria-live="polite" className={`line-clamp-3 min-h-[2.6em] pr-1 pt-1 text-[14.5px] leading-snug ${v.partial ? "text-fg" : "text-faint"}`}>
        {caption}
      </p>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setTyping(true)} className="inline-flex min-h-11 items-center gap-2 rounded-full px-1.5 text-[13px] text-muted transition-colors hover:text-fg">
          <KeyboardIcon size={17} />
          Type instead
        </button>
        {sendButton}
      </div>
    </div>
  );
}

/** The call's small menu: download the transcript so far */
function CallMenu({ callId, small = false }: { callId: string | null | undefined; small?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!callId) return null;
  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="More" aria-expanded={open} title="More" className={`grid place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg ${small ? "h-8 w-8" : "h-11 w-11"}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close the menu" onClick={() => setOpen(false)} className="fixed inset-0 z-10 cursor-default" />
          <span className="absolute right-0 top-full z-20 mt-1.5 grid min-w-[220px] rounded-[14px] border border-line bg-surface p-1 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.55)] animate-[sheet-fade_.15s_ease-out]">
            <TranscriptButton callId={callId} onDone={() => setOpen(false)} className="min-h-11 w-full rounded-[10px] px-3 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2 md:min-h-9" />
          </span>
        </>
      )}
    </span>
  );
}

/** The hidden debug overlay (?calldebug=1): what the call hears and decides, to diagnose a real call */
function DebugOverlay({ call }: { call: RefObject<Call | null> }) {
  const [d, setD] = useState<CallDebug | null>(null);
  useEffect(() => {
    const t = setInterval(() => setD(call.current?.debug() ?? null), 250);
    return () => clearInterval(t);
  }, [call]);
  if (!d) return null;
  const n = (x: number) => x.toFixed(4);
  return (
    <pre className="pointer-events-none fixed left-2 top-2 z-[99] rounded-[10px] bg-black/75 px-3 py-2 font-mono text-[11px] leading-snug text-white">
      {`phase ${d.phase}${d.muted ? " (muted)" : ""}  stall ${d.stall ?? "-"}
ears ${d.ears}
level ${n(d.level)}  noise ${n(d.noise)}  threshold ${n(d.threshold)}
in speech ${d.speaking ? "yes" : "no"}  heard ${d.heard} chars
commit ${d.commit ?? "-"}  asking ${d.asking ?? "-"}  queue ${d.queue}`}
    </pre>
  );
}

/** Whose line it is, when a specialist is (or was) on the call: captions show who's speaking */
const speakerOf = (l: Line, v: CallView) => (l.who === "agent" && l.speaker && ((v.team ?? []).length > 0 || l.speaker.role !== v.agent.roleKey) ? l.speaker.label : null);

/** The job, link cards and the upload panel, under the captions */
function CallExtras({ v, compact }: { v: CallView; compact: boolean }) {
  const cards = v.cards ?? [];
  const sc = v.screen;
  if (!cards.length && !v.uploadAsk && !sc?.asked && !sc?.sharing && !v.job) return null;
  return (
    <div className="grid gap-2.5">
      {v.job && <JobStrip job={v.job} />}
      {sc?.sharing && <SharingBar onStop={sc.onStop} looking={sc.looking} />}
      {sc?.asked && !sc.sharing && <ShareAsk agent={v.agent.roleKey === "assistant" ? "your assistant" : `the ${v.agent.label}`} onShare={sc.onShare} onCancel={sc.onCancel} />}
      {v.uploadAsk && v.onUpload && <UploadPanel ask={v.uploadAsk} busy={v.uploading ?? null} onFiles={v.onUpload} onClose={() => v.onCloseUpload?.()} />}
      {cards.length > 0 && v.onOpenCard && <CardsStrip cards={cards} compact={compact} onOpen={v.onOpenCard} onDismiss={(id) => v.onDismissCard?.(id)} />}
    </div>
  );
}

function LearnedChips({ learned, max = 3 }: { learned: LearnedItem[]; max?: number }) {
  if (learned.length === 0) return null;
  return (
    <>
      {learned.slice(-max).map((l, i) => (
        <span key={`${l.title}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-[12px] text-brand-text">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span className="truncate">
            Heard: {l.title}
          </span>
        </span>
      ))}
    </>
  );
}

// ─── Phones: the whole screen ───────────────────────────────────────────────

export function FullScreenCall({ v }: { v: CallView }) {
  // The live words are shown in the Send bar, under the captions
  const { agent, phase, lines, partial, muted, error, elapsed, left } = v;
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    captions.current?.scrollTo({ top: captions.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, partial]);
  return (
    <div role="dialog" aria-modal aria-label={`Call with the ${agent.label}`} className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]">
      <span aria-hidden className="pointer-events-none absolute left-1/2 top-[18%] h-80 w-80 -translate-x-1/2 rounded-full opacity-25 blur-3xl" style={{ background: agent.tint }} />
      <header className="relative flex items-center justify-between gap-3 px-5 pt-4">
        <span className="flex items-center gap-3">
          {v.onMinimize && (
            <button type="button" onClick={v.onMinimize} aria-label="Minimise the call" className="-ml-2 grid h-11 w-11 place-items-center rounded-full text-muted active:bg-surface-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          )}
          <span className="text-[11px] uppercase tracking-[0.16em] text-faint">{v.ears === "browser" ? "Call · browser listening" : "Call"}</span>
          <RecordedMark />
        </span>
        <span className="flex items-center gap-1">
        <CallMenu callId={v.callId} />
        <span className={`tabular rounded-full px-3 py-1 text-xs ${left < 120 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`} aria-label={`${clock(elapsed)} of ${clock(CALL_LIMIT_SECONDS)}`}>
          {clock(elapsed)} <span className="text-faint">/ {clock(CALL_LIMIT_SECONDS)}</span>
        </span>
        </span>
      </header>
      {v.debug && <DebugOverlay call={v.call} />}

      <div className="relative grid flex-none justify-items-center gap-4 px-5 pt-8 sm:pt-14">
        <div className="relative grid place-items-center">
          {phase === "speaking" && <span aria-hidden className="absolute inset-[-18px] animate-ping rounded-full opacity-20" style={{ background: agent.tint }} />}
          {phase === "listening" && !muted && <span aria-hidden className="absolute inset-[-12px] rounded-full border-2 border-brand/40" />}
          <div className="relative">{agent.icon(112)}</div>
        </div>
        <div className="text-center">
          <p className="font-heading text-[24px] leading-tight">{agent.roleKey === "assistant" ? "Your assistant" : `The ${agent.label}`}</p>
          <p aria-live="polite" className="mt-1 text-sm text-muted">
            {error ? <span className="text-bad">{error}</span> : status(v)}
          </p>
          {(v.team ?? []).length > 0 && (
            <div className="mt-2.5">
              <TeamChips team={v.team ?? []} center speaking={phase === "speaking" ? ([...lines].reverse().find((l) => l.who === "agent")?.speaker?.role ?? null) : null} />
            </div>
          )}
        </div>
        <Wave call={v.call} phase={phase} tint={agent.tint} />
      </div>

      <div ref={captions} className="relative mx-auto min-h-0 w-full max-w-xl flex-1 overflow-y-auto overscroll-contain px-5 py-4" aria-label="Live captions">
        <div className="grid gap-2.5">
          {lines.map((l) => (
            <p key={l.id} className={l.who === "you" ? "ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] bg-surface-2 px-3.5 py-2 text-[14.5px] leading-relaxed text-muted" : "max-w-[92%] text-[16px] leading-relaxed text-fg"}>
              {speakerOf(l, v) && <span className="mb-0.5 block text-[11px] uppercase tracking-[0.14em] text-faint">{speakerOf(l, v)}</span>}
              {l.text}
            </p>
          ))}
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-xl px-5 empty:hidden">
        <CallExtras v={v} compact={false} />
      </div>

      {v.learned.length > 0 && (
        <div className="relative mx-auto flex w-full max-w-xl flex-wrap gap-1.5 px-5 pb-2">
          <LearnedChips learned={v.learned} />
        </div>
      )}

      <div className="relative mx-auto w-full max-w-xl px-5 pb-1">
        <SendBar v={v} compact={false} />
      </div>

      <footer className="relative flex items-center justify-center gap-10 px-5 pb-6 pt-3">
        <button
          type="button"
          onClick={v.onMute}
          aria-pressed={muted}
          aria-label={muted ? "Unmute" : "Mute"}
          className={`grid h-16 w-16 place-items-center rounded-full border transition active:scale-95 ${muted ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg hover:border-faint"}`}
        >
          <MicIcon off={muted} />
        </button>
        <button type="button" onClick={v.onHangUp} aria-label="End call" className="grid h-[72px] w-[72px] place-items-center rounded-full bg-bad text-white shadow-lg transition hover:opacity-90 active:scale-95">
          <span className="rotate-[135deg]">
            <PhoneIcon size={28} />
          </span>
        </button>
      </footer>
    </div>
  );
}

// ─── Computers: the huddle ──────────────────────────────────────────────────

/** Docked bottom right, above the feedback bubble (which moves up with --fab-clear, so this does too) */
// Above the page's sheets and drawers (z-50 to z-70), so a sheet the call opened never covers the huddle and its cards;
// under the full screen call and the call's own dialogs
const DOCK = "fixed bottom-[calc(84px+var(--fab-clear,0px))] right-6 z-[75]";

export function Huddle({ v, minimized, onMinimize, onExpand }: { v: CallView; minimized: boolean; onMinimize: () => void; onExpand: () => void }) {
  const { agent, phase, muted, error, elapsed, left } = v;
  const [full, setFull] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (full) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [full, v.lines.length, v.partial]);

  const muteButton = (small: boolean) => (
    <button
      type="button"
      onClick={v.onMute}
      aria-pressed={muted}
      aria-label={muted ? "Unmute (Space)" : "Mute (Space)"}
      title={muted ? "Unmute (Space)" : "Mute (Space)"}
      className={`grid place-items-center rounded-full border transition active:scale-95 ${small ? "h-8 w-8" : "h-11 w-11"} ${muted ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg hover:border-faint"}`}
    >
      <MicIcon size={small ? 15 : 19} off={muted} />
    </button>
  );
  const leaveButton = (small: boolean) => (
    <button
      type="button"
      onClick={v.onHangUp}
      aria-label="Leave the huddle"
      title="Leave"
      className={`grid place-items-center rounded-full bg-bad text-white transition hover:opacity-90 active:scale-95 ${small ? "h-8 w-8" : "h-11 w-11"}`}
    >
      <span className="rotate-[135deg]">
        <PhoneIcon size={small ? 15 : 19} />
      </span>
    </button>
  );

  if (minimized)
    return (
      <div role="region" aria-label={`Huddle with the ${agent.label}`} className={`${DOCK} flex items-center gap-2 rounded-full border border-line bg-surface/95 py-1.5 pl-1.5 pr-2 shadow-[0_14px_36px_-14px_rgba(0,0,0,0.6)] backdrop-blur animate-[sheet-up_.22s_cubic-bezier(.2,.8,.2,1)]`}>
        <button type="button" onClick={onExpand} aria-label="Open the huddle" title="Open the huddle" className="flex items-center gap-2.5 rounded-full pr-1 transition-opacity hover:opacity-85">
          <span className="relative grid place-items-center">
            {phase === "speaking" && <span aria-hidden className="absolute inset-[-3px] animate-ping rounded-[14px] opacity-25" style={{ background: agent.tint }} />}
            <span className="relative">{agent.icon(32)}</span>
          </span>
          <span className={`tabular text-xs ${left < 120 ? "text-warn" : "text-muted"}`}>{clock(elapsed)}</span>
          <Wave call={v.call} phase={phase} tint={agent.tint} className="h-6 w-14" bars={14} />
        </button>
        {muteButton(true)}
        {leaveButton(true)}
      </div>
    );

  const lastYou = [...v.lines].reverse().find((l) => l.who === "you");
  const lastAgent = [...v.lines].reverse().find((l) => l.who === "agent");
  return (
    <div role="region" aria-label={`Huddle with the ${agent.label}`} className={`${DOCK} w-[360px] max-w-[calc(100vw-48px)] overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)]`}>
      <span aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-32 w-48 -translate-x-1/2 rounded-full opacity-20 blur-3xl" style={{ background: agent.tint }} />
      <div className="relative flex items-center gap-3 px-4 pb-2 pt-3.5">
        <div className="relative grid place-items-center">
          {phase === "speaking" && <span aria-hidden className="absolute inset-[-4px] animate-ping rounded-[16px] opacity-20" style={{ background: agent.tint }} />}
          {phase === "listening" && !muted && <span aria-hidden className="absolute inset-[-3px] rounded-[16px] border-2 border-brand/40" />}
          <div className="relative">{agent.icon(40)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-[16px] leading-tight">{agent.roleKey === "assistant" ? "Your assistant" : `The ${agent.label}`}</p>
          <p aria-live="polite" className="truncate text-[12.5px] text-muted">
            {error ? <span className="text-bad">{error}</span> : status(v)}
            <span className="text-faint">{v.ears === "browser" ? " · browser listening" : ""}</span>
          </p>
        </div>
        <span className={`tabular rounded-full px-2.5 py-1 text-xs ${left < 120 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`} aria-label={`${clock(elapsed)} of ${clock(CALL_LIMIT_SECONDS)}`}>
          {clock(elapsed)}
        </span>
        <CallMenu callId={v.callId} small />
        <button type="button" onClick={onMinimize} aria-label="Minimise the huddle (Esc)" title="Minimise (Esc)" className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="relative px-4">
        <Wave call={v.call} phase={phase} tint={agent.tint} className="h-10 w-full" bars={56} />
      </div>

      <div className="relative px-4 pb-1 pt-2">
        {full ? (
          <div ref={scroller} className="grid max-h-64 gap-2 overflow-y-auto overscroll-contain pr-1" aria-label="Transcript">
            {v.lines.length === 0 && <p className="text-[13px] text-faint">Nothing said yet.</p>}
            {v.lines.map((l) => (
              <p key={l.id} className={l.who === "you" ? "ml-auto max-w-[88%] rounded-[14px] rounded-br-[5px] bg-surface-2 px-3 py-1.5 text-[13px] leading-snug text-muted" : "max-w-[94%] text-[13.5px] leading-snug text-fg"}>
                {speakerOf(l, v) && <span className="block text-[10.5px] uppercase tracking-[0.14em] text-faint">{speakerOf(l, v)}</span>}
                {l.text}
              </p>
            ))}
          </div>
        ) : (
          <div className="grid min-h-[44px] gap-1.5" aria-label="Latest captions">
            {lastAgent && (
              <p className="line-clamp-3 text-[13.5px] leading-snug text-fg">
                {speakerOf(lastAgent, v) && <span className="mr-1.5 text-[10.5px] uppercase tracking-[0.14em] text-faint">{speakerOf(lastAgent, v)}</span>}
                {lastAgent.text}
              </p>
            )}
            {lastYou && (!lastAgent || lastYou.id > lastAgent.id) && <p className="line-clamp-2 text-[13px] leading-snug text-muted">{lastYou.text}</p>}
            {!lastAgent && !lastYou && <p className="text-[13px] text-faint">{phase === "connecting" ? "Calling…" : "Say something, it's listening."}</p>}
          </div>
        )}
        {v.lines.length > 0 && (
          <button type="button" onClick={() => setFull((x) => !x)} aria-expanded={full} className="mt-1.5 text-[12px] text-faint transition-colors hover:text-fg">
            {full ? "Hide the transcript" : "Show the transcript"}
          </button>
        )}
      </div>

      {((v.team ?? []).length > 0 || v.job || (v.cards ?? []).length > 0 || v.uploadAsk || v.screen?.asked || v.screen?.sharing) && (
        <div className="relative grid max-h-[46vh] gap-2 overflow-y-auto px-4 pb-1 pt-2">
          <TeamChips team={v.team ?? []} speaking={phase === "speaking" ? (lastAgent?.speaker?.role ?? null) : null} />
          <CallExtras v={v} compact />
        </div>
      )}

      {v.learned.length > 0 && (
        <div className="relative flex flex-wrap gap-1.5 px-4 pb-1 pt-1.5">
          <LearnedChips learned={v.learned} />
        </div>
      )}

      <div className="relative px-4 pb-2.5 pt-1.5">
        <SendBar v={v} compact />
      </div>
      {v.debug && <DebugOverlay call={v.call} />}

      <div className="relative flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="grid gap-1 text-[11px] leading-tight text-faint">
          <RecordedMark />
          <span>Space mutes · Enter sends · Esc minimises</span>
        </span>
        <span className="flex items-center gap-2.5">
          {v.screen?.can && (
            <button
              type="button"
              onClick={v.screen.sharing ? v.screen.onStop : v.screen.onShare}
              aria-pressed={v.screen.sharing}
              aria-label={v.screen.sharing ? "Stop sharing your screen" : "Share your screen"}
              title={v.screen.sharing ? "Stop sharing" : "Share your screen so it can take a look"}
              className={`grid h-11 w-11 place-items-center rounded-full border transition active:scale-95 ${v.screen.sharing ? "border-bad/40 bg-bad/10 text-bad" : "border-line bg-surface text-fg hover:border-faint"}`}
            >
              <ScreenIcon size={18} />
            </button>
          )}
          {muteButton(false)}
          {leaveButton(false)}
        </span>
      </div>
    </div>
  );
}

// ─── What I heard: keep or toss ─────────────────────────────────────────────

/** Where a learning would go, in plain words */
function whereTo(item: LearnedItem, skills: Record<string, string>): string {
  const skill = skills[item.skill] ?? item.skill;
  if (item.type === "note") return `A note in my ${skill} skill`;
  return item.skill === "core" ? "A change to my core, sent to my chat as an edit" : `A change to my ${skill} instructions, sent to my chat as an edit`;
}

type Choice = { keep: boolean | null; title: string; body: string };

/** One thing heard on the call: where it would go, the exact text that would be applied (editable), Keep or Toss */
function HeardItem({ item, skills, choice, onChange, disabled }: { item: LearnedItem; skills: Record<string, string>; choice: Choice; onChange: (c: Choice) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const tossed = choice.keep === false;
  return (
    <li className={`grid gap-2.5 rounded-[16px] border p-3.5 transition-colors ${choice.keep === true ? "border-ok/50 bg-ok-soft/40" : tossed ? "border-line bg-surface-2/50" : "border-line bg-surface"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[14.5px] font-medium leading-snug [overflow-wrap:anywhere] ${tossed ? "text-faint line-through" : ""}`}>{choice.title}</p>
          <p className="mt-0.5 text-[11.5px] text-faint">{whereTo(item, skills)}</p>
        </div>
        {!editing && !tossed && (
          <button type="button" onClick={() => setEditing(true)} disabled={disabled} className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-[12.5px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-8">
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="grid gap-2">
          <label className="sr-only" htmlFor={`t-${keyOf(item)}`}>
            Title
          </label>
          <input id={`t-${keyOf(item)}`} value={choice.title} onChange={(e) => onChange({ ...choice, title: e.target.value })} className={`${field} h-11 md:h-9`} />
          <label className="sr-only" htmlFor={`b-${keyOf(item)}`}>
            What will be applied
          </label>
          <textarea id={`b-${keyOf(item)}`} value={choice.body} onChange={(e) => onChange({ ...choice, body: e.target.value })} rows={4} className={`${field} h-auto py-2.5 text-[13.5px] font-normal leading-relaxed`} />
          <button type="button" onClick={() => setEditing(false)} className="min-h-11 justify-self-start text-[12.5px] text-muted hover:text-fg md:min-h-0">
            Done editing
          </button>
        </div>
      ) : (
        <p className={`text-[13px] leading-relaxed ${tossed ? "text-faint" : "text-muted"}`}>{choice.body}</p>
      )}
      <div role="radiogroup" aria-label={`Keep or toss: ${choice.title}`} className="grid grid-cols-2 gap-2">
        {([true, false] as const).map((k) => {
          const on = choice.keep === k;
          return (
            <button
              key={String(k)}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange({ ...choice, keep: k })}
              className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border text-[13.5px] font-medium transition active:scale-[0.98] md:min-h-9 ${
                on ? (k ? "border-ok bg-ok text-white" : "border-fg bg-fg text-bg") : "border-line text-muted hover:border-faint hover:text-fg"
              }`}
            >
              {k ? "Keep" : "Toss"}
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** A decided item after the review: a kept note can be undone (Put back turns it on again) */
function KeptItem({ item, callId, skills, onChange }: { item: LearnedItem; callId: string; skills: Record<string, string>; onChange: (undone: boolean) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = () =>
    start(async () => {
      if (!item.id) return;
      setError(null);
      const r = await undoLearning(callId, item.id, !item.undone);
      if (r.ok) onChange(!item.undone);
      else setError(r.error);
    });
  const tossed = statusOf(item) === "tossed";
  return (
    <li className={`grid gap-1 rounded-[14px] border border-line p-3.5 ${tossed || item.undone ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[14px] font-medium leading-snug ${tossed || item.undone ? "line-through" : ""}`}>{item.title}</p>
          <p className="mt-0.5 text-[11.5px] text-faint">{tossed ? "Tossed" : item.undone ? "Undone" : item.type === "note" ? `Saved to my ${skills[item.skill] ?? item.skill} skill` : "Sent to my chat as an edit to apply"}</p>
        </div>
        {!tossed && item.type === "note" && item.id && (
          <button type="button" onClick={toggle} disabled={pending} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-8">
            {item.undone ? "Put back" : "Undo"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

/**
 * The review of what a call heard: each pending item with where it would go and the exact text that would be applied
 * (editable), Keep or Toss, Keep all or Toss all, then Apply. Only kept items are written. Decide later leaves them
 * pending (they wait on the Overview and the agent's page). Used at hang-up and from the Overview or the agent's page.
 */
export function ReviewBody({ agent, callId, items, skills, heading, sub, onDone, onApplied, transcript = false }: { agent: AgentRef; callId: string | null; items: LearnedItem[] | null; skills: Record<string, string>; heading: string; sub: string; onDone: () => void; onApplied?: () => void; transcript?: boolean }) {
  const pendingNow = (items ?? []).filter((l) => statusOf(l) === "pending");
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [result, setResult] = useState<{ learned: LearnedItem[]; kept: number; tossed: number; proposals: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const choiceOf = (l: LearnedItem): Choice => choices[keyOf(l)] ?? { keep: null, title: l.title, body: l.body };
  const set = (l: LearnedItem, c: Choice) => setChoices((cur) => ({ ...cur, [keyOf(l)]: c }));
  const all = (keep: boolean) => setChoices(Object.fromEntries(pendingNow.map((l) => [keyOf(l), { ...choiceOf(l), keep }])));
  const decided = pendingNow.filter((l) => choiceOf(l).keep !== null);
  const kept = decided.filter((l) => choiceOf(l).keep).length;
  const apply = () =>
    start(async () => {
      if (!callId) return;
      setError(null);
      const decisions = Object.fromEntries(
        pendingNow.map((l) => {
          const c = choiceOf(l);
          return [keyOf(l), { keep: Boolean(c.keep), ...(c.keep ? { title: c.title, body: c.body } : {}) }];
        }),
      );
      const r = await reviewCallLearnings(callId, decisions);
      if (!r.ok) return setError(r.error);
      setResult({ learned: r.learned, kept: r.kept, tossed: r.tossed, proposals: r.proposals });
      onApplied?.();
    });
  const proposalsLine = (n: number) => `${n === 1 ? "One change" : `${n} changes`} to my core or a skill's instructions ${n === 1 ? "is" : "are"} on the way to my chat as ${n === 1 ? "an edit" : "edits"} for you to apply.`;

  return (
    <>
      <div className="flex items-center gap-4 border-b border-line px-5 py-5">
        <div className="shrink-0">{agent.icon(48)}</div>
        <div className="min-w-0">
          <p className="font-heading text-[20px] leading-tight">{result ? "Applied" : heading}</p>
          <p className="mt-0.5 text-sm text-muted">{sub}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {items === null ? (
          <p className="text-sm text-muted">Saving the call…</p>
        ) : result ? (
          <div className="grid gap-3">
            <p className="text-sm leading-relaxed text-muted">
              {result.kept ? `Kept ${result.kept}` : "Kept nothing"}
              {result.tossed ? `, tossed ${result.tossed}` : ""}. {result.proposals ? proposalsLine(result.proposals) : ""}
            </p>
            <ul className="grid gap-2.5">
              {result.learned
                .filter((l) => pendingNow.some((p) => keyOf(p) === keyOf(l)))
                .map((l, i) => (
                  <KeptItem key={`${keyOf(l)}-${i}`} item={l} callId={callId ?? ""} skills={skills} onChange={(u) => setResult((cur) => (cur ? { ...cur, learned: cur.learned.map((x) => (keyOf(x) === keyOf(l) ? { ...x, undone: u } : x)) } : cur))} />
                ))}
            </ul>
          </div>
        ) : pendingNow.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted">Nothing to keep this time. The whole call is in my chat, so you can read it back any time.</p>
        ) : (
          <div className="grid gap-3">
            <p className="text-[13px] leading-relaxed text-muted">Nothing here changes what I know until you keep it. Edit the wording if it isn&apos;t quite right.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => all(true)} disabled={busy} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-8">
                Keep all
              </button>
              <button type="button" onClick={() => all(false)} disabled={busy} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-8">
                Toss all
              </button>
              <span className="tabular ml-auto text-[12px] text-faint">
                {decided.length} of {pendingNow.length} decided
              </span>
            </div>
            <ul className="grid gap-3">
              {pendingNow.map((l) => (
                <HeardItem key={keyOf(l)} item={l} skills={skills} choice={choiceOf(l)} onChange={(c) => set(l, c)} disabled={busy} />
              ))}
            </ul>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      </div>
      <div className="grid gap-2 border-t border-line px-5 py-4">
        {transcript && callId && <TranscriptButton callId={callId} className={TRANSCRIPT_LINK} />}
        {!result && pendingNow.length > 0 && callId ? (
          <>
            <button
              type="button"
              onClick={apply}
              disabled={busy || decided.length < pendingNow.length}
              className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50 md:min-h-10"
            >
              {busy ? "Applying…" : decided.length < pendingNow.length ? "Keep or toss each one" : kept ? `Apply: keep ${kept}${pendingNow.length - kept ? `, toss ${pendingNow.length - kept}` : ""}` : "Apply: toss all"}
            </button>
            <button type="button" onClick={onDone} disabled={busy} className="min-h-11 w-full rounded-full text-[13.5px] text-muted transition-colors hover:text-fg md:min-h-9">
              Decide later
            </button>
          </>
        ) : (
          <button type="button" onClick={onDone} className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
            Done
          </button>
        )}
      </div>
    </>
  );
}

const TRANSCRIPT_LINK = "min-h-11 w-full justify-center rounded-full border border-line text-[13.5px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9";

/** After a call: the review (for those who train the agent) or a short wrap-up */
function SummaryBody({ s }: { s: SummaryView }) {
  const sub = s.summary ? `Call with the ${s.agent.label} · ${clock(s.summary.seconds)}` : "Hanging up…";
  if (s.summary && !s.summary.canReview && s.notes !== undefined)
    return (
      <>
        <div className="flex items-center gap-4 border-b border-line px-5 py-5">
          <div className="shrink-0">{s.agent.icon(48)}</div>
          <div className="min-w-0">
            <p className="font-heading text-[20px] leading-tight">Talk soon</p>
            <p className="mt-0.5 text-sm text-muted">{sub}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <NotesBlock notes={s.notes} />
          <p className="mt-4 text-[12.5px] leading-relaxed text-faint">Your calls and what I remember about you are on your assistant&apos;s page.</p>
        </div>
        <div className="grid gap-2 border-t border-line px-5 py-4">
          {s.callId && <TranscriptButton callId={s.callId} className={TRANSCRIPT_LINK} />}
          <a href="/assistant" className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-line text-[13.5px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            Open my assistant
          </a>
          <button type="button" onClick={s.onDone} className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
            Done
          </button>
        </div>
      </>
    );
  if (s.summary && !s.summary.canReview)
    return (
      <>
        <div className="flex items-center gap-4 border-b border-line px-5 py-5">
          <div className="shrink-0">{s.agent.icon(48)}</div>
          <div className="min-w-0">
            <p className="font-heading text-[20px] leading-tight">Call ended</p>
            <p className="mt-0.5 text-sm text-muted">{sub}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-muted">The whole call is in my chat, so you can read it back any time. Anything you asked me to remind you of or pass on is on the Overview.</p>
        </div>
        <div className="grid gap-2 border-t border-line px-5 py-4">
          {s.callId && <TranscriptButton callId={s.callId} className={TRANSCRIPT_LINK} />}
          <button type="button" onClick={s.onDone} className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
            Done
          </button>
        </div>
      </>
    );
  return <ReviewBody agent={s.agent} callId={s.callId} items={s.summary ? s.learned : null} skills={s.summary?.skills ?? {}} heading="What I heard" sub={sub} onDone={s.onDone} transcript />;
}

/** Phones: the whole screen */
export function FullScreenSummary({ s }: { s: SummaryView }) {
  return (
    <div role="dialog" aria-modal aria-label="What I heard" className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]">
      <SummaryBody s={s} />
    </div>
  );
}

/** Computers: a small sheet where the huddle was */
export function HuddleSummary({ s }: { s: SummaryView }) {
  return (
    <div role="dialog" aria-label="What I heard" className={`${DOCK} flex max-h-[min(78vh,640px)] w-[400px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)]`}>
      <SummaryBody s={s} />
    </div>
  );
}

/**
 * The same review opened later (from the Overview or the agent's page): the whole screen on phones, a centred sheet on
 * computers. Esc or the backdrop closes it (the items stay pending).
 */
export function ReviewSheet({ agent, callId, items, skills, day, onClose, onApplied }: { agent: AgentRef; callId: string; items: LearnedItem[]; skills: Record<string, string>; day: string; onClose: () => void; onApplied?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = was;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[85] flex items-stretch justify-center md:items-center md:p-6" role="dialog" aria-modal aria-label={`What you taught the ${agent.label}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 hidden bg-black/50 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out] md:block" />
      <div className="relative flex w-full flex-col overflow-hidden bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)] md:max-h-[min(86vh,760px)] md:max-w-lg md:rounded-[22px] md:border md:border-line md:bg-surface md:pt-0 md:pb-0 md:shadow-2xl">
        <ReviewBody agent={agent} callId={callId} items={items} skills={skills} heading="What you taught me" sub={`From our call ${day}`} onDone={onClose} onApplied={onApplied} />
      </div>
    </div>
  );
}

// ─── Starting another call while one is open ────────────────────────────────

export function SwitchAsk({ current, next, onStay, onLeave }: { current: string; next: string; onStay: () => void; onLeave: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center p-4" role="dialog" aria-modal aria-label="Leave the current call?">
      <button type="button" aria-label="Stay on the call" onClick={onStay} className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative w-full max-w-sm rounded-[20px] border border-line bg-surface p-5 shadow-2xl animate-[sheet-up_.24s_cubic-bezier(.2,.8,.2,1)]">
        <p className="font-heading text-[18px] leading-tight">Leave your call?</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          You&apos;re on a call with the {current}. Leave it to start one with the {next}? Anything it heard waits for you on the Overview.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onStay} className="min-h-11 rounded-full border border-line px-5 text-[14px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-10">
            Stay on the call
          </button>
          <button type="button" onClick={onLeave} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
            Leave and call the {next}
          </button>
        </div>
      </div>
    </div>
  );
}
