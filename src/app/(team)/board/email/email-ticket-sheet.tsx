"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DuePill } from "@/components/due-pill";
import { DirectionBanner } from "@/components/direction-parts";
import { EmailDesignCanvas, type Box, type CanvasPin } from "@/components/email-design-canvas";
import { toast } from "@/components/toasts";
import { createClient } from "@/lib/supabase/client";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import type { EmailComment, EmailLink, EmailMessage, EmailTicket } from "@/lib/email-board";
import {
  EMAIL_STAGES,
  emailStageInfo,
  handle,
  KIND_LABEL,
  MAX_MESSAGES,
  MESSAGE_STATUS_LABEL,
  messageStatus,
  nextStage,
  onPath,
  type EmailKind,
  type EmailPriority,
  type EmailStage,
  type MessageStatus,
  type MoveCheck,
} from "@/lib/email-board-core";
import { ClientTag } from "../ticket-card";
import {
  addMessage,
  advanceEmail,
  approveCopy,
  assignEmail,
  commentEmail,
  designUploaded,
  designUploadSlot,
  emailMoveCheck,
  loadEmailTicket,
  markBuilt,
  markLive,
  moveEmail,
  moveMessage,
  removeMessage,
  rerunReview,
  resolveComment,
  rewriteCopy,
  saveMessage,
  setEmailDue,
  setEmailPriority,
  setRoute,
  type TicketDetail,
} from "./actions";

type Person = { id: string; name: string; role: string };

const liteOf = (m: EmailMessage) => ({ channel: m.channel, copyApproved: m.copyApproved, hasDesign: Boolean(m.designPath), aiReview: m.aiReviewStatus, clientStatus: m.clientStatus, builtAt: m.builtAt, liveAt: m.liveAt });
const STATUS_TONE: Record<MessageStatus, string> = {
  copy: "bg-surface-2 text-muted",
  design: "bg-[#8b9cf7]/15 text-[#5a68d8] dark:text-[#aab5ff]",
  review: "bg-[#8b9cf7]/15 text-[#5a68d8] dark:text-[#aab5ff]",
  client: "bg-warn-soft text-warn",
  approved: "bg-ok-soft text-ok",
  changes: "bg-bad-soft text-bad",
  built: "bg-ok-soft text-ok",
  live: "bg-ok text-white",
};

export function KindBadge({ kind }: { kind: EmailKind }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${kind === "flow" ? "bg-[#14b8a6]/15 text-[#0f9e8f] dark:text-[#5eead4]" : "bg-[#6366f1]/12 text-[#5457d6] dark:text-[#a5b4fc]"}`}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {kind === "flow" ? <path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6" /> : <path d="M3 6h18v12H3zM3 7l9 6 9-6" />}
      </svg>
      {KIND_LABEL[kind]}
    </span>
  );
}

function StatusChip({ s }: { s: MessageStatus }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[s]}`}>{MESSAGE_STATUS_LABEL[s]}</span>;
}

