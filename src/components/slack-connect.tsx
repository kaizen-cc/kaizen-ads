"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";

// Each person connects their own Slack once, so client reports go out under their name.
// Connecting is a full page trip through Slack (a plain link, not client navigation); disconnecting stays on the page.
export function SlackConnect({ connected, next }: { connected: boolean; next?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  const back = next ?? pathname ?? "/reports";

  if (!connected) {
    return (
      <a
        href={`/api/slack/connect?next=${encodeURIComponent(back)}`}
        className="inline-flex h-8 items-center gap-2 rounded-full bg-fg px-3.5 text-xs font-medium text-bg hover:opacity-90"
      >
        <SlackMark />
        Connect my Slack
      </a>
    );
  }

  const disconnect = () =>
    start(async () => {
      setFailed(false);
      const res = await fetch("/api/slack/disconnect", { method: "POST" }).catch(() => null);
      if (!res?.ok) return setFailed(true);
      router.refresh();
    });

  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface pl-3 pr-1 text-xs text-muted">
      <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
      Slack connected
      <span className="text-faint">·</span>
      <button
        type="button"
        onClick={disconnect}
        disabled={pending}
        className="h-6 rounded-full px-2.5 text-faint hover:bg-fg/5 hover:text-fg disabled:opacity-50"
      >
        {pending ? "Disconnecting…" : failed ? "Try again" : "Disconnect"}
      </button>
    </span>
  );
}

function SlackMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="currentColor">
      <path d="M5.04 15.17a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52Zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 1 1-5.04 0v-6.31ZM8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83Zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04h6.31Zm10.13 2.52a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83Zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31Zm-2.52 10.13a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31Z" />
    </svg>
  );
}
