"use client";

import { DocumentCardView } from "./document-card";
import { CopyDocCardView } from "./copy-doc-card";
import { useRef, useState } from "react";
import { callTranscript, saveCallDraft } from "@/app/(team)/settings/call-actions";
import { openCallDraftInGmail } from "@/app/(team)/assistant/document-actions";
import type { CallCard, UploadAsk } from "@/lib/agent-call/core";
import type { Speaker } from "@/lib/agent-call/engine";
import { tintOf } from "@/lib/agent-look";
import type { CallNotes } from "@/lib/assistant/notes";
import type { JobView } from "@/lib/assistant/team";

// The pieces a call shows beyond talking: an agent's icon, the specialists on the line and the job they're working on, link cards ("take a look"),
// the upload panel when the assistant asks for files, the assistant's notes after the call, and the one-time notice
// that calls are recorded, and sharing the screen for a look (the ask to share, and the bar while it's shared). Used
// by both the phone's full screen and the computer's huddle. And the button that downloads a call's transcript.

const ICONS: Record<string, string> = {
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3.5-12.5-2 5-5 2 2-5z",
  shield: "M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6zm-3 9 2 2 4-4",
  feed: "M4 5h16M4 10h16M4 15h10M4 20h7",
  pen: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m-1-4 4 4m-6-6c1-4 5-9 12-9 0 7-5 11-9 12m3-7a1.5 1.5 0 1 0 0-.01",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  book: "M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h10",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  spark: "M12 3c.7 5 3 7.3 8 8v2c-5 .7-7.3 3-8 8h-.1c-.7-5-3-7.3-8-8v-2c5-.7 7.3-3 8-8z",
};

/** An agent's icon in its colour (the assistant passes its own tint) */
export function AgentGlyph({ icon, size = 40, tint }: { icon: string; size?: number; tint?: string }) {
  const t = tint ?? tintOf(icon);
  return (
    <span className="relative grid shrink-0 place-items-center rounded-[14px]" style={{ width: size, height: size, background: `${t}22`, color: t, boxShadow: `inset 0 0 0 1px ${t}33` }}>
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={ICONS[icon] ?? ICONS.spark} />
      </svg>
    </span>
  );
}

