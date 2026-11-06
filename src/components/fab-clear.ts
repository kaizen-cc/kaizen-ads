"use client";

import { useEffect } from "react";

// A page's own floating button in the bottom-right corner (the client chat, a sticky action) reserves room there, so
// the feedback bubble sits above it instead of on top of it. The bubble reads --fab-clear (pixels to move up).
const owners = new Map<symbol, number>();
const apply = () => {
  const px = Math.max(0, ...owners.values());
  if (px) document.documentElement.style.setProperty("--fab-clear", `${px}px`);
  else document.documentElement.style.removeProperty("--fab-clear");
};

/** While mounted and `on`, keep the feedback bubble `px` above the bottom-right corner. */
export function useFabClear(px: number, on = true) {
  useEffect(() => {
    if (!on) return;
    const me = Symbol("fab");
    owners.set(me, px);
    apply();
    return () => {
      owners.delete(me);
      apply();
    };
  }, [px, on]);
}
