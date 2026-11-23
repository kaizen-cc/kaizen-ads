"use client";

import { useEffect } from "react";

// Back from connecting an account in its own tab: the conversation in the other tab hears it on a BroadcastChannel
// (and a storage event as a fallback) and picks the ask back up. Then this tab says so and closes when it can.

export const CONNECTED_CHANNEL = "kaizen-connected";
const NAME: Record<string, string> = { slack: "Slack", gmail: "Gmail", drive: "Google Drive", calendar: "Google Calendar", asana: "Asana" };

export function ConnectedNotice({ service, result, reason, readUnavailable }: { service: string; result: string; reason: string; readUnavailable: boolean }) {
  const ok = result === "connected";
  const name = NAME[service] ?? "Your account";
  useEffect(() => {
    if (!ok) return;
    const msg = { service, at: Date.now(), readUnavailable };
    try {
      const ch = new BroadcastChannel(CONNECTED_CHANNEL);
      ch.postMessage(msg);
      ch.close();
    } catch {
      // No BroadcastChannel: the storage event below still reaches the other tab
    }
    try {
      localStorage.setItem(CONNECTED_CHANNEL, JSON.stringify(msg));
    } catch {
      // Storage blocked (a private window): the conversation still has the card's own "I've connected" path
    }
    const t = setTimeout(() => window.close(), 1800);
    return () => clearTimeout(t);
  }, [ok, service, readUnavailable]);

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <div className="grid w-full max-w-sm gap-3 rounded-[18px] border border-line bg-surface p-6 text-center shadow-sm">
        <span aria-hidden className={`mx-auto grid h-12 w-12 place-items-center rounded-full ${ok ? "bg-ok/15 text-ok" : "bg-bad/10 text-bad"}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {ok ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <path d="M6 6l12 12M18 6L6 18" />}
          </svg>
        </span>
        <h1 className="font-heading text-[20px] leading-tight">{ok ? `${name} is connected` : `${name} didn't connect`}</h1>
        <p className="text-[14px] leading-relaxed text-muted">
          {ok
            ? readUnavailable
              ? "It can post as you. Reading your Slack needs one setting in the Slack app first; the executives have been told."
              : "Your assistant is picking up where you left off. You can close this tab."
            : reason === "access_denied"
              ? `You cancelled on ${name}'s screen. Tap the card again whenever you're ready.`
              : `${name} said: ${reason || "something went wrong"}. Try the card again.`}
        </p>
        <button type="button" onClick={() => window.close()} className="mx-auto inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-[14px] font-medium text-bg transition hover:opacity-90">
          Close this tab
        </button>
      </div>
    </main>
  );
}