/** A ticket dropped on another column, or a stage picked in the ticket: what it needs, then the move */
export function EmailMoveDialog({ ticket, to, onClose, onMoved }: { ticket: Pick<EmailTicket, "id" | "number" | "title" | "stage">; to: EmailStage; onClose: () => void; onMoved: (stage: EmailStage) => void }) {
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    emailMoveCheck(ticket.id, to).then((c) => live && setCheck(c));
    return () => {
      live = false;
    };
  }, [ticket.id, to]);
  const needsNote = Boolean(check && (check.warnings.length || check.backwards));
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center" onClick={onClose}>
      <div role="dialog" aria-label="Move the ticket" className="w-full rounded-t-[22px] border border-line bg-bg p-5 pb-[calc(20px+env(safe-area-inset-bottom))] md:max-w-md md:rounded-[22px]" onClick={(e) => e.stopPropagation()}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{handle(ticket.number)} · Move</p>
        <h2 className="mt-1 font-heading text-xl leading-snug">
          {emailStageInfo(ticket.stage).label} <span className="text-faint">→</span> {emailStageInfo(to).label}
        </h2>
        {!check ? (
          <p className="mt-4 text-sm text-muted">Checking what it needs…</p>
        ) : (
          <div className="mt-4 grid gap-2 text-sm">
            {check.blockers.map((b) => (
              <p key={b} className="rounded-[12px] bg-bad-soft px-3 py-2 text-bad">{b}</p>
            ))}
            {check.warnings.map((w) => (
              <p key={w} className="rounded-[12px] bg-warn-soft px-3 py-2 text-warn">{w}</p>
            ))}
            {check.effects.map((e) => (
              <p key={e} className="text-muted">{e}</p>
            ))}
            {needsNote && !check.blockers.length && <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why it's moving anyway" className="mt-1 w-full rounded-[12px] border border-line bg-surface p-3 outline-none focus:border-brand-text" />}
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="h-11 flex-1 rounded-brand border border-line text-sm text-muted hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            disabled={!check || check.blockers.length > 0 || busy || (needsNote && !note.trim())}
            onClick={async () => {
              setBusy(true);
              const r = await moveEmail(ticket.id, to, note);
              setBusy(false);
              if (!r.ok) return toast({ tone: "bad", title: "Couldn't move it", body: r.error });
              onMoved(to);
            }}
            className="h-11 flex-1 rounded-brand bg-brand text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40"
          >
            {busy ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The month a batch's sends fall in, as a calendar with each email on its day (the ones with no day listed after) */
function BatchTimeline({ messages, stage, selected, onPick }: { messages: EmailMessage[]; stage: EmailStage; selected: string | null; onPick: (id: string) => void }) {
  const dated = messages.filter((m) => m.sendOn);
  const months = [...new Set(dated.map((m) => m.sendOn!.slice(0, 7)))].sort();
  return (
    <div className="grid gap-4">
      {months.map((ym) => {
        const [y, mo] = ym.split("-").map(Number);
        const first = new Date(Date.UTC(y, mo - 1, 1));
        const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        const lead = first.getUTCDay();
        return (
          <div key={ym} className="rounded-[16px] border border-line bg-surface p-3">
            <p className="mb-2 text-sm font-medium">{first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</p>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-faint">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <span key={`b${i}`} />
              ))}
              {Array.from({ length: days }).map((_, i) => {
                const day = `${ym}-${String(i + 1).padStart(2, "0")}`;
                const here = dated.filter((m) => m.sendOn === day);
                return (
                  <div key={day} className={`grid min-h-11 content-start gap-0.5 rounded-[8px] p-0.5 ${here.length ? "bg-surface-2" : ""}`}>
                    <span className="text-[10px] text-faint">{i + 1}</span>
                    {here.map((m) => (
                      <button key={m.id} type="button" onClick={() => onPick(m.id)} title={m.name} className={`truncate rounded-[6px] px-1 py-0.5 text-left text-[10px] font-medium ${selected === m.id ? "bg-fg text-bg" : STATUS_TONE[messageStatus(liteOf(m), stage)]}`}>
                        {m.channel === "sms" ? "Text" : m.name}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="grid gap-1.5">
        {messages.map((m) => (
          <button key={m.id} type="button" onClick={() => onPick(m.id)} className={`flex min-h-11 items-center gap-2 rounded-[12px] border px-3 text-left text-sm transition ${selected === m.id ? "border-fg/40 bg-surface-2" : "border-line hover:border-faint"}`}>
            <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-[10px] font-bold text-muted">{m.channel === "sms" ? "T" : "E"}</span>
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            <span className="text-xs text-faint">{m.sendOn ? new Date(`${m.sendOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "No day yet"}</span>
            <StatusChip s={messageStatus(liteOf(m), stage)} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A flow as its sequence: the trigger, then each wait and message in order */
function FlowSequence({ messages, trigger, stage, selected, onPick, onReorder }: { messages: EmailMessage[]; trigger: string | null; stage: EmailStage; selected: string | null; onPick: (id: string) => void; onReorder: (id: string, dir: -1 | 1) => void }) {
  return (
    <ol className="relative grid gap-0">
      <li className="flex items-center gap-3 rounded-[14px] border border-dashed border-line bg-surface/60 p-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#14b8a6]/15 text-[#0f9e8f] dark:text-[#5eead4]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Trigger</span>
          <span className="block truncate text-sm">{trigger || "Not set yet"}</span>
        </span>
      </li>
      {messages.map((m, i) => (
        <li key={m.id} className="grid">
          <span className="mx-auto flex flex-col items-center py-1">
            <span className="h-3 w-px bg-line" />
            <span className="rounded-full border border-line bg-bg px-2.5 py-0.5 text-[11px] text-muted">{m.delayHours ? `Wait ${m.delayHours >= 24 && m.delayHours % 24 === 0 ? `${m.delayHours / 24}d` : `${m.delayHours}h`}` : "Right away"}</span>
            <span className="h-3 w-px bg-line" />
          </span>
          <div className={`flex items-center gap-2 rounded-[14px] border p-2 pl-3 transition ${selected === m.id ? "border-fg/40 bg-surface-2" : "border-line bg-surface hover:border-faint"}`}>
            <button type="button" onClick={() => onPick(m.id)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold ${m.channel === "sms" ? "bg-[#f59e0b]/15 text-[#b77306] dark:text-[#ffc46b]" : "bg-[#6366f1]/12 text-[#5457d6] dark:text-[#a5b4fc]"}`}>{m.channel === "sms" ? "SMS" : `E${i + 1}`}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.name}</span>
                <span className="block truncate text-xs text-faint">{m.channel === "sms" ? (m.body ?? "No text yet") : (m.subject ?? "No subject yet")}</span>
              </span>
              <StatusChip s={messageStatus(liteOf(m), stage)} />
            </button>
            <span className="flex flex-col">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => onReorder(m.id, -1)} className="grid h-6 w-8 place-items-center text-faint hover:text-fg disabled:opacity-30">
                ▲
              </button>
              <button type="button" aria-label="Move down" disabled={i === messages.length - 1} onClick={() => onReorder(m.id, 1)} className="grid h-6 w-8 place-items-center text-faint hover:text-fg disabled:opacity-30">
                ▼
              </button>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const field = "w-full rounded-[12px] border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand-text";

function CopyTab({ m, kind, canApprove, ticketId, onSaved }: { m: EmailMessage; kind: EmailKind; canApprove: boolean; ticketId: string; onSaved: () => void }) {
  const [d, setD] = useState({ name: m.name, subject: m.subject ?? "", preheader: m.preheader ?? "", body: m.body ?? "", sendOn: m.sendOn ?? "", delayHours: m.delayHours ?? 0 });
  const [busy, setBusy] = useState(false);
  const dirty = d.name !== m.name || d.subject !== (m.subject ?? "") || d.preheader !== (m.preheader ?? "") || d.body !== (m.body ?? "") || d.sendOn !== (m.sendOn ?? "") || d.delayHours !== (m.delayHours ?? 0);
  const sms = m.channel === "sms";
  const save = async () => {
    setBusy(true);
    const r = await saveMessage(m.id, { name: d.name, subject: sms ? null : d.subject, preheader: sms ? null : d.preheader, body: d.body, ...(kind === "batch" ? { sendOn: d.sendOn || null } : { delayHours: Number(d.delayHours) || 0 }) });
    setBusy(false);
    if (!r.ok) return toast({ tone: "bad", title: "Couldn't save", body: r.error });
    onSaved();
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted">
          Name
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={field} />
        </label>
        {kind === "batch" ? (
          <label className="grid gap-1 text-xs text-muted">
            Send day
            <input type="date" value={d.sendOn} onChange={(e) => setD({ ...d, sendOn: e.target.value })} className={field} />
          </label>
        ) : (
          <label className="grid gap-1 text-xs text-muted">
            Wait before it (hours)
            <input type="number" min={0} value={d.delayHours} onChange={(e) => setD({ ...d, delayHours: Number(e.target.value) })} className={field} />
          </label>
        )}
      </div>
      {!sms && (
        <>
          <label className="grid gap-1 text-xs text-muted">
            Subject line <span className="tabular text-faint">{d.subject.length} characters</span>
            <input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} className={field} />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            Preview text
            <input value={d.preheader} onChange={(e) => setD({ ...d, preheader: e.target.value })} className={field} />
          </label>
        </>
      )}
      <label className="grid gap-1 text-xs text-muted">
        {sms ? (
          <>
            Text message <span className={`tabular ${d.body.length > 160 ? "text-warn" : "text-faint"}`}>{d.body.length} of 160</span>
          </>
        ) : (
          "Email copy"
        )}
        <textarea value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} rows={sms ? 4 : 12} className={`${field} leading-relaxed`} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {dirty && (
          <button type="button" disabled={busy} onClick={save} className="h-11 rounded-brand bg-fg px-5 text-sm font-medium text-bg disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        )}
        {m.copyApproved ? (
          <span className="inline-flex h-11 items-center gap-1.5 rounded-brand bg-ok-soft px-4 text-sm text-ok">✓ Copy approved</span>
        ) : (
          canApprove &&
          !dirty && (
            <button
              type="button"
              disabled={busy || !d.body.trim()}
              onClick={async () => {
                setBusy(true);
                const r = await approveCopy(ticketId, m.id);
                setBusy(false);
                if (!r.ok) return toast({ tone: "bad", title: "Couldn't approve", body: r.error });
                if (r.moved) toast({ tone: "ok", title: "All copy approved", body: `→ ${emailStageInfo(r.moved).label}` });
                onSaved();
              }}
              className="h-11 rounded-brand bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              Approve this copy
            </button>
          )
        )}
        {m.copyApproved && <span className="text-xs text-faint">Editing the words asks for approval again.</span>}
      </div>
    </div>
  );
}

function DesignTab({ m, ticketId, comments, drawingFor, setDrawingFor, onChanged }: { m: EmailMessage; ticketId: string; comments: EmailComment[]; drawingFor: string | null; setDrawingFor: (v: string | null) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pinBox, setPinBox] = useState<Box | null>(null);
  const [note, setNote] = useState("");
  const [activePin, setActivePin] = useState<string | null>(null);
  const mine = comments.filter((c) => c.messageId === m.id && !c.resolvedAt);
  const pinned = mine.filter((c) => c.box);
  const pins: CanvasPin[] = pinned.map((c, i) => ({ id: c.id, box: c.box!, n: i + 1, tone: c.authorKind === "client" ? "client" : c.authorKind === "ai" ? (c.severity === "fix" ? "fix" : c.severity === "watch" ? "watch" : "ai") : "team", label: c.body, active: activePin === c.id }));
  const upload = async (file: File) => {
    setBusy("Uploading…");
    try {
      const slot = await designUploadSlot(m.id, file.name, file.type, file.size);
      if (!slot.ok) throw new Error(slot.error);
      const { error } = await createClient().storage.from("creative").uploadToSignedUrl(slot.path, slot.token, file, { contentType: file.type });
      if (error) throw new Error("The upload didn't go through.");
      const r = await designUploaded(m.id, slot.path, file.type);
      if (!r.ok) throw new Error(r.error);
      toast({ tone: "ok", title: "Design uploaded", body: "The AI is reviewing it and will pin its notes." });
      onChanged();
    } catch (e) {
      toast({ tone: "bad", title: "Couldn't upload", body: e instanceof Error ? e.message : "Try again." });
    }
    setBusy(null);
  };
  const isPdf = (m.designMime ?? "").includes("pdf");
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-brand bg-fg px-4 text-sm font-medium text-bg">
            {busy ?? (m.designPath ? "Upload a new version" : "Upload the design")}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" className="sr-only" disabled={Boolean(busy)} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          {m.designPath && !isPdf && (
            <button type="button" onClick={() => setDrawingFor(drawingFor === "pin" ? null : "pin")} className={`h-11 rounded-brand border px-4 text-sm ${drawingFor === "pin" ? "border-brand-text bg-brand-soft text-brand-text" : "border-line text-muted hover:text-fg"}`}>
              {drawingFor === "pin" ? "Tap or drag on the design" : "Pin a note"}
            </button>
          )}
          {m.designVersion > 0 && <span className="text-xs text-faint">Version {m.designVersion}</span>}
        </div>
        {m.designUrl && !isPdf ? (
          <EmailDesignCanvas
            src={m.designUrl}
            alt={`${m.name} design`}
            pins={pins}
            links={m.links}
            drawing={Boolean(drawingFor)}
            onPin={(id) => setActivePin(id === activePin ? null : id)}
            onDraw={async (b) => {
              if (drawingFor === "pin") {
                setPinBox(b);
                setDrawingFor(null);
              } else if (drawingFor?.startsWith("link:")) {
                const i = Number(drawingFor.slice(5));
                const links = m.links.map((l, k) => (k === i ? { ...l, box: b } : l));
                setDrawingFor(null);
                const r = await saveMessage(m.id, { links });
                if (!r.ok) toast({ tone: "bad", title: "Couldn't place the link", body: r.error });
                onChanged();
              }
            }}
            className="mx-auto w-full max-w-[600px]"
          />
        ) : m.designUrl ? (
          <a href={m.designUrl} target="_blank" rel="noopener noreferrer" className="grid h-40 place-items-center rounded-[14px] border border-line bg-surface text-sm text-muted hover:text-fg">
            Open the design (PDF)
          </a>
        ) : (
          <div className="grid h-48 place-items-center rounded-[14px] border border-dashed border-line text-center text-sm text-faint">The whole email as one image (PNG or JPG) or a PDF.</div>
        )}
        {pinBox && (
          <div className="grid gap-2 rounded-[14px] border border-brand-text/40 bg-brand-soft/40 p-3">
            <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What should change here?" className={field} />
            <div className="flex gap-2">
              <button type="button" onClick={() => (setPinBox(null), setNote(""))} className="h-11 flex-1 rounded-brand border border-line text-sm text-muted">
                Cancel
              </button>
              <button
                type="button"
                disabled={!note.trim()}
                onClick={async () => {
                  const r = await commentEmail(ticketId, m.id, note, pinBox);
                  if (!r.ok) return toast({ tone: "bad", title: "Couldn't pin it", body: r.error });
                  setPinBox(null);
                  setNote("");
                  onChanged();
                }}
                className="h-11 flex-1 rounded-brand bg-brand text-sm font-medium text-white disabled:opacity-40"
              >
                Pin the note
              </button>
            </div>
          </div>
        )}
      </div>
      <aside className="grid content-start gap-3">
        <div className="rounded-[14px] border border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">AI review</p>
            {m.designPath && m.aiReviewStatus !== "running" && (
              <button type="button" onClick={async () => (await rerunReview(m.id), onChanged())} className="min-h-11 text-xs text-muted hover:text-fg">
                Run again
              </button>
            )}
          </div>
          {m.aiReviewStatus === "running" ? (
            <p className="mt-1 text-sm text-muted">Looking it over…</p>
          ) : m.aiReview ? (
            <p className={`mt-1 text-sm ${m.aiReview.verdict === "fix" ? "text-bad" : m.aiReview.verdict === "minor" ? "text-warn" : "text-ok"}`}>{m.aiReview.headline}</p>
          ) : (
            <p className="mt-1 text-sm text-faint">{m.aiReviewStatus === "failed" ? "The review didn't finish. Run it again." : "Starts when a design is uploaded."}</p>
          )}
        </div>
        {mine.length > 0 && (
          <ol className="grid gap-2">
            {mine.map((c) => {
              const n = pinned.findIndex((p) => p.id === c.id);
              return (
                <li key={c.id} onMouseEnter={() => setActivePin(c.id)} className={`rounded-[14px] border p-3 text-sm ${activePin === c.id ? "border-fg/40" : "border-line"}`}>
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    {n >= 0 && <span className="grid h-5 w-5 place-items-center rounded-full bg-surface-2 text-[10px] font-bold">{n + 1}</span>}
                    {c.authorName ?? (c.authorKind === "ai" ? "Kaizen AI" : "Someone")}
                    {c.severity && c.severity !== "good" && <span className={c.severity === "fix" ? "text-bad" : "text-warn"}>· {c.severity === "fix" ? "fix" : "watch"}</span>}
                  </p>
                  <p className="mt-1 leading-snug">{c.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {c.authorKind === "client" && (
                      <span className="inline-flex rounded-full border border-line p-0.5 text-[11px]" role="radiogroup" aria-label="Goes to">
                        {(["copy", "design"] as const).map((r) => (
                          <button key={r} type="button" role="radio" aria-checked={c.route === r} onClick={async () => (await setRoute(c.id, r), onChanged())} className={`min-h-8 rounded-full px-2.5 ${c.route === r ? "bg-fg text-bg" : "text-muted"}`}>
                            {r === "copy" ? "Copy" : "Design"}
                          </button>
                        ))}
                      </span>
                    )}
                    <button type="button" onClick={async () => (await resolveComment(c.id, true), onChanged())} className="ml-auto min-h-8 rounded-full px-2.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg">
                      Done
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </aside>
    </div>
  );
}

function LinksTab({ m, onChanged, place }: { m: EmailMessage; onChanged: () => void; place: (i: number) => void }) {
  const [links, setLinks] = useState<EmailLink[]>(m.links);
  const dirty = JSON.stringify(links) !== JSON.stringify(m.links);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">Where each button goes. The client&apos;s preview opens these, and placing a link on the design shows exactly which button it is.</p>
      {links.map((l, i) => (
        <div key={i} className="grid gap-2 rounded-[14px] border border-line p-3 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
          <input value={l.label} onChange={(e) => setLinks(links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} placeholder="Button" aria-label="Button label" className={field} />
          <input value={l.url} onChange={(e) => setLinks(links.map((x, k) => (k === i ? { ...x, url: e.target.value.trim() } : x)))} placeholder="https://" aria-label="Where it goes" className={field} />
          <span className="flex gap-1">
            {m.channel === "email" && m.designUrl && (
              <button type="button" disabled={dirty} title={dirty ? "Save first" : undefined} onClick={() => place(i)} className={`h-11 whitespace-nowrap rounded-brand border px-3 text-xs ${l.box ? "border-ok/50 text-ok" : "border-line text-muted hover:text-fg"} disabled:opacity-40`}>
                {l.box ? "Placed" : "Place on design"}
              </button>
            )}
            <button type="button" aria-label="Remove the link" onClick={() => setLinks(links.filter((_, k) => k !== i))} className="grid h-11 w-11 place-items-center rounded-brand text-faint hover:text-bad">
              ✕
            </button>
          </span>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setLinks([...links, { label: "Button", url: "", box: null }])} className="h-11 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
          + Add a link
        </button>
        {dirty && (
          <button
            type="button"
            onClick={async () => {
              const r = await saveMessage(m.id, { links });
              if (!r.ok) return toast({ tone: "bad", title: "Couldn't save", body: r.error });
              onChanged();
            }}
            className="h-11 rounded-brand bg-fg px-5 text-sm font-medium text-bg"
          >
            Save links
          </button>
        )}
      </div>
    </div>
  );
}

function BuildTab({ m, provider, canApprove, onChanged }: { m: EmailMessage; provider: string; canApprove: boolean; onChanged: () => void }) {
  const [ref, setRef] = useState(m.providerRef ?? "");
  const name = provider === "brevo" ? "Brevo" : provider === "customerio" ? "Customer.io" : "Klaviyo";
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-xs text-muted">
        The {m.channel === "sms" ? "text" : "email"} in {name} (a link or its name, optional)
        <input value={ref} onChange={(e) => setRef(e.target.value)} className={field} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={async () => (await markBuilt(m.id, !m.builtAt, ref), onChanged())} className={`h-11 rounded-brand px-5 text-sm font-medium ${m.builtAt ? "bg-ok-soft text-ok" : "bg-fg text-bg"}`}>
          {m.builtAt ? "✓ Built" : `Mark built in ${name}`}
        </button>
        {canApprove && (
          <button type="button" onClick={async () => (await markLive(m.id, !m.liveAt), onChanged())} className={`h-11 rounded-brand px-5 text-sm font-medium ${m.liveAt ? "bg-ok text-white" : "border border-line text-muted hover:text-fg"}`}>
            {m.liveAt ? "✓ Scheduled or live" : "Scheduled or set live"}
          </button>
        )}
      </div>
      <p className="text-xs text-faint">With every message built the ticket moves to the final check; with every one scheduled or live it leaves the board.</p>
    </div>
  );
}

/** The primary step for where the ticket is: approve the copy, send for review, send to the client, and on */
function NextStep({ d, onDone }: { d: TicketDetail; onDone: () => void }) {
  const t = d.ticket;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const to = nextStage(t, t.messages.map(liteOf));
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okTitle: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return toast({ tone: "bad", title: "Not yet", body: r.error });
    toast({ tone: "ok", title: okTitle });
    onDone();
  };
  const btn = "h-11 rounded-brand bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50";
  if (t.stage === "copy_review")
    return (
      <div className="flex flex-wrap items-center gap-2">
        {t.copyStatus === "writing" ? (
          <span className="text-sm text-[#6f7fe6] dark:text-[#9aa7f0]">The AI is writing the copy…</span>
        ) : (
          d.canApprove && (
            <button type="button" disabled={busy} onClick={() => run(() => approveCopy(t.id, null), "Copy approved")} className={btn}>
              Approve all copy
            </button>
          )
        )}
        {t.copyStatus === "failed" && <span className="text-sm text-bad">The copy didn&apos;t finish.</span>}
        {rewriting ? (
          <span className="flex w-full gap-2 sm:w-auto">
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to change" className={`${field} sm:w-64`} />
            <button type="button" disabled={busy} onClick={() => run(() => rewriteCopy(t.id, note), "Rewriting the copy").then(() => setRewriting(false))} className="h-11 rounded-brand bg-fg px-4 text-sm text-bg">
              Rewrite
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setRewriting(true)} className="h-11 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
            {t.copyStatus === "failed" ? "Write it again" : "Rewrite with a note"}
          </button>
        )}
      </div>
    );
  if (t.stage === "with_client")
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Waiting on the client.</span>
        <Link href={`/c/${t.clientSlug}/emails`} className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
          See what the client sees
        </Link>
      </div>
    );
  const label: Partial<Record<EmailStage, string>> = { ready_for_design: "Send for review", for_review: "Send to the client", revisions: to === "with_client" ? "Send back to the client" : "Send back for review", ready_for_build: "Built, to the final check", ready_to_send: "Sent or live" };
  return (
    <button type="button" disabled={busy} onClick={() => run(() => advanceEmail(t.id), `→ ${emailStageInfo(to).label}`)} className={btn}>
      {label[t.stage] ?? `To ${emailStageInfo(to).label}`}
    </button>
  );
}

/** One ticket: its path, its messages laid out (a flow's sequence or a batch's month), and the message being worked on */
export function EmailTicketSheet({ number, people, onClose, onChanged }: { number: number; people: Person[]; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<TicketDetail | null | undefined>(undefined);
  const [moveTo, setMoveTo] = useState<EmailStage | null>(null);
  const [drawingFor, setDrawingFor] = useState<string | null>(null);
  const picked = useParam("m");
  const tab = (useParam("tab") as "copy" | "design" | "links" | "build" | null) ?? null;
  const reload = useCallback(() => {
    loadEmailTicket(number).then(setD);
  }, [number]);
  useEffect(() => {
    let live = true;
    loadEmailTicket(number).then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, [number]);
  // While the AI is writing or reviewing, the ticket checks back on its own
  const working = Boolean(d?.ticket.copyStatus === "writing" || d?.ticket.messages.some((m) => m.aiReviewStatus === "running"));
  useEffect(() => {
    if (!working) return;
    const i = setInterval(reload, 5000);
    return () => clearInterval(i);
  }, [working, reload]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const changed = () => {
    reload();
    onChanged();
  };
  const t = d?.ticket;
  const m = useMemo(() => (t ? (t.messages.find((x) => x.id === picked) ?? t.messages[0] ?? null) : null), [t, picked]);
  const path = t ? EMAIL_STAGES.filter((s) => onPath(t, t.messages.map(liteOf), s)) : [];
  const shown = tab ?? (m && t && m.channel === "email" && ["ready_for_design", "for_review", "revisions"].includes(t.stage) ? "design" : m && t && ["ready_for_build", "ready_to_send"].includes(t.stage) ? "build" : "copy");
  const clientNotes = d ? d.comments.filter((c) => c.authorKind === "client" && !c.resolvedAt) : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-label="Email ticket" className="h-full w-full overflow-y-auto bg-bg pb-[env(safe-area-inset-bottom)] shadow-2xl md:max-w-[1080px] md:rounded-l-[24px] md:border-l md:border-line" onClick={(e) => e.stopPropagation()}>
        {d === undefined ? (
          <div className="grid h-full place-items-center text-sm text-muted">Opening…</div>
        ) : !d || !t ? (
          <div className="grid h-full place-items-center gap-2 text-center text-sm text-muted">
            That ticket isn&apos;t here.
            <button type="button" onClick={onClose} className="h-11 rounded-brand border border-line px-4">
              Close
            </button>
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 border-b border-line bg-bg/90 px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top))] backdrop-blur-xl md:px-7">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <ClientTag name={t.clientName} />
                    <KindBadge kind={t.kind} />
                    <span className="tabular text-xs text-faint">{handle(t.number)}</span>
                  </div>
                  <h2 className="mt-1.5 font-heading text-[22px] leading-tight md:text-2xl">{t.title}</h2>
                </div>
                <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
                  ✕
                </button>
              </div>
              {/* The path: where it's been and what's next; tap a stage to move it there */}
              <ol className="no-scrollbar mt-3 flex gap-1 overflow-x-auto" aria-label="Stages">
                {path.map((s) => {
                  const here = s === t.stage;
                  const passed = path.indexOf(s) < path.indexOf(t.stage);
                  return (
                    <li key={s}>
                      <button type="button" disabled={here} onClick={() => setMoveTo(s)} className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] transition max-md:h-11 ${here ? "bg-fg text-bg" : passed ? "bg-ok-soft text-ok hover:opacity-80" : "border border-line text-muted hover:text-fg"}`}>
                        {passed && "✓ "}
                        {emailStageInfo(s).short}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </header>

            <div className="grid gap-5 px-4 py-5 md:px-7">
              <DirectionBanner kind="email" refId={t.id} />
              <div className="flex flex-wrap items-center gap-2">
                <NextStep d={d} onDone={changed} />
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <label className="grid gap-1 text-xs text-muted">
                  Assigned to
                  <select value={t.assigneeId ?? ""} onChange={async (e) => (await assignEmail(t.id, e.target.value || null), changed())} className={`${field} h-11`}>
                    <option value="">Nobody</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.role}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  Priority
                  <select value={t.priority} onChange={async (e) => (await setEmailPriority(t.id, e.target.value as EmailPriority), changed())} className={`${field} h-11`}>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  <span className="flex items-center justify-between">Send or live by {t.dueOn && <DuePill due={t.dueOn} className="!px-2 !py-0.5 !text-[11px]" />}</span>
                  <input type="date" value={t.dueOn ?? ""} onChange={async (e) => (await setEmailDue(t.id, e.target.value || null), changed())} className={`${field} h-11`} />
                </label>
              </div>

              {clientNotes.length > 0 && (
                <div className="rounded-[16px] border border-brand-text/30 bg-brand-soft/40 p-3 text-sm">
                  <p className="font-medium">The client asked for {clientNotes.length} {clientNotes.length === 1 ? "change" : "changes"}</p>
                  <p className="mt-0.5 text-muted">
                    {clientNotes.filter((c) => c.route === "copy").length} to copy (the strategist), {clientNotes.filter((c) => c.route === "design").length} to design (the designer)
                    {clientNotes.some((c) => !c.route) ? ", the rest being sorted" : ""}. Open each message to see them.
                  </p>
                </div>
              )}

              <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
                <section aria-label="Messages" className="grid content-start gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">{t.kind === "flow" ? "The flow" : "The sends"}</h3>
                    <span className="tabular text-xs text-faint">
                      {t.messages.length} of {MAX_MESSAGES[t.kind]}
                    </span>
                  </div>
                  {t.kind === "flow" ? (
                    <FlowSequence messages={t.messages} trigger={t.trigger} stage={t.stage} selected={m?.id ?? null} onPick={(id) => replaceParams({ m: id })} onReorder={async (id, dir) => (await moveMessage(id, dir), changed())} />
                  ) : (
                    <BatchTimeline messages={t.messages} stage={t.stage} selected={m?.id ?? null} onPick={(id) => replaceParams({ m: id })} />
                  )}
                  {t.messages.length < MAX_MESSAGES[t.kind] && (
                    <div className="flex gap-2">
                      {(["email", "sms"] as const).map((c) => (
                        <button key={c} type="button" onClick={async () => {
                          const r = await addMessage(t.id, c);
                          if (!r.ok) toast({ tone: "bad", title: "Couldn't add it", body: r.error });
                          changed();
                        }} className="h-11 flex-1 rounded-brand border border-dashed border-line text-sm text-muted hover:border-faint hover:text-fg">
                          + {c === "sms" ? "Text" : "Email"}
                        </button>
                      ))}
                    </div>
                  )}
                  {t.brief && (
                    <details className="rounded-[14px] border border-line bg-surface p-3 text-sm">
                      <summary className="min-h-8 cursor-pointer font-medium">The brief</summary>
                      <p className="mt-2 whitespace-pre-wrap leading-relaxed text-fg/80">{t.brief}</p>
                    </details>
                  )}
                </section>

                {m && (
                  <section aria-label="The message" className="grid content-start gap-4 rounded-[20px] border border-line bg-surface/40 p-3 md:p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate font-heading text-lg">{m.name}</h3>
                      <StatusChip s={messageStatus(liteOf(m), t.stage)} />
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm(`Remove ${m.name} from this ticket?`)) return;
                          const r = await removeMessage(m.id);
                          if (!r.ok) return toast({ tone: "bad", title: "Couldn't remove it", body: r.error });
                          replaceParams({ m: null });
                          changed();
                        }}
                        className="min-h-11 px-2 text-xs text-faint hover:text-bad"
                      >
                        Remove
                      </button>
                    </div>
                    {m.clientStatus === "changes" && m.clientNote && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-sm text-bad">The client: {m.clientNote}</p>}
                    <nav className="flex rounded-full bg-ink/[0.06] p-1 text-[13px]" aria-label="Message">
                      {(m.channel === "sms" ? (["copy", "build"] as const) : (["copy", "design", "links", "build"] as const)).map((k) => (
                        <button key={k} type="button" onClick={() => pushParams({ tab: k })} aria-current={shown === k ? "page" : undefined} className={`h-9 flex-1 rounded-full px-3 capitalize max-md:h-10 ${shown === k ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-muted hover:text-fg"}`}>
                          {k}
                        </button>
                      ))}
                    </nav>
                    {shown === "copy" && <CopyTab key={`${m.id}-${m.body}-${m.subject}`} m={m} kind={t.kind} canApprove={d.canApprove} ticketId={t.id} onSaved={changed} />}
                    {shown === "design" && m.channel === "email" && <DesignTab m={m} ticketId={t.id} comments={d.comments} drawingFor={drawingFor} setDrawingFor={setDrawingFor} onChanged={changed} />}
                    {shown === "links" && (
                      <LinksTab
                        key={`${m.id}-${JSON.stringify(m.links)}`}
                        m={m}
                        onChanged={changed}
                        place={(i) => {
                          setDrawingFor(`link:${i}`);
                          pushParams({ tab: "design" });
                          toast({ tone: "ok", title: "Drag over the button on the design" });
                        }}
                      />
                    )}
                    {shown === "build" && <BuildTab key={m.id} m={m} provider={t.provider} canApprove={d.canApprove} onChanged={changed} />}
                  </section>
                )}
              </div>

              <details className="rounded-[16px] border border-line p-3 text-sm">
                <summary className="min-h-8 cursor-pointer font-medium">History</summary>
                <ol className="mt-2 grid gap-1.5">
                  {d.events.map((e) => (
                    <li key={e.id} className="flex gap-3 text-[13px]">
                      <span className="tabular w-24 shrink-0 text-faint">{new Date(e.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}</span>
                      <span className="min-w-0 text-fg/80">
                        {e.actor && <span className="text-muted">{e.actor}: </span>}
                        {e.kind === "stage" && e.toStage ? `Moved to ${emailStageInfo(e.toStage as EmailStage).label}${e.body ? `. ${e.body}` : ""}` : (e.body ?? e.kind)}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            </div>
            {moveTo && (
              <EmailMoveDialog
                ticket={t}
                to={moveTo}
                onClose={() => setMoveTo(null)}
                onMoved={() => {
                  setMoveTo(null);
                  changed();
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
