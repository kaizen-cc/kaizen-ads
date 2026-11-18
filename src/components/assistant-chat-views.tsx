"use client";

import { assistantTitle } from "@/lib/agent-look";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { CallCard, LearnedItem, UploadAsk } from "@/lib/agent-call/core";
import type { ChatLine } from "@/lib/agent-call/chat-engine";
import type { Speaker } from "@/lib/agent-call/engine";
import { tintOf } from "@/lib/agent-look";
import type { JobView } from "@/lib/assistant/team";
import { useCallDock } from "@/lib/use-call-dock";
import { useDictation } from "@/lib/use-dictation";
import { AgentGlyph, CardsStrip, JobStrip, RecordedMark, ShareAsk, SharingBar, TeamChips, TranscriptButton, UploadPanel } from "./assistant-call-parts";
import type { AgentRef } from "./agent-call-views";

// The chat with the assistant: the same conversation and the same window as the call's huddle (dragged anywhere,
// collapsed to a pill, kept while moving around the app), typed instead of spoken. Answers stream in as they're
// written, with light formatting and clickable links; specialists who join show as their own speaker in their color;
// cards, drafts, uploads, the job strip, a look at the screen and screens it opens work as on a call. A mic dictates
// into the input; "Call" carries the same conversation on as a voice call. Phones get it full screen (or the pill).

export type ChatView = {
  agent: AgentRef;
  lines: ChatLine[];
  /** The last few lines of the conversation before this one (shown dimmed above it) */
  earlier: ChatLine[];
  busy: boolean;
  /** Opening, or moving over from a call */
  connecting: boolean;
  error: string | null;
  learned: LearnedItem[];
  team: Speaker[];
  job: JobView | null;
  cards: CallCard[];
  uploadAsk: UploadAsk | null;
  uploading: string | null;
  callId: string | null;
  screen: { can: boolean; sharing: boolean; asked: boolean; looking: boolean; onShare: () => void; onStop: () => void; onCancel: () => void };
  onSend: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
  onCall: () => void;
  onLink: (href: string) => void;
  onOpenCard: (c: CallCard) => void;
  onDismissCard: (id: string) => void;
  onUpload: (files: File[]) => void;
  onCloseUpload: () => void;
};

// ─── Light formatting: paragraphs, "- " lists, **bold**, [links](…) ─────────

/** An address safe to open: an app path, or a web page */
const safeHref = (h: string): { href: string; app: boolean } | null => {
  const t = h.trim();
  if (t.startsWith("/") && !t.startsWith("//")) return { href: t, app: true };
  if (/^https?:\/\/[^\s]+$/i.test(t)) return { href: t, app: false };
  return null;
};

