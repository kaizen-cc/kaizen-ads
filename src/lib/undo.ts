"use client";

import { useSyncExternalStore } from "react";
import { closeLocally, reopenLocally } from "@/lib/closed-items";

// Undo for everything that clears an Overview item (owner, Nov 24 2026): Done, Later, Not for me, Dismiss, Save all for
// later, transfer, hand off, a group's own items. The item leaves the screen at once, but nothing is written for
// UNDO_MS: Undo (the toast, or Ctrl/Cmd+Z) puts it back exactly where it was and nothing ever reaches the server, so
// nothing has to be reversed there and nobody is told (the asker's "finished" notice, the teammate's transfer notice,
// Asana's tick all wait with the write). Leaving the page writes what's waiting at once.

export const UNDO_MS = 8000;

type Pending = { id: number; label: string; keys: string[]; commit: () => Promise<unknown>; onUndo?: () => void; onError?: (e: string) => void; timer: ReturnType<typeof setTimeout> | null };

let pending: Pending[] = [];
let failure: string | null = null;
let seq = 0;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  for (const l of listeners) l();
};

const failed = (r: unknown): string | null => (r && typeof r === "object" && "ok" in r && (r as { ok: unknown }).ok === false ? String((r as { error?: unknown }).error ?? "Couldn't save that.") : null);

async function run(p: Pending) {
  pending = pending.filter((x) => x.id !== p.id);
  if (p.timer) clearTimeout(p.timer);
  emit();
  let error: string | null = null;
  try {
    error = failed(await p.commit());
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't save that.";
  }
  // It didn't save: back on screen, and said so
  if (error) {
    for (const k of p.keys) reopenLocally(k);
    p.onUndo?.();
    p.onError?.(error);
    failure = `${p.label} didn't save: ${error}`;
    emit();
  }
}

/**
 * Clears items now and writes later: they leave the screen at once (every count with them), the toast offers Undo, and
 * `commit` runs once the undo window closes (or at once if the page is left). onUndo restores anything the caller keeps
 * itself (a story card's mark, a list's own state).
 */
export function deferClear(o: { keys: string[]; label: string; commit: () => Promise<unknown>; onUndo?: () => void; onError?: (e: string) => void; ms?: number }): number {
  const p: Pending = { id: ++seq, label: o.label, keys: [...new Set(o.keys)], commit: o.commit, onUndo: o.onUndo, onError: o.onError, timer: null };
  closeLocally(...p.keys);
  p.timer = setTimeout(() => void run(p), o.ms ?? UNDO_MS);
  pending = [...pending, p];
  failure = null;
  emit();
  return p.id;
}

function undoOne(p: Pending) {
  if (p.timer) clearTimeout(p.timer);
  pending = pending.filter((x) => x.id !== p.id);
  for (const k of p.keys) reopenLocally(k);
  p.onUndo?.();
}

/** The last one back (Ctrl/Cmd+Z) */
export function undoLast(): boolean {
  const p = pending[pending.length - 1];
  if (!p) return false;
  undoOne(p);
  emit();
  return true;
}

/** Every one still waiting back, newest first */
export function undoAll() {
  for (const p of [...pending].reverse()) undoOne(p);
  emit();
}

/** Write everything waiting now (the page is being left, or the toast was dismissed) */
export function flushPending() {
  for (const p of [...pending]) void run(p);
}

export function dismissFailure() {
  failure = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** For the toast: what's waiting (labels, newest last) and the last failure */
export function useUndo(): { labels: string[]; count: number; failure: string | null } {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return { labels: pending.map((p) => p.label), count: pending.reduce((n, p) => n + p.keys.length, 0), failure };
}

/** For tests: what's waiting */
export const pendingCount = () => pending.length;
