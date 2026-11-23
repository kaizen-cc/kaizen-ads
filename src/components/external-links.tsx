"use client";

import { useEffect } from "react";
import { isExternalHref, openExternal } from "@/lib/external-link";

/**
 * Every link that leaves Kaizen OS opens in a new tab, wherever it's drawn (the Overview, the recap, sheets, the
 * assistant's cards, the bell): one listener, ahead of the app's own link handling, so nothing replaces the OS tab.
 * Links inside the app, downloads, and links already opening elsewhere are left alone.
 */
export function ExternalLinks() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      if (!isExternalHref(a.getAttribute("href"), window.location.origin)) return;
      e.preventDefault();
      openExternal(a.href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