/** The specialists on the line with the host: each one's glyph and role, the one speaking lit up */
export function TeamChips({ team, speaking, center = false }: { team: Speaker[]; speaking: string | null; center?: boolean }) {
  if (!team.length) return null;
  return (
    <ul className={`flex flex-wrap gap-1.5 ${center ? "justify-center" : ""}`} aria-label="Also on the call">
      {team.map((g) => {
        const on = speaking === g.role;
        return (
          <li
            key={g.role}
            className={`inline-flex max-w-full items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[12.5px] transition-colors ${on ? "border-faint bg-surface text-fg" : "border-line bg-surface-2/70 text-muted"}`}
            aria-current={on ? "true" : undefined}
          >
            <span className="relative">
              {on && <span aria-hidden className="absolute inset-[-3px] animate-ping rounded-[12px] opacity-25" style={{ background: tintOf(g.icon) }} />}
              <AgentGlyph icon={g.icon} size={22} />
            </span>
            <span className="truncate">{g.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The job the agents are working on: what, for whom, and each step done or still to do */
export function JobStrip({ job }: { job: JobView }) {
  const needed = job.steps.filter((s) => !s.optional);
  const done = needed.filter((s) => s.done).length;
  const next = job.steps.find((s) => !s.done && !s.optional);
  return (
    <section className="rounded-[16px] border border-line bg-surface p-3 shadow-sm" aria-label={`${job.label} progress`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[13.5px] font-medium leading-snug">
          {job.label}
          {job.client && <span className="text-muted"> · {job.client}</span>}
          {job.platform && <span className="text-faint"> · {job.platform === "google" ? "Google" : "Meta"}</span>}
        </p>
        <span className={`shrink-0 text-[11.5px] tabular-nums ${job.status === "done" ? "text-ok" : "text-faint"}`}>{job.status === "done" ? "Done" : job.status === "dropped" ? "Stopped" : `${done} of ${needed.length}`}</span>
      </div>
      <div className="mt-2.5 flex gap-1" aria-hidden>
        {needed.map((s) => (
          <span key={s.key} className={`h-1 flex-1 rounded-full transition-colors duration-500 ${s.done ? "bg-ok" : s === next ? "bg-brand/60" : "bg-surface-2"}`} />
        ))}
      </div>
      <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {job.steps.map((s) => (
          <li key={s.key} className={`inline-flex items-center gap-1.5 text-[11.5px] ${s.done ? "text-muted" : s === next ? "text-fg" : "text-faint"}`}>
            {s.done ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ok">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s === next ? "bg-brand" : "bg-line"}`} />
            )}
            <span>
              {s.label}
              {s.optional && !s.done && <span className="text-faint"> (optional)</span>}
              <span className="sr-only">{s.done ? ", done" : s === next ? ", next" : ", to do"}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A small "recorded" mark, always shown during a call (nothing is recorded without people knowing) */
export function RecordedMark() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-faint" title="Calls are recorded and may be reviewed for safety and compliance">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-bad/80" />
      Recorded
    </span>
  );
}

/** A screen, for sharing it on a call */
export function ScreenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h18v11H3zM8 20h8M12 16v4" />
    </svg>
  );
}

/**
 * The agent asked to take a look and nothing is shared yet: one tap opens the browser's own picker (a tab, a window
 * or the whole screen). What's shared is only looked at when the agent asks; it stops when the call ends.
 */
export function ShareAsk({ agent, onShare, onCancel }: { agent: string; onShare: () => void; onCancel: () => void }) {
  return (
    <section aria-label="Share your screen" className="relative grid gap-3 rounded-[18px] border border-brand/30 bg-brand-soft/30 p-3.5 animate-[sheet-up_.22s_cubic-bezier(.2,.8,.2,1)]">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-surface text-brand-text shadow-[inset_0_0_0_1px_var(--color-line)]">
          <ScreenIcon size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium leading-snug">Share your screen so {agent} can take a look</p>
          <p className="mt-0.5 text-[12px] leading-snug text-muted">Pick a tab, a window or your whole screen. It only looks when you ask, and sharing stops when the call ends.</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="inline-flex min-h-11 items-center rounded-full px-4 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-9">
          Not now
        </button>
        <button type="button" onClick={onShare} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-9">
          <ScreenIcon size={15} />
          Share screen
        </button>
      </div>
    </section>
  );
}

/** While the screen is shared: a clear mark, and Stop sharing */
export function SharingBar({ onStop, looking }: { onStop: () => void; looking: boolean }) {
  return (
    <div role="status" className="flex items-center justify-between gap-3 rounded-full border border-bad/25 bg-bad/[0.07] py-1 pl-3 pr-1">
      <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <span aria-hidden className="relative grid h-2 w-2 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-bad/50 [animation-duration:2s]" />
          <span className="relative h-2 w-2 rounded-full bg-bad" />
        </span>
        <span className="truncate">{looking ? "Taking a look…" : "Sharing your screen"}</span>
      </span>
      <button type="button" onClick={onStop} className="inline-flex min-h-9 shrink-0 items-center rounded-full bg-surface px-3 text-[12px] font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-surface-2">
        Stop sharing
      </button>
    </div>
  );
}

/**
 * A message drafted as the person (a Slack reply or an email): edit it right here, Approve (which says yes on the call,
 * so the agent sends it as them), or copy it. After sending it shows what happened (sent, a Gmail draft, or copy).
 */
function DraftCard({ c, callId, onApprove, onDismiss }: { c: CallCard & { draft: NonNullable<CallCard["draft"]> }; callId: string | null; onApprove?: (text: string) => void; onDismiss: (id: string) => void }) {
  const d = c.draft;
  const [text, setText] = useState(d.text);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = d.status === "draft" || d.status === "copy";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr("Couldn't copy: select the text and copy it.");
    }
  };
  const [opened, setOpened] = useState<string | null>(null);
  /** Into their Gmail as a draft with the PDF attached, or a prefilled compose that names the PDF to attach */
  const openGmail = async () => {
    if (!callId) return d.compose && window.open(d.compose, "_blank", "noopener");
    const tab = window.open("about:blank", "_blank");
    setBusy(true);
    setErr(null);
    const saved = text.trim() !== d.text.trim() ? await saveCallDraft(callId, d.id, text) : { ok: true as const };
    const r = saved.ok ? await openCallDraftInGmail(callId, d.id) : { ok: false as const, error: saved.error };
    setBusy(false);
    if (!r.ok) {
      tab?.close();
      return setErr(r.error);
    }
    if (tab) tab.location.href = r.href;
    else window.open(r.href, "_blank", "noopener");
    setOpened(r.where === "gmail" ? "It's in your Gmail drafts with the PDF attached." : d.attachments?.length ? "Opened a new email: download the PDF here and attach it before sending." : "Opened a new email in Gmail.");
  };
  const approve = async () => {
    if (!onApprove || !callId) return;
    setBusy(true);
    setErr(null);
    const r = text.trim() !== d.text.trim() ? await saveCallDraft(callId, d.id, text) : { ok: true as const };
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onApprove(text);
  };
  return (
    <li className="grid gap-2 rounded-[14px] border border-line bg-surface p-3 shadow-sm sm:col-span-2" aria-label={c.title}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-[11px] uppercase tracking-[0.14em] ${d.status === "sent" ? "text-ok" : "text-brand-text"}`}>{c.title}</p>
          <p className="truncate text-[12.5px] text-muted">
            {d.where}
            {d.subject ? ` · ${d.subject}` : ""}
          </p>
        </div>
        <button type="button" onClick={() => onDismiss(c.id)} aria-label={`Hide ${c.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <label className="sr-only" htmlFor={`draft-${d.id}`}>
        The message
      </label>
      <textarea
        id={`draft-${d.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={!open}
        rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
        className="w-full resize-y rounded-[12px] border border-line bg-surface-2/40 px-3 py-2 text-[16px] leading-snug text-fg outline-none focus:border-faint md:text-[13.5px]"
      />
      {d.attachments && d.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Attached">
          {d.attachments.map((f) => (
            <a key={f.documentId} href={f.download} className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2/40 px-3 text-[12px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-8" title="Download the PDF">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
              </svg>
              <span className="truncate">{f.name}</span>
            </a>
          ))}
        </div>
      )}
      {opened && <p className="text-[12px] text-muted">{opened}</p>}
      {d.status === "gmail_draft" && <p className="text-[12px] text-muted">It&apos;s in your Gmail drafts{d.attachments?.length ? ", with the PDF attached" : ", in the thread"}: one click to send it there.</p>}
      {d.status === "copy" && <p className="text-[12px] text-muted">It can&apos;t go out as you from here yet: copy it and send it yourself.</p>}
      {err && (
        <p role="alert" className="text-[12px] text-bad">
          {err}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={copy} className="inline-flex min-h-11 items-center rounded-full px-4 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-9">
          {copied ? "Copied" : "Copy"}
        </button>
        {d.channel === "email" && open && (
          <button type="button" disabled={busy} onClick={openGmail} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9">
            Open in Gmail
          </button>
        )}
        {d.status === "draft" && onApprove && (
          <button type="button" disabled={busy || !text.trim()} onClick={approve} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 md:min-h-9">
            Approve and send
          </button>
        )}
      </div>
    </li>
  );
}

/** Link cards the agent showed: in the app (the call stays up) or a new tab; drafted messages to edit and approve */
export function CardsStrip({ cards, onOpen, onDismiss, compact = false, callId = null, onApprove }: { cards: CallCard[]; onOpen: (c: CallCard) => void; onDismiss: (id: string) => void; compact?: boolean; callId?: string | null; onApprove?: (text: string) => void }) {
  if (!cards.length) return null;
  return (
    <ul className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`} aria-label="Shared on the call">
      {cards.map((c) =>
        c.copy ? (
          <CopyDocCardView key={c.id} card={c as CallCard & { copy: NonNullable<CallCard["copy"]> }} onOpen={onOpen} onDismiss={() => onDismiss(c.id)} wide={!compact} />
        ) : c.document ? (
          <DocumentCardView key={c.id} doc={c.document} onDismiss={() => onDismiss(c.id)} wide={!compact} />
        ) : c.draft ? (
          <DraftCard key={c.id} c={c as CallCard & { draft: NonNullable<CallCard["draft"]> }} callId={callId} onApprove={onApprove} onDismiss={onDismiss} />
        ) : (
        <li key={c.id} className="group relative flex items-center gap-3 rounded-[14px] border border-line bg-surface p-2.5 pr-2 shadow-sm">
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand-text">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {c.external ? <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /> : <path d="M5 12h14M13 6l6 6-6 6" />}
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium leading-snug">{c.title}</span>
            {c.detail && <span className="block truncate text-[11.5px] text-faint">{c.detail}</span>}
          </span>
          {/* A real link: an outside site opens in a new tab by itself; in the app, a plain click goes through the
              app's router so the call stays up (a cmd or ctrl click still opens a tab) */}
          <a
            href={c.href}
            target={c.external ? "_blank" : undefined}
            rel={c.external ? "noopener noreferrer" : undefined}
            onClick={(e) => {
              if (c.external || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onOpen(c);
            }}
            className="relative z-[1] inline-flex min-h-11 shrink-0 items-center rounded-full bg-brand px-3.5 text-[12.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-8"
          >
            {c.cta}
          </a>
          <button type="button" onClick={() => onDismiss(c.id)} aria-label={`Hide ${c.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </li>
        ),
      )}
    </ul>
  );
}

/** The upload panel: opened when the assistant asks for files, without leaving the call */
export function UploadPanel({ ask, busy, onFiles, onClose }: { ask: UploadAsk; busy: string | null; onFiles: (files: File[]) => void; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []).slice(0, 20);
    if (files.length) onFiles(files);
  };
  return (
    <section aria-label="Upload for the assistant" className="relative grid gap-3 rounded-[18px] border border-brand/30 bg-brand-soft/30 p-3.5 animate-[sheet-up_.22s_cubic-bezier(.2,.8,.2,1)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.16em] text-brand-text">{ask.purpose === "creatives" ? "Creatives" : ask.purpose === "screen" ? "A screenshot" : "Files"}{ask.client ? ` · ${ask.client}` : ""}</p>
          <p className="mt-0.5 text-[13.5px] leading-snug">{ask.note}</p>
        </div>
        <button type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="Close the upload" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        disabled={Boolean(busy)}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files);
        }}
        className={`grid min-h-24 place-items-center rounded-[14px] border-2 border-dashed px-4 py-5 text-center transition-colors ${over ? "border-brand bg-brand-soft/50" : "border-line bg-surface hover:border-faint"} disabled:opacity-70`}
      >
        <span className="grid justify-items-center gap-1.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted">
            <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <span className="text-[13.5px] font-medium">{busy ?? (ask.purpose === "screen" ? "Choose a screenshot" : "Choose files or drop them here")}</span>
          {!busy && <span className="text-[11.5px] text-faint">{ask.purpose === "screen" ? "Take a screenshot, then pick it here. The call stays up." : "Pictures, videos, PDFs and sheets. The call stays up."}</span>}
        </span>
      </button>
      <input ref={input} type="file" multiple={ask.purpose !== "screen"} hidden accept={ask.purpose === "screen" ? "image/*" : "image/*,video/*,application/pdf,.csv,.xlsx,.docx,.pptx,.txt"} onChange={(e) => pick(e.target.files)} />
    </section>
  );
}

/** The assistant's notes after the call: what was decided and what to follow up (follow-ups are on the Overview) */
export function NotesBlock({ notes }: { notes: CallNotes | null | "none" }) {
  if (notes === "none") return null;
  if (!notes)
    return (
      <div className="grid gap-2" aria-busy>
        <p className="text-[11px] uppercase tracking-[0.16em] text-faint">My notes</p>
        <span className="h-3 w-3/4 animate-pulse rounded-full bg-surface-2" />
        <span className="h-3 w-1/2 animate-pulse rounded-full bg-surface-2" />
      </div>
    );
  return (
    <div className="grid gap-3">
      <p className="text-[11px] uppercase tracking-[0.16em] text-faint">My notes</p>
      {notes.summary && <p className="text-[14px] leading-relaxed text-muted">{notes.summary}</p>}
      {notes.decisions.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[12.5px] font-medium">Decided</p>
          <ul className="grid gap-1">
            {notes.decisions.map((d) => (
              <li key={d} className="flex gap-2 text-[13px] leading-snug text-muted">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(notes.made ?? []).length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[12.5px] font-medium">{notes.job ? `Made for ${notes.job.label.toLowerCase()}${notes.job.client ? ` · ${notes.job.client}` : ""}` : "Made on the call"}</p>
          <ul className="grid gap-1">
            {(notes.made ?? []).map((m, i) => (
              <li key={`${m.label}-${i}`} className="flex gap-2 text-[13px] leading-snug text-muted">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                {m.href ? (
                  <a href={m.href} className="underline decoration-line underline-offset-2 transition-colors hover:text-fg hover:decoration-faint">
                    {m.label}
                  </a>
                ) : (
                  m.label
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(notes.agents ?? []).length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12.5px] font-medium">Who did what</p>
          {(notes.agents ?? []).map((a) => (
            <div key={a.label} className="grid gap-0.5">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">{a.label}</p>
              <ul className="grid gap-0.5">
                {a.did.map((d) => (
                  <li key={d} className="text-[13px] leading-snug text-muted">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {notes.followUps.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[12.5px] font-medium">To follow up (on your Overview)</p>
          <ul className="grid gap-1">
            {notes.followUps.map((f) => (
              <li key={f.what} className="flex gap-2 text-[13px] leading-snug text-muted">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span>
                  {f.what}
                  {f.due && <span className="text-faint"> · {f.due}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Before anyone's first call: calls are recorded and may be reviewed. Acknowledged once, with the time. */
export function RecordingNotice({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[95] grid place-items-end p-0 sm:place-items-center sm:p-4" role="dialog" aria-modal aria-labelledby="call-notice-title">
      <button type="button" aria-label="Not now" onClick={onCancel} className="absolute inset-0 bg-black/55 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative w-full max-w-md rounded-t-[24px] border border-line bg-surface p-6 pb-[calc(env(safe-area-inset-bottom)+24px)] shadow-2xl animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)] sm:rounded-[22px] sm:pb-6">
        <span aria-hidden className="grid h-12 w-12 place-items-center rounded-[16px] bg-brand-soft text-brand-text">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" />
            <path d="M12 9v4M12 16h.01" />
          </svg>
        </span>
        <p id="call-notice-title" className="mt-4 font-heading text-[20px] leading-tight">
          Before your first call
        </p>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted">Calls with Kaizen&apos;s AI are recorded and may be reviewed for safety and compliance.</p>
        <p className="mt-2 text-[13px] leading-relaxed text-faint">The audio of a call is deleted right after its review unless something concerning comes up. What your assistant remembers about you stays private to you.</p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className="min-h-12 rounded-full border border-line px-5 text-[14px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-10">
            Not now
          </button>
          <button type="button" onClick={onAccept} className="min-h-12 rounded-full bg-brand px-5 text-[14px] font-medium text-white transition hover:bg-brand-hover md:min-h-10">
            Got it, start the call
          </button>
        </div>
      </div>
    </div>
  );
}

/** Downloads a call's transcript as a text file (the date, the agent, every line with its time) */
export function TranscriptButton({ callId, className = "", label = "Download transcript", onDone }: { callId: string; className?: string; label?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await callTranscript(callId).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) return setError(r && !r.ok ? r.error : "Couldn't get the transcript.");
    const url = URL.createObjectURL(new Blob([r.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    onDone?.();
  };
  return (
    <button type="button" onClick={() => void go()} disabled={busy} className={`inline-flex items-center gap-2 disabled:opacity-60 ${className}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
      </svg>
      <span>{busy ? "Getting it…" : label}</span>
      {error && <span className="text-bad">{error}</span>}
    </button>
  );
}
