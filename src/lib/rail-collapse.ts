"use client";

import { useSyncExternalStore } from "react";

// Kaizen AI's chat list (the left rail) can be hidden on desktop to give the conversation more room, like hiding the
// chat on Twitch. The choice is remembered in this browser; storage can be blocked, and then the rail just starts open.
export const RAIL_KEY = "kz-ai-rail-collapsed";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readCollapsed(storage: Store | null | undefined): boolean {
  try {
    return storage?.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCollapsed(storage: Store | null | undefined, collapsed: boolean) {
  try {
    if (collapsed) storage?.setItem(RAIL_KEY, "1");
    else storage?.removeItem(RAIL_KEY);
  } catch {
    // blocked storage: the choice lasts for this visit only
  }
}

const listeners = new Set<() => void>();
let memory: boolean | null = null;
const local = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => memory ?? readCollapsed(local());

export function useRailCollapsed(): [boolean, (next: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = (next: boolean) => {
    memory = next;
    writeCollapsed(local(), next);
    for (const fn of listeners) fn();
  };
  return [collapsed, set];
}
