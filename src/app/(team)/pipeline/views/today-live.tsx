"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshToday } from "../today-actions";

// Keeps the daily review on the Overview current without making anyone wait: shown from the saved version at once,
// then checked in the background on open and every few minutes while the tab is in view. When something changed (a
// thing handled, something new, an account further off target) the card redraws in place.

const EVERY = 5 * 60_000;

export function TodayLive({ shown }: { shown: string }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      setChecking(true);
      try {
        const r = await refreshToday(shown);
        if (!stop && r.changed) router.refresh();
      } catch {
        // Offline or signed out: the saved review stays on screen
      } finally {
        if (!stop) setChecking(false);
      }
    };
    const first = setTimeout(check, 1500);
    const timer = setInterval(check, EVERY);
    const onShow = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [shown, router]);

  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] text-white/40 transition-opacity ${checking ? "opacity-100" : "opacity-0"}`} aria-live="polite">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50" />
      Checking for updates
    </span>
  );
}
