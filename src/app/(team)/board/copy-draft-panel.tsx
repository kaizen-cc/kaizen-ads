"use client";

import { useEffect, useRef, useState } from "react";
import { ReportThis } from "@/components/report-this";
import type { CreativeCopy } from "@/lib/ticket-copy";
import { chatCopyDraft, copyDraft, startCopyDraft, undoCopyDraft, type CopyDraftState } from "./ticket-copy-actions";
import { Thinking } from "./brief-chat";
import { card, label } from "./ticket-parts";
import type { Ticket } from "./types";

const messageKey = (i: number, t: string) => `${i}-${t.length}-${t.slice(0, 24)}`;

const DEMO: CopyDraftState = {
  status: "ready",
  progress: null,
  content: { kind: "frames", versions: [{ label: "V1", headline: "$8 Calzone Mondays", subline: "Cut open, cheese pulled, every Monday" }, { label: "V2", headline: "Monday tastes better at $8", subline: "Our calzone, fresh from the oven" }] },
  changes: [],
  canUndo: false,
  messages: [],
  error: null,
  setup: true,
  updatedAt: null,
};

/** The copy the maker builds from: the script's scenes, or the headlines per version and slide */
function CopyBody({ c }: { c: CreativeCopy }) {
  if (c.kind === "frames")
    return (
      <ul className="grid gap-2">
        {c.versions.map((v) => (
          <li key={v.label} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-[12px] bg-bg/60 px-3.5 py-3">
            <span className="tabular pt-0.5 text-xs font-semibold text-brand-text">{v.label}</span>
            <span className="grid gap-0.5">
              <span className="text-[15px] font-medium leading-snug">{v.headline || <span className="text-faint">No headline</span>}</span>
              {v.subline && <span className="text-sm leading-relaxed text-muted">{v.subline}</span>}
            </span>
          </li>
        ))}
      </ul>
    );
  if (c.kind === "slides")
    return (
      <div className="grid gap-3">
        {c.versions.map((v) => (
          <div key={v.label} className="grid gap-1.5">
            <span className="tabular text-xs font-semibold text-brand-text">{v.label}</span>
            <ol className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
              {v.slides.map((s, i) => (
                <li key={i} className="grid w-44 shrink-0 snap-start content-start gap-1 rounded-[12px] bg-bg/60 px-3 py-2.5">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Slide {i + 1}</span>
                  <span className="text-sm font-medium leading-snug">{s.headline || <span className="text-faint">No text</span>}</span>
                  {s.subline && <span className="text-xs leading-relaxed text-muted">{s.subline}</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    );
  const s = c.script;
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">
        {s.title} · {s.lengthSeconds}s · {s.placement}
      </p>
      {s.hooks.length > 0 && (
        <div className="grid gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-faint">Hooks</span>
          <ul className="grid gap-1">
            {s.hooks.map((h, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="mr-1.5 text-xs text-faint">{i + 1}</span>
                <span className="font-medium">{h.onScreen}</span> <span className="text-muted">&ldquo;{h.spoken}&rdquo;</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol className="grid gap-2">
        {s.beats.map((b, i) => (
          <li key={i} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 rounded-[12px] bg-bg/60 px-3.5 py-3">
            <span className="tabular pt-0.5 text-xs font-semibold text-brand-text">{b.time}</span>
            <span className="grid gap-1 text-sm leading-relaxed">
              <span className="text-muted">{b.shot}</span>
              {b.onScreen && (
                <span>
                  <span className="mr-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">On screen</span>
                  <span className="font-medium">{b.onScreen}</span>
                </span>
              )}
              {b.voiceover && (
                <span>
                  <span className="mr-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">VO</span>&ldquo;{b.voiceover}&rdquo;
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {s.cta && (
        <p className="text-sm">
          <span className="mr-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">CTA</span>
          {s.cta}
        </p>
      )}
    </div>
  );
}

/**
 * Copy / Script in production: what the AI copywriter wrote the moment production started, and a chat with the
 * copywriter to fine-tune it. Every change updates the copy in place, says what changed and can be undone.
 */
export function CopyDraftPanel({ ticket, demo = false, starting = false }: { ticket: Ticket; demo?: boolean; /** Start production just started the copywriter (its first save may not be in yet) */ starting?: boolean }) {
  const [state, setState] = useState<CopyDraftState | null>(demo ? DEMO : null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "chat" | "undo" | "start">(null);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const title = ticket.format === "video" ? "Script" : "Copy";

  useEffect(() => {
    if (demo) return;
    let live = true;
    copyDraft(ticket.id).then((s) => live && setState(starting && s.status === "none" ? { ...s, status: "writing", progress: "Starting" } : s));
    return () => {
      live = false;
    };
  }, [ticket.id, demo, starting]);

  // While the copywriter writes, check back every couple of seconds
  const writing = state?.status === "writing";
  useEffect(() => {
    if (demo || !writing) return;
    const since = Date.now();
    // Nothing saved after a few minutes: it didn't start (shown as not written, with the button to write it)
    const t = setInterval(() => void copyDraft(ticket.id).then((s) => setState((was) => (s.status === "none" && was?.status === "writing" && Date.now() - since < 240_000 ? was : s))), 2500);
    return () => clearInterval(t);
  }, [writing, ticket.id, demo]);
  useEffect(() => {
    if (chatOpen) end.current?.scrollIntoView({ block: "end" });
  }, [state?.messages.length, busy, chatOpen]);

  const start = async () => {
    setError(null);
    setBusy("start");
    const r = await startCopyDraft(ticket.id);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setState(r.state);
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    setText("");
    setChatOpen(true);
    setBusy("chat");
    if (demo) {
      await new Promise((r) => setTimeout(r, 900));
      setBusy(null);
      return;
    }
    const r = await chatCopyDraft(ticket.id, t);
    setBusy(null);
    if (!r.ok) {
      setText(t);
      return setError(r.error);
    }
    setState(r.state);
  };
  const undo = async () => {
    setError(null);
    setBusy("undo");
    const r = await undoCopyDraft(ticket.id);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setState(r.state);
  };

  const messages = state?.messages ?? [];
  const turns = () => messages.map((m) => ({ role: m.role === "user" ? "user" : "ai", text: m.text, at: m.at, name: m.by }));

  return (
    <section className={card} aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        <p className={label}>{title}</p>
        {state?.status === "ready" && state.canUndo && (
          <button type="button" disabled={Boolean(busy)} onClick={undo} className="-my-2 -mr-2 min-h-11 rounded-full px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
            {busy === "undo" ? "Undoing…" : "↶ Undo last change"}
          </button>
        )}
      </div>

      {state === null ? (
        <span className="h-16 animate-pulse rounded-[12px] bg-surface-2" />
      ) : state.status === "writing" ? (
        <div className="grid gap-2 rounded-[12px] bg-bg/60 px-4 py-3.5">
          <p className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#9aa7f0]" />
            The AI copywriter is writing the {ticket.format === "video" ? "script" : "copy"}
          </p>
          <span className="relative h-1 overflow-hidden rounded-full bg-surface-2">
            <span className="absolute inset-y-0 left-0 w-1/3 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-[#9aa7f0]" />
          </span>
          {state.progress && <p className="text-xs text-faint">{state.progress}…</p>}
        </div>
      ) : state.content ? (
        <>
          {state.changes.length > 0 && (
            <div className="grid gap-1 rounded-[12px] border border-[#9aa7f0]/40 bg-[#9aa7f0]/10 px-3.5 py-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7d8be0]">What changed</span>
              <ul className="grid gap-0.5 text-xs leading-relaxed text-fg/85">
                {state.changes.slice(0, 6).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
                {state.changes.length > 6 && <li className="text-faint">and {state.changes.length - 6} more</li>}
              </ul>
            </div>
          )}
          <CopyBody c={state.content} />
        </>
      ) : (
        <div className="grid justify-items-start gap-3 rounded-[12px] border border-dashed border-line px-4 py-4">
          <p className="text-sm text-muted">
            {state.status === "failed" ? (state.error ?? "The copywriter couldn't finish.") : `No ${ticket.format === "video" ? "script" : "copy"} yet.`} The AI copywriter writes it from the brief{ticket.format === "video" ? ": scenes, voiceover and on-screen lines." : ticket.format === "carousel" ? ": a headline and subline per slide, per version." : ": a headline and subheadline per version."}
          </p>
          {!demo && (
            <button type="button" disabled={busy === "start"} onClick={start} className="min-h-11 rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-50">
              {busy === "start" ? "Starting…" : `Write the ${ticket.format === "video" ? "script" : "copy"}`}
            </button>
          )}
        </div>
      )}

      {/* The chat with the copywriter: what the maker uses to get the copy right */}
      {state && state.status !== "writing" && (state.content || messages.length > 0) && (
        <div className="grid gap-2.5 border-t border-line pt-3">
          {messages.length > 0 && (
            <button type="button" onClick={() => setChatOpen((o) => !o)} aria-expanded={chatOpen} className="-my-1 min-h-11 justify-self-start text-xs text-muted hover:text-fg">
              {chatOpen ? "Hide the conversation" : `The conversation · ${messages.length}`}
            </button>
          )}
          {chatOpen && messages.length > 0 && (
            <ul className="grid max-h-[40vh] gap-2.5 overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <li key={i} className={`grid gap-1 ${m.role === "user" ? "justify-items-end" : "justify-items-start"}`}>
                  <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-brand text-white" : "bg-surface-2"}`}>{m.text}</p>
                  {m.changes && m.changes.length > 0 && <span className="text-[11px] text-[#7d8be0]">Changed {m.changes.length === 1 ? "1 line" : `${m.changes.length} lines`}</span>}
                  {m.role === "assistant" && !demo && <ReportThis chat="ticket-copy" messageId={messageKey(i, m.text)} threadId={ticket.id} text={m.text} turns={turns} clientSlug={ticket.clientSlug} />}
                </li>
              ))}
              {busy === "chat" && <Thinking who="The copywriter is on it" />}
              <div ref={end} />
            </ul>
          )}
          {!chatOpen && busy === "chat" && (
            <ul>
              <Thinking who="The copywriter is on it" />
            </ul>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
          {error && !demo && <ReportThis chat="ticket-copy" messageId={`error-${messageKey(messages.length, error)}`} threadId={ticket.id} error={error} turns={turns} clientSlug={ticket.clientSlug} />}
          {state.setup ? (
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
                placeholder={ticket.format === "video" ? "e.g. Make scene 2 shorter and say the price out loud" : "e.g. Shorter V2 headline, and lead with the price"}
                aria-label="Message the copywriter"
                className="max-h-32 min-h-11 min-w-0 flex-1 resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 max-md:text-base"
              />
              <button disabled={Boolean(busy) || !text.trim()} className="h-11 shrink-0 rounded-[12px] bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40">
                Send
              </button>
            </form>
          ) : (
            <p className="text-xs text-faint">The chat with the copywriter turns on once its database update is applied.</p>
          )}
        </div>
      )}
      {error && (!state || state.status === "writing" || (!state.content && !messages.length)) && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
