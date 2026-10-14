import { isCronRequest } from "@/lib/cron";
import { runContextSync } from "@/lib/context/run";
import { reportError } from "@/lib/error-report";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Briefings take a while when many clients have news
export const maxDuration = 300;

const nyHour = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));

/**
 * Pulls new Slack, Gmail and Drive activity and refreshes client briefings at 12pm and 6pm New York time.
 * Vercel Cron calls this at both UTC hours that can be noon or 6pm in New York (daylight saving shifts them),
 * and only the right one does the work. ?force=1 runs it now.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response("Unauthorized", { status: 401 });
  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force && ![12, 18].includes(nyHour())) return Response.json({ skipped: "not 12pm or 6pm in New York" });
  if (!adminConfigured()) return Response.json({ error: "SUPABASE_SECRET_KEY not set" }, { status: 500 });

  try {
    return Response.json(await runContextSync(createAdminClient()));
  } catch (e) {
    await reportError({ message: `Context sync: ${e instanceof Error ? e.message : String(e)}`, path: "/api/cron/context", kind: "server", stack: e instanceof Error ? e.stack : null });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
