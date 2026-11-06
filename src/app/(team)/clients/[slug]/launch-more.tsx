"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ChatTurn } from "@/lib/handoff";
import { answerLaunchMore, loadLaunchMore, startLaunchMoreItem, type LaunchMoreView } from "./launch-more-actions";

// The end of a launch card once the launch is deployed and read back: "Want me to suggest some more changes while you
// have me here?". Yes: a few account-wide actions, added to the sprint (or saved as the buyer's tasks), each one
// startable right here as a chat change. Shared by the Google and Meta launch cards.

/** The chat panel listens for this, so turns added from a card show in the thread at once */
export const CHAT_EVENT = "kaizen:client-chat";
export function pushChat(clientId: string, chat: ChatTurn[]) {
  window.dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: { clientId, chat } }));
}

/** Text that shows two lines, with More for the rest (and when there's detail beyond it) */
export function Clamp({ text, more, className = "" }: { text: string; more?: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || Boolean(more);
  return (
    <span className={`grid min-w-0 gap-0.5 ${className}`}>
      <span className={`min-w-0 [overflow-wrap:anywhere] ${open ? "" : "line-clamp-2"}`}>{text}</span>
      {open && more && <span className="min-w-0 whitespace-pre-line text-ink/60 [overflow-wrap:anywhere]">{more}</span>}
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="w-fit text-[11px] text-ink/45 underline decoration-ink/20 hover:text-fg max-md:min-h-9">
          {open ? "Less" : "More"}
        </button>
      )}
    </span>
  );
}

export function LaunchMore({ runId }: { runId: string }) {
  const [v, setV] = useState<LaunchMoreView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadLaunchMore(runId).catch(() => null);
      if (!live) return;
      setV(next);
      if (next?.more?.status === "writing") timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, busy]);

  if (!v || v.status !== "applied") return null;
  const m = v.more;

  const answer = async (yes: boolean) => {
    setBusy(yes ? "yes" : "no");
    setError(null);
    const r = await answerLaunchMore(runId, yes).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Something went wrong." }));
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setV(r.view);
    pushChat(r.view.clientId, r.chat);
  };
  const start = async (i: number) => {
    setBusy(`item:${i}`);
    setError(null);
    const r = await startLaunchMoreItem(runId, i).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Something went wrong." }));
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setV(r.view);
    pushChat(r.view.clientId, r.chat);
  };

  return (
    <div className="grid min-w-0 gap-2 border-t border-ink/[0.08] pt-3">
      {!m || m.status === "failed" ? (
        <>
          <p className="text-[12.5px] font-medium leading-snug">Want me to suggest some more changes while you have me here?</p>
          {m?.status === "failed" && m.error && <p className="text-[11.5px] text-bad [overflow-wrap:anywhere]">{m.error}</p>}
          <span className="flex flex-wrap gap-1.5">
            <button type="button" disabled={Boolean(busy)} onClick={() => void answer(true)} className="h-11 rounded-full bg-fg px-4 text-[12.5px] font-medium text-bg disabled:opacity-40 md:h-9">
              {busy === "yes" ? "Reading the account…" : m?.status === "failed" ? "Try again" : "Yes, suggest"}
            </button>
            {!m && (
              <button type="button" disabled={Boolean(busy)} onClick={() => void answer(false)} className="h-11 rounded-full border border-ink/10 px-4 text-[12.5px] text-ink/65 hover:text-fg disabled:opacity-40 md:h-9">
                No thanks
              </button>
            )}
          </span>
          {busy === "yes" && <p className="text-[11px] text-ink/45">Reading the account and writing a few actions, nothing already in place.</p>}
        </>
      ) : m.status === "writing" ? (
        <p className="flex items-center gap-2 text-[12px] text-ink/60">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          Reading the account and writing a few actions
        </p>
      ) : m.status === "declined" ? (
        <p className="text-[11.5px] text-ink/45">No more suggestions this time.</p>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <p className="min-w-0 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/45">
              {m.items.length ? `${m.items.length} more · ${m.where === "sprint" ? "on the sprint" : "saved for you"}` : "Nothing new to add"}
            </p>
            {m.href && m.items.length > 0 && (
              <Link href={m.href} className="text-[11.5px] text-brand-text underline max-md:inline-flex max-md:min-h-9 max-md:items-center">
                {m.where === "sprint" ? "Open the sprint" : "Open your tasks"}
              </Link>
            )}
          </div>
          {m.skipped > 0 && <p className="text-[11px] text-ink/45">{m.skipped} left out: already on your list or already in place.</p>}
          <ul className="grid min-w-0 gap-1.5">
            {m.items.map((x, i) => (
              <li key={`${i}-${x.title}`} className="grid min-w-0 gap-1.5 rounded-[12px] border border-ink/[0.08] bg-ink/[0.02] px-3 py-2.5">
                <p className="min-w-0 text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere]">{x.title}</p>
                <Clamp text={x.why} more={[x.detail, ...x.steps.map((s, j) => `${j + 1}. ${s}`)].filter(Boolean).join("\n")} className="text-[11.5px] leading-snug text-ink/60" />
                <span className="flex flex-wrap items-center gap-1.5">
                  {x.started ? (
                    <span className="text-[11.5px] text-ok">Started · its plan is in the chat</span>
                  ) : (
                    <button type="button" disabled={Boolean(busy)} onClick={() => void start(i)} className="h-10 rounded-full bg-fg px-3.5 text-[12px] text-bg disabled:opacity-40 md:h-8">
                      {busy === `item:${i}` ? "Starting…" : "Do it now"}
                    </button>
                  )}
                  <span className="text-[11px] text-ink/45">{m.where === "sprint" ? "On the sprint" : "Saved for later"}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="text-[12px] text-bad [overflow-wrap:anywhere]">{error}</p>}
    </div>
  );
}
