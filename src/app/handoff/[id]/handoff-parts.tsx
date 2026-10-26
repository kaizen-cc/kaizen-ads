"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ChatTurn } from "@/lib/handoff";
import { askAccount, markHandoffSeen, rewriteHandoff } from "../actions";

export function HandoffBar({ id, slug, ready }: { id: string; slug: string; ready: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  return (
    <div className="no-print mx-auto mb-6 flex max-w-[1240px] flex-wrap items-center justify-between gap-3 text-sm">
      <Link href={`/clients/${slug}`} className="text-[#4d464f] hover:text-[#17131a] max-md:inline-flex max-md:min-h-11 max-md:items-center">
        ← Client page
      </Link>
      {ready && (
        <span className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              start(async () => {
                await rewriteHandoff(id);
                router.refresh();
              })
            }
            className="text-xs text-[#8a8189] hover:text-[#17131a] max-md:min-h-11"
          >
            {busy ? "Starting…" : "Write it again with today's info"}
          </button>
          <button type="button" onClick={() => window.print()} className="h-10 rounded-full bg-[#c8102e] px-5 font-medium text-white hover:brightness-110 max-md:h-11">
            Download PDF
          </button>
        </span>
      )}
    </div>
  );
}

/** Marks the handoff read by its new buyer, so it comes off their home. */
export function Seen({ id }: { id: string }) {
  useEffect(() => {
    void markHandoffSeen(id);
  }, [id]);
  return null;
}

const STEPS = ["Reading the client page, Brand Bible and go-to-market", "Going through the last 45 days of calls, docs, Slack and email", "Checking open tickets, the sprint and promises", "Finding similar accounts on your list", "Writing your handoff"];

/** While the strategist writes it: steps, and a look for the finished doc every few seconds. */
export function Writing({ id, status, error }: { id: string; status: string; error: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, start] = useTransition();
  useEffect(() => {
    if (status !== "writing") return;
    const poll = setInterval(() => router.refresh(), 5000);
    const tick = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 14000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [status, router]);
  if (status === "failed")
    return (
      <div className="grid place-items-center gap-3 py-16 text-center">
        <p className="text-sm text-[#4d464f]">The handoff didn&apos;t finish{error ? `: ${error}` : "."}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              await rewriteHandoff(id);
              router.refresh();
            })
          }
          className="h-10 rounded-full bg-[#c8102e] px-5 text-sm font-medium text-white max-md:h-11"
        >
          {busy ? "Starting…" : "Try again"}
        </button>
      </div>
    );
  return (
    <div className="grid gap-4 py-10">
      <div className="flex items-center gap-3">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#c8102e] border-t-transparent" />
        <p className="text-sm font-medium">Writing the handoff. About two minutes; you can leave and come back.</p>
      </div>
      <ol className="grid gap-2 pl-8">
        {STEPS.map((s, i) => (
          <li key={s} className={`text-[13px] ${i < step ? "text-[#1f7a43]" : i === step ? "text-[#17131a]" : "text-[#b3abb2]"}`}>
            {i < step ? "✓ " : ""}
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STARTERS = ["What should I do first this week?", "What has the client been unhappy about?", "Which angles have worked best?", "What's the status of the open tickets?"];

/** Ask the system anything about the account. The thread is kept with the handoff. */
export function AccountChat({ id, client, initial, ready }: { id: string; client: string; initial: ChatTurn[]; ready: boolean }) {
  const [chat, setChat] = useState(initial);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phones: the chat is a full-screen sheet, opened from a floating button
  const [open, setOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Braces: newer browsers return a promise from scrollIntoView, which React would take for a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [chat, pending, open]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", on);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", on);
      document.body.style.overflow = "";
    };
  }, [open]);

  const ask = async (text: string) => {
    if (!text.trim() || pending) return;
    setError(null);
    setPending(text);
    setQ("");
    const r = await askAccount(id, text);
    setPending(null);
    if (r.ok) setChat(r.chat);
    else {
      setError(r.error);
      setQ(text);
    }
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="no-print fixed bottom-[max(16px,env(safe-area-inset-bottom))] right-4 z-40 flex h-12 items-center gap-2 rounded-full bg-[#17131a] px-5 text-sm font-medium text-white shadow-[0_16px_40px_-12px_rgba(0,0,0,0.55)] md:hidden"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          Ask about {client}
        </button>
      )}
      <aside className={`no-print sticky top-6 grid max-h-[calc(100vh-48px)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[14px] border border-[#e7e2e3] bg-white shadow-[0_30px_80px_-40px_rgba(0,0,0,0.25)] max-md:fixed max-md:inset-0 max-md:z-50 max-md:h-[100dvh] max-md:max-h-none max-md:rounded-none max-md:border-0 max-md:animate-[sheet-up_.25s_ease-out] ${open ? "" : "max-md:hidden"}`}>
        <div className="flex items-start gap-3 border-b border-[#e7e2e3] px-4 py-3 max-md:pt-[max(12px,env(safe-area-inset-top))]">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-sm font-semibold [overflow-wrap:anywhere]">Ask about {client}</p>
            <p className="text-xs text-[#8a8189]">Answers come from everything Kaizen Ads knows about the account.</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close the chat" className="-mr-2 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg text-[#4d464f] active:bg-[#f4f2f1] md:hidden">
            ✕
          </button>
        </div>
        <div className="grid min-w-0 content-start gap-3 overflow-y-auto overscroll-contain px-4 py-4">
          {!chat.length && !pending && (
            <div className="grid gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!ready}
                  onClick={() => ask(s)}
                  className="rounded-[10px] border border-[#e7e2e3] px-3 py-2 text-left text-[13px] text-[#4d464f] hover:border-[#c8102e]/40 hover:text-[#17131a] disabled:opacity-50 max-md:min-h-11 max-md:text-sm"
                >
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
              <p className="flex items-center gap-2 text-xs text-[#8a8189]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#c8102e]" />
                Looking through the account…
              </p>
            </>
          )}
          {error && <p className="text-xs text-[#c8102e]">{error}</p>}
          <div ref={end} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
          className="flex items-end gap-2 border-t border-[#e7e2e3] p-3 max-md:pb-[max(12px,env(safe-area-inset-bottom))]"
        >
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(q);
              }
            }}
            rows={2}
            placeholder={ready ? "Ask anything about this account" : "You can ask once the handoff is written"}
            disabled={!ready}
            className="min-h-[44px] min-w-0 flex-1 resize-none rounded-[10px] border border-[#e7e2e3] px-3 py-2 text-[13px] outline-none focus:border-[#c8102e]/50"
          />
          <button type="submit" disabled={!ready || !q.trim() || Boolean(pending)} className="h-10 rounded-full bg-[#17131a] px-4 text-sm text-white disabled:opacity-40 max-md:h-11 max-md:px-5">
            Ask
          </button>
        </form>
      </aside>
    </>
  );
}

function Bubble({ t }: { t: ChatTurn }) {
  const me = t.role === "user";
  return (
    <div className={`grid gap-0.5 ${me ? "justify-items-end" : ""}`}>
      <p className={`max-w-[92%] whitespace-pre-wrap rounded-[12px] [overflow-wrap:anywhere] px-3 py-2 text-[13px] leading-relaxed ${me ? "bg-[#17131a] text-white" : "bg-[#f4f2f1] text-[#17131a]"}`}>{t.text}</p>
      {me && t.by && <span className="text-[10px] text-[#b3abb2]">{t.by}</span>}
    </div>
  );
}
