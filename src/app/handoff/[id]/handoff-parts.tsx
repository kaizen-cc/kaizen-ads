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
      <Link href={`/clients/${slug}`} className="text-[#4d464f] hover:text-[#17131a]">
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
            className="text-xs text-[#8a8189] hover:text-[#17131a]"
          >
            {busy ? "Starting…" : "Write it again with today's info"}
          </button>
          <button type="button" onClick={() => window.print()} className="h-10 rounded-full bg-[#c8102e] px-5 font-medium text-white hover:brightness-110">
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
          className="h-10 rounded-full bg-[#c8102e] px-5 text-sm font-medium text-white"
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
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), [chat, pending]);

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
    <aside className="no-print sticky top-6 grid max-h-[calc(100vh-48px)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[14px] border border-[#e7e2e3] bg-white shadow-[0_30px_80px_-40px_rgba(0,0,0,0.25)]">
      <div className="grid gap-0.5 border-b border-[#e7e2e3] px-4 py-3">
        <p className="text-sm font-semibold">Ask about {client}</p>
        <p className="text-xs text-[#8a8189]">Answers come from everything Kaizen Ads knows about the account.</p>
      </div>
      <div className="grid content-start gap-3 overflow-y-auto px-4 py-4">
        {!chat.length && !pending && (
          <div className="grid gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={!ready}
                onClick={() => ask(s)}
                className="rounded-[10px] border border-[#e7e2e3] px-3 py-2 text-left text-[13px] text-[#4d464f] hover:border-[#c8102e]/40 hover:text-[#17131a] disabled:opacity-50"
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
        className="flex items-end gap-2 border-t border-[#e7e2e3] p-3"
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
          className="min-h-[44px] flex-1 resize-none rounded-[10px] border border-[#e7e2e3] px-3 py-2 text-[13px] outline-none focus:border-[#c8102e]/50"
        />
        <button type="submit" disabled={!ready || !q.trim() || Boolean(pending)} className="h-10 rounded-full bg-[#17131a] px-4 text-sm text-white disabled:opacity-40">
          Ask
        </button>
      </form>
    </aside>
  );
}

function Bubble({ t }: { t: ChatTurn }) {
  const me = t.role === "user";
  return (
    <div className={`grid gap-0.5 ${me ? "justify-items-end" : ""}`}>
      <p className={`max-w-[92%] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13px] leading-relaxed ${me ? "bg-[#17131a] text-white" : "bg-[#f4f2f1] text-[#17131a]"}`}>{t.text}</p>
      {me && t.by && <span className="text-[10px] text-[#b3abb2]">{t.by}</span>}
    </div>
  );
}
