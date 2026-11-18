import { useSyncExternalStore } from "react";

// How many urgent heads-ups wait unread in the assistant chat, for the badge on My Assistant. Set by the open app's
// heartbeat (the ringer); read by the sidebar. A tiny store, browser only.

let unread = 0;
const listeners = new Set<() => void>();

export function setUnreadHeadsUps(n: number) {
  const next = Math.max(0, Math.floor(n) || 0);
  if (next === unread) return;
  unread = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useUnreadHeadsUps = () =>
  useSyncExternalStore(
    subscribe,
    () => unread,
    () => 0,
  );
