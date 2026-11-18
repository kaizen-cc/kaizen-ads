import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { allotmentPools, type PoolCounts } from "@/lib/allotment";
import { STATUS, kpiValue, money, pct } from "@/lib/kpi/format";
import { adsRisk, auditReminders, briefPriority, creativeRisk, mineFirst } from "@/lib/overview-desk";
import { loadAdsDesk, loadBrands, mySeatClients, owedByClient, type AdsDeskRow } from "@/lib/overview-desk-load";
import { etToday } from "@/lib/channel-kpis/calc";
import type { SuggestionsState } from "@/lib/suggestions";
import { DeskGroup, Reminders, brandOf, type DeskCardData } from "./channel-desk";
import { SuggestedBriefs } from "./suggested-briefs";
import { watchTab } from "./watch-panel";

// The Overview's tabs for the ads lines (Meta, Google) and the creative line, the email and social Overview's pattern:
//   Clients           the person's own accounts first, then the rest of their team's in a contained scrolling area,
//                     each worst first (retention risk); compact cards that open for the detail
//   Ideas             suggested briefs, critical first (an account off target, an unhappy client, a promise), the rest folded
//   Audits & sprints  a head: only what's critical or gone stale; a buyer: their own open ones
//   Setup             accounts we can't read yet or with no KPI set
// The exec Overview doesn't use this.

type Me = { id: string; role: string; isExec: boolean; isLead: boolean };
export type DeskTab = { id: string; label: string; count?: number; tone?: "bad" | "warn" | "ok" | "brand" | "quiet" };
export type Desk = { tabs: DeskTab[]; panels: Record<string, React.ReactNode> };

const LOOK_AT = 30;
const TONE_OF: Record<AdsDeskRow["status"], DeskCardData["tone"]> = { off: "bad", close: "warn", good: "ok", excellent: "ok", idle: "quiet", setup: "quiet", unset: "quiet" };

/** An ad account as a card: the KPI against target, what's hurting, the ways in */
function adsCard(r: AdsDeskRow & { risk: ReturnType<typeof adsRisk> }, brand: DeskCardData["brand"]): DeskCardData {
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
      ...(r.platform === "meta" ? [{ href: `/board?client=${encodeURIComponent(r.slug)}`, label: "Board" }] : []),
      { href: `/reports?client=${encodeURIComponent(r.slug)}`, label: "Reports" },
    ],
  };
}

/** Accounts still to set up: no ad account, one we can't read, or no KPI set; each opens its KPI card */
function SetupRows({ rows }: { rows: AdsDeskRow[] }) {
  if (!rows.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Everything is set up</p>
        <p className="text-sm text-muted">Every account is reading and has a KPI.</p>
      </section>
    );
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Needs setup <span className="tabular text-[15px] text-faint">{rows.length}</span>
        </h2>
        <span className="text-xs text-faint">Link the ad account, share access, or set the KPI on its card</span>
      </div>
      <ul className="grid max-h-[min(68vh,700px)] gap-px overflow-y-auto overscroll-contain rounded-[20px] border border-line bg-line">
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
    </section>
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
  const [desk, owed, watch] = await Promise.all([loadAdsDesk(db, me, platform), owedByClient(db, me), watchTab(db, me)]);
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
  const card = (r: (typeof live)[number]) => adsCard(r, brandOf(brands, r.clientId));
  const hurting = (rows: typeof live) => rows.filter((r) => r.risk.score >= LOOK_AT).length;

  const reminders = auditReminders(
    scoped.map((r) => ({ clientId: r.targetId })),
    desk.audits,
    desk.sprints,
    etToday(),
    { head },
  );
  const byTarget = new Map(desk.rows.map((r) => [r.targetId, { name: `${r.name}${r.label ? ` · ${r.label}` : ""}`, brand: brandOf(brands, r.clientId) }]));
  const critical = reminders.filter((r) => r.level === "critical").length;
  const riskOf = new Map<string, number>();
  for (const r of live) riskOf.set(r.clientId, Math.max(riskOf.get(r.clientId) ?? 0, r.risk.score));
  const ideas = platform === "meta" ? ideasPanel(suggestions, riskOf) : null;
  const name = platform === "meta" ? "Meta" : "Google";

  return {
    tabs: [
      { id: "clients", label: head ? "Clients" : "My clients", count: hurting(mine) + (head ? hurting(team) : 0), tone: live.some((r) => r.status === "off") ? "bad" : "warn" },
      ...(ideas ? [{ id: "ideas", label: "Ideas", count: ideas.critical, tone: "bad" as const }] : []),
      { id: "audits", label: "Audits & sprints", count: reminders.length, tone: critical ? "bad" : "warn" },
      { id: "setup", label: "Setup", count: setup.length, tone: "warn" },
      watch.tab,
    ],
    panels: {
      clients: (
        <>
          {(mine.length > 0 || !head) && <DeskGroup id="mine" title={head ? "Your accounts" : "My accounts"} aside="Most at risk of leaving first" cards={mine.map(card)} empty={`You own no ${name} account yet.`} />}
          {team.length > 0 && <DeskGroup id="team" title={head ? "Your team's accounts" : "Other accounts"} aside={`Worst first · ${hurting(team)} need a look`} cards={team.map(card)} contained />}
        </>
      ),
      ...(ideas ? { ideas: ideas.panel } : {}),
      audits: <Reminders items={reminders} line={platform} clients={byTarget} head={head} href={(r) => `/kpis/${r.kind}/${r.id}`} board="the KPI board" />,
      setup: <SetupRows rows={setup} />,
      watch: watch.panel,
    },
  };
}

