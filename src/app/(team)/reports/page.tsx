import type { Metadata } from "next";
import { onService } from "@/lib/service-gate";
import Link from "next/link";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { nyParts } from "@/lib/kpi/calc";
import { periodsFor } from "@/lib/reports/metrics";
import type { Qa } from "@/lib/reports/write";
import { slackConnection } from "@/lib/slack-user";
import { SlackConnect } from "@/components/slack-connect";
import { reportableTargets } from "@/lib/reports/access";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ReportBuilder, type BuilderClient, type QuickPick } from "./report-builder";
import { BundleCard, Empty, Group, ReportCard, SkippedGroup, type CardBundle, type CardReport, type SkippedItem, type Tag } from "./report-cards";
import { RegenerateButton, RegenWatcher } from "./regenerate-button";
import { EmailMark, GoogleAdsMark, MetaMark, SocialMark, TikTokMark } from "@/components/source-logo";
import { adsLinesFor, isChannelOnly, teamPlatform } from "@/lib/roles";
import { buyerRole, orderSeats, primaryOf, type SeatRow } from "@/lib/buyer-seats";
import { readHistory } from "@/lib/reports/history";
import { SendHistory } from "./send-history";
import { canBringBack, latestSkip, skipLine } from "@/lib/reports/skip-log";
import { isHeadOf, linesFor, REPORT_SEATS } from "@/lib/channel-reports/access-core";
import { channelClients, coverageFor, ownersFor, type ChannelClient } from "@/lib/channel-reports/clients";
import { lastMonthOf, lineOfPlatform, platformOfLine, type ChannelLine } from "@/lib/channel-reports/core";

export const metadata: Metadata = { title: "Reports" };
export const maxDuration = 300;

type Plat = "meta" | "google" | "tiktok" | "klaviyo" | "social";
const isChan = (p: string) => p === "klaviyo" || p === "social";

type Row = { id: string; kind: "weekly" | "monthly" | "custom"; platform: string; status: string; qa: Qa | null; posted_at: string | null; viewed_at: string | null; owner_id: string | null; client_id: string; period_start: string; period_end: string; bundle_id: string | null; clients: { name: string; slug: string }; profiles: { full_name: string } | null };

// How far back the page looks: anything not sent yet stays on the page until it's sent (or removed); the Sent tab
// keeps the last 30 days (every report stays in the client's history)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const DONE = ["posted", "skipped"];

