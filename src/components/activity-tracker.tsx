"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// The team's activity record, for execs on the Team page: each page opened, and a minute of use counted once a
// minute while a tab is open, in view and actually in use (a key, a click, a scroll or the mouse in the last three
// minutes), so a tab left open overnight isn't counted as work. Nothing here shows to the person; it only records.

const IDLE_AFTER = 3 * 60_000;

export function ActivityTracker() {
  const pathname = usePathname();
  const lastInput = useRef(0);

  // Each page opened, with its title (set by the page a moment after it renders)
  useEffect(() => {
    const t = setTimeout(() => {
      const label = document.title.replace(/\s*[·|–-]\s*Kaizen Ads\s*$/i, "").trim() || pathname;
      void createClient().rpc("activity_log", { p_kind: "page", p_path: `${pathname}${window.location.search}`, p_label: label });
    }, 800);
    return () => clearTimeout(t);
  }, [pathname]);

  // Minutes in use
  useEffect(() => {
    lastInput.current = Date.now();
    const touch = () => (lastInput.current = Date.now());
    const events = ["pointermove", "pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const beat = setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastInput.current > IDLE_AFTER) return;
      void createClient().rpc("activity_beat");
    }, 60_000);
    return () => {
      clearInterval(beat);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, []);

  return null;
}
