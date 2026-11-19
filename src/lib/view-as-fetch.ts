import "server-only";
import { flagViewAsBlocked, viewAsCookieNow } from "@/lib/view-as";
import { outboundVerdict, VIEW_AS_HEADER, ViewAsReadOnlyError, viewAsSupabaseRefusal } from "@/lib/view-as-core";

// While the owner views as someone, nothing leaves the server that could change anything: no Slack post, email,
// Meta or Google change, Asana task or upload, and no database write (lib/view-as-core.ts says what counts as a read).

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

function methodOf(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
}

function urlOf(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch that refuses changes while viewing as someone. header: also tag each request with x-kz-view-as (the
 * Supabase clients), so the database answers as the target and runs the request read only.
 */
export function viewAsFetch(base: typeof fetch, opts: { header?: boolean } = {}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = methodOf(input, init);
    // The global guard has nothing to do for a read (and doesn't read cookies for one)
    if (!opts.header && READS.has(method)) return base(input, init);
    const choice = await viewAsCookieNow();
    if (!choice) return base(input, init);
    const verdict = outboundVerdict(method, urlOf(input), process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (verdict === "block-supabase") {
      await flagViewAsBlocked();
      return viewAsSupabaseRefusal(choice.name);
    }
    if (verdict === "block") {
      await flagViewAsBlocked();
      throw new ViewAsReadOnlyError(choice.name);
    }
    if (!opts.header) return base(input, init);
    const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
    headers.set(VIEW_AS_HEADER, choice.id);
    return base(input, { ...init, headers });
  };
}

const INSTALLED = Symbol.for("kz.viewAsFetch");
const ORIGINAL = Symbol.for("kz.viewAsFetch.original");

/**
 * The server's fetch without the guard: only for the view-as audit itself (its start and stop are written while the
 * choice is still in the cookie). Never for anything a person does.
 */
export function unguardedFetch(): typeof fetch {
  const g = globalThis as typeof globalThis & { [ORIGINAL]?: typeof fetch };
  return g[ORIGINAL] ?? globalThis.fetch;
}

/** Wraps the server's fetch once (instrumentation.ts), so every outside call goes through the guard */
export function installViewAsFetchGuard() {
  const g = globalThis as typeof globalThis & { [INSTALLED]?: boolean; [ORIGINAL]?: typeof fetch };
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  const original = globalThis.fetch.bind(globalThis);
  g[ORIGINAL] = original;
  globalThis.fetch = viewAsFetch(original) as typeof fetch;
}
