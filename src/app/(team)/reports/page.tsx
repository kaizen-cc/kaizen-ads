import type { Metadata } from "next";
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
import { BundleCard, Empty, Group, ReportCard, type CardBundle, type CardReport, type Tag } from "./report-cards";
import { GoogleAdsMark, MetaMark } from "@/components/source-logo";
import { teamPlatform } from "@/lib/roles";

export const metadata: Metadata = { title: "Reports" };
export const maxDuration = 300;

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
  const lead = isExecOrLead(me);
  // The accounts this person reports on (their own; their line's for a lead; all for an exec): what they see and can draft
  const accounts = await reportableTargets(db, me);
  let q = db
    .from("reports")
    .select("id, kind, platform, status, qa, posted_at, viewed_at, owner_id, client_id, period_start, period_end, bundle_id, clients(name, slug), profiles!reports_owner_id_fkey(full_name)")
    .in("kind", ["weekly", "monthly", "custom"])
    .is("hidden_at", null)
    .gte("created_at", daysAgo(60))
    .order("created_at");
  if (!me.isExec) q = q.in("target_id", accounts.length ? accounts.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"]);
  const [{ data }, slack] = await Promise.all([q, slackConnection(me.id)]);
  if (!slack.connected) return <ConnectSlack />;
  const rows = (data ?? []) as unknown as Row[];
  // Drafted Monday (and on the 1st), they stay up until they're sent: last week's unsent draft doesn't drop off
  const waiting = (r: Row) => !DONE.includes(r.status);
  // Each Monday's drafts replace the last ones: only the latest week (and the latest month's recap) shows
  const latest = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.period_start).sort().at(-1) ?? null;
  const [lastWeek, lastMonth] = [latest("weekly"), latest("monthly")];
  const allWeekly = rows.filter((r) => r.kind === "weekly" && r.period_start === lastWeek && waiting(r));
  const allMonthly = rows.filter((r) => r.kind === "monthly" && r.period_start === lastMonth && waiting(r));
  const onDemand = rows.filter((r) => r.kind === "custom" && waiting(r));
  const sentReports = rows.filter((r) => r.status === "posted" && r.posted_at && r.posted_at >= daysAgo(30));

  // The builder: the clients this person reports on, each with every service that has an ad account (and its buyer)
  const clientIds = [...new Set(accounts.map((a) => a.client_id))];
  // Each team searches and builds for its own line only: execs see both
  const line = me.isExec ? null : teamPlatform(me.role);
  const admin = adminConfigured() ? createAdminClient() : null;
  const [{ data: allTargets }, { data: slots }, { data: built }] = admin && clientIds.length
    ? await Promise.all([
        admin.from("kpi_targets").select("client_id, platform, owner_id, clients!inner(name, slug, archived_at, slack_channel_id), profiles!kpi_targets_owner_id_fkey(full_name)").in("client_id", clientIds).in("platform", line ? [line] : ["meta", "google"]).eq("active", true).not("ad_account_id", "is", null).is("clients.archived_at", null),
        admin.from("client_assignments").select("client_id, role, profile_id, profiles(full_name)").in("client_id", clientIds).in("role", ["meta_buyer", "google_buyer"]),
        admin.from("report_bundles").select("id, client_id, status, ranges, created_by, created_at, sent_at, clients(name), reports(id, platform, status, owner_id, viewed_at, profiles!reports_owner_id_fkey(full_name))").eq("kind", "built").is("hidden_at", null).gte("created_at", daysAgo(60)).order("created_at", { ascending: false }).limit(150),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const byClient = new Map<string, BuilderClient>();
  for (const t of (allTargets ?? []) as unknown as { client_id: string; platform: "meta" | "google"; owner_id: string | null; clients: { name: string; slug: string; slack_channel_id: string | null }; profiles: { full_name: string } | null }[]) {
    const c = byClient.get(t.client_id) ?? { id: t.client_id, name: t.clients.name, slug: t.clients.slug, hasChannel: Boolean(t.clients.slack_channel_id), services: [] };
    if (c.services.some((x) => x.platform === t.platform)) continue;
    const slot = (slots ?? []).find((x) => x.client_id === t.client_id && x.role === (t.platform === "google" ? "google_buyer" : "meta_buyer"));
    const ownerId = t.owner_id ?? (slot?.profile_id as string | undefined) ?? null;
    const owner = t.profiles?.full_name ?? (slot?.profiles as unknown as { full_name: string } | null)?.full_name ?? null;
    c.services.push({ platform: t.platform, owner, mine: ownerId === me.id });
    byClient.set(t.client_id, c);
  }
  const builderClients = [...byClient.values()].map((c) => ({ ...c, services: c.services.sort((a, b) => (a.platform === "meta" ? 0 : 1) - (b.platform === "meta" ? 0 : 1)) })).sort((a, b) => a.name.localeCompare(b.name));
  type BuiltRow = { id: string; client_id: string; status: string; ranges: { label: string }[] | null; created_by: string | null; created_at: string; sent_at: string | null; clients: { name: string }; reports: { id: string; platform: string; status: string; owner_id: string | null; viewed_at: string | null; profiles: { full_name: string } | null }[] };
  // Reports built by hand: an exec sees all of them, the Head of Meta or Google every one with a part on their line,
  // a buyer the ones they built or have a part in
  const headLine = me.isExec ? null : me.role === "head_of_meta" ? "meta" : me.role === "head_of_google" ? "google" : null;
  const reach = ((built ?? []) as unknown as BuiltRow[]).filter(
    (b) => me.isExec || b.created_by === me.id || b.reports.some((p) => p.owner_id === me.id) || (headLine != null && b.reports.some((p) => p.platform === headLine)),
  );
  const builtRows = reach.filter((b) => b.status !== "sent");
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
    r.kind === "weekly"
      ? { kind: "weekly", label: "Monday weekly", dates: `${short(r.period_start)} – ${short(r.period_end)}` }
      : r.kind === "monthly"
        ? { kind: "monthly", label: "Monthly recap", dates: new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) }
        : { kind: "built", label: "Built by hand", dates: `${short(r.period_start)} – ${short(r.period_end)}` };
  const card = (r: Row): CardReport => ({ id: r.id, client: r.clients.name, platform: r.platform, status: r.status, qa: r.qa, tag: tagOf(r), owner: r.profiles?.full_name ?? null, mine: r.owner_id === me.id, viewedAt: r.viewed_at, postedAt: r.posted_at });
  const bundleCard = (b: (typeof reach)[number]): CardBundle => {
    const parts = b.reports.filter((p) => p.status !== "skipped");
    const mine = parts.find((p) => p.owner_id === me.id) ?? parts[0];
    return {
      id: b.id,
      client: b.clients.name,
      tag: { kind: "built", label: "Built by hand", dates: (b.ranges ?? []).map((x) => x.label).join(" + ") },
      status: b.status,
      sentAt: b.sent_at,
      parts: parts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, owner: p.profiles?.full_name ?? null, mine: p.owner_id === me.id, viewedAt: p.viewed_at })),
      href: mine ? `/reports/${mine.id}` : "/reports",
      yourTurn: parts.some((p) => p.owner_id === me.id && ["draft", "drafting", "queued"].includes(p.status)),
      removable: b.created_by === me.id || me.isExec,
    };
  };

  // Ready and Sent: one platform at a time for execs (everyone else is on their own line), then one buyer at a time
  const plat = (x: { platform: string }) => (x.platform === "google" ? "google" : "meta");
  const readyReports = [...allMonthly, ...allWeekly, ...onDemand];
  const pool = [...readyReports, ...sentReports];
  const bundlePlats = (b: (typeof reach)[number]) => b.reports.map(plat);
  const platforms = (["meta", "google"] as const).filter((x) => pool.some((r) => plat(r) === x) || reach.some((b) => bundlePlats(b).includes(x)));
  const wp = platforms.length > 1 ? (pick("wp") === "google" ? "google" : pick("wp") === "meta" ? "meta" : platforms[0]) : (platforms[0] ?? "meta");
  const people = (list: Row[], bundles: typeof reach) =>
    [
      ...new Map([
        ...list.filter((r) => plat(r) === wp && r.owner_id).map((r) => [r.owner_id!, r.owner_id === me.id ? "You" : (r.profiles?.full_name ?? "Buyer")] as const),
        ...bundles.flatMap((b) => b.reports.filter((p) => plat(p) === wp && p.owner_id).map((p) => [p.owner_id!, p.owner_id === me.id ? "You" : (p.profiles?.full_name ?? "Buyer")] as const)),
      ]).entries(),
    ].sort((a, b) => (a[1] === "You" ? -1 : b[1] === "You" ? 1 : a[1].localeCompare(b[1])));
  const wb = pick("wb");
  const fits = (r: Row) => plat(r) === wp && (!wb || r.owner_id === wb);
  const fitsBundle = (b: (typeof reach)[number]) => b.reports.some((p) => plat(p) === wp && (!wb || p.owner_id === wb));
  const byName = (a: { clients: { name: string } }, b: { clients: { name: string } }) => a.clients.name.localeCompare(b.clients.name, "en", { sensitivity: "base", numeric: true });
  const monthlyShown = allMonthly.filter(fits).sort(byName);
  const weeklyShown = allWeekly.filter(fits).sort(byName);
  const builtShown = builtRows.filter(fitsBundle).sort(byName);
  const customShown = onDemand.filter(fits).sort(byName);
  const sentShown = sentReports.filter(fits).sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));
  const sentBuiltShown = sentBuilt.filter(fitsBundle).sort((a, b) => (b.sent_at ?? b.created_at).localeCompare(a.sent_at ?? a.created_at));
  const readyCount = readyReports.length + builtRows.length;
  const sentCount = sentReports.length + sentBuilt.length;
  // Land on what needs doing; with nothing waiting, on building one
  const view = asked ?? (readyCount ? "ready" : "build");
  const href = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, wp: platforms.length > 1 ? wp : null, wb, ...patch })) if (v) q.set(k, v);
    return `/reports?${q}`;
  };
  // The Monday drafts already waiting for this person, by client: the builder offers them before building another
  const waitingFor: Record<string, { id: string; tag: Tag; platform: string }[]> = {};
  for (const r of [...allMonthly, ...allWeekly].filter((r) => r.owner_id === me.id && ["draft", "queued", "drafting"].includes(r.status))) (waitingFor[r.client_id] ??= []).push({ id: r.id, tag: tagOf(r), platform: plat(r) });
  const drafts = readyReports.filter((r) => r.status === "draft");
  const stats = [
    { n: drafts.length, label: "ready to review", tone: "text-fg" },
    { n: drafts.filter((r) => (r.qa?.flags ?? []).some((f) => f.severity === "fix")).length, label: "with something to fix", tone: "text-bad" },
    ...(lead ? [{ n: readyReports.filter((r) => r.owner_id !== me.id && !r.viewed_at && r.status === "draft").length, label: "not opened by their buyer", tone: "text-warn" }] : []),
    { n: sentReports.filter((r) => r.posted_at && r.posted_at >= daysAgo(7)).length + sentBuilt.filter((b) => (b.sent_at ?? b.created_at) >= daysAgo(7)).length, label: "sent this week", tone: "text-ok" },
  ];

  const TABS = [
    { key: "build", title: "Build a report", sub: "Any client, any dates", n: null },
    { key: "ready", title: "Ready to send", sub: "Drafted and waiting on review", n: readyCount },
    { key: "sent", title: "Sent", sub: "The last 30 days", n: sentCount },
  ] as const;

  return (
    <div className="mx-auto grid max-w-5xl gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Reports</h1>
          <p className="max-w-2xl text-sm text-muted">Drafted every Monday in your voice and checked by the QA (on the month&apos;s first Monday, the full monthly recap instead). Read it, tweak it or ask the AI to, then send it as you.</p>
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

      {view === "build" && <ReportBuilder clients={builderClients} quick={quick} yesterday={yesterday} waiting={waitingFor} />}

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

          {/* Meta or Google (execs; everyone else is on their own line), then one buyer at a time */}
          {(platforms.length > 1 || people(view === "ready" ? readyReports : sentReports, view === "ready" ? builtRows : sentBuilt).length > 1) && (
            <div className="flex flex-wrap items-center gap-2">
              {platforms.length > 1 && (
                <span className="inline-flex rounded-full border border-line bg-surface p-1">
                  {platforms.map((x) => (
                    <Link key={x} href={href({ wp: x, wb: null })} scroll={false} className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${wp === x ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                      {x === "meta" ? <MetaMark size={15} /> : <GoogleAdsMark size={12} />}
                      {x === "meta" ? "Meta" : "Google Ads"}
                      <span className="tabular opacity-60">{(view === "ready" ? [...readyReports] : sentReports).filter((r) => plat(r) === x).length + (view === "ready" ? builtRows : sentBuilt).filter((b) => bundlePlats(b).includes(x)).length}</span>
                    </Link>
                  ))}
                </span>
              )}
              {people(view === "ready" ? readyReports : sentReports, view === "ready" ? builtRows : sentBuilt).length > 1 && (
                <span className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto">
                  <Link href={href({ wb: null })} scroll={false} className={`inline-flex h-10 shrink-0 items-center rounded-full px-3.5 text-sm transition-colors md:h-9 ${!wb ? "bg-surface-2 text-fg ring-1 ring-line" : "text-muted hover:text-fg"}`}>
                    Everyone
                  </Link>
                  {people(view === "ready" ? readyReports : sentReports, view === "ready" ? builtRows : sentBuilt).map(([id, name]) => (
                    <Link key={id} href={href({ wb: id })} scroll={false} className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm transition-colors md:h-9 ${wb === id ? "bg-surface-2 text-fg ring-1 ring-line" : "text-muted hover:text-fg"}`}>
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-ink/10 text-[9px] font-semibold">{name.slice(0, 1)}</span>
                      {name}
                    </Link>
                  ))}
                </span>
              )}
            </div>
          )}

          {view === "ready" &&
            (monthlyShown.length + weeklyShown.length + builtShown.length + customShown.length === 0 ? (
              <Empty title="All caught up" body="Nothing waiting to send here. The Monday drafts land each Monday morning and replace last week's; to send one now, build it." />
            ) : (
              <>
                {monthlyShown.length > 0 && (
                  <Group title={`${monthName} recap`} count={monthlyShown.length} note="The full month · goes out once every buyer on the account approves">
                    {monthlyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {weeklyShown.length > 0 && (
                  <Group title="Monday weekly" count={weeklyShown.length} note={`${weeklyShown.filter((r) => r.status === "draft").length} ready to review · next Monday's replace them`}>
                    {weeklyShown.map((r) => (
                      <ReportCard key={r.id} r={card(r)} showOwner={lead} />
                    ))}
                  </Group>
                )}
                {builtShown.length + customShown.length > 0 && (
                  <Group title="Built by hand" count={builtShown.length + customShown.length} note="Here until they're sent">
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

          {view === "sent" &&
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
