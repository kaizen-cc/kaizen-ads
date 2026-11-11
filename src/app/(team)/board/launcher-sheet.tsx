"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { ReportThis } from "@/components/report-this";
import { LaunchPanel } from "./launch-panel";
import { launchFor, type LaunchView } from "./launch-actions";
import { launchChat, type LaunchChatMessage } from "./ticket-done-actions";
import { Thinking } from "./brief-chat";
import type { Ticket } from "./types";

const messageKey = (i: number, t: string) => `${i}-${t.length}-${t.slice(0, 24)}`;

/**
 * The Ads launcher, popped out like the copy studio and the creative viewer: the launch plan and the ad build
 * (campaign, ad set, ads, copy) from the existing launcher, and beside it a chat with the media buyer AI to adjust the
 * campaign, the ad set, the budget or the names. Everything is still created paused.
 */
export function LauncherSheet({ ticket, isExec, onClose, demo = false }: { ticket: Ticket; isExec: boolean; onClose: () => void; demo?: boolean }) {
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [panelKey, setPanelKey] = useState(0);
  const [messages, setMessages] = useState<LaunchChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void launchFor(ticket.id).then((l) => live && setLaunch(l));
    return () => {
      live = false;
    };
  }, [ticket.id, demo, panelKey]);
  // The plan can still be on its way (planning in the background): check back while it is
  const settling = !launch || launch.status === "planning" || launch.status === "launching";
  useEffect(() => {
    if (demo || !settling) return;
    const t = setInterval(() => void launchFor(ticket.id).then(setLaunch), 4000);
    return () => clearInterval(t);
  }, [ticket.id, demo, settling]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[data-launch-confirm]") && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy || !launch) return;
    setError(null);
    setText("");
    const before = messages;
    setMessages([...before, { role: "user", text: t, at: new Date().toISOString() }]);
    setBusy(true);
    const r = await launchChat(launch.id, t, before);
    setBusy(false);
    if (!r.ok) {
      setMessages(before);
      setText(t);
      return setError(r.error);
    }
    setMessages(r.messages);
    if (r.launch) setLaunch(r.launch);
    // The plan changed: the launcher reads it again
    if (r.messages.at(-1)?.changes?.length) setPanelKey((k) => k + 1);
  };
  const turns = () => messages.map((m) => ({ role: m.role === "user" ? "user" : "ai", text: m.text, at: m.at }));
  const canChat = Boolean(launch?.plan) && launch?.status !== "launching" && launch?.status !== "launched";

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] grid bg-black/70 backdrop-blur-sm md:place-items-center md:p-6 animate-[sheet-fade_.2s_ease-out]" role="dialog" aria-modal="true" aria-label="Ads launcher" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg shadow-2xl md:h-[92vh] md:max-w-[1180px] md:rounded-[20px] md:border md:border-line">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:px-4 md:pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Ads launcher · #{ticket.number}</p>
            <p className="truncate font-heading text-[17px]">{ticket.title}</p>
          </div>
          <span className="hidden text-xs text-faint sm:inline">Created paused, turned on in Ads Manager</span>
          <button type="button" onClick={onClose} aria-label="Close the launcher" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
        </header>
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_360px] md:overflow-hidden">
          {/* The plan and the build: the existing launcher */}
          <div className="min-w-0 px-6 py-5 max-md:px-4 md:overflow-y-auto">
            {demo ? <p className="rounded-[12px] border border-dashed border-line px-4 py-5 text-sm text-faint">The launcher opens here on a live ticket.</p> : <LaunchPanel key={panelKey} requestId={ticket.id} isExec={isExec} launched={ticket.stage === "launched"} />}
          </div>
          {/* The media buyer AI */}
          <aside className="grid min-h-[320px] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 border-line bg-surface px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:border-t md:min-h-0 md:border-l">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Media buyer AI</p>
              <p className="text-xs text-muted">Ask it to move the ads to another ad set or campaign, clone a new ad set, change the budget, the link or the names.</p>
            </div>
            <ul className="grid min-h-0 content-start gap-2.5 overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <li key={i} className={`grid gap-1 ${m.role === "user" ? "justify-items-end" : "justify-items-start"}`}>
                  <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-brand text-white" : "bg-bg"}`}>{m.text}</p>
                  {m.changes?.map((c, j) => (
                    <span key={j} className="max-w-[92%] rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">
                      {c}
                    </span>
                  ))}
                  {m.role === "assistant" && <ReportThis chat="ticket-launch" messageId={messageKey(i, m.text)} threadId={ticket.id} text={m.text} turns={turns} clientSlug={ticket.clientSlug} />}
                </li>
              ))}
              {busy && <Thinking who="The media buyer is on it" />}
              <div ref={end} />
            </ul>
            <div className="grid gap-1.5">
              {error && <p className="text-xs text-bad">{error}</p>}
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
                  disabled={!canChat}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder={canChat ? "e.g. Put it in the prospecting campaign at $50 a day" : launch?.status === "launched" ? "Launched: changes are made in Ads Manager." : "The plan is on its way…"}
                  aria-label="Message the media buyer"
                  className="min-h-11 min-w-0 flex-1 resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 disabled:opacity-60 max-md:text-base"
                />
                <button disabled={busy || !canChat || !text.trim()} className="h-11 shrink-0 rounded-[12px] bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40">
                  Send
                </button>
              </form>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
