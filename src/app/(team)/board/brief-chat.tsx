"use client";

import { useEffect, useRef, useState } from "react";
import { ReportThis } from "@/components/report-this";
import { askAboutBrief, briefChat, type BriefChatMessage } from "./brief-chat-actions";
import { card, label } from "./ticket-parts";
import type { Ticket } from "./types";

const messageKey = (i: number, t: string) => `${i}-${t.length}-${t.slice(0, 24)}`;

const STARTERS = ["What's the one thing this has to nail?", "Which assets do I use, and where are they?", "What can't I change?"];

/**
 * Questions about the brief, before production starts: compact (the last answer and a field), expands into the whole
 * conversation. Answered by the AI with the brief, the client's context and the Brand Bible.
 */
export function BriefChat({ ticket, demo = false }: { ticket: Ticket; demo?: boolean }) {
  const [messages, setMessages] = useState<BriefChatMessage[] | null>(demo ? [] : null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (demo) return;
    let live = true;
    briefChat(ticket.id).then((r) => live && setMessages(r.messages));
    return () => {
      live = false;
    };
  }, [ticket.id, demo]);
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, open]);

  const send = async (q = text) => {
    const t = q.trim();
    if (!t || busy) return;
    setError(null);
    setText("");
    setOpen(true);
    const before = messages ?? [];
    const mine: BriefChatMessage = { role: "user", text: t, at: new Date().toISOString(), by: "You" };
    setMessages([...before, mine]);
    setBusy(true);
    if (demo) {
      await new Promise((r) => setTimeout(r, 900));
      setMessages([...before, mine, { role: "assistant", text: "The brief's Must is the price in the first second: lead with it on the first frame, then the product.", at: new Date().toISOString(), by: null }]);
      setBusy(false);
      return;
    }
    const r = await askAboutBrief(ticket.id, t, before);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setText(t);
      setMessages(before);
      return;
    }
    setMessages(r.messages);
  };

  const list = messages ?? [];
  const last = [...list].reverse().find((m) => m.role === "assistant") ?? null;
  const shown = open ? list : [];
  const turns = () => list.map((m) => ({ role: m.role === "user" ? "user" : "ai", text: m.text, at: m.at, name: m.by }));

  return (
    <section className={card} aria-label="Questions about the brief">
      <div className="flex items-center justify-between gap-3">
        <p className={label}>Ask about the brief</p>
        {list.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-my-2 -mr-2 min-h-11 rounded-full px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg">
            {open ? "Hide" : `Show all ${list.length}`}
          </button>
        )}
      </div>

      {open ? (
        <ul className="grid max-h-[46vh] gap-2.5 overflow-y-auto pr-1">
          {shown.map((m, i) => (
            <li key={i} className={`grid gap-1 ${m.role === "user" ? "justify-items-end" : "justify-items-start"}`}>
              <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-brand text-white" : "bg-surface-2"}`}>{m.text}</p>
              {m.role === "assistant" && !demo && <ReportThis chat="ticket-brief" messageId={messageKey(i, m.text)} threadId={ticket.id} text={m.text} turns={turns} clientSlug={ticket.clientSlug} />}
            </li>
          ))}
          {busy && <Thinking />}
          <div ref={end} />
        </ul>
      ) : last ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-[12px] bg-surface-2 px-3.5 py-2.5 text-left text-sm leading-relaxed hover:bg-line/60">
          <span className="line-clamp-3">{last.text}</span>
        </button>
      ) : busy ? (
        <Thinking />
      ) : messages === null ? null : (
        <div className="flex flex-wrap gap-1.5">
          {STARTERS.map((s) => (
            <button key={s} type="button" onClick={() => void send(s)} className="min-h-11 rounded-full border border-line px-3.5 text-left text-xs text-muted hover:border-faint hover:text-fg md:min-h-9">
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}
      {error && !demo && <ReportThis chat="ticket-brief" messageId={`error-${messageKey(list.length, error)}`} threadId={ticket.id} error={error} turns={turns} clientSlug={ticket.clientSlug} />}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          data-chat
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder="Ask anything about the brief"
          aria-label="Ask about the brief"
          className="max-h-32 min-h-11 min-w-0 flex-1 resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 max-md:text-base"
        />
        <button disabled={busy || !text.trim()} className="h-11 shrink-0 rounded-[12px] bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40">
          Ask
        </button>
      </form>
    </section>
  );
}

export function Thinking({ who = "Thinking" }: { who?: string }) {
  return (
    <li className="flex list-none items-center gap-1.5 text-xs text-faint">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9aa7f0]" />
      {who}…
    </li>
  );
}
