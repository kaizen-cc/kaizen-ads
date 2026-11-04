"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * The KPI tabs stay current like the Board: while on screen they ask every 10 seconds whether any ticket moved (the
 * Board's fingerprint) and refresh the numbers only then, and at once when the tab comes back. The refresh swaps the
 * data in place, so there's no flash; numbers glide to their new value.
 */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      const r = await fetch("/api/board/version", { cache: "no-store" }).catch(() => null);
      const v = r?.ok ? ((await r.json()) as { v: string }).v : null;
      if (v && last !== null && v !== last) router.refresh();
      if (v) last = v;
      busy = false;
    };
    void check();
    const poll = setInterval(check, 10_000);
    const back = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [router]);
  return null;
}

/** A number that glides to its new value when the data refreshes (and briefly glows) instead of jumping */
export function Tween({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(value);
  const [changed, setChanged] = useState(false);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const t0 = performance.now();
    let raf = 0;
    let first = true;
    const step = (t: number) => {
      if (first) {
        first = false;
        setChanged(true);
      }
      const k = Math.min(1, (t - t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    const off = setTimeout(() => setChanged(false), 1600);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(off);
      from.current = value;
    };
  }, [value]);
  return <span className={`transition-[text-shadow] duration-700 ${changed ? "[text-shadow:0_0_18px_currentColor]" : ""}`}>{shown.toFixed(decimals)}</span>;
}
