import type { Instrumentation } from "next";

// Framework signals that look like errors but aren't (redirects, 404s, dynamic rendering)
const NOT_ERRORS = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

/** Every unexpected server error is recorded and, when due, emailed (see lib/error-report). */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const e = err as Error & { digest?: string };
  if (NOT_ERRORS.test(e?.digest ?? "") || NOT_ERRORS.test(e?.message ?? "")) return;
  const { reportError, personFromCookies } = await import("@/lib/error-report");
  const cookie = request.headers.cookie;
  await reportError({
    message: e?.message || String(err),
    path: request.path,
    kind: context.routeType === "action" ? "action" : "server",
    person: await personFromCookies(Array.isArray(cookie) ? cookie.join("; ") : cookie),
    digest: e?.digest,
    stack: e?.stack,
    detail: { method: request.method, route: context.routePath, routeType: context.routeType },
  });
};
