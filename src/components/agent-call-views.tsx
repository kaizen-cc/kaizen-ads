"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import { undoLearning } from "@/app/(team)/settings/call-actions";
import { CALL_LIMIT_SECONDS, clock, type LearnedItem } from "@/lib/agent-call/core";
import type { Call, Line, Phase } from "@/lib/agent-call/engine";

// The two ways a call is shown. On phones it takes the whole screen; on computers it is a huddle: a small panel
// docked bottom right that stays while you move around the app, and shrinks to a pill. Both read the same state,
// which the call provider owns (so the call itself never lives in a screen).

export type AgentRef = {
  roleKey: string;
  label: string;
  tint: string;
  /** The agent's icon at a given size */
  icon: (size: number) => ReactNode;
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
  onMute: () => void;
  onHangUp: () => void;
};

export type SummaryView = {
  agent: AgentRef;
  summary: { seconds: number; proposals: number } | null;
  learned: LearnedItem[];
  callId: string | null;
  onUndo: (index: number, undone: boolean) => void;
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

const status = (v: Pick<CallView, "muted" | "phase">) => (v.muted ? "Muted" : PHASE_LABEL[v.phase]);

function LearnedChips({ learned, max = 3 }: { learned: LearnedItem[]; max?: number }) {
  if (learned.length === 0) return null;
  return (
    <>
      {learned.slice(-max).map((l, i) => (
        <span key={`${l.title}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-ok-soft px-3 py-1 text-[12px] text-ok">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span className="truncate">
            {l.type === "note" ? "Learned" : "Edit to propose"}: {l.title}
          </span>
        </span>
      ))}
    </>
  );
}

// ─── Phones: the whole screen ───────────────────────────────────────────────

export function FullScreenCall({ v }: { v: CallView }) {
  const { agent, phase, lines, partial, muted, error, elapsed, left } = v;
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    captions.current?.scrollTo({ top: captions.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, partial]);
  return (
    <div role="dialog" aria-modal aria-label={`Call with the ${agent.label}`} className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]">
      <span aria-hidden className="pointer-events-none absolute left-1/2 top-[18%] h-80 w-80 -translate-x-1/2 rounded-full opacity-25 blur-3xl" style={{ background: agent.tint }} />
      <header className="relative flex items-center justify-between gap-3 px-5 pt-4">
        <span className="text-[11px] uppercase tracking-[0.16em] text-faint">{v.ears === "browser" ? "Call · browser listening" : "Call"}</span>
        <span className={`tabular rounded-full px-3 py-1 text-xs ${left < 120 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`} aria-label={`${clock(elapsed)} of ${clock(CALL_LIMIT_SECONDS)}`}>
          {clock(elapsed)} <span className="text-faint">/ {clock(CALL_LIMIT_SECONDS)}</span>
        </span>
      </header>

      <div className="relative grid flex-none justify-items-center gap-4 px-5 pt-8 sm:pt-14">
        <div className="relative grid place-items-center">
          {phase === "speaking" && <span aria-hidden className="absolute inset-[-18px] animate-ping rounded-full opacity-20" style={{ background: agent.tint }} />}
          {phase === "listening" && !muted && <span aria-hidden className="absolute inset-[-12px] rounded-full border-2 border-brand/40" />}
          <div className="relative">{agent.icon(112)}</div>
        </div>
        <div className="text-center">
          <p className="font-heading text-[24px] leading-tight">The {agent.label}</p>
          <p aria-live="polite" className="mt-1 text-sm text-muted">
            {error ? <span className="text-bad">{error}</span> : status(v)}
          </p>
        </div>
        <Wave call={v.call} phase={phase} tint={agent.tint} />
      </div>

      <div ref={captions} className="relative mx-auto min-h-0 w-full max-w-xl flex-1 overflow-y-auto overscroll-contain px-5 py-4" aria-label="Live captions">
        <div className="grid gap-2.5">
          {lines.map((l) => (
            <p key={l.id} className={l.who === "you" ? "ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] bg-surface-2 px-3.5 py-2 text-[14.5px] leading-relaxed text-muted" : "max-w-[92%] text-[16px] leading-relaxed text-fg"}>
              {l.text}
            </p>
          ))}
          {partial && <p className="ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] border border-dashed border-line px-3.5 py-2 text-[14.5px] leading-relaxed text-faint">{partial}</p>}
        </div>
      </div>

      {v.learned.length > 0 && (
        <div className="relative mx-auto flex w-full max-w-xl flex-wrap gap-1.5 px-5 pb-2">
          <LearnedChips learned={v.learned} />
        </div>
      )}

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
const DOCK = "fixed bottom-[calc(84px+var(--fab-clear,0px))] right-6 z-[45]";

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
          <p className="truncate font-heading text-[16px] leading-tight">The {agent.label}</p>
          <p aria-live="polite" className="truncate text-[12.5px] text-muted">
            {error ? <span className="text-bad">{error}</span> : status(v)}
            <span className="text-faint">{v.ears === "browser" ? " · browser listening" : ""}</span>
          </p>
        </div>
        <span className={`tabular rounded-full px-2.5 py-1 text-xs ${left < 120 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`} aria-label={`${clock(elapsed)} of ${clock(CALL_LIMIT_SECONDS)}`}>
          {clock(elapsed)}
        </span>
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
            {v.lines.length === 0 && !v.partial && <p className="text-[13px] text-faint">Nothing said yet.</p>}
            {v.lines.map((l) => (
              <p key={l.id} className={l.who === "you" ? "ml-auto max-w-[88%] rounded-[14px] rounded-br-[5px] bg-surface-2 px-3 py-1.5 text-[13px] leading-snug text-muted" : "max-w-[94%] text-[13.5px] leading-snug text-fg"}>
                {l.text}
              </p>
            ))}
            {v.partial && <p className="ml-auto max-w-[88%] rounded-[14px] rounded-br-[5px] border border-dashed border-line px-3 py-1.5 text-[13px] leading-snug text-faint">{v.partial}</p>}
          </div>
        ) : (
          <div className="grid min-h-[44px] gap-1.5" aria-label="Latest captions">
            {lastAgent && <p className="line-clamp-3 text-[13.5px] leading-snug text-fg">{lastAgent.text}</p>}
            {v.partial ? <p className="line-clamp-2 text-[13px] leading-snug text-faint">{v.partial}</p> : lastYou && (!lastAgent || lastYou.id > lastAgent.id) && <p className="line-clamp-2 text-[13px] leading-snug text-muted">{lastYou.text}</p>}
            {!lastAgent && !v.partial && !lastYou && <p className="text-[13px] text-faint">{phase === "connecting" ? "Calling…" : "Say something, it's listening."}</p>}
          </div>
        )}
        {v.lines.length > 0 && (
          <button type="button" onClick={() => setFull((x) => !x)} aria-expanded={full} className="mt-1.5 text-[12px] text-faint transition-colors hover:text-fg">
            {full ? "Hide the transcript" : "Show the transcript"}
          </button>
        )}
      </div>

      {v.learned.length > 0 && (
        <div className="relative flex flex-wrap gap-1.5 px-4 pb-1 pt-1.5">
          <LearnedChips learned={v.learned} />
        </div>
      )}

      <div className="relative flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="text-[11px] leading-tight text-faint">
          Space mutes
          <br />
          Esc minimises
        </span>
        <span className="flex items-center gap-2.5">
          {muteButton(false)}
          {leaveButton(false)}
        </span>
      </div>
    </div>
  );
}

// ─── What I learned ─────────────────────────────────────────────────────────

function Learned({ item, callId, onChange }: { item: LearnedItem; callId: string | null; onChange: (undone: boolean) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = () =>
    start(async () => {
      if (!callId || !item.id) return;
      setError(null);
      const r = await undoLearning(callId, item.id, !item.undone);
      if (r.ok) onChange(!item.undone);
      else setError(r.error);
    });
  return (
    <li className={`grid gap-1.5 rounded-[14px] border border-line p-3.5 transition-opacity ${item.undone ? "opacity-55" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[14.5px] font-medium leading-snug ${item.undone ? "line-through" : ""}`}>{item.title}</p>
          <p className="mt-0.5 text-[11px] text-faint">{item.type === "note" ? (item.undone ? "Undone" : `Saved to ${item.skill}`) : item.skill === "core" ? "Proposed for my core" : `Proposed for ${item.skill}`}</p>
        </div>
        {item.type === "note" && item.id && (
          <button type="button" onClick={toggle} disabled={pending} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-8">
            {item.undone ? "Put back" : "Undo"}
          </button>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-muted">{item.body}</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

function SummaryBody({ s }: { s: SummaryView }) {
  const { summary, learned } = s;
  return (
    <>
      <div className="flex items-center gap-4 border-b border-line px-5 py-5">
        <div className="shrink-0">{s.agent.icon(48)}</div>
        <div className="min-w-0">
          <p className="font-heading text-[20px] leading-tight">What I learned</p>
          <p className="mt-0.5 text-sm text-muted">{summary ? `Call with the ${s.agent.label} · ${clock(summary.seconds)}` : "Hanging up…"}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!summary ? (
          <p className="text-sm text-muted">Saving the call…</p>
        ) : learned.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted">Nothing new this time. The whole call is in my chat, so you can read it back any time.</p>
        ) : (
          <ul className="grid gap-3">
            {learned.map((l, i) => (
              <Learned key={`${l.id ?? l.title}-${i}`} item={l} callId={s.callId} onChange={(u) => s.onUndo(i, u)} />
            ))}
          </ul>
        )}
        {summary && summary.proposals > 0 && (
          <p className="mt-4 rounded-[12px] bg-brand-soft px-3.5 py-3 text-[13px] leading-relaxed text-brand-text">
            {summary.proposals === 1 ? "One change" : `${summary.proposals} changes`} to my core or a skill&apos;s instructions {summary.proposals === 1 ? "is" : "are"} on the way to my chat as {summary.proposals === 1 ? "an edit" : "edits"} for you to apply.
          </p>
        )}
      </div>
      <div className="border-t border-line px-5 py-4">
        <button type="button" onClick={s.onDone} className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
          Done
        </button>
      </div>
    </>
  );
}

/** Phones: the whole screen */
export function FullScreenSummary({ s }: { s: SummaryView }) {
  return (
    <div role="dialog" aria-modal aria-label="What I learned" className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]">
      <SummaryBody s={s} />
    </div>
  );
}

/** Computers: a small sheet where the huddle was */
export function HuddleSummary({ s }: { s: SummaryView }) {
  return (
    <div role="dialog" aria-label="What I learned" className={`${DOCK} flex max-h-[min(70vh,560px)] w-[380px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)]`}>
      <SummaryBody s={s} />
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
          You&apos;re on a call with the {current}. Leave it to start one with the {next}? What the {current} learned is kept.
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