function inline(text: string, onLink: (href: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<strong key={k} className="font-semibold text-fg">{m[1]}</strong>);
    else {
      const label = m[2] ?? m[4];
      const link = safeHref(m[3] ?? m[4]);
      if (!link) out.push(label);
      else if (link.app)
        out.push(
          <button key={k} type="button" onClick={() => onLink(link.href)} className="font-medium text-brand-text underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
            {label}
          </button>,
        );
      else
        out.push(
          <a key={k} href={link.href} target="_blank" rel="noopener noreferrer" className="break-words font-medium text-brand-text underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
            {m[2] ? label : label.replace(/^https?:\/\//, "").slice(0, 48)}
          </a>,
        );
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function ChatText({ text, onLink }: { text: string; onLink: (href: string) => void }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (item) {
      if (last?.list) last.lines.push(item[1]);
      else blocks.push({ list: true, lines: [item[1]] });
    } else if (last && !last.list && last.lines.length) last.lines.push(line);
    else blocks.push({ list: false, lines: [line] });
  }
  return (
    <>
      {blocks
        .filter((b) => b.lines.length)
        .map((b, bi) =>
          b.list ? (
            <ul key={bi} className="my-1 grid gap-1 pl-1">
              {b.lines.map((l, li) => (
                <li key={li} className="flex gap-2">
                  <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-faint" />
                  <span className="min-w-0">{inline(l, onLink, `${bi}-${li}`)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p key={bi} className="my-1 first:mt-0 last:mb-0">
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  {inline(l, onLink, `${bi}-${li}`)}
                </Fragment>
              ))}
            </p>
          ),
        )}
    </>
  );
}

// ─── The thread ─────────────────────────────────────────────────────────────

function Bubble({ l, v, dim = false }: { l: ChatLine; v: ChatView; dim?: boolean }) {
  if (l.who === "you")
    return (
      <div className={`ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] px-3.5 py-2 text-[14.5px] leading-relaxed md:text-[14px] ${l.note ? "border border-dashed border-line text-muted" : "bg-surface-2 text-fg"} ${dim ? "opacity-60" : ""}`}>
        {l.text}
      </div>
    );
  const sp = l.speaker;
  const special = sp && sp.role !== v.agent.roleKey;
  const tint = special ? tintOf(sp.icon) : v.agent.tint;
  return (
    <div className={`flex max-w-[94%] gap-2.5 ${dim ? "opacity-60" : ""}`}>
      <span className="mt-0.5 shrink-0">{special ? <AgentGlyph icon={sp.icon} size={26} /> : v.agent.icon(26)}</span>
      <div className="min-w-0 flex-1">
        {special && (
          <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: tint }}>
            {sp.label}
          </span>
        )}
        <div className="break-words text-[14.5px] leading-relaxed text-fg md:text-[14px]">
          <ChatText text={l.text} onLink={v.onLink} />
          {l.streaming && <span aria-hidden className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse rounded-full" style={{ background: tint }} />}
        </div>
      </div>
    </div>
  );
}

const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const MicIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
  </svg>
);
export const PhoneGlyph = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

/** The input: type (Enter sends, Shift+Enter a new line), or dictate with the mic; Stop while an answer is written */
function Composer({ v, phone }: { v: ChatView; phone: boolean }) {
  const [draft, setDraft] = useState("");
  const base = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);
  const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, "")} ${b.trim()}` : `${a}${b.trim()}`);
  const dict = useDictation({
    callId: v.callId,
    onWords: (t) => setDraft(join(base.current, t)),
    onSend: (t) => {
      const text = join(base.current, t);
      base.current = "";
      setDraft("");
      if (text.trim()) v.onSend(text);
    },
  });
  // The box grows with what's written, up to a few lines
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);
  const send = () => {
    if (dict.on) void dict.stop(false);
    if (!draft.trim()) return;
    v.onSend(draft);
    setDraft("");
    base.current = "";
  };
  return (
    <div className="grid gap-1.5">
      {(dict.on || dict.error) && (
        <div className="flex items-center justify-between gap-2 px-1 text-[12px]">
          <span aria-live="polite" className={dict.error ? "text-bad" : "text-muted"}>
            {dict.error ?? (dict.auto ? "Listening. It sends when you pause." : "Listening. Tap the mic to stop, then edit or send.")}
          </span>
          {dict.on && (
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 text-faint">
              <input type="checkbox" checked={dict.auto} onChange={(e) => dict.setAuto(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-brand)]" />
              Send on pause
            </label>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className={`flex items-end gap-1.5 rounded-[22px] border bg-surface p-1.5 pl-3.5 transition-colors focus-within:border-faint ${dict.on ? "border-brand/50" : "border-line"}`}
      >
        <label htmlFor="assistant-chat-input" className="sr-only">
          Message your assistant
        </label>
        <textarea
          id="assistant-chat-input"
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (!dict.on) base.current = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
              e.preventDefault();
              send();
            }
          }}
          enterKeyHint="send"
          placeholder={v.connecting ? "Opening the chat…" : "Message your assistant"}
          disabled={v.connecting}
          className="max-h-[140px] min-h-[40px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-snug text-fg outline-none placeholder:text-faint md:min-h-[36px] md:py-2 md:text-[14px]"
        />
        <button
          type="button"
          onClick={() => {
            if (dict.on) void dict.stop(false);
            else {
              base.current = draft;
              void dict.start();
            }
          }}
          disabled={v.connecting || dict.starting}
          aria-pressed={dict.on}
          aria-label={dict.on ? "Stop dictating" : "Dictate"}
          title={dict.on ? "Stop dictating" : "Dictate (voice to text)"}
          className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition active:scale-95 disabled:opacity-40 md:h-9 md:w-9 ${dict.on ? "bg-brand text-white" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
        >
          {dict.on && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-brand opacity-25" />}
          <MicIcon />
        </button>
        {v.busy && !draft.trim() ? (
          <button type="button" onClick={v.onStop} aria-label="Stop the answer" title="Stop" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-fg transition hover:border-faint active:scale-95 md:h-9 md:w-9">
            <span aria-hidden className="h-3 w-3 rounded-[3px] bg-current" />
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim() || v.connecting} aria-label="Send" title="Send (Enter)" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-white transition hover:bg-brand-hover active:scale-95 disabled:opacity-35 md:h-9 md:w-9">
            <SendIcon />
          </button>
        )}
      </form>
    </div>
  );
}

function Thread({ v }: { v: ChatView }) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = v.lines[v.lines.length - 1];
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [v.lines.length, last?.text, v.cards.length, v.uploadAsk, v.job]);
  const thinking = v.busy && !(last?.who === "agent" && last.streaming);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
      <div className="grid gap-3.5">
        {v.earlier.length > 0 && (
          <>
            {v.earlier.map((l) => (
              <Bubble key={`e${l.id}`} l={l} v={v} dim />
            ))}
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-faint">
              <span className="h-px flex-1 bg-line" />
              Now
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        {v.lines.map((l) => (
          <Bubble key={l.id} l={l} v={v} />
        ))}
        {thinking && (
          <div className="flex items-center gap-2.5" aria-label="Writing">
            <span className="shrink-0">{v.agent.icon(26)}</span>
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
          </div>
        )}
        {v.connecting && !v.lines.length && <p className="text-[13px] text-faint">Opening the chat…</p>}
      </div>
    </div>
  );
}

function Extras({ v, compact }: { v: ChatView; compact: boolean }) {
  const sc = v.screen;
  if (!v.cards.length && !v.uploadAsk && !sc.asked && !sc.sharing && !v.job && !v.team.length) return null;
  const speaking = [...v.lines].reverse().find((l) => l.who === "agent" && l.streaming)?.speaker?.role ?? null;
  return (
    <div className="grid max-h-[40vh] gap-2 overflow-y-auto border-t border-line px-4 py-2.5">
      <TeamChips team={v.team} speaking={speaking} />
      {v.job && <JobStrip job={v.job} />}
      {sc.sharing && <SharingBar onStop={sc.onStop} looking={sc.looking} />}
      {sc.asked && !sc.sharing && <ShareAsk agent="your assistant" onShare={sc.onShare} onCancel={sc.onCancel} />}
      {v.uploadAsk && <UploadPanel ask={v.uploadAsk} busy={v.uploading} onFiles={v.onUpload} onClose={v.onCloseUpload} />}
      {v.cards.length > 0 && <CardsStrip cards={v.cards} compact={compact} onOpen={v.onOpenCard} onDismiss={v.onDismissCard} callId={v.callId} onApprove={() => v.onSend("Yes, send it.")} />}
    </div>
  );
}

function Learned({ items }: { items: LearnedItem[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-1">
      {items.slice(-3).map((l, i) => (
        <span key={`${l.title}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-[12px] text-brand-text">
          <span className="truncate">Heard: {l.title}</span>
        </span>
      ))}
    </div>
  );
}

