import "server-only";

/** Only Vercel Cron (which sends CRON_SECRET) may run scheduled jobs. */
export function isCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}
