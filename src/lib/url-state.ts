"use client";

import { useSearchParams } from "next/navigation";

// In-page places (a tab, an opened ticket, a sheet, a view) live in the address, so the browser's back and forward
// walk through them like pages and a pasted link opens the same thing. Next keeps useSearchParams in step with
// history.pushState / replaceState and with back and forward, so screens read the param on render instead of copying
// it into state.

type Patch = Record<string, string | null | undefined>;
// Every entry pushed here remembers, for each param it opened, how many of these entries ago that happened. Closing
// goes back exactly that far, to before it opened, so back after a close never opens it again. Next's own navigations
// start a fresh entry without these marks, and a pasted link has none: closing then pushes the address without it.
type Marks = Record<string, number>;

const own = () => (window.history.state as { kz?: Marks } | null)?.kz;

// Next rewrites an entry's state when the page refreshes in place (after a save, or the board's minute timer), which
// drops the marks. The last ones written are kept here, and count while it's still that entry: the same address and
// the same history length (a link away and back again adds entries, so it can't pass for this one).
let last: { href: string; length: number; kz: Marks } | null = null;
const remember = (kz: Marks) => (last = { href: window.location.href, length: window.history.length, kz });
if (typeof window !== "undefined") window.addEventListener("popstate", () => remember(own() ?? {}));

const marks = (): Marks => own() ?? (last && last.href === window.location.href && last.length === window.history.length ? last.kz : {});

function addressWith(patch: Patch) {
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  return u;
}

/** One param of the address; re-read on every navigation, back and forward included. */
export function useParam(name: string) {
  return useSearchParams().get(name);
}

/** Go somewhere inside the page (a tab, a sheet, a view): a new history entry, so back returns to where you were. */
export function pushParams(patch: Patch) {
  const u = addressWith(patch);
  if (u.href === window.location.href) return;
  const was = marks();
  const next: Marks = {};
  for (const [k, n] of Object.entries(was)) if (!(k in patch) || patch[k]) next[k] = n + 1;
  // A param that wasn't open yet is opened by this entry; switching its value (another ticket, another tab) keeps
  // where it was first opened, so closing still lands where you started
  const here = new URL(window.location.href).searchParams;
  for (const [k, v] of Object.entries(patch)) if (v && !(k in was) && !here.has(k)) next[k] = 1;
  window.history.pushState({ kz: next }, "", u);
  remember(next);
}

/**
 * Change the address without a new history entry: typing in a search box, or one thing taking another's place (a
 * dialog handing over to the ticket it points at). What takes the place also takes its spot in history, so closing
 * it lands where the first one was opened from.
 */
export function replaceParams(patch: Patch) {
  const u = addressWith(patch);
  if (u.href === window.location.href) return;
  const was = marks();
  const keep: Marks = {};
  let freed = 0;
  for (const [k, n] of Object.entries(was)) {
    if (!(k in patch) || patch[k]) keep[k] = n;
    else freed = Math.max(freed, n);
  }
  const here = new URL(window.location.href).searchParams;
  if (freed) for (const [k, v] of Object.entries(patch)) if (v && !(k in keep) && !here.has(k)) keep[k] = freed;
  window.history.replaceState({ kz: keep }, "", u);
  remember(keep);
}

/**
 * Close what a param opened (and any params under it, like a tab inside a sheet). Opened in this visit: go back to
 * before it opened. From a pasted link or a refresh: a new entry without it.
 */
export function closeParams(name: string, ...under: string[]) {
  closeThen(() => {}, name, ...under);
}

/**
 * Close, then do something once the address has changed (going back lands a moment later): a router.refresh() run
 * before that would fetch the page still open.
 */
export function closeThen(after: () => void, name: string, ...under: string[]) {
  const n = marks()[name];
  if (n) {
    window.addEventListener("popstate", () => setTimeout(after, 0), { once: true });
    window.history.go(-n);
  } else {
    pushParams(Object.fromEntries([name, ...under].map((k) => [k, null])));
    after();
  }
}
