"use client";

import { useEffect, useState } from "react";

/**
 * The part of the screen you can actually see on a phone (above the keyboard, when it's up): a sheet sized to it keeps
 * its buttons in reach while typing (iOS Safari leaves fixed elements under the keyboard). Null on a computer or before
 * the browser says.
 */
export function useVisualViewport(): { height: number; top: number } | null {
  const [vv, setVv] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v || window.matchMedia("(min-width: 768px)").matches) return;
    const on = () => setVv({ height: v.height, top: v.offsetTop });
    on();
    v.addEventListener("resize", on);
    v.addEventListener("scroll", on);
    return () => {
      v.removeEventListener("resize", on);
      v.removeEventListener("scroll", on);
    };
  }, []);
  return vv;
}