/** This week's reports and this month's recap, for each buyer (theirs) and for leads and execs (their line, or all). */
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const me = await requireStaff();
  const sp = await searchParams;
  const asked = sp.view === "sent" ? "sent" : sp.view === "build" ? "build" : sp.view === "ready" ? "ready" : null;
  // The Monday drafts, one platform at a time (execs switch; everyone else is on their own line) and one buyer at a time
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const db = await createClient();
  const today = nyParts(new Date()).date;
  const month = periodsFor("monthly", today).main;
  const lead = isExecOrLead(me) || isHeadOf(me, "email") || isHeadOf(me, "social");
  const admin = adminConfigured() ? createAdminClient() : null;
  // The email and social teams see only their own line's reports and never the ads accounts (an exec sees all five platforms)
  const lines = linesFor(me);
  const channelOnly = !me.isExec && isChannelOnly(me.role);
  // The accounts this person reports on (their own; their line's for a lead; all for an exec): what they see and can draft
  const accounts = channelOnly ? [] : await reportableTargets(db, me);
  const SELECT = "id, kind, platform, status, qa, posted_at, viewed_at, owner_id, client_id, period_start, period_end, bundle_id, clients(name, slug), profiles!reports_owner_id_fkey(full_name)";
  let q = db
    .from("reports")
    .select(SELECT)
    .in("kind", ["weekly", "monthly", "custom"])
    .in("platform", ["meta", "google", "tiktok"])
    .is("hidden_at", null)
    .gte("created_at", daysAgo(60))
    .order("created_at");
  if (!me.isExec) q = q.in("target_id", accounts.length ? accounts.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"]);
  const [adsRes, slack, chanLists] = await Promise.all([
    channelOnly ? Promise.resolve({ data: [] }) : q,
    slackConnection(me.id),
    // Which clients this person reports on for each line, by the rule the database applies (the head's by service, others by seat)
    Promise.all(lines.map(async (l) => [l, admin ? await channelClients(admin, me, l) : []] as const)),
  ]);
  if (!slack.connected) return <ConnectSlack />;
  const chanBy = new Map<ChannelLine, ChannelClient[]>(chanLists);
  const chanIds = [...new Set(chanLists.flatMap(([, c]) => c.map((x) => x.id)))];
  // Email and social reports live in the same table (no ad account behind them): read by the server, kept to the person's clients
  const { data: chanData } =
    admin && chanIds.length
      ? await admin.from("reports").select(SELECT).in("kind", ["weekly", "monthly", "custom"]).in("platform", lines.map(platformOfLine)).in("client_id", chanIds).is("hidden_at", null).gte("created_at", daysAgo(120)).order("created_at")
      : { data: [] };
  const adsRows = (adsRes.data ?? []) as unknown as Row[];
  const chanRows = ((chanData ?? []) as unknown as Row[]).filter((r) => chanBy.get(lineOfPlatform(r.platform as "klaviyo" | "social"))?.some((c) => c.id === r.client_id));
  const rows = [...adsRows, ...chanRows];
  // Drafted Monday (and on the 1st), they stay up until they're sent: last week's unsent draft doesn't drop off
  const waiting = (r: Row) => !DONE.includes(r.status);
  // Each Monday's drafts replace the last ones: only the latest week (and the latest month's recap) shows
  const latest = (kind: string) => adsRows.filter((r) => r.kind === kind).map((r) => r.period_start).sort().at(-1) ?? null;
  const [lastWeek, lastMonth] = [latest("weekly"), latest("monthly")];
  const allWeekly = adsRows.filter((r) => r.kind === "weekly" && r.period_start === lastWeek && waiting(r));
  const allMonthly = adsRows.filter((r) => r.kind === "monthly" && r.period_start === lastMonth && waiting(r));
  // Built by hand: the ads ones on a single account, and email and social reports built for dates picked in the builder
  const onDemand = rows.filter((r) => r.kind === "custom" && waiting(r));
  // Email and social go out on their own (no recap bundle): each platform's latest month and week, shown like single weeklies
  const latestChan = (r: Row) => chanRows.filter((x) => x.platform === r.platform && x.kind === r.kind).map((x) => x.period_start).sort().at(-1) ?? null;
  const chanMonthly = chanRows.filter((r) => r.kind === "monthly" && r.period_start === latestChan(r) && waiting(r));
  const chanWeekly = chanRows.filter((r) => r.kind === "weekly" && r.period_start === latestChan(r) && waiting(r));
  const sentReports = rows.filter((r) => r.status === "posted" && r.posted_at && r.posted_at >= daysAgo(30));

  // The builder: the clients this person reports on, each with every service that has an ad account (and its buyer)
  const clientIds = [...new Set(accounts.map((a) => a.client_id))];
  // Each team searches and builds for its own line only: execs see both
  const line = me.isExec ? null : teamPlatform(me.role);
  // Only your own ads lines are offered to build (the server checks it again)
  const adsLines = adsLinesFor(me);
  // Seats: the buyer seats of the ad clients, and the email and social seats of those clients (the person filter reads them)
  const seatClientIds = [...new Set([...clientIds, ...chanIds])];
  const { data: slots } = admin && seatClientIds.length ? await admin.from("client_assignments").select("client_id, role, profile_id, is_primary, created_at, profiles(full_name)").in("client_id", seatClientIds).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer", ...REPORT_SEATS.email, ...REPORT_SEATS.social]) : { data: [] };
  const [{ data: allTargets }, { data: built }] = admin && clientIds.length
    ? await Promise.all([
        admin.from("kpi_targets").select("client_id, platform, owner_id, clients!inner(name, slug, archived_at, slack_channel_id, services, services_extra, services_removed, strategy_only), profiles!kpi_targets_owner_id_fkey(full_name)").in("client_id", clientIds).in("platform", adsLines).eq("active", true).not("ad_account_id", "is", null).is("clients.archived_at", null),
        admin.from("report_bundles").select("id, client_id, status, ranges, created_by, created_at, sent_at, clients(name), reports(id, platform, status, owner_id, viewed_at, profiles!reports_owner_id_fkey(full_name))").eq("kind", "built").is("hidden_at", null).gte("created_at", daysAgo(60)).order("created_at", { ascending: false }).limit(150),
      ])
    : [{ data: [] }, { data: [] }];
  // The buyer seats, primary first. A secondary buyer's accounts are theirs to report on like the owner's: their
  // reports count as theirs, and a buyer's chip holds the accounts they're a secondary on too
  type Slot = SeatRow & { client_id: string; profiles: { full_name: string } | null };
  const seatRows = orderSeats((slots ?? []) as unknown as Slot[]);
  // Ads: the secondary buyers. Email and social: everyone seated on that line's client (any of its seats)
  const coSeats = (clientId: string, platform: string) =>
    isChan(platform) ? seatRows.filter((s) => s.client_id === clientId && REPORT_SEATS[lineOfPlatform(platform as "klaviyo" | "social")].includes(s.role)) : seatRows.filter((s) => s.client_id === clientId && s.role === buyerRole(platform) && s.is_primary === false);
  const isMine = (clientId: string, p: { owner_id: string | null; platform: string }) => p.owner_id === me.id || coSeats(clientId, p.platform).some((s) => s.profile_id === me.id);
  const byClient = new Map<string, BuilderClient>();
  // Only the lines the client buys (src/lib/service-gate.ts): the builder never suggests a removed service
  for (const t of ((allTargets ?? []) as unknown as { client_id: string; platform: "meta" | "google" | "tiktok"; owner_id: string | null; clients: { name: string; slug: string; slack_channel_id: string | null }; profiles: { full_name: string } | null }[]).filter(onService)) {
    const c = byClient.get(t.client_id) ?? { id: t.client_id, name: t.clients.name, slug: t.clients.slug, hasChannel: Boolean(t.clients.slack_channel_id), services: [] };
    if (c.services.some((x) => x.platform === t.platform)) continue;
    const slot = primaryOf(seatRows, buyerRole(t.platform), t.client_id);
    const ownerId = t.owner_id ?? slot?.profile_id ?? null;
    const owner = t.profiles?.full_name ?? slot?.profiles?.full_name ?? null;
    c.services.push({ platform: t.platform, owner, mine: isMine(t.client_id, { owner_id: ownerId, platform: t.platform }) });
    byClient.set(t.client_id, c);
  }
  // A service the client buys whose ad account isn't connected yet still shows, and says to connect it (adding TikTok on
  // the client page shows here at once; removing it hides it, by the services gate above)
  const ADS_SERVICE = { meta: "facebook-ads", google: "google-ads", tiktok: "tiktok-ads" } as const;
  const ADS_NAME = { meta: "Meta", google: "Google Ads", tiktok: "TikTok" } as const;
  for (const t of (allTargets ?? []) as unknown as { client_id: string; clients: { services: string[] | null; services_extra: string[] | null; services_removed: string[] | null } }[]) {
    const c = byClient.get(t.client_id);
    if (!c) continue;
    const buys = new Set([...(t.clients.services ?? []), ...(t.clients.services_extra ?? [])].filter((x) => !(t.clients.services_removed ?? []).includes(x)));
    for (const p of (adsLines) as ("meta" | "google" | "tiktok")[]) {
      if (!buys.has(ADS_SERVICE[p]) || c.services.some((x) => x.platform === p)) continue;
      const slot = primaryOf(seatRows, buyerRole(p), t.client_id);
      c.services.push({ platform: p, owner: slot?.profiles?.full_name ?? null, mine: slot?.profile_id === me.id, setup: { state: "missing", what: `${ADS_NAME[p]} is on their services, but no ${ADS_NAME[p]} ad account is connected yet. Add it on the client page.` } });
    }
  }
  const builderClients = [...byClient.values()].map((c) => ({ ...c, services: c.services.sort((a, b) => (a.platform === "meta" ? 0 : 1) - (b.platform === "meta" ? 0 : 1)) })).sort((a, b) => a.name.localeCompare(b.name));
  type BuiltRow = { id: string; client_id: string; status: string; ranges: { label: string }[] | null; created_by: string | null; created_at: string; sent_at: string | null; clients: { name: string }; reports: { id: string; platform: string; status: string; owner_id: string | null; viewed_at: string | null; profiles: { full_name: string } | null }[] };
  // Reports built by hand: an exec sees all of them, the Head of Meta or Google every one with a part on their line,
  // a buyer the ones they built or have a part in
  const headLine = me.isExec ? null : me.role === "head_of_meta" ? "meta" : me.role === "head_of_google" ? "google" : null;
  const reach = ((built ?? []) as unknown as BuiltRow[]).filter(
    (b) => me.isExec || b.created_by === me.id || b.reports.some((p) => isMine(b.client_id, p)) || (headLine != null && b.reports.some((p) => p.platform === headLine)),
  );
  // Who built each one, by name
  const builderIds = [...new Set(reach.map((b) => b.created_by).filter((x): x is string => Boolean(x)))];
  const { data: builders } = builderIds.length && admin ? await admin.from("profiles").select("id, full_name").in("id", builderIds) : { data: [] as { id: string; full_name: string | null }[] };
  const builderName = new Map((builders ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? null]));
  // A built report with every part skipped has left the queue (it shows under Skipped)
  const builtRows = reach.filter((b) => b.status !== "sent" && b.reports.some((p) => p.status !== "skipped"));
  // The send history: every report that went to the clients this person reports on (everything for an exec), never
  // trimmed by age; a client at a time on the page
  const history = (admin ? await readHistory(admin, { clientIds: me.isExec ? null : seatClientIds, limit: 400 }, today) : [])
    // Email and social only for the lines this person is on; joint (built) ones only for the ads side
    .filter((s) => (s.platform == null ? !channelOnly : isChan(s.platform) ? lines.includes(lineOfPlatform(s.platform as "klaviyo" | "social")) : !channelOnly))
    .filter((s) => !line || !s.platform || isChan(s.platform) || s.platform === line);
  const sentBuilt = reach.filter((b) => b.status === "sent" && (b.sent_at ?? b.created_at) >= daysAgo(30));
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  // Quick create: the reports this person builds again and again, and their own clients with no report this week
  const [{ data: myBuilds }, { data: recentSent }] = admin
    ? await Promise.all([
        admin.from("report_bundles").select("client_id, ranges, services, created_at").eq("kind", "built").eq("created_by", me.id).gte("created_at", new Date(Date.parse(`${today}T12:00:00Z`) - 90 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(80),
        clientIds.length ? admin.from("reports").select("client_id").in("client_id", clientIds).in("status", ["posted", "submitted", "draft", "drafting"]).gte("created_at", new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86_400_000).toISOString()) : Promise.resolve({ data: [] }),
      ])
    : [{ data: [] }, { data: [] }];
  const quick: QuickPick[] = [];
  const habits = new Map<string, { clientId: string; ranges: string[]; services: string[]; n: number; last: string }>();
  for (const b of myBuilds ?? []) {
    const ranges = ((b.ranges ?? []) as { key: string }[]).map((x) => x.key).filter((k) => k !== "custom");
    const services = ((b.services ?? []) as string[]).sort();
    if (!ranges.length || !byClient.has(b.client_id as string)) continue;
    const k = `${b.client_id}|${ranges.join(",")}|${services.join(",")}`;
    const h = habits.get(k) ?? { clientId: b.client_id as string, ranges, services, n: 0, last: b.created_at as string };
    h.n++;
    habits.set(k, h);
  }
  for (const h of [...habits.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last)).slice(0, 2))
    quick.push({ clientId: h.clientId, ranges: h.ranges, services: h.services, reason: h.n > 1 ? `You've built this ${h.n} times` : `Like the one you built ${new Date(h.last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` });
  const reported = new Set((recentSent ?? []).map((x) => x.client_id as string));
  for (const c of builderClients.filter((c) => c.services.some((s) => s.mine) && !reported.has(c.id))) {
    if (quick.length >= 4) break;
    if (quick.some((q) => q.clientId === c.id)) continue;
    quick.push({ clientId: c.id, ranges: ["last7"], services: c.services.filter((s) => s.mine).map((s) => s.platform), reason: "Your client · no report in the last 7 days" });
  }

  const monthName = lastMonth ? new Date(`${lastMonth}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : month.label;
  // What each line item is: the Monday weekly, the monthly recap, or one built by hand, with its dates
  const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const tagOf = (r: Row): Tag =>
    isChan(r.platform)
      ? r.kind === "monthly"
        ? { kind: "monthly", label: "Monthly report", dates: new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) }
        : r.kind === "custom"
          ? { kind: "built", label: "Built by hand", dates: `${short(r.period_start)} – ${short(r.period_end)}` }
          : { kind: "weekly", label: "Weekly report", dates: `${short(r.period_start)} – ${short(r.period_end)}` }
      : r.kind === "weekly"
      ? { kind: "weekly", label: "Monday weekly", dates: `${short(r.period_start)} – ${short(r.period_end)}` }
      : r.kind === "monthly"
        ? { kind: "monthly", label: "Monthly recap", dates: new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) }
        : { kind: "built", label: "Built by hand", dates: `${short(r.period_start)} – ${short(r.period_end)}` };
  const card = (r: Row): CardReport => ({ id: r.id, client: r.clients.name, platform: r.platform, status: r.status, qa: r.qa, tag: tagOf(r), owner: r.profiles?.full_name ?? null, mine: isMine(r.client_id, r), viewedAt: r.viewed_at, postedAt: r.posted_at });
  const bundleCard = (b: (typeof reach)[number]): CardBundle => {
    const parts = b.reports.filter((p) => p.status !== "skipped");
    const mine = parts.find((p) => p.owner_id === me.id) ?? parts.find((p) => isMine(b.client_id, p)) ?? parts[0];
    return {
      id: b.id,
      client: b.clients.name,
      tag: { kind: "built", label: "Built by hand", dates: (b.ranges ?? []).map((x) => x.label).join(" + ") },
      status: b.status,
      sentAt: b.sent_at,
      createdAt: b.created_at,
      createdBy: b.created_by === me.id ? "you" : b.created_by ? (builderName.get(b.created_by) ?? null) : null,
      parts: parts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, owner: p.profiles?.full_name ?? null, mine: isMine(b.client_id, p), viewedAt: p.viewed_at })),
      href: mine ? `/reports/${mine.id}` : "/reports",
      skipId: mine && !["queued", "drafting"].includes(mine.status) ? mine.id : null,
      yourTurn: parts.some((p) => isMine(b.client_id, p) && ["draft", "drafting", "queued"].includes(p.status)),
      removable: b.created_by === me.id || me.isExec,
      // Their own parts (approved ones too: it goes back to review); an exec or lead also the ones still in review
      regenIds: b.status === "sent" ? [] : parts.filter((p) => (isMine(b.client_id, p) && ["draft", "failed", "submitted"].includes(p.status)) || (lead && ["draft", "failed"].includes(p.status))).map((p) => p.id),
    };
  };

  // Ready and Sent: one platform at a time for execs (everyone else is on their own line), then one buyer at a time
  const plat = (x: { platform: string }): Plat => (x.platform === "google" ? "google" : x.platform === "tiktok" ? "tiktok" : x.platform === "klaviyo" ? "klaviyo" : x.platform === "social" ? "social" : "meta");
  const readyReports = [...allMonthly, ...allWeekly, ...onDemand, ...chanMonthly, ...chanWeekly];
  const pool = [...readyReports, ...sentReports];
  const bundlePlats = (b: (typeof reach)[number]) => b.reports.map(plat);
  // Ads platforms with something on the page, then the lines this person is on (always, so a client can be built for)
  const platforms = (["meta", "google", "tiktok", "klaviyo", "social"] as const).filter((x) => (x === "klaviyo" ? lines.includes("email") : x === "social" ? lines.includes("social") : pool.some((r) => plat(r) === x) || reach.some((b) => bundlePlats(b).includes(x))));
  const wp: Plat = platforms.length > 1 ? (platforms.find((x) => x === pick("wp")) ?? platforms[0]) : (platforms[0] ?? "meta");
  // Email and social: only the seats that report (an email strategist, the social seats), never a designer or a builder, even
  // when an older report was drafted for one (the head of email's view too)
  const reporters = new Set(seatRows.filter((s) => isChan(wp) && REPORT_SEATS[lineOfPlatform(wp as "klaviyo" | "social")].includes(s.role)).map((s) => s.profile_id));
  const eligible = (id: string) => !isChan(wp) || id === me.id || reporters.has(id);
  const people = (list: Row[], bundles: typeof reach) =>
    [
      ...new Map([
        ...list.filter((r) => plat(r) === wp && r.owner_id && eligible(r.owner_id)).map((r) => [r.owner_id!, r.owner_id === me.id ? "You" : (r.profiles?.full_name ?? "Buyer")] as const),
        ...bundles.flatMap((b) => b.reports.filter((p) => plat(p) === wp && p.owner_id && eligible(p.owner_id)).map((p) => [p.owner_id!, p.owner_id === me.id ? "You" : (p.profiles?.full_name ?? "Buyer")] as const)),
        // The secondary buyers on those accounts
        ...[...list.map((r) => r.client_id), ...bundles.map((b) => b.client_id)].flatMap((c) => coSeats(c, wp).map((s) => [s.profile_id, s.profile_id === me.id ? "You" : (s.profiles?.full_name ?? "Buyer")] as const)),
      ]).entries(),
    ].sort((a, b) => (a[1] === "You" ? -1 : b[1] === "You" ? 1 : a[1].localeCompare(b[1])));
  const wb = pick("wb");
  // One buyer's: the reports they own, and the ones on accounts they're a secondary buyer on
  const forBuyer = (clientId: string, p: { owner_id: string | null; platform: string }) => !wb || p.owner_id === wb || coSeats(clientId, p.platform).some((s) => s.profile_id === wb);
  const fits = (r: Row) => plat(r) === wp && forBuyer(r.client_id, r);
  const fitsBundle = (b: (typeof reach)[number]) => b.reports.some((p) => plat(p) === wp && forBuyer(b.client_id, p));
  const byName = (a: { clients: { name: string } }, b: { clients: { name: string } }) => a.clients.name.localeCompare(b.clients.name, "en", { sensitivity: "base", numeric: true });
  const monthlyShown = allMonthly.filter(fits).sort(byName);
  const weeklyShown = allWeekly.filter(fits).sort(byName);
  const builtShown = builtRows.filter(fitsBundle).sort(byName);
  const customShown = onDemand.filter(fits).sort(byName);
  const sentShown = sentReports.filter(fits).sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));
  const chanMonthlyShown = chanMonthly.filter(fits).sort(byName);
  const chanWeeklyShown = chanWeekly.filter(fits).sort(byName);
  const sentBuiltShown = sentBuilt.filter(fitsBundle).sort((a, b) => (b.sent_at ?? b.created_at).localeCompare(a.sent_at ?? a.created_at));
  const readyCount = readyReports.length + builtRows.length;
  // Sent history by platform pill: joint (built) ones sit with the ads platforms
  const inLine = (s: { platform: string | null }, x: Plat) => (s.platform ? s.platform === x : !isChan(x));
  const historyShown = history.filter((s) => inLine(s, wp));
  // Regenerate all shown: every draft in a section, with the platform and person picked (an exec or lead: anyone's
  // they report on; a buyer: their own). Approved, sent and still-writing ones are left as they are
  const regenable = (x: { status: string; owner_id: string | null; platform: string }, clientId: string) => ["draft", "failed"].includes(x.status) && (lead || isMine(clientId, x));
  const regenAll = (ids: string[], label: string) => (ids.length > 1 ? <RegenerateButton kind="many" variant="bulk" ids={ids} label={label} /> : undefined);
  const sentCount = history.length || sentReports.length + sentBuilt.length;
  // Land on what needs doing; with nothing waiting, on building one
  const view = asked ?? (readyCount ? "ready" : "build");
  const href = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, wp: platforms.length > 1 ? wp : null, wb, ...patch })) if (v) q.set(k, v);
    return `/reports?${q}`;
  };
  // The Monday drafts already waiting for this person, by client: the builder offers them before building another
  const waitingFor: Record<string, { id: string; tag: Tag; platform: string }[]> = {};
  for (const r of [...allMonthly, ...allWeekly].filter((r) => isMine(r.client_id, r) && ["draft", "queued", "drafting"].includes(r.status))) (waitingFor[r.client_id] ??= []).push({ id: r.id, tag: tagOf(r), platform: plat(r) });
  // Email and social build in the same builder as ads, one line at a time: the clients that buy the line (with this
  // person's seats; all of the line's for its head, every client on it for an exec), each with its one service and who
  // it's drafted for. A client not connected yet is listed too, and says what to connect when picked
  // One builder for every line (owner, Nov 20 2026): search the client, then pick the dates and the services. The
  // clients are this person's own (their line's for a lead, everyone's for an exec): the ads accounts they report on,
  // plus the clients whose email or social they're seated on (a head: every client on their line). Each service says
  // who it's drafted for, and one that isn't connected yet says what to connect when it's picked.
  const merged = new Map<string, BuilderClient>(builderClients.map((c) => [c.id, { ...c, services: [...c.services] }]));
  const quickAll: QuickPick[] = [...quick];
  const waitingAll: typeof waitingFor = Object.fromEntries(Object.entries(waitingFor).map(([k, v]) => [k, [...v]]));
  if (view === "build") {
    const monthRange = lastMonthOf(today);
    const monthWord = new Date(`${monthRange.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    for (const l of lines) {
      const plat = platformOfLine(l) as "klaviyo" | "social";
      const list = chanBy.get(l) ?? [];
      const ids = list.map((c) => c.id);
      if (!ids.length) continue;
      const [cover, owners] = admin ? await Promise.all([coverageFor(admin, l, ids), ownersFor(admin, l, ids)]) : [new Map<string, never>(), new Map<string, string | null>()];
      const nameOf = (id: string) => seatRows.find((x) => x.profile_id === id)?.profiles?.full_name ?? null;
      const hasMonth = new Set(chanRows.filter((r) => r.platform === plat && r.kind === "monthly" && r.period_start === monthRange.start && r.status !== "skipped").map((r) => r.client_id));
      for (const c of list) {
        const cv = cover.get(c.id);
        const ownerId = owners.get(c.id) ?? null;
        const mine = !ownerId || ownerId === me.id;
        const setup = !cv || cv.state === "connected" ? null : { state: cv.state, what: cv.what ?? "It isn't connected yet." };
        const entry = merged.get(c.id) ?? { id: c.id, name: c.name, slug: c.slug, hasChannel: c.hasChannel, services: [] };
        if (!entry.services.some((x) => x.platform === plat)) entry.services.push({ platform: plat, owner: mine ? null : nameOf(ownerId!), mine, setup });
        merged.set(c.id, entry);
        if (!setup && !hasMonth.has(c.id) && quickAll.length < 4 && !quickAll.some((q) => q.clientId === c.id) && (ownerId === me.id || coSeats(c.id, plat).some((x) => x.profile_id === me.id)))
          quickAll.push({ clientId: c.id, ranges: ["lastMonth"], services: [plat], reason: `Your client · no ${monthWord} report yet` });
      }
      for (const r of [...chanMonthly, ...chanWeekly, ...onDemand].filter((r) => r.platform === plat && isMine(r.client_id, r) && ["draft", "queued", "drafting"].includes(r.status))) (waitingAll[r.client_id] ??= []).push({ id: r.id, tag: tagOf(r), platform: plat });
    }
  }
  const ORDER = ["meta", "google", "tiktok", "klaviyo", "social"];
  const allClients = [...merged.values()].map((c) => ({ ...c, services: c.services.sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform)) })).sort((a, b) => a.name.localeCompare(b.name));
  const drafts = readyReports.filter((r) => r.status === "draft");
  const stats = [
    { n: drafts.length, label: "ready to review", tone: "text-fg" },
    { n: drafts.filter((r) => (r.qa?.flags ?? []).some((f) => f.severity === "fix")).length, label: "with something to fix", tone: "text-bad" },
    ...(lead ? [{ n: readyReports.filter((r) => r.owner_id !== me.id && !r.viewed_at && r.status === "draft").length, label: "not opened by their buyer", tone: "text-warn" }] : []),
    { n: sentReports.filter((r) => r.posted_at && r.posted_at >= daysAgo(7)).length + sentBuilt.filter((b) => (b.sent_at ?? b.created_at) >= daysAgo(7)).length, label: "sent this week", tone: "text-ok" },
  ];

  // Skipped for the current period (the latest week and month, and anything built): who skipped them, when and why. The
  // log is read apart: the column may not exist yet, and then they show without the detail
  const skippedRows = rows.filter((r) => r.status === "skipped" && (r.kind === "custom" || r.period_start === (isChan(r.platform) ? latestChan(r) : r.kind === "weekly" ? lastWeek : lastMonth))).filter(fits);
  const skippedBuilt = reach.filter((b) => b.status !== "sent" && b.reports.length > 0 && b.reports.every((p) => p.status === "skipped")).filter(fitsBundle);
  const logIds = [...skippedRows.map((r) => r.id), ...skippedBuilt.flatMap((b) => b.reports.map((p) => p.id))];
  const logOf = new Map<string, unknown>();
  if (logIds.length) {
    const { data: logged, error: logError } = await (admin ?? db).from("reports").select("id, log").in("id", logIds);
    if (!logError) for (const l of (logged ?? []) as { id: string; log: unknown }[]) logOf.set(l.id, l.log);
  }
  const skipped: SkippedItem[] = [
    ...skippedRows.map((r) => {
      const e = latestSkip(logOf.get(r.id));
      return { id: r.id, client: r.clients.name, platform: r.platform, tag: tagOf(r), line: e ? skipLine(e) : "Skipped", note: e?.note ?? null, canBringBack: canBringBack(r.kind, r.period_end, today), href: `/reports/${r.id}` };
    }),
    ...skippedBuilt.map((b) => {
      const e = b.reports.map((p) => latestSkip(logOf.get(p.id))).find(Boolean) ?? null;
      const first = b.reports.find((p) => isMine(b.client_id, p)) ?? b.reports[0];
      return { id: first.id, client: b.clients.name, platform: null, tag: { kind: "built" as const, label: "Built by hand", dates: (b.ranges ?? []).map((x) => x.label).join(" + ") }, line: e ? skipLine(e) : "Skipped", note: e?.note ?? null, canBringBack: canBringBack("built", b.created_at.slice(0, 10), today), href: `/reports/${first.id}` };
    }),
  ];

  // The platform pills: names, and what each counts (what's waiting; in Sent, what went out)
  const PILL: Record<Plat, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok", klaviyo: "Email", social: "Social" };
  const countOf = (x: Plat) =>
    view === "sent" && history.length
      ? history.filter((s) => inLine(s, x)).length
      : (view === "sent" ? sentReports : readyReports).filter((r) => plat(r) === x).length + (view === "sent" ? sentBuilt : builtRows).filter((b) => bundlePlats(b).includes(x)).length;
  // One person at a time (never over the send history, which has its own client filter, nor in Build)
  const peopleList = view === "build" ? [] : people(view === "ready" ? readyReports : sentReports, view === "ready" ? builtRows : sentBuilt);
  const showPeople = view !== "build" && !(view === "sent" && history.length) && peopleList.length > 1;

  const TABS = [
    { key: "build", title: "Build a report", sub: "Any client, any dates", n: null },
    { key: "ready", title: "Ready to send", sub: "Drafted and waiting on review", n: readyCount },
    { key: "sent", title: "Sent", sub: "Every report, to review and resend", n: sentCount },
  ] as const;

  return (
    <div className="mx-auto grid max-w-5xl gap-7">
      <RegenWatcher />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Reports</h1>
          <p className="max-w-2xl text-sm text-muted">Drafted in your voice and checked by the QA: ads every Monday (on the month&apos;s first Monday, the full monthly recap instead), email and social once a month. Read it, tweak it or ask the AI to, then send it as you.</p>
        </div>
        <SlackConnect connected={slack.connected} next="/reports" />
      </header>

      {/* The three parts of reporting */}
      <nav className="grid grid-cols-3 gap-1.5 rounded-[22px] border border-line bg-surface p-1.5" aria-label="Reports">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href({ view: t.key })}
            scroll={false}
            aria-current={view === t.key ? "page" : undefined}
            className={`relative grid gap-0.5 overflow-hidden rounded-[17px] px-3 py-3 text-left transition-all md:px-5 md:py-4 ${view === t.key ? "bg-deep text-fg shadow-[0_14px_40px_-22px_rgba(200,16,46,0.9)] ring-1 ring-ink/10" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
          >
            {view === t.key && <span aria-hidden className="pointer-events-none absolute -left-10 -top-16 h-32 w-32 rounded-full bg-[rgba(200,16,46,0.35)] blur-[50px]" />}
            <span className="relative flex items-baseline gap-2 font-heading text-[15px] md:text-[18px]">
              {t.title}
              {t.n != null && <span className={`tabular text-xs md:text-sm ${view === t.key ? "text-brand-text" : "text-faint"}`}>{t.n}</span>}
            </span>
            <span className="relative truncate text-[11px] text-faint max-md:hidden">{t.sub}</span>
          </Link>
        ))}
      </nav>

      {/* One row for every platform this person reports on: the ads ones, then Email and Social (they scroll sideways on a phone) */}
      {view !== "build" && (platforms.length > 1 || showPeople) && (
        <div className="flex flex-wrap items-center gap-2">
          {platforms.length > 1 && (
            <span className="no-scrollbar max-w-full overflow-x-auto rounded-full">
              <span className="inline-flex whitespace-nowrap rounded-full border border-line bg-surface p-1">
                {platforms.map((x) => (
                  <Link key={x} href={href({ wp: x, wb: null })} scroll={false} className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${wp === x ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                    {x === "meta" ? <MetaMark size={15} /> : x === "google" ? <GoogleAdsMark size={12} /> : x === "tiktok" ? <TikTokMark size={13} /> : x === "klaviyo" ? <EmailMark size={14} /> : <SocialMark size={14} />}
                    {PILL[x]}
                    <span className="tabular opacity-60">{countOf(x)}</span>
                  </Link>
                ))}
              </span>
            </span>
          )}
          {showPeople && (
            <span className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto">
              <Link href={href({ wb: null })} scroll={false} className={`inline-flex h-11 shrink-0 items-center rounded-full px-3.5 text-sm transition-colors md:h-9 ${!wb ? "bg-surface-2 text-fg ring-1 ring-line" : "text-muted hover:text-fg"}`}>
                Everyone
              </Link>
              {peopleList.map(([id, name]) => (
                <Link key={id} href={href({ wb: id })} scroll={false} className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm transition-colors md:h-9 ${wb === id ? "bg-surface-2 text-fg ring-1 ring-line" : "text-muted hover:text-fg"}`}>
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-ink/10 text-[9px] font-semibold">{name.slice(0, 1)}</span>
                  {name}
                </Link>
              ))}
            </span>
          )}
        </div>
      )}

      {view === "build" &&
        (allClients.length ? (
          <ReportBuilder clients={allClients} quick={quickAll} yesterday={yesterday} waiting={waitingAll} />
        ) : (
          <Empty title="No clients yet" body="The clients you're seated on (or your team's, for a lead) show here, ready to build a report for." />
        ))}

      {view !== "build" && (
        <div className="grid gap-6">
          {view === "ready" && (
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              {stats.map((x) => (
                <div key={x.label} className="grid gap-0.5 rounded-[18px] border border-line bg-surface px-4 py-3.5">
                  <span className={`tabular font-display text-[30px] leading-none ${x.n ? x.tone : "text-faint"}`}>{x.n}</span>
                  <span className="text-xs text-muted">{x.label}</span>
                </div>
              ))}
            </div>
          )}

          {view === "ready" &&
            (monthlyShown.length + weeklyShown.length + builtShown.length + customShown.length + chanMonthlyShown.length + chanWeeklyShown.length === 0 ? (
              <Empty
                title="All caught up"
                body={isChan(wp) ? `Nothing waiting to send here. ${PILL[wp]} reports are drafted on the first business days of the month; to draft one now, build it.` : "Nothing waiting to send here. The Monday drafts land each Monday morning and replace last week's; to send one now, build it."}
              />
            ) : (
              <>
                {monthlyShown.length > 0 && (
                  <Group title={`${monthName} recap`} count={monthlyShown.length} note="The full month · goes out once every buyer on the account approves" action={regenAll(monthlyShown.filter((r) => regenable(r, r.client_id)).map((r) => r.id), `${monthName} recaps`)}>
                    {monthlyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {weeklyShown.length > 0 && (
                  <Group title="Monday weekly" count={weeklyShown.length} note={`${weeklyShown.filter((r) => r.status === "draft").length} ready to review · next Monday's replace them`} action={regenAll(weeklyShown.filter((r) => regenable(r, r.client_id)).map((r) => r.id), "Monday weeklies")}>
                    {weeklyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {chanMonthlyShown.length > 0 && (
                  <Group title="Monthly report" count={chanMonthlyShown.length} note="The month just over · goes out on its own" action={regenAll(chanMonthlyShown.filter((r) => regenable(r, r.client_id)).map((r) => r.id), `${PILL[wp]} monthly reports`)}>
                    {chanMonthlyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {chanWeeklyShown.length > 0 && (
                  <Group title="Weekly report" count={chanWeeklyShown.length} note="For clients that ask for a weekly" action={regenAll(chanWeeklyShown.filter((r) => regenable(r, r.client_id)).map((r) => r.id), `${PILL[wp]} weekly reports`)}>
                    {chanWeeklyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {builtShown.length + customShown.length > 0 && (
                  <Group
                    title="Built by hand"
                    count={builtShown.length + customShown.length}
                    note="Here until they're sent"
                    action={regenAll([...builtShown.flatMap((b) => b.reports.filter((p) => plat(p) === wp && forBuyer(b.client_id, p) && regenable(p, b.client_id)).map((p) => p.id)), ...customShown.filter((r) => regenable(r, r.client_id)).map((r) => r.id)], "Reports built by hand")}
                  >
                    {builtShown.map((b) => (
                      <BundleCard key={b.id} b={bundleCard(b)} showOwner={lead} />
                    ))}
                    {customShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} removable />
                    ))}
                  </Group>
                )}
              </>
            ))}

          {view === "ready" && <SkippedGroup items={skipped} />}

          {view === "sent" && historyShown.length > 0 && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="flex items-baseline gap-2 font-heading text-[19px]">
                  Sent <span className="tabular text-sm text-faint">{historyShown.length}</span>
                </h3>
                <span className="text-xs text-faint">Who sent it, when, where and to whom · the PDF as it went</span>
              </div>
              <SendHistory items={historyShown} filterable />
            </section>
          )}
          {view === "sent" &&
            !historyShown.length &&
            (sentShown.length + sentBuiltShown.length === 0 ? (
              <Empty title="Nothing sent yet" body="Reports that go out land here for 30 days. Every one stays in the client's history." />
            ) : (
              <Group title="Sent" count={sentShown.length + sentBuiltShown.length} note="The last 30 days · every report stays in the client's history">
                {sentBuiltShown.map((b) => (
                  <BundleCard key={b.id} b={bundleCard(b)} showOwner={lead} />
                ))}
                {sentShown.map((r) => (
                  <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                ))}
              </Group>
            ))}
        </div>
      )}
    </div>
  );
}

/** Before anything else: reports go out as the person, through their own Slack, so it has to be connected first. */
function ConnectSlack() {
  return (
    <div className="mx-auto grid min-h-[70vh] max-w-3xl place-items-center">
      <section className="relative isolate grid w-full justify-items-center gap-5 overflow-hidden rounded-[28px] border border-ink/[0.08] bg-deep px-6 py-14 text-center md:px-14 md:py-20">
        <span aria-hidden className="pointer-events-none absolute -left-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full bg-[rgba(200,16,46,0.28)] blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-48 right-[-120px] -z-10 h-[380px] w-[380px] rounded-full bg-[rgba(79,124,255,0.16)] blur-[120px]" />
        <span className="grid h-16 w-16 place-items-center rounded-[20px] border border-ink/10 bg-ink/[0.05]">
          <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden>
            <path fill="#e01e5a" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.52h2.52zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0z" />
            <path fill="#36c5f0" d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05z" />
            <path fill="#2eb67d" d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 0 1 5.05 0z" />
            <path fill="#ecb22e" d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 0 1 0 5.05z" />
          </svg>
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-text">One step to unlock reporting</span>
        <h1 className="max-w-xl font-heading text-[32px] leading-[1.1] tracking-tight md:text-[40px]">Connect your Slack</h1>
        <p className="max-w-md text-[15px] text-ink/60">Every report goes to the client&apos;s channel as you, in your voice, with the PDF attached. That needs your own Slack connected first; it takes about ten seconds.</p>
        <a href="/api/slack/connect?next=%2Freports" className="mt-2 inline-flex h-12 items-center gap-2.5 rounded-full bg-brand px-7 text-[15px] font-medium text-white shadow-[0_18px_40px_-16px_rgba(200,16,46,0.9)] transition hover:bg-brand-hover">
          Connect my Slack
          <span aria-hidden>→</span>
        </a>
        <span className="text-xs text-ink/40">Nothing is posted without you approving it</span>
      </section>
    </div>
  );
}
