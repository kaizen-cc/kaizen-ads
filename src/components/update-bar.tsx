"use client";

import { useEffect, useState } from "react";

// The version this tab is running, baked in at build time (next.config.ts)
const MINE = process.env.APP_VERSION ?? "dev";
const EVERY_MS = 5 * 60_000;

/**
 * Tabs left open keep running the code they loaded. When a newer version goes live, offer a
 * refresh so people pick up fixes the same day. Checks when the tab comes back into view and
 * every 5 minutes while it's open.
 */
export function UpdateBar({ preview = false }: { preview?: boolean } = {}) {
  const [stale, setStale] = useState(preview);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (MINE === "dev") return;
    let last = 0;
    const check = async () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const { version } = (await r.json()) as { version?: string };
        if (version && version !== "dev" && version !== MINE) setStale(true);
      } catch {
        // Offline or signed out: try again later
      }
    };
    const t = setInterval(check, EVERY_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!stale || hidden) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-brand border border-brand/60 bg-surface px-4 py-3 text-sm shadow-2xl md:bottom-6"
    >
      <span className="text-brand-text" aria-hidden>
        ✦
      </span>
      <p className="min-w-0 flex-1">Kaizen Ads was updated. Refresh to get the latest version.</p>
      <button onClick={() => window.location.reload()} className="h-8 shrink-0 rounded-brand bg-brand px-3 text-xs font-medium text-white hover:bg-brand-hover">
        Refresh
      </button>
      <button onClick={() => setHidden(true)} aria-label="Later" className="shrink-0 text-faint hover:text-fg">
        ✕
      </button>
    </div>
  );
}
