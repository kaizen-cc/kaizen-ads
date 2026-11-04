"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { WhyKind, WhyMessage } from "@/lib/audit-why";
import { askWhyAction, loadWhy, teachWhy } from "@/app/(team)/kpis/why-actions";

// "Why?" on an audit item or a sprint move: a small chat with the agent that wrote it (team only, never clients).
// It answers from the audit's own numbers; when someone disagrees and says why, it offers the lesson it would take,
// and "Teach the agent this" saves it so the next audits of the client learn it. Open in the address (?why=), so
// back closes it.

export function AuditWhy({ kind, auditId, itemKey, count = 0, agent = "auditor" }: { kind: WhyKind; auditId: string; itemKey: string; count?: number; agent?: "auditor" | "google_auditor" }) {
  const id = `${auditId}~${itemKey}`;
  const open = useParam("why") === id;
  const [messages, setMessages] = useState<WhyMessage[] | null>(null);
  const [canTeach, setCanTeach] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [teaching, startTeach] = useTransition();
  const [loading, startLoad] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const who = agent === "google_auditor" ? "Google auditor" : "Auditor";

  useEffect(() => {
    if (!open || messages) return;
    startLoad(async () => {
      const r = await loadWhy(kind, auditId, itemKey);
      if (!r.ok) return setError(r.error);
      setMessages(r.messages);
      setCanTeach(r.canTeach);
    });
  }, [open, messages, kind, auditId, itemKey]);

  useEffect(() => {
    if (open && (thinking || messages?.length)) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open, thinking, messages?.length]);

  const ask = async () => {
    const q = text.trim();
    if (!q || thinking) return;
    setError(null);
    setText("");
    // The question shows at once; the answer follows
    setMessages((m) => [...(m ?? []), { id: `q-${Date.now()}`, role: "person", body: q, by: "You", at: new Date().toISOString(), lesson: null, taught: false }]);
    setThinking(true);
    const r = await askWhyAction(kind, auditId, itemKey, q);
    setThinking(false);
    if (!r.ok) return setError(r.error);
    setMessages((m) => [...(m ?? []), r.answer]);
  };

  const teach = (m: WhyMessage) =>
    startTeach(async () => {
      setError(null);
      setMessages((ms) => (ms ?? []).map((x) => (x.id === m.id ? { ...x, taught: true } : x)));
      const r = await teachWhy(m.id);
      if (!r.ok) {
        setError(r.error);
        setMessages((ms) => (ms ?? []).map((x) => (x.id === m.id ? { ...x, taught: false } : x)));
      }
    });

  const total = Math.max(count, messages?.length ?? 0);
  if (!open)
    return (
      <button type="button" onClick={() => pushParams({ why: id })} className="-my-2 inline-flex min-h-11 items-center gap-1.5 justify-self-start py-2 text-[12px] text-faint transition-colors hover:text-fg md:my-0 md:min-h-0 md:py-0 md:text-[11.5px]">
        <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full border border-current text-[9px] font-semibold">?</span>
        Why?{total ? <span className="tabular text-muted">· {total}</span> : null}
      </button>
    );

  return (
    <div className="grid min-w-0 gap-3 rounded-[14px] border border-line bg-bg/60 p-3 md:p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
          Ask the {who.toLowerCase()} why
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal">Team only</span>
        </p>
        <button type="button" onClick={() => closeParams("why")} className="-my-2 min-h-11 px-2 text-[12px] text-faint hover:text-fg md:my-0 md:min-h-0 md:px-0 md:text-[11px]">
          Close
        </button>
      </div>

      {loading && !messages && <p className="text-[12.5px] text-faint">Opening the thread…</p>}
      {messages && messages.length === 0 && !thinking && <p className="text-[12.5px] leading-relaxed text-muted">Ask what this is based on, or say why you disagree. The {who.toLowerCase()} answers from the numbers this audit read and the client page.</p>}

      {(messages?.length || thinking) && (
        <div className="grid max-h-[420px] gap-2.5 overflow-y-auto overscroll-contain pr-0.5">
          {(messages ?? []).map((m) =>
            m.role === "person" ? (
              <div key={m.id} className="grid justify-items-end gap-0.5">
                <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-surface-2 px-3 py-2 text-[13px] leading-relaxed">{m.body}</p>
                <span className="text-[10.5px] text-faint">{m.by ?? "Team"}</span>
              </div>
            ) : (
              <div key={m.id} className="grid gap-2">
                <div className="grid gap-0.5">
                  <span className="text-[10.5px] font-medium text-brand-text">{who}</span>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{m.body}</p>
                </div>
                {m.lesson && (
                  <div className="grid gap-2 rounded-[12px] border border-brand/30 bg-brand-soft/40 px-3 py-2.5">
                    <p className="text-[12.5px] leading-relaxed">
                      <span className="font-medium">What I&apos;d learn from this: </span>
                      <span className="text-muted">{m.lesson}</span>
                    </p>
                    {m.taught ? (
                      <p className="text-[12px] text-ok">✓ Taught. The next audits of this client read it.</p>
                    ) : canTeach ? (
                      <button type="button" disabled={teaching} onClick={() => teach(m)} className="min-h-11 justify-self-start rounded-full bg-fg px-4 text-[12.5px] font-medium text-bg disabled:opacity-60 md:min-h-8">
                        Teach the agent this
                      </button>
                    ) : (
                      <p className="text-[11.5px] text-faint">Someone with the audit pushback permission can teach it this.</p>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {thinking && (
            <p className="flex items-center gap-2 text-[12.5px] text-muted">
              <span className="flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint [animation-delay:300ms]" />
              </span>
              Going back through the numbers…
            </p>
          )}
          <div ref={end} />
        </div>
      )}

      {error && <p className="text-[12px] text-bad">{error}</p>}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <textarea
          data-chat
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          rows={2}
          placeholder="Why this? Or say why you disagree…"
          className="min-h-11 w-full resize-none rounded-[12px] border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-faint"
        />
        <button type="button" disabled={!text.trim() || thinking} onClick={() => void ask()} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
          {thinking ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
