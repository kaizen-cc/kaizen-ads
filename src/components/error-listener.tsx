"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/error-actions";

/**
 * Errors that don't crash the page still count: a script that throws, a button whose action fails. They're reported
 * like a crash (grouped, diagnosed, emailed when real). At most one report a minute per message from a tab.
 */
export function ErrorListener() {
  useEffect(() => {
    const sent = new Map<string, number>();
    const send = (message: string, stack?: string) => {
      if (!message) return;
      const last = sent.get(message) ?? 0;
      if (Date.now() - last < 60_000) return;
      sent.set(message, Date.now());
      reportClientError({ message, path: window.location.pathname, stack }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => {
      // Scripts from other sites (extensions, embeds) show up as "Script error." with nothing to go on
      if (!e.message || e.message === "Script error.") return;
      send(e.message, e.error instanceof Error ? e.error.stack : undefined);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      send(r instanceof Error ? r.message : typeof r === "string" ? r : "", r instanceof Error ? r.stack : undefined);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
