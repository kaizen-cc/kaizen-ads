"use client";

import { useEffect, useState } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { ChatView } from "./chat-view";

// Their team chat from any page of the portal: a button in the corner on a computer (the tab bar's Chat on a phone)
// opens it docked beside the page, or as the whole screen on a phone. It's in the address (?chat=1), so back closes it.
// The badge counts what our team wrote since they last looked, read again every half minute while the page is open.

const POLL = 30_000;

export function ChatDock({ slug, brand, me, team, hasChannel, slackLink, unread: initial }: { slug: string; brand: string; me: string; team: boolean; hasChannel: boolean; slackLink: string | null; unread: number }) {
  const open = useParam("chat") === "1";
  const [unread, setUnread] = useState(initial);
  useEffect(() => {
    if (open || !hasChannel) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await fetch(`/api/portal-chat/${slug}?unread=1`, { cache: "no-store" }).catch(() => null);
      const body = r?.ok ? ((await r.json().catch(() => null)) as { unread?: number } | null) : null;
      if (typeof body?.unread === "number") setUnread(body.unread);
    };
    const t = setInterval(() => void tick(), POLL);
    return () => clearInterval(t);
  }, [open, hasChannel, slug]);
  // Reading it marks it read
  const shown = open ? 0 : unread;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            setUnread(0);
            pushParams({ chat: "1" });
          }}
          aria-label={shown ? `Chat with Kaizen, ${shown} new` : "Chat with Kaizen"}
          className="fixed bottom-6 right-6 z-30 hidden h-14 items-center gap-2 rounded-full bg-brand pl-4 pr-5 text-[14px] font-medium text-white shadow-[0_18px_40px_-14px_rgba(178,30,44,0.7)] transition-transform hover:-translate-y-0.5 lg:inline-flex"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 5h16v11H9l-5 4z M8 10h8 M8 13h5" />
          </svg>
          Chat
          {shown > 0 && <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-white px-1.5 text-[11px] font-semibold text-brand">{shown}</span>}
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg lg:inset-auto lg:bottom-4 lg:right-4 lg:top-4 lg:w-[420px] lg:overflow-hidden lg:rounded-[24px] lg:border lg:border-line lg:bg-surface lg:shadow-[0_30px_80px_-30px_rgba(0,0,0,0.55)]">
          <div className="pt-safe min-h-0 flex-1 lg:pt-0">
            <ChatView slug={slug} brand={brand} me={me} team={team} hasChannel={hasChannel} slackLink={slackLink} compact onClose={() => closeParams("chat", "thread")} />
          </div>
          <div className="pb-[env(safe-area-inset-bottom)] lg:hidden" />
        </div>
      )}
    </>
  );
}
