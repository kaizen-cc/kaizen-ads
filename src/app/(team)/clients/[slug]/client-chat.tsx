"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { requestAudit } from "@/components/audit-watcher";
import type { ChatTurn } from "@/lib/handoff";
import { askClientAi, clearClientAi, loadClientAi } from "./actions";

// The AI on the client page: a button in the corner that opens a drawer, so the page itself doesn't get longer. Ask a
// question, strategize, bounce an idea off it, get a summary, or run the account audit (the same audit as on the KPI
// board; it shows on both). Each person has their own thread per client, kept between visits.

export type AuditTarget = { id: string; label: string; status: "none" | "queued" | "running" | "ready" | "failed"; auditId: string | null };

const STARTERS = [
  "Summarize where this account stands",
  "What should we test next, and why?",
  "What has the client told us lately?",
  "What could put this client at risk?",
];

function Bubble({ t }: { t: ChatTurn }) {
  const me = t.role === "user";
  return (
    <div className={`grid ${me ? "justify-items-end" : ""}`}>
      <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-[13.5px] leading-relaxed ${me ? "bg-fg text-bg" : "border border-white/[0.06] bg-white/[0.04] text-fg"}`}>{t.text}</p>
    </div>
  );
}

/**
 * floating: the corner button on the client page (the thread comes with the page). inline: a button where it's placed
 * (a KPI card), which loads the thread when opened. Either way it's the same thread, so a conversation started on the
 * KPI board is there on the client page and the other way round.
 */
export function ClientChat({ clientId, client, initial, targets, live, variant = "floating" }: { clientId: string; client: string; initial?: ChatTurn[]; targets: AuditTarget[]; live: boolean; variant?: "floating" | "inline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<ChatTurn[]>(initial ?? []);
  const [loaded, setLoaded] = useState(Boolean(initial));
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    void loadClientAi(clientId).then((turns) => {
      if (!live) return;
      setChat(turns);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [open, loaded, clientId]);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Braces: newer browsers return a promise from scrollIntoView, which React would take for a cleanup
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [chat, pending, open]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ask = async (text: string) => {
    if (!text.trim() || pending) return;
    setError(null);
    setPending(text);
    setQ("");
    const r = await askClientAi(clientId, text);
    setPending(null);
    if (r.ok) setChat(r.chat);
    else {
      setError(r.error);
      setQ(text);
    }
  };

  const audit = async (t: AuditTarget) => {
    setStarting(t.id);
    await requestAudit({ targetId: t.id }, client);
    setStarting(null);
    router.refresh();
  };

  return (
    <>
      {variant === "inline" ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:border-brand/50 hover:text-fg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          Ask about {client}
        </button>
      ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`fixed bottom-6 right-6 z-40 flex items-center gap-2.5 rounded-full border border-white/10 bg-[#141117] py-2.5 pl-3 pr-5 text-sm shadow-[0_20px_50px_-15px_rgba(200,16,46,0.55)] transition duration-300 hover:-translate-y-0.5 hover:border-white/25 ${open ? "pointer-events-none opacity-0" : ""}`}
      >
        <span className="relative grid h-8 w-8 place-items-center rounded-full bg-brand text-white">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-brand/40 [animation-duration:2.6s]" />
        </span>
        Ask about {client}
      </button>
      )}

      {open && <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />}
      <aside
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 grid w-full max-w-[460px] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden border-l border-white/[0.07] bg-[#0b0a0e] shadow-[-30px_0_80px_-30px_rgba(0,0,0,0.9)] transition-transform duration-300 ease-out ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
      >
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-[rgba(200,16,46,0.35)] blur-[90px]" />
        <header className="relative flex items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="grid gap-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/50">Account strategist</p>
            <h2 className="font-display text-2xl leading-tight tracking-tight">{client}</h2>
            <p className="text-xs text-white/50">Questions, strategy, ideas, a summary. It reads everything Kaizen Ads knows about the account, including the latest audit.</p>
          </div>
          <span className="flex shrink-0 gap-1.5">
            {chat.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  await clearClientAi(clientId);
                  setChat([]);
                }}
                className="h-8 rounded-full border border-white/10 px-3 text-xs text-white/55 hover:text-white"
              >
                New chat
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-white/55 hover:text-white">
              ×
            </button>
          </span>
        </header>

        {/* The account audit, the same one as on the KPI board */}
        <div className="relative mx-5 mb-3 grid gap-2 rounded-[14px] border border-white/[0.07] bg-white/[0.03] p-3">
          {targets.length === 0 ? (
            <p className="text-xs text-white/50">An audit needs a KPI with an ad account. Set one on the KPI board.</p>
          ) : (
            targets.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3">
                <span className="grid min-w-0">
                  <span className="truncate text-[13px]">Audit · {t.label}</span>
                  <span className="text-[11px] text-white/45">
                    {t.status === "running" ? "Running now, follow it on the page" : t.status === "queued" ? "Queued for a free slot" : t.status === "ready" ? "Last audit ready" : t.status === "failed" ? "The last one didn't finish" : "Never audited"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1.5">
                  {t.auditId && t.status === "ready" && (
                    <Link href={`/kpis/audit/${t.auditId}`} className="grid h-8 place-items-center rounded-full border border-white/10 px-3 text-xs text-white/65 hover:text-white">
                      Open
                    </Link>
                  )}
                  <button
                    type="button"
                    disabled={!live || starting === t.id || t.status === "running" || t.status === "queued"}
                    onClick={() => audit(t)}
                    className="h-8 rounded-full bg-fg px-3 text-xs text-bg disabled:opacity-40"
                  >
                    {starting === t.id ? "Starting…" : t.status === "none" ? "Run an audit" : "Run again"}
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="relative grid content-start gap-3 overflow-y-auto px-5 py-2">
          {!loaded && <p className="animate-pulse text-xs text-white/50">Loading your conversation about {client}…</p>}
          {loaded && !chat.length && !pending && (
            <div className="grid gap-2">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="rounded-[12px] border border-white/[0.08] px-3.5 py-2.5 text-left text-[13px] text-white/70 transition-colors hover:border-brand/50 hover:text-white">
                  {s}
                </button>
              ))}
            </div>
          )}
          {chat.map((t, i) => (
            <Bubble key={i} t={t} />
          ))}
          {pending && (
            <>
              <Bubble t={{ role: "user", text: pending, at: "" }} />
              <p className="flex items-center gap-2 text-xs text-white/50">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                Reading the account…
              </p>
            </>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
          <div ref={end} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
          className="relative flex items-end gap-2 border-t border-white/[0.07] p-4"
        >
          <textarea
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(q);
              }
            }}
            rows={2}
            placeholder="Ask, strategize, think out loud…"
            className="min-h-[46px] flex-1 resize-none rounded-[12px] border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[13.5px] outline-none placeholder:text-white/35 focus:border-brand/50"
          />
          <button type="submit" disabled={!q.trim() || Boolean(pending)} className="h-11 rounded-full bg-fg px-5 text-sm text-bg disabled:opacity-40">
            Ask
          </button>
        </form>
      </aside>
    </>
  );
}