const DOCK = "fixed bottom-[calc(84px+var(--fab-clear,0px))] right-6 z-[75]";

function HeaderButton({ label, onClick, children, className = "" }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg md:h-8 md:w-8 ${className}`}>
      {children}
    </button>
  );
}

/** The chat window: a docked, movable panel on computers, the whole screen on phones; both shrink to a pill */
export function ChatWidget({ v, minimized, phone, onMinimize, onExpand }: { v: ChatView; minimized: boolean; phone: boolean; onMinimize: () => void; onExpand: () => void }) {
  const { ref: dockRef, style: dockStyle, dragging, handle, keys } = useCallDock(phone ? "phone" : "desktop", { snap: phone && minimized });
  const [menu, setMenu] = useState(false);
  const title = v.agent.roleKey === "assistant" ? assistantTitle(v.agent.label) : `The ${v.agent.label}`;
  const lastAgent = [...v.lines].reverse().find((l) => l.who === "agent");
  const status = v.error ?? (v.connecting ? "Opening…" : v.busy ? "Writing…" : "Chat");

  if (minimized)
    return (
      <div
        ref={dockRef}
        style={dockStyle}
        role="region"
        aria-label="Chat with your assistant, collapsed"
        className={`${DOCK} flex max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full border border-line bg-surface/95 py-1.5 pl-1.5 pr-2 shadow-[0_14px_36px_-14px_rgba(0,0,0,0.6)] backdrop-blur ${dragging ? "select-none" : "animate-[sheet-up_.22s_cubic-bezier(.2,.8,.2,1)]"}`}
      >
        <button type="button" onClick={onExpand} {...handle} {...keys} aria-label="Open the chat (drag to move)" title="Open the chat" className="flex min-h-11 min-w-0 touch-none items-center gap-2 rounded-full pr-1 transition-opacity hover:opacity-85 md:min-h-0">
          <span className="relative">
            {v.busy && <span aria-hidden className="absolute inset-[-3px] animate-ping rounded-[14px] opacity-25" style={{ background: v.agent.tint }} />}
            <span className="relative">{v.agent.icon(32)}</span>
          </span>
          <span className="grid min-w-0 text-left leading-tight">
            <span className={`max-w-[11rem] truncate text-[12.5px] ${v.error ? "text-bad" : "text-fg"}`}>{v.busy ? "Writing…" : lastAgent ? lastAgent.text.replace(/[*_[\]]/g, "").slice(0, 60) : title}</span>
            <span className="text-[11px] text-muted">Chat</span>
          </span>
        </button>
        <HeaderButton label="Close the chat" onClick={v.onClose} className="md:h-8 md:w-8">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </HeaderButton>
      </div>
    );

  const shell = phone
    ? "fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]"
    : `${DOCK} flex h-[min(620px,calc(100vh-140px))] w-[400px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[22px] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] ${dragging ? "select-none" : "animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)]"}`;
  return (
    <div
      ref={phone ? undefined : dockRef}
      style={phone ? undefined : dockStyle}
      role={phone ? "dialog" : "region"}
      aria-modal={phone || undefined}
      aria-label={`Chat with ${title.toLowerCase()}`}
      className={shell}
      onKeyDown={(e) => {
        if (e.key === "Escape") onMinimize();
      }}
    >
      <span aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-32 w-56 -translate-x-1/2 rounded-full opacity-20 blur-3xl" style={{ background: v.agent.tint }} />
      <div className={`relative flex items-center gap-2.5 border-b border-line py-2 pl-3 pr-2 ${phone ? "" : "touch-none"}`} {...(phone ? {} : handle)}>
        {!phone && (
          <button type="button" aria-label="Move the chat: drag it, or use the arrow keys (Home puts it back)" title="Drag to move (arrow keys too)" {...handle} {...keys} className="grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg active:cursor-grabbing">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden>
              <circle cx="2.5" cy="3" r="1.4" />
              <circle cx="7.5" cy="3" r="1.4" />
              <circle cx="2.5" cy="8" r="1.4" />
              <circle cx="7.5" cy="8" r="1.4" />
              <circle cx="2.5" cy="13" r="1.4" />
              <circle cx="7.5" cy="13" r="1.4" />
            </svg>
          </button>
        )}
        <span className="relative">{v.agent.icon(phone ? 38 : 34)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-[16px] leading-tight">{title}</p>
          <p aria-live="polite" className={`truncate text-[12px] ${v.error ? "text-bad" : "text-muted"}`}>
            {status}
          </p>
        </div>
        <button
          type="button"
          onClick={v.onCall}
          disabled={!v.callId}
          title="Carry this conversation on as a call"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] text-fg transition hover:border-faint active:scale-[0.97] disabled:opacity-40 md:min-h-8"
        >
          <PhoneGlyph size={14} />
          Call
        </button>
        <span className="relative">
          <HeaderButton label="More" onClick={() => setMenu((m) => !m)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </HeaderButton>
          {menu && v.callId && (
            <>
              <button type="button" aria-label="Close the menu" onClick={() => setMenu(false)} className="fixed inset-0 z-10 cursor-default" />
              <span className="absolute right-0 top-full z-20 mt-1.5 grid min-w-[220px] rounded-[14px] border border-line bg-surface p-1 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.55)]">
                <TranscriptButton callId={v.callId} onDone={() => setMenu(false)} className="min-h-11 w-full rounded-[10px] px-3 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2 md:min-h-9" />
                {v.screen.can && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(false);
                      if (v.screen.sharing) v.screen.onStop();
                      else v.screen.onShare();
                    }}
                    className="min-h-11 w-full rounded-[10px] px-3 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2 md:min-h-9"
                  >
                    {v.screen.sharing ? "Stop sharing my screen" : "Share my screen"}
                  </button>
                )}
              </span>
            </>
          )}
        </span>
        <HeaderButton label={phone ? "Minimise the chat" : "Minimise the chat (Esc)"} onClick={onMinimize}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            {phone ? <path d="m6 9 6 6 6-6" /> : <path d="M5 12h14" />}
          </svg>
        </HeaderButton>
        <HeaderButton label="End the chat" onClick={v.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </HeaderButton>
      </div>

      <Thread v={v} />
      <Extras v={v} compact={!phone} />
      <Learned items={v.learned} />

      <div className="relative px-3 pb-3 pt-2">
        <Composer v={v} phone={phone} />
        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-faint">
          <RecordedMark />
          {!phone && <span>Enter sends · Shift+Enter new line · Esc minimises</span>}
        </div>
      </div>
    </div>
  );
}
