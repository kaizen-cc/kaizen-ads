import { isCronRequest } from "@/lib/cron";
import { checkSetup } from "@/lib/context/check";
import { collectStep, refreshAll, type Step } from "@/lib/context/run";
import { debugMeta, linkAdAccounts } from "@/lib/context/meta";
import { inviteBotToClientChannels } from "@/lib/context/slack";
import { reportError } from "@/lib/error-report";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { refreshAllKpis } from "@/lib/kpi/sync";
import { detectIndustries } from "@/lib/industry";
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

/** New York time right now: weekday, hour, minute. */
function nyNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

/**
 * Whether a scheduled call should do its step now (Vercel Cron runs in UTC; this is New York time):
 * - slack, drive, gmail: every 30 minutes on weekdays 8am to 6pm, every 3 hours otherwise
 * - meta: every 2 hours (Meta's own numbers settle slowly)
 * - kpi: every 2 hours (campaign numbers for the KPI dashboard; no AI, so it's cheap)
 * - brief: 12pm and 6pm
 */
function due(step: string | null) {
  const { weekday, hour, minute } = nyNow();
  const businessHours = !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour < 18;
  if (step === "slack" || step === "drive" || step === "gmail") return businessHours || (hour % 3 === 0 && minute < 30);
  if (step === "meta") return hour % 2 === 0;
  if (step === "kpi") return true; // every 2 hours (vercel.json)
  if (step === "brief") return [12, 18].includes(hour) && minute < 30;
  return false;
}

/**
 * Each source is pulled in its own run (?step=slack, drive, gmail, meta) and ?step=brief refreshes the client
 * briefings; see due() for how often. Vercel Cron calls on a fixed UTC schedule and each call checks New York
 * time, so daylight saving never shifts the timing. ?force=1, or an exec opening the URL, runs it now.
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
  if (!force && !due(step)) return Response.json({ skipped: "not this step's time in New York" });
  if (!adminConfigured()) return Response.json({ error: "SUPABASE_SECRET_KEY not set" }, { status: 500 });

  try {
    const admin = createAdminClient();
    // Sprint packages past their end date switch off (cheap, so every run checks)
    await admin.rpc("expire_sprint_packages");
    if (step === "kpi") return Response.json(await refreshAllKpis(admin));
    if (step === "brief") {
      const out = await refreshAll(admin, undefined, new URL(request.url).searchParams.get("rebuild") === "1");
      // Clients still without an industry get one (the AI reads what's known about them; a team-set one is kept)
      let industries: number | string = 0;
      try {
        industries = await detectIndustries(admin);
      } catch (e) {
        industries = e instanceof Error ? e.message : String(e);
      }
      return Response.json({ ...out, industries });
    }
    // Execs, by hand: sort every client without an industry now (&force=1 redoes the AI's own guesses)
    if (step === "industry") return Response.json({ set: await detectIndustries(admin, { force: new URL(request.url).searchParams.get("redo") === "1" }) });
    if (step === "slack" || step === "drive" || step === "gmail" || step === "meta") return Response.json(await collectStep(admin, step as Step));
    return Response.json({ error: "Use ?step=slack, drive, gmail, brief or check" }, { status: 400 });
  } catch (e) {
    await reportError({ message: `Context sync: ${e instanceof Error ? e.message : String(e)}`, path: "/api/cron/context", kind: "server", stack: e instanceof Error ? e.stack : null });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
