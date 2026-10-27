import Link from "next/link";
import type { CreativeDb } from "@/lib/creative-db";
import { ActionButton, ActionForm } from "@/components/action-form";
import { Section, field, label } from "@/components/ui";
import type { Digest } from "@/lib/ai";
import { SLOTS } from "@/lib/roles";
import { AssignSelect, type Option } from "../assign-select";
import type { Freshness } from "@/lib/dates";
import { BriefingPanel } from "./briefing-panel";
import { ConnectionStatus } from "./connection-status";
import { setPortalLive,
  syncMetaNow,
  addAngle,
  addContact,
  addMemory,
  archiveMemory,
  endCreativePackage,
  refreshClientBriefing,
  removeContact,
  saveAllotment,
  saveClientDetails,
  setAngleStatus,
  setSprintPackage,
} from "./actions";
import { PackagePanel, type PackageOption } from "./package-panel";
import { ReadinessCheck } from "./readiness-check";
import { LaunchRules, type LaunchRule } from "./launch-rules";
import { ServicesPanel, type Tier } from "./services-panel";
import type { Readiness } from "@/lib/readiness";
import { CreativePanel } from "./creative-panel";
import { KpiPanel } from "./kpi-panel";
import { ClientChat, type AuditTarget } from "./client-chat";
import type { AuditSummary } from "../../kpis/audit-panel";
import type { ChatTurn } from "@/lib/handoff";
import type { AccountChange } from "@/lib/account-changes";
import { ShotListPanel, type AssetGlance, type SavedShotList } from "./shot-list-panel";
import { ClientSections } from "./client-sections";
import { BusinessOverview, type ServiceCard } from "./business-overview";
import { CampaignsPanel } from "./campaigns-panel";
import { DocsPanel } from "./docs-panel";
import { ReportsHistory, type HistoryReport } from "./reports-history";
import { PlaybookPanel } from "./playbook-panel";
import type { LedgerItem } from "@/lib/ledger";
import type { ClientDoc } from "@/lib/client-docs";
import type { PlatformSummary } from "@/lib/client-campaigns";
import { SERVICES, servicesOf } from "@/lib/services";
import type { Status } from "@/lib/kpi/calc";
import { STATUS } from "@/lib/kpi/format";
import { Glance, type Alert } from "./glance";
import type { SprintSummary } from "@/lib/sprints";
import { ArchiveControl } from "./archive-control";
import { IntakePanel, type IntakeRecord } from "./intake-panel";
import { CallsPanel, type ClientCall } from "./calls-panel";
import { FatigueWatch } from "@/components/fatigue-watch";
import type { MarketAd } from "@/lib/market";
import { MarketPanel } from "./market-panel";
import type { WatchRow } from "@/lib/fatigue";
import type { ClientKpi } from "@/lib/kpi/client";
import { IndustryChip } from "./industry-chip";
import { INDUSTRY_OPTIONS, industryLabel } from "@/lib/industries";
import type { ClientCreative } from "@/lib/client-creative";
import { BrandBiblePanel, type BrandBible } from "./brand-bible-panel";
import { GtmPanel, type GtmStrategy } from "./gtm-panel";
import { untilLabel } from "@/lib/allotment";
import { isLive } from "@/lib/live";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const chip = "inline-flex items-center rounded-full px-2.5 py-1 text-xs";
const row = "flex items-start justify-between gap-3 rounded-[8px] bg-surface-2/70 px-4 py-3 text-sm";

const RANK: Record<Status, number> = { off: 0, close: 1, setup: 2, idle: 3, good: 4, excellent: 5 };
const worstOf = (ks: ClientKpi[]) => [...ks].sort((a, b) => RANK[a.status] - RANK[b.status])[0] ?? null;
/** A service's dot on the switch: its worst account */
const toneOf = (ks: ClientKpi[]): "bad" | "warn" | "ok" | null => {
  const w = worstOf(ks);
  return !w ? null : w.status === "off" ? "bad" : w.status === "close" ? "warn" : w.status === "good" || w.status === "excellent" ? "ok" : null;
};
const noteOf = (ks: ClientKpi[]) => {
  const w = worstOf(ks);
  return w ? STATUS[w.status].label : "No KPI target";
};
/** Google campaigns held back by budget or rank (more than a quarter of their impressions lost) */
const googleLosing = (p: PlatformSummary | null) =>
  (p?.campaigns ?? [])
    .filter((c) => c.spend > 0 && ((c.share?.lostBudget ?? 0) > 0.25 || (c.share?.lostRank ?? 0) > 0.25))
    .slice(0, 2)
    .map((c) => `${c.name.length > 40 ? `${c.name.slice(0, 40)}…` : c.name}: losing ${Math.round(Math.max(c.share!.lostBudget ?? 0, c.share!.lostRank ?? 0) * 100)}% of its impressions to ${(c.share!.lostBudget ?? 0) >= (c.share!.lostRank ?? 0) ? "budget" : "rank"}`);

const MEMORY_SOURCE: Record<string, string> = { client: "Client said", team: "Team", review: "From review", copy: "From copy", lab: "Ads Lab", audit: "Account audit", sprint: "Optimization sprint", network: "From a similar account", call: "From a call" };

