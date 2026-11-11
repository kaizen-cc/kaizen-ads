"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";
import { reportFromChat } from "@/app/(team)/feedback/actions";
import { fallShort, trimTurns, type ChatKind } from "@/lib/chat-report";
import { buildTranscript, type TranscriptEntry } from "@/lib/chat-transcript";
import { toast } from "./toasts";

// "Report this" under an AI message that failed, "Ask for this" under one that says it can't do something, in every
// chat. One tap opens a tiny confirm with an optional note; Send files it through the same feedback as the bubble,
// with the whole conversation (read on the server from the stored chat where there is one), the error, the client
// and the page. Afterwards the message reads "Reported · we're on it" with a link to where it stands. Never twice on
// the same message: what's been reported is remembered for this tab, and the server answers a repeat with the first.

export type ReportTurn = { role: string; text: string; at?: string | null; name?: string | null };

const KEY = "kz-chat-reported";
const listeners = new Set<() => void>();
let reported: Record<string, string> | null = null;
const read = () => {
  if (reported) return reported;
  try {
    reported = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    reported = {};
  }
  return reported;
};
const remember = (key: string, id: string) => {
  reported = { ...read(), [key]: id };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(reported));
  } catch {}
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function ReportThis(props: {
  chat: ChatKind;
  messageId: string;
  threadId?: string | null;
  /** The AI's reply (read for "I can't...") */
  text?: string | null;
  /** The error shown on the message, and its code */
  error?: string | null;
  code?: string | null;
  /** The server flagged a failed tool or step on this message */
  failed?: boolean | null;
  /** The whole chat as the browser has it, oldest first (the server reads the stored one where there is one) */
  turns: () => ReportTurn[];
  /** A richer copy (tool calls and errors), when the browser has one */
  entries?: () => TranscriptEntry[];
  /** What surrounds the chat: a brief draft, a launch card's state */
  state?: () => Record<string, unknown> | null;
  clientSlug?: string | null;
  className?: string;
}) {
  const mode = fallShort({ text: props.text, error: props.error, failed: props.failed });
  const key = `${props.chat}:${props.threadId ?? ""}:${props.messageId}`;
  const done = useSyncExternalStore(subscribe, () => read()[key] ?? null, () => null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  if (!mode) return null;

  const wrap = `flex flex-wrap items-center gap-2 ${props.className ?? ""}`;
  if (done)
    return (
      <p className={`${wrap} text-[12.5px] text-muted`} role="status">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
          Reported · we&apos;re on it
        </span>
        <Link href="/feedback?tab=mine" className="inline-flex min-h-11 items-center text-brand-text underline-offset-2 hover:underline md:min-h-8">
          See where it stands
        </Link>
      </p>
    );

  const label = mode === "error" ? "Report this" : "Ask for this";
  const send = async () => {
    setSending(true);
    const url = new URL(window.location.href);
    const all = props.turns();
    const r = await reportFromChat({
      mode,
      chat: props.chat,
      threadId: props.threadId ?? null,
      messageId: props.messageId,
      // The last few turns for the report's words; the whole chat as entries, kept under the request size limit
      // (long tool output is cut first, never a person's words; the server reads the stored chat where there is one)
      turns: trimTurns(all),
      entries: buildTranscript({ chat: props.chat, source: "client", threadId: props.threadId ?? null, state: null, entries: props.entries?.() ?? all.map((t) => ({ role: t.role === "user" ? "user" : "ai", at: t.at ?? null, text: t.text, name: t.name ?? null })) }, 600_000).entries,
      state: props.state?.() ?? null,
      error: props.error || props.code ? { text: props.error ?? null, code: props.code ?? null } : null,
      clientSlug: props.clientSlug ?? url.pathname.match(/^\/clients\/([^/]+)/)?.[1] ?? null,
      note,
      path: `${url.pathname}${url.search}`,
      pageUrl: url.href,
    }).catch(() => ({ error: "That didn't send. Check your connection and try again." }));
    setSending(false);
    if ("error" in r) {
      toast({ tone: "bad", title: r.error });
      return;
    }
    remember(key, r.id);
    setOpen(false);
  };

  if (!open)
    return (
      <div className={wrap}>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => box.current?.focus());
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-muted transition-colors hover:border-faint/60 hover:text-fg md:min-h-8"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {mode === "error" ? <path d="M4 22V4a1 1 0 0 1 1-1h11l-2 4 2 4H5" /> : <path d="M12 5v14M5 12h14" />}
          </svg>
          {label}
        </button>
      </div>
    );

  return (
    <div className={`grid w-full max-w-md gap-2 rounded-[14px] border border-line bg-surface p-3 shadow-sm ${props.className ?? ""}`}>
      <p className="text-[13px] text-fg">{mode === "error" ? "Send this to be fixed? The whole chat and the error go with it." : "Ask for this? The whole chat goes with it, to the owner."}</p>
      <textarea
        ref={box}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Anything to add (optional)"
        className="w-full resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[15px] text-fg outline-none placeholder:text-faint focus:border-brand-text/70 md:text-[13px]"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} disabled={sending} className="min-h-11 rounded-full px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
          Cancel
        </button>
        <button type="button" onClick={() => void send()} disabled={sending} className="min-h-11 rounded-full bg-brand px-4 text-[13px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60 md:min-h-9">
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