type CreativeClient = { clientId: string; name: string; slug: string; tone: string; note: string; waiting: number; revisionsPerItem: number; counts: PoolCounts; elapsed?: number };

/** The creative line: each client's allotment against where they should be by now, their own first */
export async function creativeDesk(db: SupabaseClient, me: Me, clients: CreativeClient[], monthElapsed: number, suggestions?: SuggestionsState | null): Promise<Desk> {
  const head = me.isLead || me.isExec;
  const [seats, brands, watch] = await Promise.all([mySeatClients(db, me).catch(() => new Set<string>()), loadBrands(db, clients.map((c) => c.clientId)).catch(() => new Map()), watchTab(db, me)]);
  const rows = clients.map((c) => ({ ...c, mine: seats.has(c.clientId), risk: creativeRisk(c) })).filter((c) => head || c.mine);
  const { mine, team } = mineFirst(rows);
  const card = (c: (typeof rows)[number]): DeskCardData => {
    const pools = allotmentPools(c.counts).filter((p) => p.cap > 0 || p.used > 0);
    const main = pools[0];
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
      detail: [...pools.map((p) => ({ label: p.label, value: `${p.used}/${p.cap}` })), { label: "With client", value: String(c.waiting) }, { label: "Revisions", value: c.revisionsPerItem.toFixed(1) }].slice(0, 3),
      links: [
        { href: `/clients/${c.slug}?service=creative`, label: "Client" },
        { href: `/board?client=${encodeURIComponent(c.slug)}`, label: "Board" },
      ],
    };
  };
  const hurting = (xs: typeof rows) => xs.filter((r) => r.risk.score >= LOOK_AT).length;
  const riskOf = new Map(rows.map((r) => [r.clientId, r.risk.score]));
  const ideas = head ? ideasPanel(suggestions, riskOf) : null;
  return {
    tabs: [
      { id: "clients", label: head ? "Clients" : "My clients", count: hurting(mine) + (head ? hurting(team) : 0), tone: rows.some((r) => r.tone === "bad") ? "bad" : "warn" },
      ...(ideas ? [{ id: "ideas", label: "Ideas", count: ideas.critical, tone: "bad" as const }] : []),
      watch.tab,
    ],
    panels: {
      watch: watch.panel,
      clients: (
        <>
          {(mine.length > 0 || !head) && <DeskGroup id="mine" title={head ? "Your clients" : "My clients"} aside="Furthest behind first" cards={mine.map(card)} empty="You hold no seat on a creative client yet." />}
          {team.length > 0 && <DeskGroup id="team" title="Your team's clients" aside={`Furthest behind first · ${hurting(team)} need a look`} cards={team.map(card)} contained />}
        </>
      ),
      ...(ideas ? { ideas: ideas.panel } : {}),
    },
  };
}
