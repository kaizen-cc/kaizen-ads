import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allotmentPools, type PoolCounts } from "@/lib/allotment";
import { STATUS, kpiValue, money, pct } from "@/lib/kpi/format";
import { adsRisk, briefPriority, creativeRisk, mineFirst, reminderFor } from "@/lib/overview-desk";
import { loadAdsDesk, loadBrands, mySeatClients, owedByClient, type AdsDeskRow } from "@/lib/overview-desk-load";
import { etToday } from "@/lib/channel-kpis/calc";
import type { SuggestionsState } from "@/lib/suggestions";
import { DeskGroup, brandOf, type DeskCardData } from "./channel-desk";
import { SuggestedBriefs } from "./suggested-briefs";
import { WatchList } from "./watch-panel";
import { CreativeClientRows, type ClientRow } from "./creative-client-rows";
import { WATCH_GROUP, type WatchFlag } from "@/lib/account-watch/load";
import type { OpenSuggestion } from "@/lib/suggestions";
import { allotmentSlice, nextBucket, POOL_FORMAT } from "@/lib/creative-allotments";
import { loadAllotmentDesk } from "@/lib/creative-allotments-load";
import { accountBrief, type BriefInput } from "@/lib/account-brief";

// The Overview's tabs for the ads lines (Meta, Google) and the creative line, the email and social Overview's pattern:
//   Clients           the person's own accounts first, then the rest of their team's in a contained scrolling area,
//                     each worst first (retention risk); compact cards that open for the detail
//   Ideas             suggested briefs, critical first (an account off target, an unhappy client, a promise), the rest
//                     folded (the ads lines; the creative leads have their briefs inside each client's row instead)
//   Audits & sprints  a head: only what's critical or gone stale; a buyer: their own open ones
//   Setup             accounts we can't read yet or with no KPI set
// The exec Overview doesn't use this.

type Me = { id: string; role: string; isExec: boolean; isLead: boolean };
export type DeskTab = { id: string; label: string; count?: number; tone?: "bad" | "warn" | "ok" | "brand" | "quiet" };
/** mergeWork: no My work tab; Today holds the day and My work under it (the ads lines, owner Nov 19 2026). today:
 *  anything more for the Today tab (a creative lead's account watch flags with no client row) */
export type Desk = { tabs: DeskTab[]; panels: Record<string, React.ReactNode>; mergeWork?: boolean; today?: React.ReactNode };

const LOOK_AT = 30;
const TONE_OF: Record<AdsDeskRow["status"], DeskCardData["tone"]> = { off: "bad", close: "warn", good: "ok", excellent: "ok", idle: "quiet", setup: "quiet", unset: "quiet" };

/** An ad account as a card: the KPI against target, what's hurting, the ways in */
function adsCard(r: AdsDeskRow & { risk: ReturnType<typeof adsRisk> }, brand: DeskCardData["brand"], opts: { head: boolean; brief: DeskCardData["brief"]; work: DeskCardData["work"] }): DeskCardData {
  const has = r.value != null && r.target != null && r.target > 0;
  // Toward target: ROAS higher is better, a cost lower is better
  const fill = has ? (r.roas ? r.value! / r.target! : r.target! / Math.max(r.value!, 0.0001)) : null;
  return {
    key: r.targetId,
    name: r.name,
    sub: [r.label, r.owner].filter(Boolean).join(" · "),
    brand,
    risk: r.risk,
    tone: TONE_OF[r.status],
    statusLabel: STATUS[r.status].label,
    big: r.value == null ? "n/a" : kpiValue(r.value, r.roas),
    bigCaption: r.target != null ? `/ ${kpiValue(r.target, r.roas)}${r.label ? ` ${r.label}` : ""}` : r.label || null,
    gauge: fill == null ? null : { fill: Math.min(1, fill), mark: 1 },
    detail: [
      { label: "Spend 30d", value: money(Math.round(r.spend30)) },
      { label: "Vs target", value: r.deviation == null ? "n/a" : pct(r.deviation) },
      { label: "Pace", value: r.pacing ? (r.pace != null ? `${Math.round(r.pace * 100)}%` : r.pacing) : "On pace" },
    ],
    links: [
      { href: `/clients/${r.slug}?service=${r.platform}`, label: "Client" },
      { href: `/kpis?target=${encodeURIComponent(r.targetId)}`, label: "KPIs" },
      // The heads don't work tickets: no Board for them (a buyer keeps it)
      ...(r.platform === "meta" && !opts.head ? [{ href: `/board?client=${encodeURIComponent(r.slug)}`, label: "Board" }] : []),
      { href: `/reports?client=${encodeURIComponent(r.slug)}`, label: "Reports" },
    ],
    brief: opts.brief,
    work: opts.work,
  };
}

