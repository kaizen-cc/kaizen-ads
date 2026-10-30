import { autoGtm } from "@/lib/gtm";
import { keepVerticals } from "@/lib/verticals";
import { writeMissingFirstRounds } from "@/lib/onboarding";
import { syncMarket } from "@/lib/market";
import { isCronRequest } from "@/lib/cron";
import { checkSetup } from "@/lib/context/check";
import { collectStep, refreshAll, type Step } from "@/lib/context/run";
import { debugMeta, linkAdAccounts } from "@/lib/context/meta";
import { inviteBotToClientChannels } from "@/lib/context/slack";
import { reportError } from "@/lib/error-report";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { refreshAllKpis } from "@/lib/kpi/sync";
import { detectIndustries, refreshIndustries } from "@/lib/industry";
import { runStrategist } from "@/lib/suggestions";
import { prewriteRefreshes, runFatigue } from "@/lib/fatigue";
import { mirrorTrack } from "@/lib/client-sync";
import { collectCalls } from "@/lib/calls";
import { readBackfill } from "@/lib/onboarding";
import { createClient } from "@/lib/supabase/server";
import { googleConfigured } from "@/lib/context/google";

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
 * - kpi: every 30 minutes on weekdays 8am to 6pm, every hour otherwise (campaign numbers for the KPI dashboard; no AI)
 * - brief: 12pm and 6pm
 * - market: 8:30am (live ads from Motion for the Market tab, ready for the morning)
 * - sheet: 12pm and 5pm, the Account Overview sheet (buyer, budget and KPI target per account, and the team's notes)
 * - remind: 11am and 3pm on weekdays, a nudge for anyone who hasn't been through their daily recap
 * - notify: every 10 minutes, critical notifications still unread are emailed
 * - docs: every 30 minutes, new and edited Google Docs and Slides across the Workspace, read for the client they're about
 * - asana: every 5 minutes, mirroring open tasks on Asana's Creative board while the team moves over
 * - sprints: every hour, checking each optimization sprint whose next check is due (daily, or the follow-up date it set)
 * - verticals: every hour (the taxonomy weekly, new clients placed, benchmarks researched a few at a time)
 * - gtm: every hour (a Meta go-to-market strategy for newly onboarded clients once the intake form, call notes and website are in)
 * - calls: every 30 minutes on weekdays 8am to 7pm, every 3 hours otherwise (Gemini and Fireflies notes, promises watched)
 * - clients: every hour (new, archived and upgraded clients from Kaizen Track)
 * - suggest: weekdays at 8:30am (the strategist's suggested briefs, ready for the morning)
 */
function due(step: string | null) {
  const { weekday, hour, minute } = nyNow();
  const businessHours = !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour < 18;
  if (step === "slack" || step === "drive" || step === "gmail") return businessHours || (hour % 3 === 0 && minute < 30);
  if (step === "meta") return hour % 2 === 0;
  if (step === "kpi") return businessHours || minute >= 30; // called at :15 and :45 (vercel.json)
  if (step === "brief") return [12, 18].includes(hour) && minute < 30;
  if (step === "suggest") return !["Sat", "Sun"].includes(weekday) && hour === 8;
  if (step === "clients") return true;
  if (step === "gtm") return true;
  if (step === "verticals") return true;
  if (step === "sprints") return true; // hourly; each sprint's own next check decides
  if (step === "asana") return true; // every 5 minutes (vercel.json), so the mirror keeps up with Asana
  if (step === "sheet") return [12, 17].includes(hour);
  if (step === "docs") return true; // every 30 minutes (vercel.json)
  if (step === "remind") return !["Sat", "Sun"].includes(weekday) && [11, 15].includes(hour);
  if (step === "notify") return true; // every 10 minutes (vercel.json): critical notifications still unread go out by email
  if (step === "reports") return true; // every 15 minutes (vercel.json): queues on Mondays and the 1st, drafts what's queued
  if (step === "audits") return hour >= 6 && hour <= 21;
  if (step === "ledger") return hour >= 5 && hour <= 22; // hourly (vercel.json): each client's playbook, oldest first
  if (step === "owed") return !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour <= 19; // every 15 minutes (vercel.json): unanswered messages, nudged then escalated
  if (step === "launches") return true; // every 5 minutes (vercel.json): launch what reached Ready to launch, complete what was turned on

  if (step === "market") return hour === 8;
  if (step === "bibles") return true; // every 10 minutes (vercel.json): every client gets a Brand Bible, kept current
  if (step === "calls") return (businessHours || hour === 18) || (hour % 3 === 0 && minute < 30);
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
    // Hourly: Kaizen Track's clients, then any intake forms still waiting to be read (a backfill, a short burst of forms)
    if (step === "calls") return Response.json(await collectCalls(admin));
    if (step === "gtm") return Response.json(await autoGtm(admin, 1));
    if (step === "verticals") return Response.json(await keepVerticals(admin));
    if (step === "sheet") {
      const { sheetConfigured, syncAccountSheet } = await import("@/lib/account-sheet");
      return Response.json(sheetConfigured() ? await syncAccountSheet(admin) : { skipped: "Google isn't connected" });
    }
    if (step === "remind") return Response.json(await (await import("@/lib/notifications")).remindRecaps(admin));
    if (step === "notify") return Response.json(await (await import("@/lib/notifications")).emailNotifications(admin));
    if (step === "reports") {
      // Mondays from 5am: this week's reports, except the month's first Monday, which gets last month's full recap
      // instead (a weekly and a monthly the same Monday would say the same thing twice). Each Monday's drafts replace
      // the last ones still unsent. Every run drafts what's queued; reminders go out Monday afternoon and Tuesday morning.
      const { queueReports, draftQueued, remindReports } = await import("@/lib/reports/run");
      const { weekday, hour, minute } = nyNow();
      const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const dom = Number(date.slice(8, 10));
      const firstMonday = weekday === "Mon" && dom <= 7;
      const queued = {
        weekly: weekday === "Mon" && !firstMonday && hour >= 5 ? await queueReports(admin, "weekly", date) : 0,
        monthly: firstMonday && hour >= 5 ? await queueReports(admin, "monthly", date) : 0,
      };
      const drafted = await draftQueued(admin, 600_000);
      const remindNow = minute < 15 && ((weekday === "Mon" && hour === 14) || (weekday === "Tue" && hour === 10));
      const reminded = remindNow ? await remindReports(admin, date) : 0;
      return Response.json({ queued, drafted, reminded });
    }
    if (step === "docs") {
      const { watchDocs } = await import("@/lib/context/docs");
      return Response.json(googleConfigured() ? await watchDocs(admin) : { skipped: "Google isn't connected" });
    }
    if (step === "asana") {
      const { asanaConfigured, syncAsana } = await import("@/lib/asana");
      return Response.json(asanaConfigured() ? await syncAsana(admin) : { skipped: "ASANA_TOKEN not set" });
    }
    if (step === "sprints") return Response.json(await (await import("@/lib/sprints")).checkDueSprints(admin));
    if (step === "launches") return Response.json(await (await import("@/lib/launcher")).launchStep(admin));
    if (step === "audits") return Response.json(await (await import("@/lib/auto-audits")).autoAudits(admin));
    if (step === "bibles") return Response.json(await (await import("@/lib/brand-bible")).autoBibles(admin, 3));
    if (step === "ledger") return Response.json(await (await import("@/lib/ledger")).runLedger(admin));
    if (step === "owed") return Response.json(await (await import("@/lib/owed-replies")).runOwedReplies(admin));
    if (step === "market") return Response.json(await syncMarket(admin));
    if (step === "clients")
      return Response.json({
        track: await mirrorTrack(admin),
        intakes: await readBackfill(admin, 25),
        industries: await refreshIndustries(admin).catch((e) => String(e)),
        // Catch up on refresh briefs the Meta run didn't get to
        refreshes: await prewriteRefreshes(admin, 4).catch((e) => String(e)),
        // Clients whose offboarding form gave a last day that has now come
        offboarded: await (await import("@/lib/offboarding")).runScheduledOffboardings(admin).catch((e) => String(e)),
        // Onboarding clients whose intake is in but who have no first round yet
        firstRounds: await writeMissingFirstRounds(admin).catch((e) => String(e)),
      });
    // Execs, by hand: read backfilled intake forms (context only, no first rounds)
    if (step === "intakes") return Response.json(await readBackfill(admin));
    // Execs, by hand: check every ad for fatigue now
    if (step === "fatigue") return Response.json({ ...(await runFatigue(admin)), refreshes: await prewriteRefreshes(admin) });
    if (step === "suggest") return Response.json(await runStrategist(admin, null));
    if (step === "slack" || step === "drive" || step === "gmail" || step === "meta") return Response.json(await collectStep(admin, step as Step));
    return Response.json({ error: "Use ?step=slack, drive, gmail, brief or check" }, { status: 400 });
  } catch (e) {
    await reportError({ message: `Context sync: ${e instanceof Error ? e.message : String(e)}`, path: "/api/cron/context", kind: "server", stack: e instanceof Error ? e.stack : null });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
