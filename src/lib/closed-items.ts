"use client";

import { useSyncExternalStore } from "react";

// What was closed on this page since it loaded (an item's Done or Dismiss, a group card's own item): every block count,
// group title and list reads it, so the numbers drop the moment something closes, before the server's answer comes
// back. A reload starts empty: by then the saved day has the same marks (src/lib/today-counts.ts applyMarks).

const closed = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

export function closeLocally(...keys: string[]) {
  let changed = false;
  for (const k of keys) if (!closed.has(k)) (closed.add(k), (changed = true));
  if (!changed) return;
  version++;
  for (const l of listeners) l();
}

/** Undo after a failed save */
export function reopenLocally(key: string) {
  if (!closed.delete(key)) return;
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The closed keys, re-read whenever one closes */
export function useClosed(): { has: (k: string) => boolean } {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return closed;
}

/** Outside React (tests, the undo queue): whether it's closed on this page */
export const isClosedLocally = (key: string) => closed.has(key);
