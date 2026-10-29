"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// The team's activity record, for execs on the Team page: every page opened, every button and link pressed (with what
// it was about), every search typed and form sent, and a minute of use counted once a minute while a tab is open, in
// view and actually in use (a key, a click, a scroll or the mouse in the last three minutes), so a tab left open
// overnight isn't counted as work. Any of it moves "last active". Nothing here shows to the person; it only records.
// Typed text is only kept for searches; nothing typed into other fields is recorded.

const IDLE_AFTER = 3 * 60_000;
const FLUSH_EVERY = 8_000;

type Item = { kind: "click" | "search" | "submit"; path: string; label: string; at: string };

const clean = (s: string | null | undefined, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const here = () => `${window.location.pathname}${window.location.search}`;

/** What a press was about: the card, row or section it was in (its first line), so "Done" says what was done */
function contextOf(el: Element, label: string) {
  const box = el.closest("[data-hideable], article, li, tr, [role=dialog], section");
  if (!box) return "";
  const lines = ((box as HTMLElement).innerText ?? "").split("\n").map((l) => clean(l, 90)).filter((l) => l && l !== label && l.length > 2);
  return lines[0] ?? "";
}

function labelOf(el: Element) {
  const own = el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || (el as HTMLInputElement).value || "";
  return clean(own, 60);
}

/** The RPC only goes out once something waits on it: send, and let a failure pass quietly */
const send = (fn: string, args?: Record<string, unknown>) => {
  createClient()
    .rpc(fn, args)
    .then(
      () => {},
      () => {},
    );
};

export function ActivityTracker() {
  const pathname = usePathname();
  const lastInput = useRef(0);
  const queue = useRef<Item[]>([]);

  // Each page opened, with its title (set by the page a moment after it renders)
  useEffect(() => {
    const t = setTimeout(() => {
      const label = document.title.replace(/\s*[·|–-]\s*Kaizen Ads\s*$/i, "").trim() || pathname;
      send("activity_log", { p_kind: "page", p_path: here(), p_label: label });
    }, 800);
    return () => clearTimeout(t);
  }, [pathname]);

  // Clicks, searches and submissions, sent in batches
  useEffect(() => {
    const push = (i: Omit<Item, "at" | "path">) => queue.current.push({ ...i, path: here(), at: new Date().toISOString() });
    const flush = () => {
      if (!queue.current.length) return;
      const items = queue.current.splice(0, 50);
      send("activity_log_many", { p_items: items });
    };

    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest("button, a, [role=button], [role=tab], summary, select, input[type=checkbox], input[type=radio]");
      if (!el) return;
      const label = labelOf(el);
      if (!label) return;
      const about = contextOf(el, label);
      const href = el.tagName === "A" ? (el as HTMLAnchorElement).getAttribute("href") : null;
      push({ kind: "click", label: `Clicked “${label}”${about ? ` · ${about}` : ""}${href && !href.startsWith("#") ? ` → ${clean(href, 80)}` : ""}` });
    };

    // A search is recorded once they stop typing for a moment
    const timers = new Map<EventTarget, ReturnType<typeof setTimeout>>();
    const onInput = (e: Event) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || el.tagName !== "INPUT") return;
      const place = el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? "";
      if (el.type !== "search" && !/search|find|filter/i.test(place)) return;
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => {
          const v = clean(el.value, 80);
          if (v.length >= 2) push({ kind: "search", label: `Searched “${v}”${place ? ` in ${clean(place, 40)}` : ""}` });
        }, 1500),
      );
    };

    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form) return;
      const btn = (e.submitter as HTMLElement | null) ?? form.querySelector("button[type=submit], button:not([type])");
      const what = clean(form.getAttribute("aria-label") ?? form.querySelector("h1, h2, h3, legend, p")?.textContent ?? "", 60);
      push({ kind: "submit", label: `Submitted${btn ? ` “${labelOf(btn)}”` : ""}${what ? ` · ${what}` : ""}` });
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSubmit, true);
    const tick = setInterval(flush, FLUSH_EVERY);
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("visibilitychange", onHide);
      clearInterval(tick);
      for (const t of timers.values()) clearTimeout(t);
      flush();
    };
  }, []);

  // Minutes in use
  useEffect(() => {
    lastInput.current = Date.now();
    const touch = () => (lastInput.current = Date.now());
    const events = ["pointermove", "pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const beat = setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastInput.current > IDLE_AFTER) return;
      send("activity_beat");
    }, 60_000);
    return () => {
      clearInterval(beat);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, []);

  return null;
}
