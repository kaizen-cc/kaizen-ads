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
import { RemoveGenerated } from "./remove-generated";
import { teamPlatform } from "@/lib/roles";

export const metadata: Metadata = { title: "Reports" };
export const maxDuration = 300;

type Row = { id: string; kind: "weekly" | "monthly" | "custom"; platform: string; status: string; qa: Qa | null; posted_at: string | null; viewed_at: string | null; owner_id: string | null; period_start: string; bundle_id: string | null; clients: { name: string; slug: string }; profiles: { full_name: string } | null };

// How far back the page looks: anything not sent yet stays on the page until it's sent (or removed); the Sent tab
// keeps the last 30 days (every report stays in the client's history)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const DONE = ["posted", "skipped"];

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-faint" },
  drafting: { label: "Writing…", tone: "text-faint" },
  draft: { label: "Ready to review", tone: "text-fg" },
  submitted: { label: "Submitted · waiting on the other buyer", tone: "text-warn" },
  posted: { label: "Sent", tone: "text-ok" },
  skipped: { label: "Skipped", tone: "text-faint" },
  failed: { label: "Couldn't write it", tone: "text-bad" },
};

/** This week's reports and this month's recap, for each buyer (theirs) and for leads and execs (their line, or all). */
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const me = await requireStaff();
  const sp = await searchParams;
  const view = sp.view === "sent" ? "sent" : "open";
  // The Monday drafts, one platform at a time (execs switch; everyone else is on their own line) and one buyer at a time
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const db = await createClient();
  const today = nyParts(new Date()).date;
  const week = periodsFor("weekly", today).main;
  const month = periodsFor("monthly", today).main;
  const lead = isExecOrLead(me);
  // The accounts this person reports on (their own; their line's for a lead; all for an exec): what they see and can draft
  const accounts = await reportableTargets(db, me);
  let q = db
    .from("reports")
    .select("id, kind, platform, status, qa, posted_at, viewed_at, owner_id, period_start, bundle_id, clients(name, slug), profiles!reports_owner_id_fkey(full_name)")
    .in("kind", ["weekly", "monthly", "custom"])
    .is("hidden_at", null)
    .gte("created_at", daysAgo(60))
    .order("created_at");
  if (!me.isExec) q = q.in("target_id", accounts.length ? accounts.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"]);
  const [{ data }, slack] = await Promise.all([q, slackConnection(me.id)]);
  const rows = (data ?? []) as unknown as Row[];
  // Drafted Monday (and on the 1st), they stay up until they're sent: last week's unsent draft doesn't drop off
  const waiting = (r: Row) => !DONE.includes(r.status);
  // Each Monday's drafts replace the last ones: only the latest week (and the latest month's recap) shows
  const latest = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.period_start).sort().at(-1) ?? null;
  const [lastWeek, lastMonth] = [latest("weekly"), latest("monthly")];
  const allWeekly = rows.filter((r) => r.kind === "weekly" && r.period_start === lastWeek && waiting(r));
  const allMonthly = rows.filter((r) => r.kind === "monthly" && r.period_start === lastMonth && waiting(r));
  const both = [...allWeekly, ...allMonthly];
  const platforms = (["meta", "google"] as const).filter((x) => both.some((r) => (r.platform === "google" ? "google" : "meta") === x));
  const wp = platforms.length > 1 ? (pick("wp") === "google" ? "google" : pick("wp") === "meta" ? "meta" : platforms[0]) : (platforms[0] ?? "meta");
  const onLine = (r: Row) => (r.platform === "google" ? "google" : "meta") === wp;
  const buyers = [...new Map(both.filter(onLine).filter((r) => r.owner_id).map((r) => [r.owner_id!, r.owner_id === me.id ? "You" : (r.profiles?.full_name ?? "Buyer")])).entries()].sort((a, b) => (a[1] === "You" ? -1 : b[1] === "You" ? 1 : a[1].localeCompare(b[1])));
  const wb = buyers.some(([id]) => id === pick("wb")) ? pick("wb") : null;
  const shown = (r: Row) => onLine(r) && (!wb || r.owner_id === wb);
  const weekly = allWeekly.filter(shown);
  const monthly = allMonthly.filter(shown);
  const periodLabel = (start: string | null, days: number) => {
    if (!start) return "";
    const a = new Date(`${start}T12:00:00Z`);
    const b = new Date(a.getTime() + (days - 1) * 86_400_000);
    const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return `${f(a)} – ${f(b)}`;
  };
  const href = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ wp: platforms.length > 1 ? wp : null, wb, ...patch })) if (v) q.set(k, v);
    return `/reports${q.size ? `?${q}` : ""}`;
  };
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
  const open = weekly.filter((r) => r.status === "draft").length;
  const monthName = lastMonth ? new Date(`${lastMonth}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : month.label;

  const list = (items: Row[], removable = false) => (
    <ul className="grid gap-2">
      {items
        .sort((a, b) => a.clients.name.localeCompare(b.clients.name))
        .map((r) => {
          const s = STATUS[r.status] ?? STATUS.draft;
          const flags = r.status === "draft" ? (r.qa?.flags ?? []) : [];
          const fix = flags.filter((f) => f.severity === "fix").length;
          const alert = flags.filter((f) => f.severity === "alert").length;
          return (
            <li key={r.id} className="flex items-center gap-2">
              <Link href={`/reports/${r.id}`} className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[14px] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-faint/70 active:bg-surface-2 max-md:gap-3">
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-heading text-[15px] max-md:whitespace-normal max-md:[overflow-wrap:anywhere]">
                    {r.clients.name} <span className="text-muted">· {r.platform === "google" ? "Google" : "Meta"}</span>
                  </span>
                  <span className={`text-xs ${s.tone}`}>
                    {s.label}
                    {lead && r.profiles?.full_name ? <span className="text-faint"> · {r.profiles.full_name}</span> : null}
                    {lead && r.owner_id !== me.id && r.status !== "posted" ? <Seen at={r.viewed_at} /> : null}
                    {r.status === "posted" && r.posted_at ? <span className="text-faint"> · {new Date(r.posted_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span> : null}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 max-md:max-w-[9.5rem] max-md:flex-wrap max-md:justify-end">
                  {fix > 0 && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{fix} to fix</span>}
                  {alert > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{alert} alert{alert === 1 ? "" : "s"}</span>}
                  {r.status === "draft" && !fix && !alert && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">QA clean</span>}
                  <span className="text-faint">→</span>
                </span>
              </Link>
              {removable && <RemoveGenerated kind="report" id={r.id} sent={r.status === "posted"} />}
            </li>
          );
        })}
    </ul>
  );

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Reports</h1>
          <p className="max-w-2xl text-sm text-muted">
            Drafted every Monday (the last 7 days and the month so far), and on the month&apos;s first Monday the full monthly recap instead, in your voice, checked by the QA. Read it, tweak it or ask the AI to, then send it as you.
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2 max-md:w-full">
          <SlackConnect connected={slack.connected} next="/reports" />
        </span>
      </header>

      <ReportBuilder clients={builderClients} quick={quick} yesterday={yesterday} />

      <nav className="-mb-3 flex items-center gap-1.5" aria-label="Reports">
        {(
          [
            ["open", "To send", allWeekly.length + allMonthly.length + onDemand.length + builtRows.length],
            ["sent", "Sent", sentReports.length + sentBuilt.length],
          ] as const
        ).map(([key, label, n]) => (
          <Link
            key={key}
            href={key === "sent" ? "/reports?view=sent" : "/reports"}
            scroll={false}
            className={`inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${view === key ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
          >
            {label} <span className="tabular opacity-60">{n}</span>
          </Link>
        ))}
      </nav>

      {view === "sent" && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">Sent</h2>
            <span className="text-xs text-faint">The last 30 days · every report stays in the client&apos;s history</span>
          </div>
          {sentBuilt.length + sentReports.length === 0 ? (
            <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-muted">Nothing sent in the last 30 days.</p>
          ) : (
            <>
              {sentBuilt.length > 0 && (
                <ul className="grid gap-2">
                  {sentBuilt.map((b) => {
                    const parts = b.reports.filter((p) => p.status !== "skipped");
                    const mine = parts.find((p) => p.owner_id === me.id) ?? parts[0];
                    return (
                      <li key={b.id}>
                        <Link href={mine ? `/reports/${mine.id}` : "/reports"} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[14px] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-faint/70">
                          <span className="grid min-w-0 gap-0.5">
                            <span className="truncate font-heading text-[15px]">
                              {b.clients.name} <span className="text-muted">· {(b.ranges ?? []).map((x) => x.label).join(" + ")}</span>
                            </span>
                            <span className="text-xs text-faint">{parts.map((p) => `${p.platform === "google" ? "Google" : "Meta"} · ${p.owner_id === me.id ? "you" : (p.profiles?.full_name ?? "buyer")}`).join("  ·  ")}</span>
                          </span>
                          <span className="text-xs text-ok">Sent {new Date(b.sent_at ?? b.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} →</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {sentReports.length > 0 && list([...sentReports])}
            </>
          )}
        </section>
      )}

      {view === "open" && (builtRows.length > 0 || onDemand.length > 0) && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">Reports generated</h2>
            <span className="text-xs text-faint">Built by hand · here until they&apos;re sent</span>
          </div>
          <ul className="grid gap-2">
            {builtRows.map((b) => {
              const parts = b.reports.filter((p) => p.status !== "skipped");
              const mine = parts.find((p) => p.owner_id === me.id) ?? parts[0];
              const waitingOnMe = parts.some((p) => p.owner_id === me.id && ["draft", "drafting", "queued"].includes(p.status));
              return (
                <li key={b.id} className="flex items-center gap-2">
                  <Link href={mine ? `/reports/${mine.id}` : "/reports"} className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[14px] border bg-surface px-4 py-3.5 transition-colors hover:border-faint/70 ${waitingOnMe ? "border-warn/50" : "border-line"}`}>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-heading text-[15px]">
                        {b.clients.name} <span className="text-muted">· {(b.ranges ?? []).map((x) => x.label).join(" + ")}</span>
                      </span>
                      <span className="flex flex-wrap gap-x-3 text-xs">
                        {parts.map((p) => (
                          <span key={p.id} className={p.status === "submitted" || p.status === "posted" ? "text-ok" : "text-muted"}>
                            {p.platform === "google" ? "Google" : "Meta"} · {p.owner_id === me.id ? "you" : (p.profiles?.full_name ?? "buyer")} · {p.status === "submitted" ? "approved" : p.status === "posted" ? "sent" : p.status === "drafting" ? "writing" : "to review"}
                            {p.owner_id !== me.id && !["submitted", "posted"].includes(p.status) && <Seen at={p.viewed_at} />}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className={`text-xs ${b.status === "sent" ? "text-ok" : b.status === "failed" ? "text-bad" : b.status === "waiting" ? "text-warn" : "text-faint"}`}>
                      {b.status === "sent" ? "Sent" : b.status === "failed" ? "Didn't send" : b.status === "waiting" ? "Waiting on a part" : waitingOnMe ? "Your turn" : "In progress"} →
                    </span>
                  </Link>
                  {(b.created_by === me.id || me.isExec) && <RemoveGenerated kind="bundle" id={b.id} sent={b.status === "sent"} />}
                </li>
              );
            })}
          </ul>
          {onDemand.length > 0 && list(onDemand, true)}
        </section>
      )}

      {view === "open" && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">{allMonthly.length && !allWeekly.length ? `${monthName} recap` : `This week · ${periodLabel(lastWeek, 7) || week.label}`}</h2>
            <span className="text-xs text-faint">{allMonthly.length && !allWeekly.length ? "The month's first Monday: the full recap instead of a weekly" : open ? `${open} ready to review` : weekly.length ? "All reviewed" : "Drafted Monday morning"}</span>
          </div>
          {/* Meta or Google (execs; everyone else sees their own line), then one buyer at a time */}
          {(platforms.length > 1 || buyers.length > 1) && (
            <div className="flex flex-wrap items-center gap-2">
              {platforms.length > 1 && (
                <span className="inline-flex rounded-full border border-line bg-surface p-1">
                  {platforms.map((x) => (
                    <Link key={x} href={href({ wp: x, wb: null })} scroll={false} className={`inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm transition-colors md:h-8 ${wp === x ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                      {x === "meta" ? "Meta" : "Google Ads"} <span className="tabular opacity-60">{both.filter((r) => (r.platform === "google" ? "google" : "meta") === x).length}</span>
                    </Link>
                  ))}
                </span>
              )}
              {buyers.length > 1 && (
                <span className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto">
                  <Link href={href({ wb: null })} scroll={false} className={`inline-flex h-10 shrink-0 items-center rounded-full px-3.5 text-sm transition-colors md:h-8 ${!wb ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
                    Everyone
                  </Link>
                  {buyers.map(([id, name]) => (
                    <Link key={id} href={href({ wb: id })} scroll={false} className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors md:h-8 ${wb === id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
                      {name} <span className="tabular opacity-60">{both.filter((r) => onLine(r) && r.owner_id === id).length}</span>
                    </Link>
                  ))}
                </span>
              )}
            </div>
          )}
          {monthly.length > 0 && list(monthly)}
          {weekly.length > 0 && list(weekly)}
          {!weekly.length && !monthly.length && (
            <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-sm text-muted">Nothing waiting to send. The drafts are written Monday morning for every account that spent, and next Monday&apos;s replace them; for one now, build it above (Last 7 days).</p>
          )}
        </section>
      )}

    </div>
  );
}

/** Whether the report's buyer has opened it yet (for the heads of each line and execs) */
function Seen({ at }: { at: string | null }) {
  return at ? (
    <span className="text-faint"> · opened {new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
  ) : (
    <span className="text-warn"> · not opened yet</span>
  );
}
