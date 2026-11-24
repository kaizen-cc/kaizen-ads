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
 * - google_market: Mondays at 7am, Google in the market by industry: what people search (Keyword Planner)
 * - google_ideas: daily at 6:30am, Google's Hall of Fame and live winners (ads, keywords, search terms)
 * - kpi: every 30 minutes on weekdays 8am to 6pm, every hour otherwise (campaign numbers for the KPI dashboard; no AI)
 * - klaviyo: on the KPI numbers' cadence; every connected client's recent email numbers, the full window once a day,
 *   six clients at a time
 * - social: every 3 hours (organic social clients: Facebook Page and Instagram account numbers, recent posts and live
 *   stories, read only, only the platforms each client posts on; clients very behind on their social allotment flagged;
 *   the full 90 days once a day, three clients at a time; a client still without a Page is looked for again every 6 hours)
 * - brief: 12pm and 6pm
 * - market: 8:30am (live ads from Motion for the Market tab, ready for the morning)
 * - sheet: 12pm and 5pm, the Account Overview sheet (buyer, budget and KPI target per account, and the team's notes)
 * - remind: 11am and 3pm on weekdays, a nudge for anyone who hasn't been through their daily recap
 * - notify: every 10 minutes, critical notifications still unread are emailed
 * - direction: every 30 minutes on weekdays 8am to 6pm, new client messages (Slack, email, the portal chat, read calls)
 *   checked for a change of direction against each client's open work (src/lib/direction-changes.ts)
 * - approvals: every 15 minutes on weekdays 8am to 6pm, creative with the client: the Slack post and email, reminders at
 *   24 and 48 business hours, customer success's queue, and auto-approval for clients who opted in
 * - docs: every 30 minutes, new and edited Google Docs and Slides across the Workspace, read for the client they're about
 * - asana: every 5 minutes, mirroring open tasks on Asana's Creative board while the team moves over
 * - email_ops: every hour 6am to 9pm: email accounts in the red audit themselves (and the strategist is told), each email sprint
 *   whose next check is due re-measures the score, and on weekdays 7am to 10am each client's campaign suggestions are
 *   refreshed weekly (src/lib/email-ops); the same run audits red social accounts and checks social sprints
 *   (src/lib/social-ops)
 * - sprints: every hour, checking each optimization sprint whose next check is due (daily, or the follow-up date it set)
 * - verticals: every hour (the taxonomy weekly, new clients placed, benchmarks researched a few at a time)
 * - gtm: every hour (a Meta go-to-market strategy for newly onboarded clients once the intake form, call notes and website are in)
 * - calls: every 30 minutes on weekdays 8am to 7pm, every 3 hours otherwise (Gemini and Fireflies notes, promises watched)
 * - clients: every hour (new, archived and upgraded clients from Kaizen Track)
 * - suggest: weekdays at 8:30am (the strategist's suggested briefs, ready for the morning)
 * - integrations: every hour (each client's WooCommerce, GoHighLevel or HubSpot read; at 9am, the buyers' notes)
 * - shopify: every 10 minutes (stores whose full history is still being read go first, every store refreshed hourly with
 *   only changed days written; a few clients checked for a Shopify store nobody connected)
 * - bible_upkeep: every hour (the Bible's pages checked every 90 days, website issues read from new Bibles, each
 *   client's onboarding sheet read when it's new or changed, brand guidelines clients shared read for the Head of
 *   Creative to approve; at 9am, clients paid for creative and given nothing)
 */
function due(step: string | null) {
  const { weekday, hour, minute } = nyNow();
  const businessHours = !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour < 18;
  if (step === "slack" || step === "drive" || step === "gmail") return businessHours || (hour % 3 === 0 && minute < 30);
  if (step === "meta") return hour % 2 === 0;
  if (step === "tiktok") return hour % 2 === 0; // like Meta's ads; does nothing until TikTok's app keys are in Vercel
  if (step === "social") return hour % 3 === 1; // called hourly at :28 (vercel.json); insights are daily numbers, so every third hour is plenty
  if (step === "klaviyo") return businessHours || minute >= 30; // called at :18 and :48 (vercel.json): as often as the KPI numbers; every client's recent numbers each run, the full window once a day
  if (step === "kpi") return businessHours || minute >= 30; // called at :15 and :45 (vercel.json)
  if (step === "google_ideas") return true; // once a day (vercel.json): Google's Hall of Fame and live winners
  if (step === "google_market") return true; // Mondays (vercel.json): Google in the market, by industry
  if (step === "brief") return [12, 18].includes(hour) && minute < 30;
  if (step === "suggest") return !["Sat", "Sun"].includes(weekday) && hour === 8;
  if (step === "clients") return true;
  if (step === "gtm") return true;
  if (step === "verticals") return true;
  if (step === "creative_plan") return hour >= 6 && hour <= 22; // hourly (vercel.json): shot lists each cycle, files ticked off, marketing moments
  if (step === "email_ops") return hour >= 6 && hour <= 21; // hourly (vercel.json): red email accounts audited, email sprints checked, suggestions weekly
  if (step === "sprints") return true; // hourly; each sprint's own next check decides
  if (step === "asana") return true; // every 5 minutes (vercel.json), so the mirror keeps up with Asana
  if (step === "sheet") return [12, 17].includes(hour);
  if (step === "creative_db") return true; // every 15 minutes (vercel.json): each client's Creative Database, the source of truth for delivered creative
  if (step === "docs") return true; // every 30 minutes (vercel.json)
  if (step === "email_sow") return hour >= 6 && hour <= 21; // hourly (vercel.json): email clients' SOWs found and read, the SOW month's requests drafted, very-behind allotments flagged
  if (step === "social_learn") return true; // hourly (vercel.json): calls, Slack and Gmail read for the organic social agents' lessons (pending approval)
  if (step === "youtube") return true; // every 30 minutes (vercel.json): channels checked every few hours, new videos read into takeaways, the day's notices
  if (step === "loom") return true; // every 15 minutes (vercel.json): the Loom queue, shared folders daily, the senior buyer's teachings consolidated
  if (step === "remind") return !["Sat", "Sun"].includes(weekday) && [11, 15].includes(hour);
  if (step === "notify") return true; // every 10 minutes (vercel.json): critical notifications still unread go out by email
  if (step === "feedback") return true; // every 5 minutes (vercel.json): missed feedback read, automatic fixes followed on GitHub; Mondays at 9am the digest
  if (step === "reports") return true; // every 15 minutes (vercel.json): queues on Mondays and the 1st, drafts what's queued
  if (step === "audits") return hour >= 6 && hour <= 21;
  if (step === "ledger") return hour >= 5 && hour <= 22; // hourly (vercel.json): each client's playbook, oldest first
  if (step === "owed") return !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour <= 19; // every 15 minutes (vercel.json): unanswered messages, nudged then escalated
  if (step === "approvals") return businessHours; // every 15 minutes (vercel.json), weekdays 8am to 6pm: creative with the client posted, reminded at 24 and 48 business hours, chased or auto-approved
  if (step === "direction") return businessHours; // every 30 minutes (vercel.json), weekdays 8am to 6pm: a client changing direction, caught against their open work
  if (step === "launches") return true; // every 5 minutes (vercel.json): launch what reached Ready to launch, complete what was turned on

  if (step === "market") return hour === 8;
  if (step === "creative_drive") return true; // every 10 minutes (vercel.json): ticket creative copied into each client's Drive, retries
  if (step === "bibles") return true; // every 10 minutes (vercel.json): every client gets a Brand Bible, kept current
  if (step === "after_call") return true; // every 5 minutes (vercel.json): work approved on a call that keeps going after it (case studies), one item at a time
  if (step === "slack_seats") return true; // hourly (vercel.json), but runs once a day: everyone on a client's seats in its Slack channels
  if (step === "meta_tokens") return true; // daily (vercel.json): each Business Manager's Meta token checked, execs told when one stops working
  if (step === "connectors") return true; // daily (vercel.json): the MCP registry's remote servers into the connector catalog, offered ones kept current
  if (step === "bible_write") return true; // started by a Bible build once its research is in (?client=<id>)
  if (step === "presentation_write") return true; // started once a Bible is written (?client=<id>): its client presentation, drafted (never sent)
  if (step === "presentations") return true; // every 10 minutes (vercel.json): a new client's presentation, written and sent
  if (step === "integrations") return true; // hourly (vercel.json): stores and CRMs read, and at 9am the notes to the buyers
  if (step === "shopify") return true; // every 10 minutes (vercel.json): history reads first, each store refreshed hourly (the step itself skips stores read in the last 50 minutes)
  if (step === "patterns") return weekday === "Mon" && hour >= 5 && hour <= 10; // Mondays early (vercel.json): patterns across clients, a group or two a run
  if (step === "bible_upkeep") return true; // hourly (vercel.json): links, website issues, creative packages with nothing made
  if (step === "learnings") return true; // nightly (vercel.json): the team's learnings classified, merged, settled and retired
  if (step === "drift") return true; // weekly (vercel.json): replay what the week's learning changes did to each agent
  if (step === "done") return hour >= 7 && hour <= 23; // hourly (vercel.json), 7am to 11pm: items on anyone's day closed when Slack, Gmail or call notes show them done
  if (step === "stepins") return hour >= 6 && hour <= 19; // every 2 hours (vercel.json): the execs' step-ins, built Monday morning and kept current through the week
  if (step === "dogs") return hour >= 7 && hour <= 18; // twice a day (vercel.json): the daily watchdogs, same-day notices to the account owner and the line's head
  if (step === "sites") return true; // hourly (vercel.json): web design clients' sites up or down; Mondays the page check
  if (step === "reviews") return weekday === "Mon" && hour >= 6 && hour <= 12; // hourly on Mondays (vercel.json): the line heads' weekly account reviews, drafted a batch at a time
  if (step === "history") return true; // every 10 minutes (vercel.json): a client's whole email history and earlier calls, once
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
  // Execs only, by hand: who's assigned to a client but missing from its Slack channels (a report unless &go=1, which invites them)
  if (step === "slack_seats" && !cron && adminConfigured()) {
    try {
      return Response.json(await (await import("@/lib/slack-seats")).syncSlackSeats(createAdminClient(), { invite: new URL(request.url).searchParams.get("go") === "1" }));
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
    if (step === "tiktok") return Response.json(await (await import("@/lib/tiktok/store")).syncAllTikTok(admin));
    // Klaviyo, then Brevo and Customer.io clients, on the same schedule: all three feed the same email tables
    if (step === "klaviyo") {
      const synced = await (await import("@/lib/email-providers")).syncAllEmail(admin, { budgetMs: 640_000 });
      // Months before the stored history that a report, the KPI sheet or a card asked for: read in the background, a few pieces per run
      const history = await import("@/lib/email-history/run").then((m) => m.runHistoryJobs(admin, 200_000)).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ ...synced, history });
    }
    if (step === "social") {
      const synced = await (await import("@/lib/social/store")).syncAllSocial(admin, { budgetMs: 560_000 });
      // Clients very behind on their social allotment: their Social Media Manager and the Head of Social, once a cycle (and in its last week)
      const pace = await (await import("@/lib/social-pace-alerts")).socialPaceAlerts(admin).catch((e) => String(e));
      // Which posts the ads team is boosting (each recent ad's post, asked of Meta), and clients with nothing boosted flagged
      const boosts = await import("@/lib/social-boosts");
      const adPosts = await boosts.syncAdPosts(admin, { budgetMs: 90_000 }).catch((e) => String(e));
      const boostFlags = await boosts.boostAlerts(admin).catch((e) => String(e));
      return Response.json({ ...synced, pace, adPosts, boostFlags });
    }
    if (step === "after_call") return Response.json(await (await import("@/lib/assistant/after-call-jobs")).runAfterCallJobs(admin));
    if (step === "slack_seats") {
      // Once a day: the hourly call does nothing when the last audit is under 20 hours old (so the first runs soon after a deploy)
      const { data: last } = await admin.from("slack_seat_audits").select("ran_at").order("ran_at", { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - Date.parse(last.ran_at as string) < 20 * 3_600_000) return Response.json({ skipped: "audited in the last 20 hours" });
      const { slackConfigured } = await import("@/lib/context/slack");
      if (!slackConfigured()) return Response.json({ skipped: "Slack isn't connected" });
      return Response.json(await (await import("@/lib/slack-seats")).syncSlackSeats(admin));
    }
    if (step === "meta_tokens") return Response.json(await (await import("@/lib/meta-tokens")).checkAllBusinessTokens(admin));
    if (step === "connectors") return Response.json(await (await import("@/lib/connectors/registry-sync")).syncConnectorRegistry(admin));
    if (step === "google_ideas") {
      const { googleAdsConfigured } = await import("@/lib/context/google-ads");
      if (!googleAdsConfigured()) return Response.json({ skipped: "Google Ads isn't connected" });
      return Response.json(await (await import("@/lib/google-ideas")).updateGoogleIdeas(admin));
    }
    if (step === "google_market") {
      const { googleAdsConfigured } = await import("@/lib/context/google-ads");
      if (!googleAdsConfigured()) return Response.json({ skipped: "Google Ads isn't connected" });
      return Response.json(await (await import("@/lib/google-market")).updateGoogleMarket(admin));
    }
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
    if (step === "creative_plan") {
      const { keepShotLists, matchShotUploads } = await import("@/lib/shot-list");
      const { keepMoments } = await import("@/lib/moments");
      const shots = await keepShotLists(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const matched = await matchShotUploads(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const moments = await keepMoments(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ shots, matched, moments });
    }
    if (step === "creative_db") {
      // Every creative client's Creative Database, read now and paced under Google's per-minute limit: delivered this
      // cycle comes from it (client_allotment_usage), so the allotments are never a schedule behind
      const { syncCreativeDatabases } = await import("@/lib/creative-db");
      return Response.json(googleConfigured() ? await syncCreativeDatabases(admin) : { skipped: "Google isn't connected" });
    }
    if (step === "sheet") {
      const { sheetConfigured, syncAccountSheet } = await import("@/lib/account-sheet");
      return Response.json(sheetConfigured() ? await syncAccountSheet(admin) : { skipped: "Google isn't connected" });
    }
    if (step === "remind") return Response.json(await (await import("@/lib/notifications")).remindRecaps(admin));
    if (step === "notify") {
      // Also: the safety review of ended calls (and their audio's retention), and reports the assistant is watching
      const safety = await (await import("@/lib/agent-call/safety")).sweepCallSafety(admin).catch((e) => ({ error: String(e) }));
      const watches = await (await import("@/lib/assistant/tools")).sweepReportWatches(admin).catch((e) => ({ error: String(e) }));
      // Urgent heads-ups for people not in the app: into their assistant chat, unread (the app rings the others)
      const headsUps = await (await import("@/lib/assistant/heads-up-server")).sweepHeadsUps(admin).catch((e) => ({ error: String(e) }));
      // Once: calendar scheduling checked end to end in production (no invites; system_checks "calendar-booking")
      const calendar = await (await import("@/lib/assistant/calendar-selftest")).calendarSelfTestOnce(admin).catch((e) => ({ error: String(e) }));
      return Response.json({ ...(await (await import("@/lib/notifications")).emailNotifications(admin)), safety, watches, headsUps, calendar });
    }
    if (step === "feedback") {
      const { feedbackDigest, runFeedback } = await import("@/lib/feedback");
      const out = await runFeedback(admin);
      // Mondays at 9am New York: what keeps coming up, to every exec (one a week: the notification key is the date)
      const { weekday, hour } = nyNow();
      const digest = weekday === "Mon" && hour === 9 ? await feedbackDigest(admin) : null;
      return Response.json({ ...out, digest });
    }
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
      // The email and organic social reports: the monthly on the first business days, the weekly (clients that ask for it)
      // on Mondays. Guarded on its own: a failure here never reaches the ads reports above
      const channel = await (async () => {
        try {
          const ch = await import("@/lib/channel-reports/queue");
          const { dueKinds } = await import("@/lib/channel-reports/core");
          const dueKindsNow = dueKinds({ weekday, dom, hour });
          const made: Record<string, unknown> = {};
          for (const kind of dueKindsNow) made[kind] = await ch.queueChannelReports(admin, kind, date);
          // The days after Monday: a client connected since (Brevo, Customer.io or Klaviyo) is caught up, never made twice
          const { catchUpKind } = await import("@/lib/channel-reports/core");
          const late = dueKindsNow.length ? null : catchUpKind({ weekday, dom, hour });
          if (late) made[`${late}-catch-up`] = await ch.queueChannelReports(admin, late, date);
          const done = await ch.draftChannelQueued(admin, 240_000);
          const told = remindNow ? await ch.remindChannelReports(admin, date) : 0;
          return { queued: made, drafted: done, reminded: told };
        } catch (e) {
          await reportError({ message: `Channel reports: ${e instanceof Error ? e.message : String(e)}`, path: "/api/cron/context?step=reports", kind: "server", stack: e instanceof Error ? e.stack : null }).catch(() => null);
          return { error: e instanceof Error ? e.message : String(e) };
        }
      })();
      return Response.json({ queued, drafted, reminded, channel });
    }
    if (step === "loom") {
      const { aiEnabled } = await import("@/lib/ai");
      if (!aiEnabled()) return Response.json({ skipped: "The AI isn't connected" });
      const loom = await import("@/lib/loom-intake");
      const began = Date.now();
      // Shared folders not read for a day: new recordings queued
      const folders = await loom.recheckLoomFolders(admin).catch((e) => String(e));
      // Loom through Atlassian's MCP server (when connected): every video created since the last check queued
      const la = await import("@/lib/loom-atlassian");
      const atlassian = await la.syncLoomFromAtlassian(admin, { budgetMs: 60_000 }).catch((e) => String(e));
      // Once a day: the execs told when the Atlassian token is 30, 14, 7 or 1 days from expiring
      const tokenExpiry = await la.checkTokenExpiry(admin).catch((e) => String(e));
      const queue = await loom.processLoomQueue(admin, { budgetMs: 480_000, parallel: 4 });
      // New teachings distilled since the last run: merged, contradictions flagged, the skills rewritten
      const { count } = await admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("consolidated_at", null).is("merged_into", null);
      const bi = await import("@/lib/buying-insights");
      // Points not yet attributed to an industry or sorted general vs industry-only: a slice each run until done
      const room = 560_000 - (Date.now() - began);
      const attribution = room > 120_000 && (await bi.attributionPending(admin)) ? await bi.attributeInsights(admin, { budgetMs: Math.min(room, 240_000) }).catch((e) => String(e)) : { pending: "later" };
      const insights = count ? await bi.consolidateInsights(admin, { budgetMs: 180_000 }).catch((e) => String(e)) : { new: 0 };
      // Prospects that became clients (by name, website or ad account): their pre-sale audit Looms filed to them
      const prospects = await (await import("@/lib/loom-prospects")).attachProspectLooms(admin).catch((e) => String(e));
      // Videos waiting for a decision get the AI's guess at the prospect they audit; videos get their picture
      const left = 590_000 - (Date.now() - began);
      const suggested = left > 60_000 ? await loom.suggestProspects(admin, 8).catch((e) => String(e)) : { later: true };
      const thumbs = left > 30_000 ? await loom.fillLoomThumbnails(admin, 40).catch((e) => String(e)) : { later: true };
      // Contradictions nobody was told about yet: the bell of everyone who rules on them
      const told = await (await import("@/lib/insight-conflicts")).notifyContradictions(admin).catch((e) => String(e));
      return Response.json({ folders, atlassian, tokenExpiry, queue, attribution, insights, prospects, suggested, thumbs, told });
    }
    if (step === "youtube") {
      // YouTube learning (Settings › AI agents › YouTube): channels not checked for a few hours read for new uploads,
      // queued videos read and distilled a few at a time within the budget, and new takeaways shared in the app
      const { aiEnabled } = await import("@/lib/ai");
      if (!aiEnabled()) return Response.json({ skipped: "The AI isn't connected" });
      const yt = await import("@/lib/youtube");
      const sources = await yt.checkSources(admin, { budgetMs: 60_000 }).catch((e) => String(e));
      // Videos the team shared in Slack: team channels the bot is in (and line channels it joins), and people's own DMs
      // when they've connected Slack reading (client channels come in with the context sync)
      const ys = await import("@/lib/youtube-slack");
      const slackShares = await ys.scanTeamChannels(admin, { budgetMs: 60_000 }).catch((e) => String(e));
      const dmShares = await ys.scanPersonalDms(admin).catch((e) => String(e));
      // The Gemini key just set: the videos that waited for it go back in the queue
      const requeued = await yt.requeueForKey(admin).catch((e) => String(e));
      const queue = await yt.processYouTubeQueue(admin, { budgetMs: 240_000, parallel: 3 }).catch((e) => String(e));
      const shared = await yt.shareTakeaways(admin).catch((e) => String(e));
      // The Tracking Engineer, on the same beat: its playbook filed once, and clients with a tracking flag or a sudden
      // conversion-rate drop checked (a few a run, each at most weekly), the tracking specialists told in the app
      const tracking = await import("@/lib/tracking-agent");
      const playbook = await tracking.seedTrackingPlaybook(admin).catch((e) => String(e));
      const trackingChecks = await tracking.trackingWatch(admin, { max: 3 }).catch((e) => String(e));
      // Videos shared in a client's channel, now read: filed to that client's knowledge when they're about the client
      const clientFiled = await ys.attachSharedToClients(admin).catch((e) => String(e));
      return Response.json({ sources, slackShares, dmShares, requeued, queue, shared, clientFiled, playbook, trackingChecks });
    }
    if (step === "social_learn") {
      const { aiEnabled } = await import("@/lib/ai");
      if (!aiEnabled()) return Response.json({ skipped: "The AI isn't connected" });
      // What clients and the team said about each social account: lessons for the Social Strategist, waiting for the Head of Social or an exec
      return Response.json(await (await import("@/lib/social-training")).harvestSocialLearnings(admin, { budgetMs: 300_000 }));
    }
    if (step === "email_sow") {
      const { aiEnabled } = await import("@/lib/ai");
      if (!aiEnabled()) return Response.json({ skipped: "The AI isn't connected" });
      const { sowPass } = await import("@/lib/email-sow");
      // Clients very behind on their email allotment: their strategist and the Head of Email, once a cycle (and in its last week)
      const pace = await (await import("@/lib/email-pace-alerts")).emailPaceAlerts(admin).catch((e) => String(e));
      return Response.json({ ...(await sowPass(admin, Date.now() + 300_000)), pace });
    }
    if (step === "docs") {
      const { watchDocs } = await import("@/lib/context/docs");
      return Response.json(googleConfigured() ? await watchDocs(admin) : { skipped: "Google isn't connected" });
    }
    if (step === "asana") {
      const { asanaConfigured, syncAsana } = await import("@/lib/asana");
      if (!asanaConfigured()) return Response.json({ skipped: "ASANA_TOKEN not set" });
      // The Creative board, then the email board (its own mirror for the Email Board); one failing never stops the other
      const creative = await syncAsana(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const { syncAsanaEmail } = await import("@/lib/asana-email");
      const email = await syncAsanaEmail(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ creative, email });
    }
    if (step === "email_ops") {
      const { weekday, hour } = nyNow();
      // Each part is its own try, so one failing does not stop the others
      const part = async <T,>(work: () => Promise<T>) => work().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const audits = await part(async () => (await import("@/lib/email-ops/auto-audits")).autoEmailAudits(admin, 240_000));
      const sprints = await part(async () => (await import("@/lib/email-ops/sprint")).checkDueEmailSprints(admin));
      const suggestions = !["Sat", "Sun"].includes(weekday) && hour >= 7 && hour <= 10 ? await part(async () => (await import("@/lib/email-ops/suggestions")).refreshSuggestions(admin, 240_000)) : { skipped: "weekday mornings only" };
      // The social line, the same way: red social accounts audit themselves, each social sprint's due check runs
      const socialAudits = await part(async () => (await import("@/lib/social-ops/auto-audits")).autoSocialAudits(admin, 180_000));
      const socialSprints = await part(async () => (await import("@/lib/social-ops/sprint")).checkDueSocialSprints(admin));
      return Response.json({ audits, sprints, suggestions, socialAudits, socialSprints });
    }
    if (step === "sprints") return Response.json(await (await import("@/lib/sprints")).checkDueSprints(admin));
    if (step === "launches") {
      // Every 5 minutes: also pick up background briefs a cut-off server left queued or half-written
      const briefJobs = await (await import("@/lib/brief-jobs")).pickUpBriefJobs(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      // …and finish Higgsfield images and videos nobody's page is waiting on (copied in, the person told)
      const mediaJobs = await (await import("@/lib/ai-media-jobs")).pickUpMediaJobs(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ ...(await (await import("@/lib/launcher")).launchStep(admin)), briefJobs, mediaJobs });
    }
    if (step === "creative_drive") {
      // The queue first (new creative), then files already in Drive moved to where the layout says (avatar / angle / concept)
      const lib = await import("@/lib/creative-drive");
      const queue = await lib.processDriveQueue(admin, { limit: 200, budgetMs: 240_000 });
      const relayout = await lib.relayoutDrive(admin, { budgetMs: 150_000 }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      // Each client's Ad Creatives folder, found and set on its own (new clients as soon as their Drive folder is known)
      const adCreatives = await lib.fillAdCreativeFolders(admin, { limit: 120, budgetMs: 90_000 }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ ...queue, relayout, adCreatives });
    }
    if (step === "audits") return Response.json(await (await import("@/lib/auto-audits")).autoAudits(admin));
    // The account watch: billed but idle, neglected or overtouched accounts, spend anomalies, creative behind, unknown people
    if (step === "stepins") return Response.json(await (await import("@/lib/stepins/run")).runStepins(admin));
    if (step === "dogs") return Response.json(await (await import("@/lib/watchdogs/run")).runWatchdogs(admin));
    if (step === "done") return Response.json(await (await import("@/lib/done-check")).runDoneChecks(admin, { budget: Number(new URL(request.url).searchParams.get("budget")) || 40 }));
    if (step === "sites") return Response.json(await (await import("@/lib/watchdogs/run")).runSiteChecks(admin));
    if (step === "reviews") return Response.json(await (await import("@/lib/line-review/build")).runWeeklyReviews(admin, { batch: 40 }));
    if (step === "watch") return Response.json(await (await import("@/lib/account-watch/run")).runAccountWatch(admin));
    if (step === "bibles") return Response.json(await (await import("@/lib/brand-bible")).autoBibles(admin, 3));
    if (step === "presentations") {
      const presentations = await (await import("@/lib/presentation")).keepPresentations(admin);
      const launches = await (await import("@/lib/engagement-launch")).keepLaunches(admin);
      const guides = await (await import("@/lib/onboarding-guide")).keepGuides(admin);
      // After approval: the final execution plan and its tasks, then the client's Slack messages
      const plans = await (await import("@/lib/execution-plan")).keepExecution(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const { keepKickoffs, keepMeetTeam } = await import("@/lib/kickoff");
      const meetTeam = await keepMeetTeam(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      const kickoffs = await keepKickoffs(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return Response.json({ presentations, launches, guides, plans, meetTeam, kickoffs });
    }
    if (step === "history") {
      const { googleConfigured, pullEmailHistory } = await import("@/lib/context/google");
      if (!googleConfigured()) return Response.json({ skipped: "Google not set up" });
      return Response.json(await pullEmailHistory(admin, Date.now() + 300_000));
    }
    if (step === "bible_write") {
      const id = new URL(request.url).searchParams.get("client");
      if (!id) return Response.json({ error: "client missing" }, { status: 400 });
      return Response.json({ result: await (await import("@/lib/brand-bible")).writeBible(admin, id) });
    }
    if (step === "presentation_write") {
      const id = new URL(request.url).searchParams.get("client");
      if (!id) return Response.json({ error: "client missing" }, { status: 400 });
      return Response.json({ result: await (await import("@/lib/presentation")).writePresentation(admin, id) });
    }
    if (step === "integrations") return Response.json(await (await import("@/lib/integrations")).keepIntegrations(admin));
    if (step === "shopify") return Response.json(await (await import("@/lib/shopify/store")).keepShopify(admin));
    if (step === "bible_upkeep") {
      const links = await (await import("@/lib/bible-links")).keepLinks(admin).catch((e) => String(e));
      const issues = await (await import("@/lib/website-issues")).keepIssues(admin).catch((e) => String(e));
      const packages = nyNow().hour === 9 ? await (await import("@/lib/package-gaps")).flagPackageGaps(admin).catch((e) => String(e)) : "not the hour";
      const sheets = await (await import("@/lib/onboarding-sheet")).keepOnboardingSheets(admin).catch((e) => String(e));
      // Portal chat: an email for team messages left unread (off until switched on)
      const chat = await (await import("@/lib/portal-chat")).chatDigest(admin).catch((e) => String(e));
      // Knowledge files left half read (the server stopped mid-read): read again
      const knowledge = await (await import("@/lib/knowledge")).keepKnowledge(admin).catch((e) => String(e));
      // Feedback on the makers' work (review and client comments, Asana comments) sorted into real errors
      const errors = await (await import("@/lib/creative-errors")).keepCreativeErrors(admin).catch((e) => String(e));
      // The same for email work (Asana email board and Email Board comments), each comment read once
      const emailErrors = await (await import("@/lib/email-errors")).keepEmailErrors(admin).catch((e) => String(e));
      // Brand guidelines the clients shared (Drive, Slack, email, calls, the intake form), read for the Head of Creative to approve into the Bible
      const guidelines = await (await import("@/lib/brand-guidelines")).keepGuidelines(admin).catch((e) => String(e));
      return Response.json({ links, issues, packages, sheets, chat, knowledge, errors, emailErrors, guidelines });
    }
    // By hand (execs): the guideline pass plus the back-fill for every client, resumable; each call reads the next few
    // ...or one client now (&client=<slug>)
    if (step === "guidelines" && new URL(request.url).searchParams.get("client")) {
      const { data: c } = await admin.from("clients").select("id, name").eq("slug", new URL(request.url).searchParams.get("client") as string).maybeSingle();
      if (!c) return Response.json({ error: "No client with that slug" }, { status: 404 });
      return Response.json({ client: c.name, ...(await (await import("@/lib/brand-guidelines")).guidelinesForClient(admin, c.id as string)) });
    }
    if (step === "guidelines") return Response.json(await (await import("@/lib/brand-guidelines")).keepGuidelines(admin));
    if (step === "ledger") return Response.json(await (await import("@/lib/ledger")).runLedger(admin, 300_000));
    if (step === "learnings") return Response.json(await (await import("@/lib/learnings")).consolidateLearnings(admin));
    if (step === "drift") return Response.json(await (await import("@/lib/agent-evals")).driftCheck(admin));
    if (step === "patterns") {
      // Only groups not done this week
      const { data: st } = await admin.from("sync_state").select("last_result").eq("source", "patterns").maybeSingle();
      const last = (st?.last_result ?? {}) as Record<string, { at?: string }>;
      const { MODEL_NAMES, runPatterns } = await import("@/lib/patterns");
      const due = (Object.keys(MODEL_NAMES) as (keyof typeof MODEL_NAMES)[]).filter((m) => !last[m]?.at || Date.now() - Date.parse(last[m]!.at!) > 5 * 86_400_000);
      return Response.json(due.length ? await runPatterns(admin, 200_000, due) : { done: "this week" });
    }
    if (step === "owed") {
      // Also closes calls with the AI agents nobody hung up (a closed tab, a dropped phone): what they heard stays for review
      const calls = await (await import("@/lib/agent-call/server")).sweepOpenCalls(admin).catch((e) => ({ error: String(e) }));
      return Response.json({ ...(await (await import("@/lib/owed-replies")).runOwedReplies(admin)), calls });
    }
    if (step === "direction") return Response.json(await (await import("@/lib/direction-changes")).runDirectionChanges(admin));
    if (step === "approvals") return Response.json(await (await import("@/lib/approval-notices")).runApprovalNotices(admin));
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