export type ClientViewProps = {
  client: {
    id: string;
    archived_at?: string | null;
    archive_reason?: string | null;
    archive_source?: string | null;
    name: string;
    slug: string;
    status: string;
    client_type: string;
    portal_live?: boolean;
    industry?: string | null;
    industry_detail?: string | null;
    industry_source?: "ai" | "team" | null;
    portal_live_at?: string | null;
    website: string | null;
    meta_ad_account_id: string | null;
    url_tags?: string | null;
    slack_channel_id: string | null;
    internal_slack_channel_id: string | null;
    drive_folder_id: string | null;
    kaizen_id: number | null;
    auto_approve_opt_in: boolean;
    creative_package: boolean;
    creative_package_key?: string | null;
    creative_package_until?: string | null;
    creative_package_note?: string | null;
};
  packages: PackageOption[];
  brandBible?: BrandBible | null;
  gtm?: GtmStrategy | null; // the Meta go-to-market strategy
  today: string; // YYYY-MM-DD in New York
  packageLabel: string | null;
  team: Record<string, { current: Option | null; options: Option[] }>;
  contacts: { id: string; email: string; full_name: string | null; auth_user_id: string | null }[];
  angles: { id: string; name: string; kind: string; description: string | null; status: string }[];
  memory: { id: string; kind: string; body: string; source: string; shareReason?: string | null; by: string | null; dated?: string | null }[];
  digest: Digest | null;
  briefingAt: string | null;
  needsInvite: string[];
  images: number;
  videos: number;
  imagesUsed: number;
  videosUsed: number;
  fromAsana?: { images: number; videos: number; waitingImages?: number; waitingVideos?: number };
  creativeDb?: CreativeDb | null;
  can: { admin: boolean; contacts: boolean; allot: boolean; assign: boolean };
  demo?: boolean; // design preview: the refresh only plays its animation
  connections: { meta: Freshness | null; slackClient: Freshness | null; slackInternal: Freshness | null; drive: Freshness | null };
  creative?: ClientCreative | null; // tickets in motion and launched, live and paused ads
  kpis?: ClientKpi[] | null; // performance vs target; null in the design preview
  audits?: Record<string, AuditSummary> | null; // the latest audit per KPI, shared with the KPI board
  changes?: Record<string, AccountChange[]> | null; // each KPI's ad account, its last 30 changes
  sprints?: Record<string, SprintSummary> | null; // the optimization sprint on each account
  reportable?: string[] | null; // the accounts this person can draft reports for (their own; their line's for a lead)
  assets?: AssetGlance | null; // what's on their Drive
  shotList?: SavedShotList | null; // next month's shot list
  chat?: { initial: ChatTurn[]; targets: AuditTarget[] } | null; // my thread with the AI about this client
  fatigue?: WatchRow[] | null; // ads wearing out
  market?: MarketAd[]; // live in this client's market (Motion)
  intake?: IntakeRecord | null; // the marketing intake form; undefined in the design preview
  calls?: ClientCall[]; // from Gemini and Fireflies notes; undefined in the design preview
  readiness?: { initial: Readiness; autoOpen: boolean; stamp: string } | null; // what's missing after going live again
  services?: { track: string[]; extra: string[]; tiers: Tier[]; chosen: Record<string, string> } | null; // what they buy, and the tiers
  launchRules?: LaunchRule[]; // where their new ads go, learned from their buyers' moves
  campaigns?: PlatformSummary[] | null; // each platform's campaigns, last 30 days
  docs?: ClientDoc[] | null; // every file and link shared about them
  reports?: HistoryReport[] | null; // every report made for them
  playbook?: { items: LedgerItem[]; learnings: { at: string; kind: string; text: string }[] } | null; // everything they've run, and what it taught
};

