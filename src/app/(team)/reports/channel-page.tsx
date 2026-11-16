import Link from "next/link";
import type { Staff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { readHistory } from "@/lib/reports/history";
import { SlackConnect } from "@/components/slack-connect";
import type { Qa } from "@/lib/reports/write";
import { lineName, platformOfLine, type ChannelLine } from "@/lib/channel-reports/core";
import { channelClients, coverageFor } from "@/lib/channel-reports/clients";
import { linesFor } from "@/lib/channel-reports/access-core";
import { ChannelCard, type ChannelCardReport } from "./channel-cards";
import { ChannelClientRow } from "./channel-client-row";
import { Empty, Group } from "./report-cards";
import { SendHistory } from "./send-history";
import { LineSwitch } from "./line-switch";

// The Reports page for the email and organic social teams (and the execs, on the Email and Social lines): the reports
// drafted for their clients, waiting on review or sent, and the clients themselves: who is connected, who isn't and what to
// connect. Read by the server after the same client and line rule the database applies (see channel-reports/clients.ts).

type Row = { id: string; kind: "weekly" | "monthly"; status: string; qa: Qa | null; posted_at: string | null; owner_id: string | null; client_id: string; period_start: string; period_end: string; metrics: { main?: { label?: string } } | null; clients: { name: string } | null; profiles: { full_name: string } | null };

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export async function ChannelReports({ me, line, view: asked, slack }: { me: Staff; line: ChannelLine; view: string | null; slack: { connected: boolean } }) {
  const admin = adminConfigured() ? createAdminClient() : null;
  const lines = linesFor(me);
  const clients = admin ? await channelClients(admin, me, line) : [];
  const ids = clients.map((c) => c.id);
  const platform = platformOfLine(line);
  const [cover, rowsRes, prefs] = admin && ids.length
    ? await Promise.all([
        coverageFor(admin, line, ids),
        admin.from("reports").select("id, kind, status, qa, posted_at, owner_id, client_id, period_start, period_end, metrics, clients(name), profiles!reports_owner_id_fkey(full_name)").eq("platform", platform).in("client_id", ids).is("hidden_at", null).gte("created_at", daysAgo(120)).order("created_at"),
        admin.from("client_report_prefs").select("client_id, channel_weekly").in("client_id", ids).then((x) => (x.error ? { data: [] as { client_id: string; channel_weekly: string[] | null }[] } : x)),
      ])
    : [new Map(), { data: [] }, { data: [] }];
  const rows = ((rowsRes as { data: unknown }).data ?? []) as unknown as Row[];
  const weekly = new Set(((prefs as { data: { client_id: string; channel_weekly: string[] | null }[] | null }).data ?? []).filter((p) => p.channel_weekly?.includes(line)).map((p) => p.client_id));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const history = admin ? (await readHistory(admin, { clientIds: ids, limit: 300 }, today)).filter((s) => s.platform === platform) : [];

  const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const period = (r: Row) => r.metrics?.main?.label ?? (r.kind === "monthly" ? new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : `${short(r.period_start)} – ${short(r.period_end)}`);
  const card = (r: Row): ChannelCardReport => ({ id: r.id, client: r.clients?.name ?? "Client", kind: r.kind, period: period(r), status: r.status, qa: r.qa, owner: r.profiles?.full_name ?? null, mine: r.owner_id === me.id, postedAt: r.posted_at });
  const waiting = rows.filter((r) => !["posted", "skipped"].includes(r.status));
  const latest = (kind: string) => waiting.filter((r) => r.kind === kind).map((r) => r.period_start).sort().at(-1) ?? null;
  const monthly = waiting.filter((r) => r.kind === "monthly" && r.period_start === latest("monthly")).sort((a, b) => (a.clients?.name ?? "").localeCompare(b.clients?.name ?? ""));
  const weeklies = waiting.filter((r) => r.kind === "weekly" && r.period_start === latest("weekly")).sort((a, b) => (a.clients?.name ?? "").localeCompare(b.clients?.name ?? ""));
  const sent = rows.filter((r) => r.status === "posted" && r.posted_at && r.posted_at >= daysAgo(30)).sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""));
  const readyCount = monthly.length + weeklies.length;
  const connected = clients.filter((c) => cover.get(c.id)?.state === "connected");
  const view = asked === "sent" ? "sent" : asked === "clients" ? "clients" : asked === "ready" ? "ready" : readyCount ? "ready" : "clients";
  const drafts = [...monthly, ...weeklies].filter((r) => r.status === "draft");
  const stats = [
    { n: drafts.length, label: "ready to review", tone: "text-fg" },
    { n: drafts.filter((r) => (r.qa?.flags ?? []).some((f) => f.severity === "fix")).length, label: "with something to fix", tone: "text-bad" },
    { n: sent.filter((r) => r.posted_at && r.posted_at >= daysAgo(7)).length, label: "sent this week", tone: "text-ok" },
    { n: clients.length - connected.length, label: "not connected", tone: "text-warn" },
  ];
  const lead = me.isExec || me.role === "head_of_email" || me.role === "head_of_social";
  const href = (v: string) => `/reports?${new URLSearchParams({ ...(me.isExec ? { line } : {}), view: v })}`;
  const TABS = [
    { key: "ready", title: "Ready to send", sub: "Drafted and waiting on review", n: readyCount },
    { key: "sent", title: "Sent", sub: "Every report, to review and resend", n: history.length || sent.length },
    { key: "clients", title: "Clients", sub: "Who is connected, and what to connect", n: clients.length },
  ] as const;
  const latestOf = (id: string) => {
    const r = rows.filter((x) => x.client_id === id && x.status !== "skipped").sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
    return r ? { id: r.id, label: `${period(r)} · ${r.status === "posted" ? "sent" : r.status === "draft" ? "ready to review" : r.status}`, status: r.status } : null;
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Reports</h1>
          <p className="max-w-2xl text-sm text-muted">
            {line === "email" ? "Email" : "Organic social"} reports are drafted on the first business days of the month for the month just over, in your voice, and checked by the QA. Read it, tweak it or ask the AI to, then send it as you. A weekly is optional, per client.
          </p>
        </div>
        <SlackConnect connected={slack.connected} next="/reports" />
      </header>

      {lines.length > 1 && <LineSwitch current={line} />}

      <nav className="grid grid-cols-3 gap-1.5 rounded-[22px] border border-line bg-surface p-1.5" aria-label="Reports">
        {TABS.map((t) => (
          <Link key={t.key} href={href(t.key)} scroll={false} aria-current={view === t.key ? "page" : undefined} className={`relative grid gap-0.5 overflow-hidden rounded-[17px] px-3 py-3 text-left transition-all md:px-5 md:py-4 ${view === t.key ? "bg-deep text-fg shadow-[0_14px_40px_-22px_rgba(200,16,46,0.9)] ring-1 ring-ink/10" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
            <span className="relative flex items-baseline gap-2 font-heading text-[15px] md:text-[18px]">
              {t.title}
              <span className={`tabular text-xs md:text-sm ${view === t.key ? "text-brand-text" : "text-faint"}`}>{t.n}</span>
            </span>
            <span className="relative truncate text-[11px] text-faint max-md:hidden">{t.sub}</span>
          </Link>
        ))}
      </nav>

      {view === "ready" && (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {stats.map((x) => (
              <div key={x.label} className="grid gap-0.5 rounded-[18px] border border-line bg-surface px-4 py-3.5">
                <span className={`tabular font-display text-[30px] leading-none ${x.n ? x.tone : "text-faint"}`}>{x.n}</span>
                <span className="text-xs text-muted">{x.label}</span>
              </div>
            ))}
          </div>
          {readyCount === 0 ? (
            <Empty title="All caught up" body={`Nothing waiting to send. ${lineName(line)} reports are drafted on the first business days of the month; to draft one now, open the Clients tab.`} />
          ) : (
            <>
              {monthly.length > 0 && (
                <Group title="Monthly report" count={monthly.length} note="The month just over">
                  {monthly.map((r) => (
                    <ChannelCard key={r.id} r={card(r)} showOwner={lead} line={line} />
                  ))}
                </Group>
              )}
              {weeklies.length > 0 && (
                <Group title="Weekly report" count={weeklies.length} note="For clients that ask for a weekly">
                  {weeklies.map((r) => (
                    <ChannelCard key={r.id} r={card(r)} showOwner={lead} line={line} />
                  ))}
                </Group>
              )}
            </>
          )}
        </div>
      )}

      {view === "sent" &&
        (history.length ? (
          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="flex items-baseline gap-2 font-heading text-[19px]">
                Sent <span className="tabular text-sm text-faint">{history.length}</span>
              </h3>
              <span className="text-xs text-faint">Who sent it, when, where and to whom · the PDF as it went</span>
            </div>
            <SendHistory items={history} filterable />
          </section>
        ) : sent.length ? (
          <Group title="Sent" count={sent.length} note="The last 30 days">
            {sent.map((r) => (
              <ChannelCard key={r.id} r={card(r)} showOwner={lead} line={line} />
            ))}
          </Group>
        ) : (
          <Empty title="Nothing sent yet" body="Reports that go out land here. Every one stays in the client's history." />
        ))}

      {view === "clients" &&
        (clients.length ? (
          <ul className="grid gap-2.5">
            {[...clients]
              .sort((a, b) => Number(cover.get(a.id)?.state === "connected") - Number(cover.get(b.id)?.state === "connected") || a.name.localeCompare(b.name))
              .map((c) => (
                <ChannelClientRow key={c.id} clientId={c.id} name={c.name} slug={c.slug} line={line} state={cover.get(c.id)?.state ?? "missing"} what={cover.get(c.id)?.what ?? null} weekly={weekly.has(c.id)} latest={latestOf(c.id)} />
              ))}
          </ul>
        ) : (
          <Empty title="No clients yet" body={`You'll see the clients that buy ${line === "email" ? "Email Marketing" : "Social Media"} and have you seated here.`} />
        ))}
    </div>
  );
}
