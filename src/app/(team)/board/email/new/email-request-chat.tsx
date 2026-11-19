"use client";

import { useEffect, useRef, useState } from "react";
import { ChatSession, type ChatLine } from "@/lib/agent-call/chat-engine";
import { ackCallNotice, endCall, startCall } from "@/app/(team)/settings/call-actions";
import { Spark } from "@/app/(team)/requests/new/parts";

/**
 * "Talk it through" on the email request form: a typed conversation with the Email Strategist, the same pipeline as a
 * call or the assistant's chat (/api/agent-call/turn, the deliverable flow: type and count, ideas, the copywriter, the
 * copy document). It opens already about this client; the moment the copy document is written, the form moves to the
 * Copy step with it (onCopy). Leaving ends the conversation (what was said stays for review).
 */
export function EmailRequestChat({ clientId, clientName, seed, onCopy, onBack }: { clientId: string; clientName: string; seed: string | null; onCopy: (docId: string) => void; onBack: () => void }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const session = useRef<ChatSession | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef(onCopy);
  useEffect(() => {
    copyRef.current = onCopy;
  }, [onCopy]);

  const open = async (acked = false) => {
    setError(null);
    if (acked) {
      const a = await ackCallNotice();
      if (!a.ok) return setError(a.error);
      setNotice(null);
    }
    const r = await startCall("email_strategist", { talk: "text" });
    if (!r.ok) {
      if (r.needsNotice) return setNotice(r.error);
      return setError(r.error);
    }
    const s = new ChatSession({
      onLine: (l) => setLines((all) => (all.some((x) => x.id === l.id) ? all.map((x) => (x.id === l.id ? l : x)) : [...all, l])),
      onBusy: setBusy,
      onError: setError,
      onProgress: (p) => setProgress(p ? p.step : null),
      onCard: (c) => {
        if (c.copy?.id) copyRef.current(c.copy.id);
      },
    });
    s.callId = r.callId;
    s.context = { screen: "the new email request form", clientId, client: clientName };
    session.current = s;
    setReady(true);
    if (r.greeting) setLines([{ id: 0, who: "agent", text: r.greeting }]);
    s.send(seed?.trim() ? `Let's put together an email request for ${clientName}. ${seed}` : `Let's put together an email request for ${clientName}.`);
  };

  useEffect(() => {
    void Promise.resolve().then(() => open());
    return () => {
      const s = session.current;
      session.current = null;
      if (s) {
        s.close();
        void endCall(s.callId).catch(() => null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length, busy]);

  const send = () => {
    if (!text.trim() || !session.current) return;
    session.current.send(text);
    setText("");
  };

  return (
    <section aria-label="Talk it through with the Email Strategist" className="grid gap-4 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-brand/15 text-brand-text">
            <Spark size={14} />
          </span>
          <div className="grid">
            <p className="text-[14.5px] font-medium text-fg">Email Strategist</p>
            <p className="text-[12px] text-faint">The copywriter joins once the ideas are agreed</p>
          </div>
        </div>
        <button type="button" onClick={onBack} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
          Other ways to start
        </button>
      </div>

      {notice && (
        <div className="grid gap-3 rounded-[16px] border border-line bg-surface-2/60 p-4">
          <p className="text-[13.5px] text-fg">{notice}</p>
          <button type="button" onClick={() => void open(true)} className="justify-self-start rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-hover">
            Got it, start
          </button>
        </div>
      )}

      <div className="grid max-h-[55vh] min-h-[220px] content-start gap-3 overflow-y-auto pr-1">
        {lines.map((l) => (
          <div key={l.id} className={`flex ${l.who === "you" ? "justify-end" : "justify-start"}`}>
            <p
              className={`max-w-[85%] whitespace-pre-wrap rounded-[18px] px-4 py-2.5 text-[14.5px] leading-relaxed [overflow-wrap:anywhere] ${
                l.who === "you" ? "bg-fg text-bg" : "bg-surface-2 text-fg"
              } ${l.note ? "italic opacity-70" : ""}`}
            >
              {l.speaker && l.who === "agent" && <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{l.speaker.label}</span>}
              {l.text}
              {l.streaming && <span className="ml-1 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-faint align-middle" />}
            </p>
          </div>
        ))}
        {busy && !lines.some((l) => l.streaming) && <p className="text-[13px] text-faint">{progress ?? "Thinking…"}</p>}
        <div ref={endRef} />
      </div>

      {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}

      <div className="flex items-end gap-2">
        <label htmlFor="email-chat" className="sr-only">
          Message the Email Strategist
        </label>
        <textarea
          id="email-chat"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Two campaigns for the holiday sale, or a welcome flow…"
          className="max-h-40 min-h-12 flex-1 resize-none rounded-[16px] border border-line bg-bg px-4 py-3 text-[16px] leading-snug text-fg outline-none transition-colors focus:border-faint md:text-[14.5px]"
        />
        <button type="button" onClick={send} disabled={!text.trim() || !ready} className="inline-flex min-h-12 shrink-0 items-center rounded-full bg-brand px-5 text-[14px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50">
          Send
        </button>
      </div>
    </section>
  );
}
