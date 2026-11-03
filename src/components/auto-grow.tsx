"use client";

import { useEffect } from "react";

// Chat boxes (textarea[data-chat]) grow with the text up to about 40% of the screen. Most browsers do it in CSS
// (field-sizing, in globals.css); this does the same where that isn't supported, on typing, focus and when the box is
// cleared after sending.
export function AutoGrow() {
  useEffect(() => {
    if (typeof CSS !== "undefined" && CSS.supports("field-sizing", "content")) return;
    const fit = (el: Element | null) => {
      if (!(el instanceof HTMLTextAreaElement) || !el.matches("textarea[data-chat]")) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
    };
    const onEvent = (e: Event) => fit(e.target as Element);
    const all = () => document.querySelectorAll("textarea[data-chat]").forEach(fit);
    document.addEventListener("input", onEvent, true);
    document.addEventListener("focusin", onEvent, true);
    // Sent and cleared by the app (no input event): check again after each key and click
    document.addEventListener("keyup", all, true);
    document.addEventListener("click", all, true);
    return () => {
      document.removeEventListener("input", onEvent, true);
      document.removeEventListener("focusin", onEvent, true);
      document.removeEventListener("keyup", all, true);
      document.removeEventListener("click", all, true);
    };
  }, []);
  return null;
}
