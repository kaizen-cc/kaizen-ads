import Link from "next/link";
import { needsConnecting } from "@/components/channel-parts";
import { loadChannelBoard, riskForRow } from "@/lib/channel-kpis/load";
import { etToday, moneyShort, orderByRisk, pctText, type Line } from "@/lib/channel-kpis/calc";
import { loadSuggestions } from "@/lib/email-ops/load";
import { mineFirst, prioritizeIdeas, reminderFor } from "@/lib/overview-desk";
import { mainText, targetText } from "@/components/channel-parts";
import { accountBrief } from "@/lib/account-brief";
import { loadBrands, loadDeskOps, owedByClient } from "@/lib/overview-desk-load";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { IdeaDeck } from "./campaign-ideas";
import { ClientGroup, SetupList, brandOf, type CardExtra, type DeskRow } from "./channel-desk";
import { OverviewTabs, TabCards, WorkUnderToday } from "./overview-tabs";
import { PageHeader, Stats } from "./shared";

type Me = { id: string; role: TeamRole; isExec: boolean; isLead: boolean };

/** A client needs a look at this risk and up; under it, it's on track */
const LOOK_AT = 30;

/**
 * Overview for the email and organic social teams (heads and their team), in tabs so each part stays short:
 *   Today            the recap, the month's numbers and a card per tab with what's waiting there
 *   Clients          the person's own accounts first, then the rest of the team's in a contained scrolling area,
 *                    each worst first (retention risk); compact cards that open for the detail
 *   Ideas (email)    campaign ideas, critical first, the rest folded
 *   Audits & sprints a head: only what's critical or gone stale; a strategist: their own open ones
 *   Setup            the clients still to connect
 * It reads nothing from the ad tables.
 */
export async function ChannelHome(props: ChannelProps) {
  const { header, tabs, panels } = await channelTabs(props);
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:gap-8">
      {header}
      <OverviewTabs tabs={tabs} panels={panels} />
    </div>
  );
}

type ChannelProps = { me: Me; line: Line; today: string; greeting: string; firstName: string; /** Their day (the recap's way in), above their clients */ recap?: React.ReactNode; /** My work, under the day (no separate tab) */ work?: React.ReactNode; workCount?: number };

