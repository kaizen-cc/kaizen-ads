/** Public address of the app, used in emails and magic links. */
export function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
}

/** Only allow redirects to paths inside the app (never to another site). */
export function safeNext(next: string | null | undefined, fallback = "/") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