/** Accounts still to set up (no ad account, one we can't read, or no KPI set), folded at the end of Clients: each opens its KPI card */
function SetupRows({ rows }: { rows: AdsDeskRow[] }) {
  if (!rows.length) return null;
  return (
    <details className="group/setup grid gap-3">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 [&::-webkit-details-marker]:hidden">
        <span className="font-heading text-lg">
          Needs setup <span className="tabular text-[14px] text-faint">{rows.length}</span> <span aria-hidden className="inline-block text-faint transition-transform group-open/setup:rotate-180">⌄</span>
        </span>
        <span className="text-xs text-faint">Link the ad account, share access, or set the KPI on its card</span>
      </summary>
      <ul className="mt-3 grid max-h-[min(68vh,700px)] gap-px overflow-y-auto overscroll-contain rounded-[20px] border border-line bg-line">
        {rows.map((r) => (
          <li key={r.targetId}>
            <Link href={`/kpis?target=${encodeURIComponent(r.targetId)}`} className="flex min-h-11 items-center justify-between gap-3 bg-surface px-4 py-3 hover:bg-surface-2">
              <span className="grid min-w-0">
                <span className="truncate font-heading text-[15px]">{r.name}</span>
                <span className="truncate text-[12px] text-faint">{[r.label, r.owner].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{r.status === "unset" ? "No KPI set" : r.hasAccount ? "Can't read it" : "No ad account"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Suggested briefs with each one's priority (critical first), for the Ideas tab */
function ideasPanel(suggestions: SuggestionsState | null | undefined, riskOf: Map<string, number>) {
  if (!suggestions) return null;
  const priority = Object.fromEntries(suggestions.open.map((s) => [s.id, briefPriority(s.kind, riskOf.get(s.clientId) ?? 0)]));
  return { panel: <SuggestedBriefs state={suggestions} bare priority={priority} />, critical: Object.values(priority).filter((p) => p.tier === "critical").length };
}

/** The Meta or Google line: a head sees their own accounts then the team's; a buyer their own */
export async function adsDesk(db: SupabaseClient, me: Me, platform: "meta" | "google", suggestions?: SuggestionsState | null): Promise<Desk> {
  const head = me.isLead || me.isExec;
  const [desk, owed] = await Promise.all([loadAdsDesk(db, me, platform), owedByClient(db, me)]);
  const brands = await loadBrands(db, [...new Set(desk.rows.map((r) => r.clientId))]).catch(() => new Map());
  const scoped = head ? desk.rows : desk.rows.filter((r) => r.mine);
  const setup = scoped.filter((r) => r.status === "setup" || r.status === "unset");
  const live = scoped
    .filter((r) => r.status !== "setup")
    .map((r) => {
      const o = owed.get(r.clientId);
      return { ...r, risk: adsRisk({ status: r.status, deviation: r.deviation, pacing: r.pacing, hasAccount: r.hasAccount, owed: o?.n, escalated: o?.escalated }) };
    });
  const { mine, team } = mineFirst(live);
  // What to know on hover: the client's open direction changes on this line and overdue promises, with the rest
  const ids = [...new Set(live.map((r) => r.clientId))];
  const [{ data: changes }, { data: promises }] = ids.length
    ? await Promise.all([
        db.from("client_direction_changes").select("client_id, summary, lines, created_at, direction_change_tasks(action)").eq("status", "open").eq("scope", "direction").in("client_id", ids).order("created_at", { ascending: false }).limit(300),
        db.from("message_promises").select("client_id").eq("status", "overdue").in("client_id", ids).limit(500),
      ])
    : [{ data: [] }, { data: [] }];
  const changesOf = new Map<string, NonNullable<BriefInput["changes"]>>();
  for (const c of (changes ?? []) as { client_id: string; summary: string; lines: string[] | null; direction_change_tasks: { action: string }[] | null }[]) {
    if (c.lines?.length && !c.lines.includes(platform) && !c.lines.includes("creative")) continue;
    const list = changesOf.get(c.client_id) ?? [];
    list.push({ summary: c.summary, pending: (c.direction_change_tasks ?? []).filter((t) => t.action === "pending").length });
    changesOf.set(c.client_id, list);
  }
  const overdue = new Map<string, number>();
  for (const p of (promises ?? []) as { client_id: string | null }[]) if (p.client_id) overdue.set(p.client_id, (overdue.get(p.client_id) ?? 0) + 1);
  const briefOf = (r: (typeof live)[number]) =>
    accountBrief({
      status: r.status,
      label: r.label,
      value: r.value == null ? null : kpiValue(r.value, r.roas),
      target: r.target == null ? null : kpiValue(r.target, r.roas),
      deviation: r.deviation,
      pacing: r.pacing,
      pace: r.pace,
      spend30: r.spend30,
      hasAccount: r.hasAccount,
      owed: owed.get(r.clientId) ?? null,
      audit: desk.audits.get(r.targetId) ?? null,
      sprint: desk.sprints.get(r.targetId) ?? null,
      changes: changesOf.get(r.clientId) ?? [],
      overduePromises: overdue.get(r.clientId) ?? 0,
    }).map(({ tone, text }) => ({ tone, text }));
  const today = etToday();
  // The account's open audit or sprint, small under its card (no separate tab): critical, gone stale, or open
  const workOf = (r: (typeof live)[number]): DeskCardData["work"] => {
    const w = reminderFor(r.targetId, desk.audits.get(r.targetId) ?? null, desk.sprints.get(r.targetId) ?? null, today);
    if (!w) return null;
    return { label: `${w.kind === "sprint" ? "Sprint" : "Audit"} ${w.progress.done}/${w.progress.of}`, why: w.why, href: `/kpis/${w.kind}/${w.id}`, tone: w.level === "critical" ? "bad" : w.level === "stale" ? "warn" : "quiet" };
  };
  const card = (r: (typeof live)[number]) => adsCard(r, brandOf(brands, r.clientId), { head, brief: briefOf(r), work: workOf(r) });
  const hurting = (rows: typeof live) => rows.filter((r) => r.risk.score >= LOOK_AT).length;

  const riskOf = new Map<string, number>();
  for (const r of live) riskOf.set(r.clientId, Math.max(riskOf.get(r.clientId) ?? 0, r.risk.score));
  const ideas = platform === "meta" ? ideasPanel(suggestions, riskOf) : null;
  const name = platform === "meta" ? "Meta" : "Google";

  return {
    // Today (with My work under it), Clients and Ideas: audits and sprints sit on each card, setup at the end of Clients
    mergeWork: true,
    tabs: [
      { id: "clients", label: head ? "Clients" : "My clients", count: hurting(mine) + (head ? hurting(team) : 0), tone: live.some((r) => r.status === "off") ? "bad" : "warn" },
      ...(ideas ? [{ id: "ideas", label: "Ideas", count: ideas.critical, tone: "bad" as const }] : []),
    ],
    panels: {
      clients: (
        <>
          {(mine.length > 0 || !head) && <DeskGroup id="mine" title={head ? "Your accounts" : "My accounts"} aside="Most at risk of leaving first" cards={mine.map(card)} empty={`You own no ${name} account yet.`} />}
          {team.length > 0 && <DeskGroup id="team" title={head ? "Your team's accounts" : "Other accounts"} aside={`Worst first · ${hurting(team)} need a look`} cards={team.map(card)} contained />}
          <SetupRows rows={setup} />
        </>
      ),
      ...(ideas ? { ideas: ideas.panel } : {}),
    },
  };
}

type CreativeClient = { clientId: string; name: string; slug: string; tone: string; note: string; waiting: number; revisionsPerItem: number; counts: PoolCounts; elapsed?: number };

/**
 * The creative line. The creative leads (the head of creative, the lead graphic designer, the lead video editor) get
 * Today, Clients and My work only: each client's row holds its allotment, this week's healthy share, its account watch
 * flags and the briefs already drafted for it (pacing catch-up, the market, what's winning for similar clients, a
 * client's ask), ready to approve, edit or reject right there; Create brief opens the normal request form. Watch
 * flags on clients without a row go to Today. Designers and editors keep their clients' cards under their rows.
 */
export async function creativeDesk(db: SupabaseClient, me: Me, clients: CreativeClient[], monthElapsed: number, suggestions?: SuggestionsState | null): Promise<Desk> {
  const head = me.isLead || me.isExec;
  const lead = me.isExec || me.role === "head_of_creative" || me.role === "lead_graphic_designer" || me.role === "lead_video_editor";
  const { loadReady } = await import("@/lib/brief-drafting");
  const { loadWatch } = await import("@/lib/account-watch/load");
  const [seats, brands, gaps, ready, watchFlags] = await Promise.all([
    mySeatClients(db, me).catch(() => new Set<string>()),
    loadBrands(db, clients.map((c) => c.clientId)).catch(() => new Map()),
    // Their slice of this cycle's allotment gaps (src/lib/creative-allotments.ts), most urgent first
    loadAllotmentDesk(db, me).catch(() => null),
    // The briefs drafted for their clients, waiting on a decision (only approvers can read them)
    loadReady(db, { limit: 200 }).catch(() => []),
    loadWatch(db, me)
      .then((w) => w.flags.filter((f) => f.kind !== "unrecognized" || me.isExec))
      .catch(() => [] as WatchFlag[]),
  ]);
  const slice = allotmentSlice(me);
  const pools = new Set<string>(slice?.pools ?? ["images", "videos"]);
  // A brief is theirs when it makes something in their pool (images and carousels share the image pool)
  const inPool = (s: OpenSuggestion) => s.draft.formats.some((f) => pools.has(f.format === "video" ? "videos" : "images"));
  const ideas = [...ready.flatMap((g) => g.items), ...(suggestions?.open ?? []).filter((s) => !s.drafted)].filter(inPool);
  const rowsBy = new Map<string, ClientRow>();
  const row = (clientId: string, client: string, slug: string) => {
    const r = rowsBy.get(clientId) ?? { clientId, client, slug, brand: brandOf(brands, clientId), group: "covered" as const, pools: [], fresh: null, watch: [], ideas: [], noBriefsWhy: null };
    rowsBy.set(clientId, r);
    return r;
  };
  // Every client in their slice with an allotment: behind, on pace, covered and over alike (each in its own group)
  for (const g of gaps?.gaps ?? []) {
    row(g.clientId, g.client, g.slug).pools.push({ pool: g.pool, line: g.line, pace: g.pace, detail: g.detail, requested: g.requested, inMotion: g.inMotion, delivered: g.delivered, cap: g.cap, missing: g.missing, over: g.over, dueThisWeek: g.dueThisWeek, state: g.state, elapsed: g.elapsed, daysLeft: g.daysLeft, urgent: nextBucket(g) === "now", nothing: g.state === "nothing", format: POOL_FORMAT[g.pool] });
  }
  for (const s of ideas) if (s.clientSlug) row(s.clientId, s.client, s.clientSlug).ideas.push(s);
  for (const f of gaps?.fresh ?? []) row(f.clientId, f.client, f.slug).fresh = f.why;
  const leftover: typeof watchFlags = [];
  for (const f of watchFlags) {
    const r = rowsBy.get(f.clientId);
    if (r) r.watch.push({ id: f.id, title: f.title, severity: f.severity, href: `/watch?tab=${WATCH_GROUP[f.kind] ?? "idle"}&client=${f.slug}` });
    else leftover.push(f);
  }
  const { clientGroup } = await import("@/lib/creative-desk-core");
  const { noBriefsWhy } = await import("@/lib/allotment-over");
  for (const r of rowsBy.values()) {
    r.group = r.pools.length ? clientGroup(r.pools) : "now";
    // Over the allotment with nothing drafted: the card says why (and Create brief anyway stays)
    r.noBriefsWhy = r.ideas.length ? null : noBriefsWhy(r.pools.map((p) => ({ pool: p.pool, cap: p.cap, used: p.requested })));
  }
  // Most urgent first within each group: the gap over the days to reset, then the most briefs waiting
  const urgency = (r: ClientRow) => Math.max(0, ...r.pools.map((p) => (p.missing ? p.missing / Math.max(1, p.daysLeft) : 0) + (p.nothing ? 1 : 0))) + r.ideas.length * 0.05;
  const clientRows = [...rowsBy.values()].sort((a, b) => urgency(b) - urgency(a) || a.client.localeCompare(b.client));
  const briefed = clientRows.filter((r) => r.group === "covered").length;
  const week = gaps?.load ? gaps.load.filter((w) => pools.has(w.pool)).map((w) => ({ pool: w.pool, due: w.due, capacity: w.capacity, line: w.line })) : null;

  const rows = clients.map((c) => ({ ...c, mine: seats.has(c.clientId), risk: creativeRisk(c) })).filter((c) => head || c.mine);
  const { mine, team } = mineFirst(rows);
  const card = (c: (typeof rows)[number]): DeskCardData => {
    const ps = allotmentPools(c.counts).filter((p) => p.cap > 0 || p.used > 0);
    const main = ps[0];
    return {
      key: c.clientId,
      name: c.name,
      brand: brandOf(brands, c.clientId),
      risk: c.risk,
      tone: c.tone === "bad" ? "bad" : c.tone === "warn" ? "warn" : "ok",
      statusLabel: c.tone === "bad" ? "Behind" : c.tone === "warn" ? "Watch" : "On pace",
      big: main ? `${main.used}/${main.cap}` : String(c.waiting),
      bigCaption: main ? main.label.toLowerCase() : "with the client",
      gauge: main && main.cap > 0 ? { fill: main.used / main.cap, mark: c.elapsed ?? monthElapsed } : null,
      detail: [...ps.map((p) => ({ label: p.label, value: `${p.used}/${p.cap}` })), { label: "With client", value: String(c.waiting) }, { label: "Revisions", value: c.revisionsPerItem.toFixed(1) }].slice(0, 3),
      links: [
        { href: `/clients/${c.slug}?service=creative`, label: "Client" },
        { href: `/board?client=${encodeURIComponent(c.slug)}`, label: "Board" },
      ],
    };
  };
  const waiting = clientRows.reduce((n, r) => n + r.ideas.length, 0);
  const urgent = clientRows.filter((r) => r.group === "now").length;
  return {
    tabs: [{ id: "clients", label: head || lead ? "Clients" : "My clients", count: waiting + urgent, tone: urgent ? "bad" : "brand" }],
    panels: {
      clients: (
        <>
          <CreativeClientRows rows={clientRows} week={week} briefed={briefed} canApprove={lead} />
          {!lead && (mine.length > 0 || !head) && <DeskGroup id="mine" title="My clients" aside="Furthest behind first" cards={mine.map(card)} empty="You hold no seat on a creative client yet." />}
          {!lead && team.length > 0 && <DeskGroup id="team" title="Your team's clients" aside="Furthest behind first" cards={team.map(card)} contained />}
        </>
      ),
    },
    today: leftover.length ? <WatchList flags={leftover} /> : null,
  };
}