/** The client page itself, given its data (the page loads it; the design preview passes samples). */
export function ClientView({ client, packageLabel, packages, brandBible = null, gtm = null, today, team, contacts, angles, memory, digest, briefingAt, needsInvite, images, videos, imagesUsed, videosUsed, fromAsana, creativeDb = null, can, demo = false, connections, creative = null, kpis = null, audits = null, changes = null, sprints = null, reportable = null, assets = null, shotList = null, chat = null, fatigue = null, market = [], intake, calls, readiness = null, services = null, launchRules = [], campaigns = null, docs = null, reports = null, playbook = null }: ClientViewProps) {
  // A sprint whose end date passed is off, even before the nightly job switches it off
  const until = client.creative_package_until ?? null;
  const active = client.creative_package && (!until || until >= today);
  // Archived or paused: read-only. Nothing is pulled or generated until they're live again
  const live = isLive(client);

  // The glance: what's in motion, and what needs someone (each a link to where it's handled)
  const tab = (t: string) => `/clients/${client.slug}?tab=${t}`;
  const openPromises = (calls ?? []).flatMap((c) => c.commitments).filter((x) => x.status === "open");
  const tired = (fatigue ?? []).filter((f) => f.severity === "tired").length;
  const alerts: Alert[] = [
    ...(kpis ?? []).filter((k) => k.status === "off").map((k): Alert => ({ tone: "bad", text: `${k.platform === "google" ? "Google" : "Meta"} · ${k.label ?? k.conversionLabel} is off target${k.deviation != null ? ` (${Math.round(Math.abs(k.deviation) * 100)}% off)` : ""}`, href: `/kpis?target=${k.id}` })),
    ...(openPromises.length ? [{ tone: "bad" as const, text: `${openPromises.length} promise${openPromises.length === 1 ? "" : "s"} from calls not started`, href: tab("knowledge") }] : []),
    ...(tired ? [{ tone: "warn" as const, text: `${tired} ad${tired === 1 ? "" : "s"} worn out and ready for a refresh`, href: `/clients/${client.slug}?service=meta&tab=ads` }] : []),
    ...(active && images + videos > 0 && imagesUsed + videosUsed === 0 ? [{ tone: "warn" as const, text: "Nothing made against this month's creative allotment yet", href: `/clients/${client.slug}?service=creative` }] : []),
    ...(assets?.stale && active ? [{ tone: "info" as const, text: "No new footage on Drive in 45 days: time for a shot list", href: `/clients/${client.slug}?service=creative&tab=package` }] : []),
    ...(!(kpis ?? []).length ? [{ tone: "warn" as const, text: "No KPI target set", href: "/kpis" }] : []),
    ...(!contacts.length ? [{ tone: "warn" as const, text: "No client contact: nobody can approve ads", href: tab("team") }] : []),
    ...(!client.slack_channel_id ? [{ tone: "info" as const, text: "No client Slack channel linked", href: tab("team") }] : []),
  ];
  const needsSetup = [!contacts.length, !client.slack_channel_id, !client.drive_folder_id].filter(Boolean).length;
  const sprintMoves = Object.values(sprints ?? {}).reduce((n, s) => n + Math.max(0, s.total - s.done), 0);
  const inMotion = [
    { label: "creative in production", value: creative?.moving.length ?? 0, href: `/clients/${client.slug}?service=creative` },
    { label: "Meta ads live now", value: creative?.live.length ?? 0, href: `/clients/${client.slug}?service=creative` },
    { label: "sprint moves open", value: sprintMoves, href: "/kpis" },
    { label: "creatives this month", value: imagesUsed + videosUsed, href: `/clients/${client.slug}?service=creative&tab=package` },
  ].filter((m) => m.value > 0);
  const summary = digest?.summary ? digest.summary.split(/(?<=\.)\s+/).slice(0, 2).join(" ") : null;
  const glance = kpis || creative ? <Glance accounts={false} kpis={kpis ?? []} audits={audits ?? {}} sprints={sprints ?? {}} changes={changes ?? {}} alerts={alerts} inMotion={inMotion} summary={summary} today={today} /> : null;
  // Which services this client has: what they buy, or what's set up for them (Track's list is often empty)
  const bought = servicesOf({ services: services?.track ?? [], services_extra: services?.extra ?? [] });
  const metaKpis = (kpis ?? []).filter((k) => k.platform === "meta");
  const googleKpis = (kpis ?? []).filter((k) => k.platform === "google");
  const metaCampaigns = (campaigns ?? []).find((c) => c.platform === "meta") ?? null;
  const googleCampaigns = (campaigns ?? []).find((c) => c.platform === "google") ?? null;
  const has = {
    meta: bought.includes("facebook-ads") || Boolean(client.meta_ad_account_id) || metaKpis.length > 0,
    google: bought.includes("google-ads") || googleKpis.length > 0 || Boolean(googleCampaigns),
    creative: bought.includes("creative") || client.creative_package || images + videos > 0 || Boolean(creative?.moving.length),
  };
  const tierOf = (slug: string) => {
    const id = services?.chosen[slug];
    return id ? (services?.tiers.find((t) => t.id === id)?.label ?? null) : null;
  };
  const cards: ServiceCard[] = [
    ...(has.meta ? [{ id: "meta" as const, kind: "ads" as const, label: "Meta Ads", kpis: metaKpis, summary: metaCampaigns, extra: [creative?.live.length ? `${creative.live.length} ads live` : "", tired ? `${tired} worn out, ready for a refresh` : ""].filter(Boolean) }] : []),
    ...(has.google ? [{ id: "google" as const, kind: "ads" as const, label: "Google Ads", kpis: googleKpis, summary: googleCampaigns, extra: googleLosing(googleCampaigns) }] : []),
    ...(has.creative
      ? [{ id: "creative" as const, kind: "creative" as const, label: "Creative", package: active ? (packageLabel ?? "Creative package") : null, used: imagesUsed + videosUsed, allotted: images + videos, moving: creative?.moving.filter((r) => !["client_review", "ready_for_launch"].includes(r.stage)).length ?? 0, waiting: creative?.moving.filter((r) => r.stage === "client_review").length ?? 0, live: creative?.live.length ?? 0 }]
      : []),
    ...bought.filter((b) => !["facebook-ads", "google-ads", "creative"].includes(b)).map((b) => ({ id: b, kind: "other" as const, label: SERVICES.find((x) => x.slug === b)?.label ?? b, tier: tierOf(b) })),
  ];
  const creativeTone: "warn" | null = active && images + videos > 0 && imagesUsed + videosUsed === 0 ? "warn" : null;

  const reportAccounts = (kpis ?? []).filter((k) => k.accountId && (!reportable || reportable.includes(k.id))).map((k) => ({ id: k.id, label: `${k.platform === "google" ? "Google" : "Meta"}${k.label ? ` · ${k.label}` : ""}` }));

  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      {chat && !demo && <ClientChat clientId={client.id} client={client.name} initial={chat.initial} targets={chat.targets} live={live} />}
      {/* Header */}
      <header className="grid gap-3">
        <Link href="/clients" className="inline-flex min-h-11 w-fit items-center text-xs text-muted hover:text-fg md:min-h-0">
          ← Clients
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 font-heading text-[28px] leading-tight [overflow-wrap:anywhere] md:text-[32px]">{client.name}</h1>
          <span className="flex flex-wrap items-center gap-2">
            {/* Reports are built on the Reports page (dates, services, one report for the client) */}
            {!demo && live && reportAccounts.length > 0 && (
              <Link href={`/reports?client=${client.slug}`} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm text-muted hover:border-faint hover:text-fg max-md:h-11">
                Build a report
              </Link>
            )}
            {can.assign && !demo && !client.archived_at && <ArchiveControl clientId={client.id} slug={client.slug} name={client.name} archived={null} />}
          </span>
        </div>
        {readiness && live && !demo && <ReadinessCheck clientId={client.id} slug={client.slug} name={client.name} initial={readiness.initial} team={team} autoOpen={readiness.autoOpen} stamp={readiness.stamp} />}
        {!client.archived_at && !live && (
          <p className="rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-sm">
            This client is paused, so their page is read-only: nothing is synced, pulled or generated for them. Set their status back to active in Details to switch it all back on.
          </p>
        )}
        {client.archived_at && (
          can.assign && !demo ? (
            <ArchiveControl clientId={client.id} slug={client.slug} name={client.name} archived={{ at: client.archived_at, reason: client.archive_reason ?? null, source: client.archive_source ?? null }} />
          ) : (
            <p className="rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-sm">This client is archived. Everything is kept; an exec or lead can restore it.</p>
          )
        )}
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <span className={`${chip} bg-brand-soft text-brand-text`}>{packageLabel ? `${packageLabel} creative package` : "Creative package"}</span>
          ) : (
            <span className={`${chip} gap-1.5 border border-dashed border-line text-faint`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              Not on a creative package
            </span>
          )}
          {active && until && <span className={`${chip} bg-warn-soft text-warn`}>Sprint until {untilLabel(until)}</span>}
          <IndustryChip clientId={client.id} slug={client.slug} industry={client.industry ?? null} detail={client.industry_detail ?? null} source={client.industry_source ?? null} options={INDUSTRY_OPTIONS} canEdit={can.assign} />
          <span className={`${chip} bg-surface-2 capitalize text-muted`}>{client.status}</span>
          {client.client_type === "whitelabel" && <span className={`${chip} bg-surface-2 text-muted`}>White label</span>}
          {client.auto_approve_opt_in && <span className={`${chip} bg-ok-soft text-ok`}>Opted into auto-approval</span>}
          {client.kaizen_id && <span className={`${chip} tabular bg-surface-2 text-faint`}>ID {client.kaizen_id}</span>}
          <span className="ml-1 min-w-0 text-xs text-faint [overflow-wrap:anywhere]">
            Portal <span className="text-muted">ads.kaizenmarketing.agency/c/{client.slug}</span>
          </span>
        </div>
      </header>

      <ClientSections
        sections={[
          {
            id: "business",
            label: "Whole business",
            note: `${cards.length} service${cards.length === 1 ? "" : "s"}`,
            tabs: [
              {
                id: "overview",
                label: "Overview",
                hint: "Every service side by side, what needs someone and what's in motion",
                content: (
                  <div className="grid gap-6">
                    {glance}
                    <BusinessOverview cards={cards} audits={audits ?? {}} sprints={sprints ?? {}} />
                  </div>
                ),
              },
              ...(playbook
                ? [
                    {
                      id: "playbook",
                      label: "Playbook",
                      count: playbook.items.filter((i) => i.verdict === "winner").length || null,
                      hint: "Every creative, message angle and audience they've run, with what won and what didn't, kept forever",
                      content: <PlaybookPanel items={playbook.items} learnings={playbook.learnings} />,
                    },
                  ]
                : []),
              ...(reports
                ? [
                    {
                      id: "reports",
                      label: "Reports",
                      count: reports.length || null,
                      hint: "Every report made for them: weekly, monthly and built, with what each said and its PDF",
                      content: <ReportsHistory reports={reports} slug={client.slug} />,
                    },
                  ]
                : []),
              ...(docs
                ? [
                    {
                      id: "documents",
                      label: "Documents",
                      count: docs.length || null,
                      hint: "Every file and link shared about them, read and summarized",
                      content: <DocsPanel clientId={client.id} slug={client.slug} docs={docs} live={live && !demo} />,
                    },
                  ]
                : []),
              {
                id: "knowledge",
                label: "Knowledge",
                hint: "What the AI knows: the briefing, memory, Brand Bible, intake and calls",
                content: (
              <div className="grid gap-6">
                {active && (
            <BriefingPanel
              demo={demo}
              refresh={live ? refreshClientBriefing.bind(null, client.id, client.slug) : undefined}
              description={
                <>
                  What the AI knows from Slack, email, Drive, Meta and past requests. Refreshes at 12pm and 6pm ET.
                  {briefingAt && <span className="text-faint"> Updated {fmt(briefingAt)}.</span>}
                </>
              }
            >
              {needsInvite.length > 0 && (
                <p className="rounded-[8px] border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
                  The Slack bot can&apos;t read {needsInvite.join(" and ")} yet. It&apos;s private, so someone in it needs to type /invite and the bot&apos;s name.
                </p>
              )}
              {digest ? (
                <div className="grid gap-6 text-sm">
                  <div className="grid gap-3">
                    <p className="text-[15px] leading-relaxed">{digest.summary}</p>
                    {digest.direction && (
                      <p className="rounded-[8px] border-l-2 border-brand bg-brand-soft/30 px-4 py-3 leading-relaxed text-muted">
                        <span className="mb-1 block text-xs font-medium text-fg">Direction</span>
                        {digest.direction}
                      </p>
                    )}
                    {digest.performance && (
                      <p className="rounded-[8px] border-l-2 border-ok bg-ok-soft/30 px-4 py-3 leading-relaxed text-muted">
                        <span className="mb-1 block text-xs font-medium text-fg">Ad performance · Meta</span>
                        {digest.performance}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-x-10 gap-y-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    {(
                      [
                        ["Asks", digest.asks, "bg-fg"],
                        ["Avoid", digest.avoid, "bg-bad"],
                        ["Works", digest.works, "bg-ok"],
                        ["Open questions", digest.openQuestions, "bg-warn"],
                      ] as const
                    )
                      .filter(([, items]) => items.length > 0)
                      .map(([title, items, dot]) => (
                        <div key={title} className="grid min-w-0 content-start gap-3">
                          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-faint">
                            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                            {title}
                          </p>
                          <ul className="grid gap-2.5 leading-relaxed text-muted">
                            {items.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                  </div>
                  {digest.newAssets.length > 0 && (
                    <div className="grid gap-2.5 border-t border-line pt-5">
                      <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">New Drive assets not used yet</p>
                      <ul className="grid gap-2">
                        {digest.newAssets.map((a) => (
                          <li key={a.url || a.name} className="leading-relaxed text-muted">
                            {a.url ? (
                              <a href={a.url} target="_blank" rel="noreferrer" className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg">
                                {a.name}
                              </a>
                            ) : (
                              <span className="text-fg">{a.name}</span>
                            )}
                            {a.note && <span className="text-faint"> · {a.note}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-faint">No briefing yet. It&apos;s made at the next 12pm or 6pm run, or now with Refresh now.</p>
              )}
            </BriefingPanel>
          )}
                <Section title="Client memory" description="What we've learned about this client. The AI reads it for suggestions and flags anything that goes against it before a request is sent.">
            {memory.length > 0 ? (
              <div className="grid gap-3">
                <ul className="grid gap-2">
                  {memory.filter((m) => !m.dated).map((m) => (
                    <li key={m.id} className={row}>
                      <span className="flex min-w-0 items-start gap-3">
                        <span
                          className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            m.kind === "avoid" ? "bg-bad-soft text-bad" : m.kind === "prefer" ? "bg-ok-soft text-ok" : "bg-bg text-muted"
                          }`}
                        >
                          {m.kind === "avoid" ? "Avoid" : m.kind === "prefer" ? "Works" : "Note"}
                        </span>
                        <span className="grid min-w-0 gap-0.5">
                          <span className="leading-relaxed">{m.body}</span>
                          <span className="text-xs text-faint">
                            {m.dated ? `As of ${new Date(`${m.dated}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ` : ""}
                            {MEMORY_SOURCE[m.source] ?? "Team"}
                            {m.source === "network" && m.shareReason ? ` · why it applies here: ${m.shareReason}` : m.by ? ` · ${m.by}` : ""}
                          </span>
                        </span>
                      </span>
                      <ActionButton action={archiveMemory.bind(null, client.slug, m.id)} label="Remove" confirmText="Remove this?" />
                    </li>
                  ))}
                </ul>
                {memory.some((m) => m.dated) && (
                  <details className="group rounded-[12px] border border-line">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
                      <span>
                        Background <span className="text-faint">· {memory.filter((m) => m.dated).length} notes true as of their date: past results, events, promotions</span>
                      </span>
                      <span className="text-faint transition-transform group-open:rotate-90">›</span>
                    </summary>
                    <ul className="grid gap-2 px-3 pb-3">
                      {memory.filter((m) => m.dated).map((m) => (
                        <li key={m.id} className={row}>
                          <span className="flex min-w-0 items-start gap-3">
                            <span
                              className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                m.kind === "avoid" ? "bg-bad-soft text-bad" : m.kind === "prefer" ? "bg-ok-soft text-ok" : "bg-bg text-muted"
                              }`}
                            >
                              {m.kind === "avoid" ? "Avoid" : m.kind === "prefer" ? "Works" : "Note"}
                            </span>
                            <span className="grid min-w-0 gap-0.5">
                              <span className="leading-relaxed">{m.body}</span>
                              <span className="text-xs text-faint">
                                {m.dated ? `As of ${new Date(`${m.dated}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ` : ""}
                                {MEMORY_SOURCE[m.source] ?? "Team"}
                                {m.source === "network" && m.shareReason ? ` · why it applies here: ${m.shareReason}` : m.by ? ` · ${m.by}` : ""}
                              </span>
                            </span>
                          </span>
                          <ActionButton action={archiveMemory.bind(null, client.slug, m.id)} label="Remove" confirmText="Remove this?" />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-faint">Nothing yet. Add what the client loves, hates, or asked us never to do again.</p>
            )}
            <ActionForm action={addMemory.bind(null, client.id, client.slug)} submitLabel="Add to memory" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
              <div className="grid gap-3 sm:grid-cols-[150px_150px_minmax(0,1fr)]">
                <label className={label}>
                  Type
                  <select name="kind" className={field} defaultValue="avoid">
                    <option value="avoid">Avoid</option>
                    <option value="prefer">Works well</option>
                    <option value="note">Note</option>
                  </select>
                </label>
                <label className={label}>
                  From
                  <select name="source" className={field} defaultValue="client">
                    <option value="client">Client said</option>
                    <option value="team">Team</option>
                  </select>
                </label>
                <label className={label}>
                  What should the AI know?
                  <input name="body" required maxLength={1000} className={field} placeholder="e.g. Don't mention delivery, pickup only until December" />
                </label>
              </div>
            </ActionForm>
          </Section>
                <BrandBiblePanel clientId={client.id} slug={client.slug} bible={brandBible} canBuild={can.assign && live} />
                {!demo && !has.meta && <GtmPanel clientId={client.id} slug={client.slug} gtm={gtm} canReview={can.assign} readOnly={!live} />}
                {intake !== undefined && <IntakePanel intake={intake} />}
                {calls && <CallsPanel calls={calls} />}
              </div>),
              },
              {
                id: "team",
                label: "Team & setup",
                hint: "What they buy, the team, client contacts, the portal, connections",
                count: needsSetup || null,
                content: (
              <div className="grid items-start gap-6 lg:grid-cols-2">
                <div className="grid min-w-0 gap-6">
                  {services && (
                    <Section title="Services" description="What they buy from Kaizen and at which tier. Kaizen Track's services come in on their own.">
                      <ServicesPanel
                        clientId={client.id}
                        slug={client.slug}
                        track={services.track}
                        extra={services.extra}
                        tiers={services.tiers}
                        chosen={services.chosen}
                        creative={{ label: active ? packageLabel : null, active, until: active && until ? untilLabel(until) : null }}
                        canEdit={can.assign && !demo}
                      />
                    </Section>
                  )}
                  <Section title="Kaizen team" description="The copywriter reviews all copy and customer success handles every client.">
            <dl className="grid gap-1">
              {SLOTS.map((slot) => (
                <div key={slot.value} className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
                  <dt className="text-sm text-muted">{slot.label}</dt>
                  <dd className="min-w-0">
                    <AssignSelect clientId={client.id} slot={slot.value} label={slot.label} current={team[slot.value]?.current ?? null} options={team[slot.value]?.options ?? []} canEdit={can.assign} size="md" />
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
                  <Section title="Client contacts" description="They get a magic link and can approve. The first approval counts.">
            {contacts.length > 0 ? (
              <ul className="grid gap-2">
                {contacts.map((c) => (
                  <li key={c.id} className={row}>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{c.full_name ?? c.email}</span>
                      <span className="truncate text-xs text-faint">
                        {c.full_name ? `${c.email} · ` : ""}
                        {c.auth_user_id ? "Signed in" : "Not signed in yet"}
                      </span>
                    </span>
                    {can.contacts && <ActionButton action={removeContact.bind(null, client.id, client.slug, c.id)} label="Remove" confirmText="Remove?" />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">No contacts yet.</p>
            )}
            {can.contacts && (
              <ActionForm action={addContact.bind(null, client.id, client.slug)} submitLabel="Add contact" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
                <div className="grid gap-3">
                  <label className={label}>
                    Email
                    <input name="email" type="email" required className={field} placeholder="name@brand.com" />
                  </label>
                  <label className={label}>
                    <span>
                      Name <span className="font-normal text-faint">(optional)</span>
                    </span>
                    <input name="name" className={field} />
                  </label>
                </div>
              </ActionForm>
            )}
          </Section>
                </div>
                <div className="grid min-w-0 gap-6">
                  <Section title="Client portal" description="Where the client swipes through their ads to approve or ask for changes.">
            <div className={`${row} max-md:flex-wrap`}>
              <span className="grid min-w-0 gap-0.5">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${client.portal_live ? "bg-ok" : "bg-faint"}`} />
                  {client.portal_live ? "Live" : "Off"}
                </span>
                <span className="text-xs text-faint">
                  {client.portal_live
                    ? `Contacts can sign in and get notified${client.portal_live_at ? ` · live since ${new Date(client.portal_live_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}.`
                    : "Contacts can't sign in or see anything, and nothing is sent to them. The team can test it from the preview."}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <a href={`/c/${client.slug}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-1 text-xs text-muted hover:border-faint hover:text-fg md:min-h-0 md:px-3">
                  Preview ↗
                </a>
                {can.admin &&
                  (client.portal_live ? (
                    <ActionButton action={setPortalLive.bind(null, client.id, client.slug, false)} label="Turn off" confirmText="Turn the portal off? Contacts lose access." />
                  ) : (
                    <ActionButton action={setPortalLive.bind(null, client.id, client.slug, true)} label="Go live" confirmText={`Go live with ${client.name}? Their contacts can sign in and see their ads.`} />
                  ))}
              </span>
            </div>
            {contacts.length === 0 && <p className="rounded-[8px] bg-warn-soft/50 px-3 py-2 text-xs text-warn">Needs a contact: add who approves ads before going live.</p>}
          </Section>
                  <Section title="Details">
            {can.admin ? (
              <ActionForm action={saveClientDetails.bind(null, client.id, client.slug)} submitLabel="Save details" autosave className="grid gap-5">
                <div className="grid grid-cols-2 gap-3">
                  <label className={label}>
                    Status
                    <select name="status" defaultValue={client.status} className={field}>
                      <option value="onboarding">Onboarding</option>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="offboarded">Offboarded</option>
                    </select>
                  </label>
                  <label className={label}>
                    Type
                    <select name="client_type" defaultValue={client.client_type} className={field}>
                      <option value="traditional">Traditional</option>
                      <option value="whitelabel">White label</option>
                    </select>
                  </label>
                </div>
                <div className="grid gap-3 border-t border-line pt-5">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Connections</p>
                  <label className={label}>
                    Meta ad account ID
                    <span className="relative block">
                      <input name="meta_ad_account_id" defaultValue={client.meta_ad_account_id ?? ""} className={`${field} tabular pr-20`} placeholder="From Ads Manager, e.g. 6615…" />
                      {connections.meta?.tone === "ok" && (
                        <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[11px] font-medium text-ok">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
                          </span>
                          Live
                        </span>
                      )}
                    </span>
                    <ConnectionStatus status={connections.meta} sync={live ? syncMetaNow.bind(null, client.id, client.slug) : undefined} demo={demo} />
                  </label>
                  <label className={label}>
                    <span>
                      UTM parameters <span className="font-normal text-faint">(only if this client uses their own)</span>
                    </span>
                    <input name="url_tags" defaultValue={client.url_tags ?? ""} className={`${field} font-mono text-[12.5px]`} placeholder="Empty: Kaizen's template from Settings" />
                  </label>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className={label}>
                      Client Slack channel
                      <input name="slack_channel_id" defaultValue={client.slack_channel_id ?? ""} className={field} placeholder="Linked automatically" />
                      <ConnectionStatus status={connections.slackClient} />
                    </label>
                    <label className={label}>
                      Internal Slack channel
                      <input name="internal_slack_channel_id" defaultValue={client.internal_slack_channel_id ?? ""} className={field} placeholder="Linked automatically" />
                      <ConnectionStatus status={connections.slackInternal} />
                    </label>
                  </div>
                  <label className={label}>
                    <span>
                      Drive folder <span className="font-normal text-faint">(ID or link)</span>
                    </span>
                    <input name="drive_folder_id" defaultValue={client.drive_folder_id ?? ""} className={field} placeholder="Linked automatically" />
                    <ConnectionStatus status={connections.drive} />
                  </label>
                  <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
                    <label className={label}>
                      Website
                      <input name="website" defaultValue={client.website ?? ""} className={field} placeholder="https://" />
                    </label>
                    <label className={label}>
                      Client ID
                      <input name="kaizen_id" defaultValue={client.kaizen_id ?? ""} className={`${field} tabular`} inputMode="numeric" />
                    </label>
                  </div>
                </div>
              </ActionForm>
            ) : (
              <dl className="grid gap-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Status</dt>
                  <dd className="capitalize">{client.status}</dd>
                </div>
                {(
                  [
                    ["Meta ad account", connections.meta, true],
                    ["Client Slack", connections.slackClient, false],
                    ["Internal Slack", connections.slackInternal, false],
                    ["Drive folder", connections.drive, false],
                  ] as const
                ).map(([k, st, canSync]) => (
                  <div key={k} className="grid gap-1">
                    <dt className="text-muted">{k}</dt>
                    <dd>{st ? <ConnectionStatus status={st} sync={canSync && live ? syncMetaNow.bind(null, client.id, client.slug) : undefined} demo={demo} /> : <span className="text-faint">Not linked</span>}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
                </div>
              </div>),
              },
            ],
          },
          ...(has.meta
            ? [
                {
                  id: "meta",
                  label: "Meta Ads",
                  tone: toneOf(metaKpis),
                  note: noteOf(metaKpis),
                  tabs: [
                    {
                      id: "performance",
                      label: "Performance",
                      hint: "Against target, audits and sprints, change history, campaigns",
                      content: (
                        <div className="grid gap-6">
                          {kpis && <KpiPanel kpis={metaKpis} audits={audits} changes={changes} />}
                          {metaCampaigns && <CampaignsPanel p={metaCampaigns} />}
                        </div>
                      ),
                    },
                    {
                      id: "ads",
                      label: "Ads",
                      count: tired || null,
                      hint: "Ads wearing out and ready for a refresh",
                      content: (
                        <div className="grid gap-6">
                          {live && fatigue && fatigue.length > 0 ? <FatigueWatch rows={fatigue} showClient={false} /> : <p className="text-sm text-faint">No ads wearing out right now.</p>}
                        </div>
                      ),
                    },
                    {
                      id: "strategy",
                      label: "Strategy",
                      hint: "The Meta go-to-market strategy, and where new ads go",
                      content: (
                        <div className="grid gap-6">
                          {!demo && <GtmPanel clientId={client.id} slug={client.slug} gtm={gtm} canReview={can.assign} readOnly={!live} />}
                          {launchRules.length > 0 && (
                            <Section title="Where new ads go" description="Learned from the buyers moving ads the launcher placed. The launcher follows these first for this client.">
                              <LaunchRules rules={launchRules} slug={client.slug} canEdit={!demo} />
                            </Section>
                          )}
                        </div>
                      ),
                    },
                  ],
                },
              ]
            : []),
          ...(has.google
            ? [
                {
                  id: "google",
                  label: "Google Ads",
                  tone: toneOf(googleKpis),
                  note: noteOf(googleKpis),
                  tabs: [
                    {
                      id: "performance",
                      label: "Performance",
                      hint: "Against target, audits and sprints, change history",
                      content: <div className="grid gap-6">{kpis && googleKpis.length > 0 ? <KpiPanel kpis={googleKpis} audits={audits} changes={changes} /> : <p className="text-sm text-faint">No Google KPI target yet. Set one on the KPI board and every audit and report starts from it.</p>}</div>,
                    },
                    {
                      id: "campaigns",
                      label: "Campaigns",
                      hint: "Every campaign: spend, results, cost and impression share",
                      content: googleCampaigns ? <CampaignsPanel p={googleCampaigns} /> : <p className="text-sm text-faint">No Google campaign data yet.</p>,
                    },
                  ],
                },
              ]
            : []),
          ...(has.creative
            ? [
                {
                  id: "creative",
                  label: "Creative",
                  tone: creativeTone,
                  note: images + videos > 0 ? `${imagesUsed + videosUsed}/${images + videos} this month` : packageLabel,
                  tabs: [
                    { id: "production", label: "Production", hint: "Creative in motion, launched and live; what's working in the market", content: (<div className="grid gap-6">
                {creative && <CreativePanel data={creative} />}
                {!demo && live && market.length > 0 && <MarketPanel clientId={client.id} industry={client.industry ?? null} label={client.industry_detail ?? industryLabel(client.industry) ?? "their industry"} ads={market} />}
              </div>) },
                    {
                      id: "package",
                      label: "Package & assets",
                      hint: "The package and allotment, assets on Drive and the shot list",
                      content: (
                        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                          <div className="grid min-w-0 gap-6">
                            {assets && !demo && client.creative_package && <ShotListPanel clientId={client.id} slug={client.slug} assets={assets} latest={shotList} live={live} />}
                            {!(assets && !demo && client.creative_package) && <p className="text-sm text-faint">Shot lists come with a creative package.</p>}
                          </div>
                          <div className="grid min-w-0 gap-6">
                            <PackagePanel
            active={active}
            packageLabel={packageLabel}
            packageKey={client.creative_package_key ?? null}
            until={client.creative_package_until ?? null}
            note={client.creative_package_note ?? null}
            today={today}
            images={images}
            videos={videos}
            imagesUsed={imagesUsed}
            videosUsed={videosUsed}
            fromAsana={fromAsana}
            creativeDb={creativeDb}
            packages={packages}
            can={{ exec: can.admin, allot: can.allot }}
            setSprint={setSprintPackage.bind(null, client.id, client.slug)}
            endPackage={endCreativePackage.bind(null, client.id, client.slug)}
            saveAllotment={saveAllotment.bind(null, client.id, client.slug)}
          />
                          </div>
                        </div>
                      ),
                    },
                    { id: "angles", label: "Angles", count: angles.filter((a) => a.status !== "archived").length || null, hint: "Angles and avatars; copy is approved once per angle", content: (<Section title="Angles & avatars" description="Copy is approved once per angle and reused for every creative on it.">
            {angles.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {angles.map((a) => (
                  <li key={a.id} className={`${row} ${a.status === "archived" ? "opacity-50" : ""}`}>
                    <span className="grid min-w-0 gap-0.5">
                      <span>
                        {a.name} <span className="text-xs capitalize text-faint">· {a.kind}</span>
                      </span>
                      {a.description && <span className="text-xs leading-relaxed text-muted">{a.description}</span>}
                    </span>
                    <ActionButton
                      action={setAngleStatus.bind(null, client.slug, a.id, a.status === "archived" ? "active" : "archived")}
                      label={a.status === "archived" ? "Restore" : "Archive"}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">No angles yet. They&apos;re also created from requests.</p>
            )}
            <ActionForm action={addAngle.bind(null, client.id, client.slug)} submitLabel="Add angle" resetOnSuccess className="grid gap-4 border-t border-line pt-5">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.4fr)]">
                <label className={label}>
                  Name
                  <input name="name" required className={field} placeholder="e.g. Fresh, never frozen" />
                </label>
                <label className={label}>
                  Type
                  <select name="kind" className={field}>
                    <option value="angle">Angle</option>
                    <option value="avatar">Avatar</option>
                  </select>
                </label>
                <label className={label}>
                  <span>
                    Description <span className="font-normal text-faint">(optional)</span>
                  </span>
                  <input name="description" className={field} />
                </label>
              </div>
            </ActionForm>
          </Section>) },
                  ],
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
