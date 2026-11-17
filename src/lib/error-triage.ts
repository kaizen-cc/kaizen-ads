// Sorts errors into harmless ones we handle automatically and real ones a person should see.
// Client-safe (used by the error page too).

export type AutoHandled = {
  kind: "network" | "stale";
  summary: string; // what happened, in plain words
  cause: string; // why
  handled: string; // what was done about it
};

// How browsers word a request that never completed (Safari: "Load failed"; Chrome: "Failed to fetch", or "network error" when the response is cut off mid-download; Firefox: "NetworkError…")
const NETWORK =
  /^(typeerror: )?(load failed|failed to fetch|fetch failed|network error|networkerror when attempting to fetch resource\.?|network request failed|the network connection was lost\.?|the internet connection appears to be offline\.?|a network error occurred\.?|cancelled|the operation was aborted\.?|aborterror\b.*|the request timed out\.?)$/i;
// A tab still running the previous version asked for files or actions that no longer exist
const STALE =
  /chunkloaderror|loading chunk [\w-]+ failed|loading css chunk|failed to fetch dynamically imported module|importing a module script failed|failed to find server action|server action .* was not found|older or newer deployment/i;

/**
 * Next.js's own control signals, not errors: redirect() and notFound() are thrown on purpose (a server action whose
 * session check sends someone to /login rejects with NEXT_REDIRECT in the browser), and Next.js handles them.
 */
export const isNavigationSignal = (message: string | undefined | null, digest?: unknown) =>
  /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)\b/.test(typeof digest === "string" ? digest : String(message ?? "").trim());

export const isNetworkError = (message: string | undefined | null) => NETWORK.test(String(message ?? "").trim());

export function classifyError(message: string, stack?: string | null): AutoHandled | null {
  const m = String(message ?? "").trim();
  if (isNetworkError(m) && !(stack && /at .*\(.*\/src\//.test(stack))) {
    return {
      kind: "network",
      summary: "A request from someone's browser never finished — their connection dropped mid-load.",
      cause:
        "This is how browsers report a lost connection (switching apps on a phone, weak Wi-Fi or mobile data, a VPN reconnecting). It isn't a bug in Kaizen OS.",
      handled: "Nothing was lost. Their page retried by itself once the connection came back. Closed automatically; you're only emailed if many people hit it at once (that would look like an outage).",
    };
  }
  if (STALE.test(m) || (stack && STALE.test(stack))) {
    return {
      kind: "stale",
      summary: "A tab that had been open since before the last update tried to load something from the old version.",
      cause: "Kaizen OS was updated while the tab stayed open, so it asked for files that the new version replaced.",
      handled: "The 'Kaizen OS was updated — Refresh' bar prompts them to reload, which fixes it. Closed automatically.",
    };
  }
  return null;
}
