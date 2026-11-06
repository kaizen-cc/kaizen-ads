// What was going wrong in this tab just before someone left feedback: the last console errors and failed requests,
// kept in a small ring in memory (never sent anywhere until they send feedback). Installed once per tab.

export type CapturedError = { at: string; message: string };
export type FailedRequest = { at: string; method: string; url: string; status: number | null; error?: string };

const MAX = 12;
const errors: CapturedError[] = [];
const requests: FailedRequest[] = [];
let installed = false;

const push = <T>(ring: T[], item: T) => {
  ring.push(item);
  if (ring.length > MAX) ring.shift();
};
const now = () => new Date().toISOString();
const text = (v: unknown): string => {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
// Query strings can carry tokens: only the path is kept
const pathOf = (url: string) => {
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
};

export function installCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push(errors, { at: now(), message: args.map(text).join(" ").slice(0, 400) });
    original(...args);
  };
  window.addEventListener("error", (e) => {
    if (e.message && e.message !== "Script error.") push(errors, { at: now(), message: e.message.slice(0, 400) });
  });
  window.addEventListener("unhandledrejection", (e) => push(errors, { at: now(), message: `Unhandled: ${text(e.reason).slice(0, 380)}` }));

  const fetch0 = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      const res = await fetch0(input, init);
      if (res.status >= 400) push(requests, { at: now(), method, url: pathOf(url), status: res.status });
      return res;
    } catch (e) {
      // A request cancelled on purpose (leaving a page, a newer search) isn't a failure
      if (!(e instanceof DOMException && e.name === "AbortError")) push(requests, { at: now(), method, url: pathOf(url), status: null, error: text(e).slice(0, 200) });
      throw e;
    }
  };
}

/** A copy of what's been seen so far in this tab. */
export function captured() {
  return { consoleErrors: [...errors], failedRequests: [...requests] };
}