/** The line's tabs and their panels, as data: everyone's block Overview folds them into its blocks (Nov 23 2026) */
export async function channelTabs({ me, line, today, greeting, firstName, recap = null, work = null, workCount = 0 }: ChannelProps): Promise<{ header: React.ReactNode; tabs: { id: string; label: string; count?: number }[]; panels: Record<string, React.ReactNode> }> {
  const db = await createClient();
  const [board, owed] = await Promise.all([loadChannelBoard(db, line, me), owedByClient(db, me)]);
  const ids = board.rows.map((r) => r.clientId);
  const head = me.isLead || me.isExec;
  const [brands, ops, suggestions] = await Promise.all([
    loadBrands(db, ids).catch(() => new Map()),
    loadDeskOps(db, ids, line).catch(() => ({ audits: new Map(), sprints: new Map() })),
    line === "email" ? loadSuggestions(db, ids, 240).catch(() => []) : Promise.resolve([]),
  ]);
  const ranked: DeskRow[] = orderByRisk(board.rows.map((r) => ({ ...r, risk: riskForRow(r, owed.get(r.clientId)), brand: brandOf(brands, r.clientId) })));
  const channel = line === "email" ? "Email" : "Social";
  const day = etToday();

  const connecting = ranked.filter(needsConnecting);
  const live = ranked.filter((r) => !needsConnecting(r));
  const { mine, team } = mineFirst(live);
  const hurting = (rows: DeskRow[]) => rows.filter((r) => r.risk.score >= LOOK_AT);
  const off = live.filter((r) => r.status === "off").length;
  const close = live.filter((r) => r.status === "close").length;
  const good = live.filter((r) => r.status === "good" || r.status === "excellent").length;

  // The account score: email's, or social's overall (every platform weighted by reach)
  const scoreOf = (r: DeskRow) => r.score?.score ?? r.socialScore?.score ?? null;
  const scored = live.filter((r) => scoreOf(r) != null);
  const avg = scored.length ? Math.round(scored.reduce((t, r) => t + (scoreOf(r) ?? 0), 0) / scored.length) : null;
  const mtd = live.reduce((t, r) => t + (r.line === "email" ? (r.value ?? 0) : 0), 0);
  const reach = live.reduce((t, r) => t + (r.social?.reach ?? 0), 0);
  const inter = live.reduce((t, r) => t + (r.social?.interactions ?? 0), 0);
  const scoreTone = avg == null ? undefined : avg >= 80 ? ("ok" as const) : avg >= 60 ? ("warn" as const) : ("bad" as const);
  const stats = [
    line === "email"
      ? { label: "Average score", value: avg ?? "n/a", hint: `${moneyShort(mtd)} attributed revenue this month`, tone: scoreTone }
      : { label: "Engagement this month", value: pctText(reach > 0 ? inter / reach : null), hint: `Interactions over reach, all your clients${avg != null ? ` · average social score ${avg}` : ""}`, tone: scoreTone },
    { label: line === "email" ? "Red or yellow" : "Off or close", value: off + close, hint: line === "email" ? (off ? `${off} red${close ? `, ${close} yellow` : ""}` : close ? `${close} yellow` : "None slipping") : off ? `${off} off target` : close ? `${close} close` : "None slipping", tone: off ? ("bad" as const) : close ? ("warn" as const) : ("ok" as const) },
    { label: line === "email" ? "Green" : "On target", value: good, hint: line === "email" ? "Score 80 and up" : "At or better than target", tone: good ? ("ok" as const) : undefined },
    { label: "Need connecting", value: connecting.length, hint: connecting.length ? (line === "email" ? "Klaviyo key missing or failing" : "Page or Instagram not linked") : "All reading", tone: connecting.length ? ("warn" as const) : ("ok" as const) },
  ];

  const byId = new Map(ranked.map((r) => [r.clientId, r]));
  // On each card: its open audit or sprint (no separate tab), and What to know on hover (owner, Nov 19 2026)
  const [{ data: changes }, { data: promises }] = ids.length
    ? await Promise.all([
        db.from("client_direction_changes").select("client_id, summary, lines, direction_change_tasks(action)").eq("status", "open").eq("scope", "direction").in("client_id", ids).order("created_at", { ascending: false }).limit(300),
        db.from("message_promises").select("client_id").eq("status", "overdue").in("client_id", ids).limit(500),
      ])
    : [{ data: [] }, { data: [] }];
  const changesOf = new Map<string, { summary: string; pending: number }[]>();
  for (const c of (changes ?? []) as { client_id: string; summary: string; lines: string[] | null; direction_change_tasks: { action: string }[] | null }[]) {
    if (c.lines?.length && !c.lines.includes(line)) continue;
    changesOf.set(c.client_id, [...(changesOf.get(c.client_id) ?? []), { summary: c.summary, pending: (c.direction_change_tasks ?? []).filter((t) => t.action === "pending").length }]);
  }
  const overdue = new Map<string, number>();
  for (const p of (promises ?? []) as { client_id: string | null }[]) if (p.client_id) overdue.set(p.client_id, (overdue.get(p.client_id) ?? 0) + 1);
  const BAND: Record<string, "bad" | "warn" | "ok"> = { bad: "bad", red: "bad", watch: "warn", yellow: "warn", good: "ok", green: "ok" };
  const extra = (r: DeskRow): CardExtra => {
    const w = reminderFor(r.clientId, ops.audits.get(r.clientId) ?? null, ops.sprints.get(r.clientId) ?? null, day);
    const sc = r.score ?? r.socialScore ?? null;
    const drags = r.score ? r.score.weighingDown.map((c) => c.label) : r.socialScore ? (r.socialScore.weighingDown as { label: string; platform?: string }[]).map((c) => (c.platform ? `${c.label} (${c.platform})` : c.label)) : [];
    const brief = accountBrief({
      status: "good",
      label: "",
      value: null,
      target: null,
      deviation: null,
      pacing: null,
      pace: null,
      spend30: 0,
      hasAccount: !needsConnecting(r),
      owed: owed.get(r.clientId) ?? null,
      changes: changesOf.get(r.clientId) ?? [],
      overduePromises: overdue.get(r.clientId) ?? 0,
      kpiLine: sc ? { tone: BAND[sc.band] ?? "warn", text: `${line === "email" ? "Account" : "Social"} score ${sc.score}/100${r.target != null ? ` · ${mainText(r)} vs ${targetText(r)}` : ""}` } : null,
      drags,
      ...(w ? { sprint: w.kind === "sprint" ? (ops.sprints.get(r.clientId) ?? null) : null, audit: w.kind === "audit" ? (ops.audits.get(r.clientId) ?? null) : null } : {}),
    }).map(({ tone, text }) => ({ tone, text: text.replace("No ad account is linked, so nothing is being measured", line === "email" ? "Klaviyo isn't connected, so nothing is being measured" : "The page or Instagram isn't linked, so nothing is being measured") }));
    return {
      brief,
      hideBoard: head,
      work: w ? { label: `${w.kind === "sprint" ? "Sprint" : "Audit"} ${w.progress.done}/${w.progress.of}`, why: w.why, href: `/kpis/${line}-${w.kind}/${w.id}`, tone: w.level === "critical" ? "bad" : w.level === "stale" ? "warn" : "quiet" } : null,
    };
  };

  // Campaign ideas still open, critical first
  const ideas = prioritizeIdeas(
    suggestions.filter((s) => (s.status === "new" || s.status === "in_motion") && byId.has(s.clientId)),
    day,
  ).map((s) => {
    const c = byId.get(s.clientId)!;
    return { id: s.id, clientName: c.name, slug: c.slug, brand: c.brand, title: s.title, idea: s.idea, why: s.why, sendOn: s.sendOn, status: s.status, tier: s.priority.tier, reason: s.priority.reason };
  });
  const criticalIdeas = ideas.filter((i) => i.tier === "critical");

  const total = ranked.length;
  const mineHurting = hurting(mine);
  const teamHurting = hurting(team);
  const needs = hurting(live).length + connecting.length;
  const header = <PageHeader today={today} title={`${greeting}, ${firstName}`} subtitle={`${roleLabel(me.role)} · ${total} ${total === 1 ? "client" : "clients"} · ${needs ? `${needs} ${needs === 1 ? "needs" : "need"} a look` : total ? "all steady today" : "no clients yet"}`} />;

  if (total === 0)
    return {
      header,
      tabs: [{ id: "clients", label: "Clients" }],
      panels: {
        clients: (
          <>
            {recap}
            <section className="grid justify-items-start gap-3 rounded-[18px] border border-dashed border-line p-6 md:p-8">
          <p className="font-heading text-xl">No clients yet</p>
          <p className="max-w-prose text-sm text-muted">
            {channel} clients show here once they buy {line === "email" ? "Email Marketing" : "Social Media"} and you hold a seat on them. Heads see every client with the service.
          </p>
          <Link href="/clients" className="inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg">
            Open the clients
          </Link>
        </section>
          </>
        ),
      },
    };

  const names = (rows: DeskRow[]) => rows.slice(0, 3).map((r) => `${r.name}${r.risk.reasons[0] ? `: ${r.risk.reasons[0].toLowerCase()}` : ""}`);
  // Today (with My work under it), Clients and Ideas: audits and sprints sit on each card, setup at the end of Clients
  const tabs = [
    { id: "today", label: "Today", ...(workCount ? { count: workCount, tone: "brand" as const } : {}) },
    { id: "clients", label: head ? "Clients" : "My clients", count: mineHurting.length + (head ? teamHurting.length : 0), tone: mineHurting.some((r) => r.status === "off") ? ("bad" as const) : ("warn" as const) },
    ...(line === "email" ? [{ id: "ideas", label: "Ideas", count: criticalIdeas.length, tone: "bad" as const }] : []),
  ];
  const cards = [
    {
      tab: "clients",
      title: head ? "Your accounts" : "My clients",
      count: mineHurting.length,
      tone: mineHurting.some((r) => r.status === "off") ? ("bad" as const) : ("warn" as const),
      headline: mine.length ? (mineHurting.length ? `of your ${mine.length} need a look` : `Your ${mine.length} are steady`) : "You hold no seat yet",
      points: names(mineHurting),
    },
    ...(head
      ? [{ tab: "clients", title: "Your team's", count: teamHurting.length, tone: teamHurting.some((r) => r.status === "off") ? ("bad" as const) : ("warn" as const), headline: teamHurting.length ? `of ${team.length} team accounts need a look` : `All ${team.length} team accounts steady`, points: names(teamHurting) }]
      : []),
    ...(line === "email" ? [{ tab: "ideas", title: "Campaign ideas", count: criticalIdeas.length, tone: "bad" as const, headline: criticalIdeas.length ? `critical, ${ideas.length - criticalIdeas.length} more when there's room` : `Nothing urgent · ${ideas.length} open`, points: criticalIdeas.slice(0, 3).map((i) => `${i.clientName}: ${i.reason.split(" · ")[0].toLowerCase()}`) }] : []),
  ].slice(0, 4);

  const panels: Record<string, React.ReactNode> = {
    today: (
      <>
        {recap}
        <Stats items={stats} />
        <TabCards cards={cards} />
        {work && <WorkUnderToday>{work}</WorkUnderToday>}
      </>
    ),
    clients: (
      <>
        {(mine.length > 0 || !head) && <ClientGroup id="mine" title={head ? "Your accounts" : "My clients"} aside="Most at risk of leaving first" rows={mine} empty="You hold no seat on a client yet." extra={extra} />}
        {team.length > 0 && <ClientGroup id="team" title={head ? "Your team's accounts" : "Other clients you can see"} aside={`Worst first · ${teamHurting.length} need a look`} rows={team} contained extra={extra} />}
        {connecting.length > 0 && (
          <details className="group/setup">
            <summary className="flex min-h-11 cursor-pointer list-none items-baseline justify-between gap-2 [&::-webkit-details-marker]:hidden">
              <span className="font-heading text-lg">
                Needs connecting <span className="tabular text-[14px] text-faint">{connecting.length}</span> <span aria-hidden className="inline-block text-faint transition-transform group-open/setup:rotate-180">⌄</span>
              </span>
            </summary>
            <div className="mt-3">
              <SetupList rows={connecting} line={line} />
            </div>
          </details>
        )}
      </>
    ),
    ideas: <IdeaDeck ideas={ideas} />,
  };

  return { header, tabs, panels };
}
