import { isCronRequest } from "@/lib/cron";
import { checkSetup } from "@/lib/context/check";
import { collectStep, refreshAll, type Step } from "@/lib/context/run";
import { debugMeta, linkAdAccounts } from "@/lib/context/meta";
import { inviteBotToClientChannels } from "@/lib/context/slack";
import { reportError } from "@/lib/error-report";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Briefings take a while when many clients have news
export const maxDuration = 800;

/** A signed-in exec can open this URL to run a step by hand. */
async function isExec() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return false;
  const { data } = await supabase.from("profiles").select("is_exec").eq("auth_user_id", claims.claims.sub).eq("is_active", true).maybeSingle();
  return Boolean(data?.is_exec);
}

const nyHour = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));

/**
 * At 12pm and 6pm New York time, Slack, Drive and Gmail are each pulled in their own run (?step=slack, drive,
 * gmail) and fifteen minutes later ?step=brief refreshes the client briefings. Each step gets its own time limit.
 * Vercel Cron calls at both UTC hours that can be noon or 6pm in New York (daylight saving shifts them),
 * and only the right one does the work. ?force=1, or an exec opening the URL, runs it now.
 * ?step=check tests every connection without reading client data. ?step=brief&rebuild=1 redoes every briefing.
 */
export async function GET(request: Request) {
  const cron = isCronRequest(request);
  if (!cron && !(await isExec())) return new Response("Unauthorized", { status: 401 });
  const force = !cron || new URL(request.url).searchParams.get("force") === "1";
  const step = new URL(request.url).searchParams.get("step");
  if (step === "check" && adminConfigured()) return Response.json(await checkSetup(createAdminClient()));
  // Execs only, by hand: what Meta says to each kind of request on one client's ad account (?client=<slug>)
  if (step === "meta-debug" && !cron && adminConfigured()) {
    const slug = new URL(request.url).searchParams.get("client") ?? "nectr";
    const { data: c } = await createAdminClient().from("clients").select("meta_ad_account_id").eq("slug", slug).maybeSingle();
    if (!c?.meta_ad_account_id) return Response.json({ error: `No ad account linked for "${slug}"` }, { status: 400 });
    return Response.json(await debugMeta(c.meta_ad_account_id));
  }
  // Execs only, by hand: which ad accounts the system user sees, linking creative clients to theirs by name
  if (step === "meta-accounts" && !cron && adminConfigured()) {
    try {
      return Response.json(await linkAdAccounts(createAdminClient()));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }
  // Execs only, by hand: add the bot to private client channels (dry run unless &go=1)
  if (step === "invite") {
    if (cron) return new Response("Not for the schedule", { status: 400 });
    try {
      return Response.json(await inviteBotToClientChannels(new URL(request.url).searchParams.get("go") === "1"));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }
  if (!force && ![12, 18].includes(nyHour())) return Response.json({ skipped: "not 12pm or 6pm in New York" });
  if (!adminConfigured()) return Response.json({ error: "SUPABASE_SECRET_KEY not set" }, { status: 500 });

  try {
    const admin = createAdminClient();
    if (step === "brief") return Response.json(await refreshAll(admin, undefined, new URL(request.url).searchParams.get("rebuild") === "1"));
    if (step === "slack" || step === "drive" || step === "gmail" || step === "meta") return Response.json(await collectStep(admin, step as Step));
    return Response.json({ error: "Use ?step=slack, drive, gmail, brief or check" }, { status: 400 });
  } catch (e) {
    await reportError({ message: `Context sync: ${e instanceof Error ? e.message : String(e)}`, path: "/api/cron/context", kind: "server", stack: e instanceof Error ? e.stack : null });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
