"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { ActionForm } from "@/components/action-form";
import { ChannelStatusPill, ConnectCta, TONE, needsConnecting, num, paceLine, signed, targetText } from "@/components/channel-parts";
import { EmailRevenueChart, RevenuePace } from "@/components/email-revenue-chart";
import { BAND_TONE, ScoreBadge, ScoreChecks, WeighingDown, checkText } from "@/components/email-score-parts";
import { KlaviyoLocations } from "@/components/klaviyo-locations";
import { KlaviyoMetricPicker } from "@/components/klaviyo-metric-picker";
import { field, label as labelCls } from "@/components/ui";
import { moneyShort, pctText, type Month } from "@/lib/channel-kpis/calc";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { freshness } from "@/lib/dates";
import { AREA_LABEL as EMAIL_AREA_LABEL, OWNER_LABEL as EMAIL_OWNER_LABEL, type EmailAction } from "@/lib/email-ops/audit-core";
import { SOCIAL_AREA_LABEL, SOCIAL_OWNER_LABEL } from "@/lib/social-ops/audit-core";
import { activeDays, agoShort, changeText, lastManual } from "@/lib/email-ops/changes-core";
import { CALENDAR, ROLLING, WINDOW_LABEL, daysInMonth, gapOf, gapTone, momentum, trendSeries, windowNumbers, type TrendMetric, type WindowNumbers } from "@/lib/email-ops/windows";
import { EMAIL_CHECKS } from "@/lib/email-score";
import { RANK_LABEL } from "@/lib/email-metrics";
import { pushParams, useParam } from "@/lib/url-state";
import { ClientChat } from "../clients/[slug]/client-chat";
import { EmailOpsSuggestions } from "../clients/[slug]/email-ops-suggestions";
import { Layer } from "../clients/[slug]/layer";
import { SegmentPerformance } from "../clients/[slug]/segment-performance";
import { BoardBreakdown } from "./board-breakdown";
import { BoardLocations } from "./board-locations";
import { setChannelTarget } from "./channel-actions";
import { EmailActionCard, RunEmailAudit, SprintControls, SprintMove } from "./email-ops-parts";
import { startEmailSprint, type OpsLine } from "./email-ops-actions";
import { loadEmailSheet, type EmailSheet, type SheetAudit, type SheetSprint } from "./email-sheet-actions";
import { EmailTrendChart } from "./email-trend-chart";
import { TargetGauge } from "./kpi-charts";

// One email account, opened from its card on the Email KPI board: the same sheet the ads accounts get. The score and
// where revenue stands up top with the latest change in the account and the chat; tabs for the overview, every window's
// numbers, the campaigns, the flows, the audit and its sprint, the notes and change history, and the settings. The tab
// and the views inside it live in the address, so the browser's back walks through them. What the board doesn't carry
// (the days behind each window, the audit, the sprint, the change history) is read when the sheet opens.

// The audit card, the sprint panel and the sprint strip are shared with the Social sheet (social-sheet.tsx): `line` picks
// the email or the social audit and sprint
const AREA_LABEL: Record<string, string> = { ...EMAIL_AREA_LABEL, ...SOCIAL_AREA_LABEL };
const OWNER_LABEL: Record<string, string> = { ...EMAIL_OWNER_LABEL, ...SOCIAL_OWNER_LABEL };
const LINE_NAME: Record<OpsLine, string> = { email: "Email", social: "Social" };

type Tab = "overview" | "numbers" | "campaigns" | "flows" | "segments" | "actions" | "notes" | "settings";
const TABS: Tab[] = ["overview", "numbers", "campaigns", "flows", "segments", "actions", "notes", "settings"];
type NumMetric = "revenue" | "rpr" | "open" | "click" | "orders";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "none yet");
const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const symbol = (currency: string | null) => (!currency || currency === "USD" ? "$" : `${currency} `);
const BAR = Object.fromEntries(EMAIL_CHECKS.map((c) => [c.key, c.bar])) as Record<(typeof EMAIL_CHECKS)[number]["key"], number>;
const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const VERDICT: Record<string, { label: string; tone: string }> = {
  started: { label: "Started", tone: "bg-surface-2 text-muted" },
  no_action: { label: "Nothing moving", tone: "bg-bad-soft text-bad" },
  on_track: { label: "On track", tone: "bg-ok-soft text-ok" },
  improving: { label: "Improving", tone: "bg-ok-soft text-ok" },
  worse: { label: "Slipping", tone: "bg-bad-soft text-bad" },
  done: { label: "Back in the green", tone: "bg-ok-soft text-ok" },
};

/** The section label every card here starts with */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{children}</p>;
}

function Stat({ k, v, hint }: { k: string; v: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5 rounded-[12px] border border-line bg-surface p-3">
      <dt className="text-[11px] text-faint">{k}</dt>
      <dd className="tabular truncate font-heading text-lg leading-tight">{v}</dd>
      {hint && <dd className="truncate text-[11px] text-faint">{hint}</dd>}
    </div>
  );
}

/** A change against what came before, with higher better: "+12% up" in green, "-8% down" in red */
function Delta({ label: name, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 whitespace-nowrap text-xs">
      <span className="text-faint">{name}</span>
      <span className={`tabular font-medium ${value == null ? "text-faint" : value > 0.05 ? "text-ok" : value < -0.05 ? "text-bad" : "text-muted"}`}>
        {value == null ? "n/a" : Math.abs(value) < 0.01 ? "same" : `${Math.round(Math.abs(value) * 100)}% ${value > 0 ? "up" : "down"}`}
      </span>
    </div>
  );
}

function Skeleton({ h = "h-40" }: { h?: string }) {
  return <div className={`${h} animate-pulse rounded-[20px] bg-surface-2`} />;
}

export function EmailAccountSheet({ r, month, onClose, onStep }: { r: ChannelRow; month: Month; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  const tone = TONE[r.status];
  const connect = needsConnecting(r);
  const pace = paceLine(r);
  const klaviyo = !r.provider || r.provider === "klaviyo";
  const money = r.revenueMeasured !== false;
  const raw = useParam("tab");
  const asked: Tab = (TABS as string[]).includes(raw ?? "") ? (raw as Tab) : "overview";
  // An account still connecting has only its overview (with the way to connect it) and its settings
  const tab: Tab = connect && asked !== "settings" ? "overview" : asked;
  const setTab = (t: Tab) => pushParams({ tab: t === "overview" ? null : t });

  // A sheet over the board: Escape closes it, the arrows step through the clients, the page behind stays put
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      // A campaign preview open over the sheet takes the keys (Escape closes it, not the sheet)
      if (new URLSearchParams(window.location.search).has("epreview")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") onStep(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") onStep(-1);
    };
    window.addEventListener("keydown", key);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = was;
    };
  }, [onClose, onStep]);

  // What the board doesn't carry, read when the sheet opens; read again after anything here changes it
  const [got, setGot] = useState<{ id: string; sheet: EmailSheet | null; error: string | null } | null>(null);
  const reload = useCallback(async () => {
    const res = await loadEmailSheet(r.clientId).catch(() => ({ ok: false as const, error: "Couldn't read this account." }));
    setGot({ id: r.clientId, sheet: res.ok ? res.sheet : null, error: res.ok ? null : res.error });
  }, [r.clientId]);
  useEffect(() => {
    let live = true;
    loadEmailSheet(r.clientId)
      .then((res) => live && setGot({ id: r.clientId, sheet: res.ok ? res.sheet : null, error: res.ok ? null : res.error }))
      .catch(() => live && setGot({ id: r.clientId, sheet: null, error: "Couldn't read this account." }));
    return () => {
      live = false;
    };
  }, [r.clientId]);
  const sheet = got?.id === r.clientId ? got.sheet : null;
  const loading = !got || got.id !== r.clientId;
  // An audit running: look again every few seconds until it's done (its sprint opens with it on a red account)
  const running = sheet?.audit?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [running, reload]);

  const sprint = sheet?.sprint ?? null;
  const audit = sheet?.audit ?? null;
  const openMoves = sprint ? sprint.moves.filter((m) => m.status === "todo" || m.status === "doing").length : audit?.status === "ready" && audit.result ? audit.result.actions.filter((_, i) => !audit.done[String(i)]).length : 0;
  const tabs: { id: Tab; label: string; count?: number | null; hint: string }[] = [
    { id: "overview", label: "Overview", hint: "Where it stands, the last 30 days, revenue against the target and the next move" },
    { id: "numbers", label: "Numbers", hint: "Every window, month and quarter against the target, and the account's numbers this month" },
    { id: "campaigns", label: "Campaigns", hint: "Every campaign sent in the last 120 days with its results" },
    { id: "flows", label: "Flows", hint: "Every flow with its last 30 and 90 days" },
    { id: "segments", label: "Segments", hint: "Every list and segment the campaigns went to: results, the ones to rest or trim, who to include and leave out, and what works for similar clients" },
    { id: "actions", label: "Actions", count: openMoves || null, hint: "The audit, the sprint of moves and the campaign ideas" },
    { id: "notes", label: "Notes", hint: "The #1 problem, the plan and every change in the account" },
    { id: "settings", label: "Settings", hint: "The revenue target, what counts as the sale and where the numbers come from" },
  ];
  const shown = connect ? tabs.filter((t) => t.id === "overview" || t.id === "settings") : tabs;

  return (
    <Layer>
      <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${r.name} email KPI`}>
        <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-deep/70 backdrop-blur-[2px] motion-safe:animate-[fadeIn_.18s_ease-out]" />
        <div className="relative flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg motion-safe:animate-[sheetIn_.24s_cubic-bezier(.2,.8,.2,1)] md:w-[min(980px,94vw)]">
          {/* Who, how it's doing, the latest change and the tabs: always in view */}
          <header className="relative isolate shrink-0 border-b border-line bg-surface/80 backdrop-blur" style={{ backgroundImage: `radial-gradient(90% 140% at 0% 0%, color-mix(in srgb, ${tone.css} 18%, transparent), transparent 60%)` }}>
            <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} style={{ boxShadow: `0 0 22px ${tone.css}` }} />
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+16px)] sm:px-6 md:pt-5">
              <div className="grid min-w-0 gap-1">
                <p className="truncate font-heading text-xl leading-tight md:text-2xl">{r.name}</p>
                <p className="truncate text-xs text-faint">
                  {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
                  Email{r.account ? ` · ${r.account}` : ""}
                  {r.team.filter((t) => t.seat === "Strategist").length > 0 && ` · ${r.team.filter((t) => t.seat === "Strategist").map((t) => t.name).join(" + ")}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => onStep(-1)} aria-label="Previous client" className="hidden h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:grid">‹</button>
                <button type="button" onClick={() => onStep(1)} aria-label="Next client" className="hidden h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:grid">›</button>
                <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-lg text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">×</button>
              </div>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pb-4 sm:px-6">
              {connect ? (
                <ChannelStatusPill status={r.status} line="email" />
              ) : (
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {r.score ? <ScoreBadge r={r.score} size="lg" /> : <span className="tabular font-display text-[34px] leading-none tracking-tight text-faint">n/a</span>}
                    <span className="text-sm text-faint">account score</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelStatusPill status={r.status} line="email" />
                    {pace && <span className="text-xs text-muted">{pace}</span>}
                  </div>
                  <LastChange sheet={sheet} loading={loading} klaviyo={klaviyo} onOpen={() => setTab("notes")} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <ClientChat variant="inline" clientId={r.clientId} client={r.name} live targets={[]} desk="email" />
                <Link href={`/clients/${r.slug}?service=email`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
                  Client page →
                </Link>
                <Link href={`/reports?client=${r.slug}`} className="hidden h-9 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:inline-flex">
                  Reports →
                </Link>
              </div>
            </div>
            <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 sm:px-5" role="tablist" aria-label="Account sheet">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  title={t.hint}
                  onClick={() => setTab(t.id)}
                  className={`relative inline-flex h-12 shrink-0 items-center gap-1.5 px-3 text-sm transition-colors md:h-11 ${tab === t.id ? "text-fg" : "text-muted hover:text-fg"}`}
                >
                  {t.label}
                  {t.count ? <span className="tabular rounded-full bg-brand-soft px-1.5 text-[10px] leading-4 text-brand-text">{t.count}</span> : null}
                  {tab === t.id && <span aria-hidden className={`absolute inset-x-2 bottom-0 h-[2px] rounded-full ${tone.bar}`} />}
                </button>
              ))}
            </nav>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)] sm:px-6 md:py-6">
            <div className="grid gap-5 md:gap-6">
              <p className="-mb-2 text-xs text-faint">{shown.find((t) => t.id === tab)?.hint}</p>
              {got?.error && got.id === r.clientId && <p className="rounded-[12px] border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad">{got.error}</p>}

              {tab === "overview" && (connect ? <ConnectCta r={r} /> : <Overview r={r} sheet={sheet} loading={loading} money={money} onTab={setTab} />)}
              {tab === "numbers" && <Numbers r={r} sheet={sheet} loading={loading} money={money} />}
              {tab === "campaigns" && <BoardBreakdown clientId={r.clientId} currency={r.currency} provider={r.provider ?? null} revenueMeasured={money} only="campaigns" />}
              {tab === "flows" && <BoardBreakdown clientId={r.clientId} currency={r.currency} provider={r.provider ?? null} revenueMeasured={money} only="flows" />}
              {tab === "segments" && <SegmentPerformance clientId={r.clientId} currency={r.currency} />}
              {tab === "actions" && (loading ? <Skeleton h="h-72" /> : sheet && <Actions r={r} sheet={sheet} reload={reload} />)}
              {tab === "notes" && (loading ? <Skeleton h="h-72" /> : sheet && <Notes r={r} sheet={sheet} klaviyo={klaviyo} onTab={setTab} />)}
              {tab === "settings" && <Settings r={r} month={month} klaviyo={klaviyo} />}
            </div>
          </div>
        </div>
      </div>
    </Layer>
  );
}

/** "Last change 5h ago · Flow "Welcome" set live": is anyone working in the account. Red when nobody has for a week. */
function LastChange({ sheet, loading, klaviyo, onOpen }: { sheet: EmailSheet | null; loading: boolean; klaviyo: boolean; onOpen: () => void }) {
  if (!klaviyo) return null;
  if (loading) return <span className="h-4 w-56 animate-pulse rounded-full bg-surface-2" aria-label="Reading the change history" />;
  if (!sheet) return null;
  const last = lastManual(sheet.changes);
  const cls = "inline-flex min-h-11 max-w-full items-center truncate text-left text-[11.5px] underline-offset-4 hover:underline md:min-h-0";
  if (!sheet.changesRead.readAt && !sheet.changes.length) return <span className="text-[11.5px] text-faint">Change history starts with the next Klaviyo sync</span>;
  if (!last)
    return (
      <button type="button" onClick={onOpen} className={`${cls} text-bad`}>
        No change in the account in the last 30 days
      </button>
    );
  const days = (sheet.now - Date.parse(last.at)) / 86_400_000;
  return (
    <button type="button" onClick={onOpen} className={`${cls} ${days >= 7 ? "text-bad" : days >= 3 ? "text-warn" : "text-faint"}`} title="From Klaviyo's created and updated times on each sync. Klaviyo doesn't say who made a change.">
      Last change {agoShort(last.at, sheet.now)} ago · {changeText(last)}
    </button>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

const TREND: { id: TrendMetric; label: string; money?: boolean }[] = [
  { id: "revenue", label: "Revenue", money: true },
  { id: "rpr", label: "Per recipient", money: true },
  { id: "orders", label: "Orders", money: true },
  { id: "recipients", label: "Recipients" },
];

function Overview({ r, sheet, loading, money, onTab }: { r: ChannelRow; sheet: EmailSheet | null; loading: boolean; money: boolean; onTab: (t: Tab) => void }) {
  const asked = useParam("et") as TrendMetric | null;
  const metrics = TREND.filter((m) => money || !m.money);
  const metric: TrendMetric = metrics.some((m) => m.id === asked) ? asked! : metrics[0].id;
  const windows = sheet ? windowNumbers({ today: sheet.today, days: sheet.days, campaigns: sheet.campaigns, monthTarget: r.target }) : null;
  const points = sheet ? trendSeries(sheet.days, sheet.today, metric, 30) : [];
  const mom = windows ? momentum(windows) : null;
  const sym = symbol(r.currency);
  const fmt = (v: number | null) => (v == null ? "n/a" : metric === "revenue" ? moneyShort(v, r.currency) : metric === "rpr" ? `${sym}${v.toFixed(2)}` : Math.round(v).toLocaleString("en-US"));
  const dayTarget = metric === "revenue" && r.target != null && sheet ? r.target / daysInMonth(sheet.today) : metric === "rpr" ? BAR.rpr : null;
  const week = sheet ? sheet.changes.filter((c) => c.manual && sheet.now - Date.parse(c.at) < 7 * 86_400_000).length : 0;
  const active = sheet ? activeDays(sheet.changes, new Date(sheet.now - 14 * 86_400_000).toISOString()) : 0;
  const tone = TONE[r.status];

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <span aria-hidden className="pointer-events-none absolute -left-20 -top-24 -z-10 h-64 w-64 rounded-full opacity-25 blur-[90px]" style={{ background: tone.css }} />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <Eyebrow>Last 30 days</Eyebrow>
              <p className="text-sm text-muted">{metric === "revenue" ? "Attributed revenue each day" : metric === "rpr" ? "Revenue per recipient each day" : metric === "orders" ? "Attributed orders each day" : "Recipients each day, campaigns and flows"}</p>
            </div>
            <div role="radiogroup" aria-label="Number shown" className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-bg/60 p-1">
              {metrics.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={metric === m.id} onClick={() => pushParams({ et: m.id === metrics[0].id ? null : m.id })} className={`min-h-11 shrink-0 rounded-full px-3 text-[12px] transition-colors md:min-h-7 ${metric === m.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {loading ? <div className="h-[200px] animate-pulse rounded-[12px] bg-surface-2" /> : <EmailTrendChart id={r.clientId} points={points} metric={metric} target={dayTarget} format={fmt} />}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
            <span>Bars are each day, the line the 7-day average. Point at a day for its numbers.</span>
            {dayTarget != null && (
              <span className="flex gap-3">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" />At or over</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warn" />Close</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-bad" />Under</span>
              </span>
            )}
          </div>
        </div>
        <div className="grid content-start gap-3">
          <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
            <Eyebrow>Revenue this month</Eyebrow>
            {money && r.revenue ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="tabular font-heading text-[28px] leading-none">{moneyShort(r.value, r.currency)}</span>
                  {r.target != null && <span className="tabular text-xs text-faint">of {targetText(r)} target</span>}
                </div>
                <RevenuePace m={r.revenue} currency={r.currency} />
                {r.target != null && r.revenue.projected != null && r.revenue.projected < r.target && sheet && (
                  <p className="text-xs leading-relaxed text-muted">
                    About <span className="tabular text-fg">{moneyShort(Math.max(0, (r.target - (r.value ?? 0)) / Math.max(1, daysInMonth(sheet.today) - Number(sheet.today.slice(8)) + 1)), r.currency)}</span> a day for the rest of the month lands it on target.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">{money ? "No revenue read for this month yet." : "This source reports no revenue, so there is no revenue goal to pace against."}</p>
            )}
          </div>
          <div className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-5">
            <Eyebrow>Momentum</Eyebrow>
            {money && <Delta label="vs last month, per day" value={mom?.vsMonth ?? null} />}
            {money && <Delta label="vs last quarter, per day" value={mom?.vsQuarter ?? null} />}
            {loading ? (
              <span className="h-4 w-40 animate-pulse rounded-full bg-surface-2" />
            ) : (
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-faint">Work in the account</span>
                <span className={`tabular font-medium ${active === 0 ? "text-bad" : active < 3 ? "text-warn" : "text-ok"}`}>
                  {week} {week === 1 ? "change" : "changes"} in 7 days · {active} of 14 days
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <NextMove r={r} sheet={sheet} loading={loading} onTab={onTab} />

      {sheet?.sprint && <SprintStrip s={sheet.sprint} onOpen={() => onTab("actions")} />}

      {r.score && (
        <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4 md:grid-cols-2 md:p-5">
          <div className="grid content-start gap-2">
            <Eyebrow>The checks</Eyebrow>
            <ScoreChecks score={r.score} currency={r.currency} />
            <p className="text-[11px] text-faint">Last 30 days, to {when(r.score.window.to)}. Flows are Klaviyo&apos;s 30-day numbers.</p>
          </div>
          <div className="grid content-start gap-3">
            <WeighingDown score={r.score} limit={4} currency={r.currency} />
            {r.score.deliverability && (
              <p className="text-[11.5px] leading-relaxed text-muted">
                Deliverability {r.score.deliverability.score}: {r.score.deliverability.parts.map((p) => `${p.label.toLowerCase()} ${checkText("pct", p.rate)}`).join(", ")}.
              </p>
            )}
            {r.score.unmeasured.length > 0 && <p className="text-[11.5px] text-faint">Nothing to measure yet for {r.score.checks.filter((c) => c.value == null).map((c) => c.label.toLowerCase()).join(", ")}; the score is out of what is measured.</p>}
          </div>
        </section>
      )}
    </>
  );
}

/** The two cards under the chart: the move to make now, and the #1 problem with the latest change */
function NextMove({ r, sheet, loading, onTab }: { r: ChannelRow; sheet: EmailSheet | null; loading: boolean; onTab: (t: Tab) => void }) {
  if (loading || !sheet)
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton h="h-36" />
        <Skeleton h="h-36" />
      </div>
    );
  const a = sheet.audit;
  const res = a?.status === "ready" ? a.result : null;
  const next = sheet.sprint?.moves.find((m) => m.status === "doing") ?? sheet.sprint?.moves.find((m) => m.status === "todo") ?? null;
  const firstAction = res ? (res.actions.find((_, i) => !a!.done[String(i)]) ?? null) : null;
  const top = res?.causes[0] ?? null;
  const open = sheet.sprint ? sheet.sprint.moves.filter((m) => m.status === "todo" || m.status === "doing").length : res ? res.actions.filter((_, i) => !a!.done[String(i)]).length : 0;
  const last = lastManual(sheet.changes);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <button type="button" onClick={() => onTab("actions")} className="group grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
        <span className="flex items-center justify-between gap-2">
          <Eyebrow>What to do</Eyebrow>
          <span className="text-xs text-muted group-hover:text-fg">{open ? `${open} ${open === 1 ? "move" : "moves"} →` : "Actions →"}</span>
        </span>
        {next || firstAction ? (
          <>
            <span className="font-heading text-[17px] leading-snug">{next?.title ?? firstAction!.title}</span>
            {(next?.impact ?? firstAction?.impact) && <span className="line-clamp-2 text-sm leading-relaxed text-ok">{next?.impact ?? firstAction?.impact}</span>}
            <span className="text-[11px] text-faint">
              {OWNER_LABEL[next?.owner ?? firstAction?.owner ?? ""] ?? "Email strategist"}
              {sheet.sprint ? " · on the sprint" : res ? " · from the audit" : ""}
              {a?.status === "ready" ? ` · audited ${when(a.createdAt)}${a.auto ? ", by itself" : ""}` : ""}
            </span>
          </>
        ) : a?.status === "running" ? (
          <span className="text-sm text-brand-text">The audit is running ({a.progress}%)</span>
        ) : res ? (
          <span className="text-sm text-ok">Every move on the audit&apos;s plan is done. Run a fresh audit to see what&apos;s next.</span>
        ) : (
          <span className="text-sm text-muted">No audit yet. Run one and the moves to make in the account show up here.{r.status === "off" ? " A red account audits itself and opens its sprint." : ""}</span>
        )}
      </button>
      <button type="button" onClick={() => onTab("notes")} className="group grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
        <span className="flex items-center justify-between gap-2">
          <Eyebrow>#1 problem</Eyebrow>
          <span className="text-xs text-muted group-hover:text-fg">Notes →</span>
        </span>
        {top ? (
          <>
            <span className="line-clamp-2 text-sm font-medium leading-relaxed">{top.title}</span>
            {top.evidence[0] && <span className="line-clamp-2 text-sm leading-relaxed text-muted">{top.evidence[0]}</span>}
          </>
        ) : r.score?.weighingDown[0] ? (
          <span className="line-clamp-3 text-sm leading-relaxed">
            {r.score.weighingDown[0].label} is {checkText(r.score.weighingDown[0].unit, r.score.weighingDown[0].value, r.currency, r.score.weighingDown[0].bar)} against a {checkText(r.score.weighingDown[0].unit, r.score.weighingDown[0].bar, r.currency)} bar.
          </span>
        ) : (
          <span className="text-sm text-muted">Nothing is weighing the score down.</span>
        )}
        {last && (
          <span className="truncate text-[11px] text-faint">
            Last change {agoShort(last.at, sheet.now)} ago · {changeText(last)}
          </span>
        )}
      </button>
    </div>
  );
}

/** The sprint on this account: how far, the score since it began, and what the last check said */
export function SprintStrip({ s, onOpen }: { s: SheetSprint; onOpen: () => void }) {
  const done = s.moves.filter((m) => m.status === "done").length;
  const total = s.moves.filter((m) => m.status !== "skipped").length;
  const check = s.checks[0];
  const v = check ? VERDICT[check.verdict] : null;
  return (
    <button type="button" onClick={onOpen} className="group grid gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>Sprint in motion</Eyebrow>
        <span className="text-xs text-muted group-hover:text-fg">The moves →</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="tabular">
          {done} of {total} moves done
        </span>
        {s.baseline != null && s.latest != null && (
          <span className="tabular text-muted">
            Score {s.baseline} to {s.latest}
          </span>
        )}
        {v && <span className={`rounded-full px-2 py-0.5 text-[11px] ${v.tone}`}>{v.label}</span>}
        <span className="text-xs text-faint">Next check {stamp(s.nextCheckAt)}</span>
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-ok" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </span>
      {check && <span className="line-clamp-2 text-[13px] leading-relaxed text-muted">{check.message}</span>}
    </button>
  );
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

const NUMS: { id: NumMetric; label: string; money?: boolean }[] = [
  { id: "revenue", label: "Revenue", money: true },
  { id: "rpr", label: "Per recipient", money: true },
  { id: "open", label: "Open rate" },
  { id: "click", label: "Click rate" },
  { id: "orders", label: "Orders", money: true },
];

function Numbers({ r, sheet, loading, money }: { r: ChannelRow; sheet: EmailSheet | null; loading: boolean; money: boolean }) {
  const asked = useParam("en") as NumMetric | null;
  const list = NUMS.filter((m) => money || !m.money);
  const metric: NumMetric = list.some((m) => m.id === asked) ? asked! : list[0].id;
  const windows = sheet ? windowNumbers({ today: sheet.today, days: sheet.days, campaigns: sheet.campaigns, monthTarget: r.target }) : null;
  const sym = symbol(r.currency);
  const e = r.email;
  const vsLast = r.projected != null && r.prev ? r.projected / r.prev - 1 : null;
  const valueOf = (w: WindowNumbers) => (metric === "revenue" ? w.revenue : metric === "rpr" ? w.rpr : metric === "open" ? w.openRate : metric === "click" ? w.clickRate : w.orders);
  const targetOf = (w: WindowNumbers) => (metric === "revenue" ? w.target : metric === "rpr" ? BAR.rpr : metric === "open" ? BAR.campaignOpen : metric === "click" ? BAR.campaignClick : null);
  const fmt = (v: number | null) => (v == null ? "n/a" : metric === "revenue" ? moneyShort(v, r.currency) : metric === "rpr" ? `${sym}${v.toFixed(2)}` : metric === "orders" ? Math.round(v).toLocaleString("en-US") : pctText(v, metric === "click" ? 2 : 1));
  const sub = (w: WindowNumbers) =>
    metric === "revenue"
      ? w.target != null
        ? `of ${moneyShort(w.target, r.currency)} target pace`
        : `Campaigns ${moneyShort(w.campaignRevenue, r.currency)} · flows ${moneyShort(w.flowRevenue, r.currency)}`
      : metric === "rpr"
        ? `bar ${sym}${BAR.rpr.toFixed(2)} · ${num(w.recipients)} recipients`
        : metric === "open" || metric === "click"
          ? `bar ${pctText(targetOf(w), metric === "click" ? 1 : 0)} · ${w.sent} ${w.sent === 1 ? "campaign" : "campaigns"}`
          : "attributed to email and SMS";
  const cell = (w: WindowNumbers, highlight = false) => {
    const v = valueOf(w);
    const t = targetOf(w);
    const g = gapTone(gapOf(v, t));
    const partial = sheet?.dataFrom && sheet.dataFrom > w.from;
    return (
      <div key={w.key} className={`grid min-w-0 content-start gap-1.5 bg-surface px-3 py-3 md:px-4 ${highlight ? "ring-1 ring-inset ring-fg/25" : ""}`}>
        <span className="text-[11px] text-faint">
          {WINDOW_LABEL[w.key]}
          {highlight && " · the score's window"}
        </span>
        <span className={`tabular font-heading text-lg leading-tight ${g ? TONE_TEXT[g] : "text-fg"}`}>{fmt(v)}</span>
        <TargetGauge value={v} target={t} roas />
        <span className="tabular truncate text-[11px] text-faint">{sub(w)}</span>
        {partial && <span className="text-[10.5px] text-faint">{sheet!.reading ? sheet!.reading.line : `Read from ${when(`${sheet!.dataFrom}T12:00:00Z`)} only`}</span>}
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Number shown" className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
          {list.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={metric === m.id} onClick={() => pushParams({ en: m.id === list[0].id ? null : m.id })} className={`min-h-11 shrink-0 rounded-full px-3.5 text-[12.5px] transition-colors md:min-h-8 ${metric === m.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-faint">
          {metric === "revenue"
            ? r.target != null
              ? `Judged against this month's target at the same daily pace (${moneyShort(r.target / daysInMonth(sheet?.today ?? month0()), r.currency)} a day)`
              : "No revenue target yet, so nothing to judge it against"
            : metric === "orders"
              ? "Orders have no target of their own"
              : "Judged against the score's bar"}
        </p>
      </div>
      {loading || !windows ? (
        <>
          <Skeleton h="h-28" />
          <Skeleton h="h-28" />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">{ROLLING.map((k) => cell(windows[k], k === "d30"))}</div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line lg:grid-cols-4">{CALENDAR.map((k) => cell(windows[k]))}</div>
        </>
      )}

      {e && (
        <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
          {money && <Stat k="Campaign revenue" v={moneyShort(e.campaignRevenue, r.currency)} hint={`${e.campaignsSent} ${e.campaignsSent === 1 ? "campaign" : "campaigns"} sent this month`} />}
          {money && <Stat k="Flow revenue" v={moneyShort(e.flowRevenue, r.currency)} hint={r.value ? `${Math.round((e.flowRevenue / r.value) * 100)}% of the total` : undefined} />}
          {money && <Stat k="vs last month" v={vsLast == null ? "n/a" : `${vsLast >= 0 ? "+" : "-"}${Math.abs(Math.round(vsLast * 100))}%`} hint={r.prev != null ? `Last month ${moneyShort(r.prev, r.currency)}, this month at pace` : undefined} />}
          {!money && <Stat k="Campaigns sent" v={num(e.campaignsSent)} hint="This month" />}
          <Stat k="Open rate" v={pctText(e.openRate)} hint="Email campaigns this month" />
          <Stat k="Click rate" v={pctText(e.clickRate)} hint="Email campaigns this month" />
          <Stat k="List growth" v={signed(e.listNet)} hint="Subscribed less unsubscribed" />
          {money && <Stat k="Orders attributed" v={num(e.orders)} hint="Placed by email and SMS" />}
          {(!r.provider || r.provider === "klaviyo") && <Stat k="Store orders" v={num(e.storeOrders)} hint="All orders Klaviyo sees" />}
          <Stat k="Last campaign" v={when(e.lastSendAt)} hint={r.quietDays != null && r.quietDays >= 14 ? `${r.quietDays} days ago` : undefined} />
        </dl>
      )}

      {money && r.revenue && (
        <section className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <div className="grid gap-0.5">
            <Eyebrow>{r.conversionMetrics?.[0]?.name ?? r.conversionMetric ?? "Placed Order"} revenue this month</Eyebrow>
            <p className="text-sm text-muted">Running total against the target&apos;s even pace (dashed), last month in grey. Slide across to read any day.</p>
          </div>
          <EmailRevenueChart id={`${r.clientId}-sheet`} m={r.revenue} currency={r.currency} />
        </section>
      )}

      {r.metricNumbers && r.metricNumbers.length > 1 && <MetricsSideBySide r={r} />}
      {r.data !== "missing" && (!r.provider || r.provider === "klaviyo") && <BoardLocations clientId={r.clientId} />}
    </>
  );
}

const month0 = () => new Date().toISOString().slice(0, 10);

/** Each ranked metric that counts as the sale, side by side: this month's numbers and its weight in the score */
function MetricsSideBySide({ r }: { r: ChannelRow }) {
  const list = r.metricNumbers ?? [];
  const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="grid gap-0.5">
        <Eyebrow>What counts as the sale</Eyebrow>
        <p className="text-sm text-muted">This month for each ranked metric. The score&apos;s money checks blend them by rank; the chart and the target follow the primary.</p>
      </div>
      <div className={`grid gap-2.5 sm:grid-cols-2 ${list.length > 2 ? "lg:grid-cols-4" : ""}`}>
        {list.map((m, i) => (
          <div key={m.id} className={`grid min-w-0 content-start gap-1.5 rounded-[14px] border p-3 ${i === 0 ? "border-fg/25 bg-surface-2/40" : "border-line"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10.5px] uppercase tracking-[0.12em] text-faint">{RANK_LABEL[i]}</span>
              <span className="tabular text-[11px] text-faint">{Math.round(m.weight * 100)}% of money checks</span>
            </div>
            <p className="truncate text-sm font-medium text-fg" title={m.integration ? `${m.name} · ${m.integration}` : m.name}>
              {m.name}
              {m.integration && <span className="font-normal text-faint"> · {m.integration}</span>}
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-faint">Attributed</dt>
              <dd className="tabular text-right text-fg">{moneyShort(m.revenue, r.currency)}</dd>
              <dt className="text-faint">Conversions</dt>
              <dd className="tabular text-right text-fg">{num(m.conversions)}</dd>
              <dt className="text-faint">Store total</dt>
              <dd className="tabular text-right text-fg">{m.storeRevenue ? moneyShort(m.storeRevenue, r.currency) : num(m.storeOrders)}</dd>
              <dt className="text-faint">Share, 30 days</dt>
              <dd className="tabular text-right text-fg">{pct(m.attributed)}</dd>
              <dt className="text-faint">Per recipient</dt>
              <dd className="tabular text-right text-fg">{m.rpr == null ? "n/a" : `${symbol(r.currency)}${m.rpr.toFixed(2)}`}</dd>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Actions: the audit, its sprint, the campaign ideas ─────────────────────

const WHEN: [EmailAction["when"], string][] = [
  ["now", "Today"],
  ["this_week", "This week"],
  ["next", "Next"],
];
const SEV: Record<string, string> = { high: "border-l-bad", medium: "border-l-warn", low: "border-l-line" };

function Actions({ r, sheet, reload }: { r: ChannelRow; sheet: EmailSheet; reload: () => Promise<void> }) {
  const a = sheet.audit;
  const res = a?.status === "ready" ? a.result : null;
  const s = sheet.sprint;
  const sprintOfThis = Boolean(s && a && s.auditId === a.id);
  const listed = new Map<number, string>();
  if (s && sprintOfThis) for (const m of s.moves) if (m.auditIndex != null) listed.set(m.auditIndex, m.status);
  const last = lastManual(sheet.changes);
  const quiet = !last || sheet.now - Date.parse(last.at) > 48 * 3_600_000;
  const rest = res ? res.actions.map((x, i) => ({ x, i })).filter(({ i }) => !listed.has(i)) : [];

  return (
    <>
      {(r.status === "off" || r.status === "close") && !s && a?.status !== "running" && quiet && (
        <p className="rounded-[14px] border border-dashed border-bad/50 px-4 py-3 text-sm text-bad">
          Nobody&apos;s working in this account yet{last ? `: the last change was ${agoShort(last.at, sheet.now)} ago` : ": no change in the last 30 days"}. Run the audit and make the first moves below.
        </p>
      )}

      <AuditCard r={r} a={a} reload={reload} />

      {s ? (
        <SprintPanel s={s} replaced={Boolean(a && s.auditId !== a.id && a.status === "ready")} reload={reload} />
      ) : (
        res && (
          <section className="grid gap-3 rounded-[20px] border border-dashed border-line p-4 md:flex md:items-center md:justify-between md:p-5">
            <div className="grid gap-0.5">
              <p className="font-heading text-[16px]">Follow the plan as a sprint</p>
              <p className="text-[13px] leading-relaxed text-muted">Every few days the sprint re-measures the score, looks in the account for each move and tells the strategist what moved.</p>
            </div>
            <FollowHere auditId={a!.id} reload={reload} />
          </section>
        )
      )}

      {res && rest.length > 0 && (
        <section className="grid gap-4">
          <div className="grid gap-0.5">
            <h2 className="font-heading text-xl">{s && sprintOfThis ? "The rest of the plan" : "The audit's plan"}</h2>
            <p className="text-[13px] text-muted">Tick a move off when it&apos;s done, or add it to the sprint.</p>
          </div>
          {WHEN.map(([w, title]) => {
            const items = rest.filter(({ x }) => x.when === w);
            if (!items.length) return null;
            return (
              <div key={w} className="grid gap-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{title}</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  {items.map(({ x, i }) => (
                    <EmailActionCard key={`${a!.id}:${i}`} auditId={a!.id} index={i} action={x} areaLabel={AREA_LABEL[x.area] ?? x.area} done={a!.done[String(i)] ?? null} listed={null} onChange={reload} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <EmailOpsSuggestions suggestions={sheet.suggestions} clientId={r.clientId} onChange={reload} />
    </>
  );
}

/** The latest audit: what it found, its state while it runs, and a way to run a new one without leaving the sheet */
export function AuditCard({ r, a, reload, line = "email" }: { r: Pick<ChannelRow, "clientId">; a: SheetAudit | null; reload: () => Promise<void>; line?: OpsLine }) {
  const res = a?.status === "ready" ? a.result : null;
  const band = a?.band ? BAND_TONE[a.band] : null;
  return (
    <section className="relative isolate grid gap-4 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-6">
      {band && <span aria-hidden className="pointer-events-none absolute -right-24 -top-28 -z-10 h-64 w-64 rounded-full opacity-20 blur-[90px]" style={{ background: band.css }} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <Eyebrow>{LINE_NAME[line]} audit{a ? ` · ${when(a.createdAt)}${a.auto ? " · ran itself" : a.by ? ` · ${a.by}` : ""}` : ""}</Eyebrow>
          <h2 className="font-heading text-[19px] leading-snug md:text-[22px]">{res ? res.verdict.headline : a?.status === "running" ? "Reading the account" : a?.status === "failed" ? "The last audit didn't finish" : "No audit yet"}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {band && a?.status === "ready" && (
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${band.pill}`}>
              {band.label} · {a.score}
            </span>
          )}
          {a?.status !== "running" && <RunEmailAudit clientId={r.clientId} line={line} label={a ? "Run a new audit" : "Run the audit"} quiet={Boolean(res)} onStarted={() => reload()} />}
        </div>
      </div>
      {a?.status === "running" && (
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted">{a.step ?? "Starting"}</span>
            <span className="tabular text-brand-text">{a.progress}%</span>
          </div>
          <div role="progressbar" aria-valuenow={a.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Audit progress" className="h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.max(4, a.progress)}%` }} />
          </div>
          <p className="text-[12px] text-faint">You can leave the sheet: it keeps going, and a red account&apos;s sprint opens with it.</p>
        </div>
      )}
      {a?.status === "failed" && <p className="text-sm text-bad">{a.error ?? "Something went wrong reading the account."}</p>}
      {!a && <p className="text-sm text-muted">{line === "social" ? "The Social Strategist reads every platform against the social score, the posts, their hooks, formats and posting times, and the client's context, and writes why it's where it is and the moves to make." : <>The Email Strategist reads the account against the score, its last 90 days, the change history and the client&apos;s context, and writes why it&apos;s where it is and the moves to make.</>}</p>}
      {res && (
        <>
          <p className="max-w-3xl text-[14.5px] leading-relaxed text-muted">{res.verdict.summary}</p>
          {res.causes.length > 0 && (
            <div className="grid gap-2 md:grid-cols-3">
              {res.causes.slice(0, 3).map((c, i) => (
                <article key={i} className={`grid min-w-0 content-start gap-1 rounded-[12px] border border-l-4 border-line bg-bg/40 p-3 ${SEV[c.severity] ?? ""}`}>
                  <span className="text-[10.5px] uppercase tracking-[0.12em] text-faint">{AREA_LABEL[c.area] ?? c.area}</span>
                  <span className="text-[13px] font-medium leading-snug">{c.title}</span>
                </article>
              ))}
            </div>
          )}
          <Link href={`/kpis/${line}-audit/${a!.id}`} className="inline-flex min-h-11 w-fit items-center text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
            The whole audit: why, every cause, tests and questions for the client →
          </Link>
        </>
      )}
    </section>
  );
}

/** Follow the audit as a sprint, staying in the sheet */
export function FollowHere({ auditId, reload, line = "email" }: { auditId: string; reload: () => Promise<void>; line?: OpsLine }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {error && <span className="text-[11.5px] text-bad">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await startEmailSprint(auditId, undefined, line);
            if (!res.ok) return setError(res.error);
            await reload();
          })
        }
        className="min-h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9"
      >
        {pending ? "Opening…" : "Start the sprint"}
      </button>
    </span>
  );
}

/** The live sprint: where it stands, what the last check saw, and each move to set (saved on change) */
export function SprintPanel({ s, replaced, reload, line = "email" }: { s: SheetSprint; replaced: boolean; reload: () => Promise<void>; line?: OpsLine }) {
  const done = s.moves.filter((m) => m.status === "done").length;
  const total = s.moves.filter((m) => m.status !== "skipped").length;
  const check = s.checks[0];
  const v = check ? VERDICT[check.verdict] : null;
  const order = { doing: 0, todo: 1, done: 2, skipped: 3 } as const;
  const moves = [...s.moves].sort((x, y) => order[x.status] - order[y.status]);
  return (
    <section className="grid gap-4">
      <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <Eyebrow>Sprint in motion · since {when(s.startedAt)}</Eyebrow>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="tabular">
                {done} of {total} moves done
              </span>
              {s.baseline != null && s.latest != null && (
                <span className="tabular text-muted">
                  Score {s.baseline} to {s.latest}
                </span>
              )}
              {v && <span className={`rounded-full px-2 py-0.5 text-[11px] ${v.tone}`}>{v.label}</span>}
            </p>
          </div>
          <SprintControls sprintId={s.id} active line={line} />
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-ok" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        {check && (
          <p className="rounded-[12px] bg-bg/60 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
            {check.message}
            <span className="mt-1 block text-[11px] text-faint">
              Checked {stamp(check.at)} · next check {stamp(s.nextCheckAt)}
            </span>
          </p>
        )}
        {replaced && <p className="text-[12px] text-warn">A newer audit is ready. This sprint follows the older one until it&apos;s closed or the new audit is followed.</p>}
        <Link href={`/kpis/${line}-sprint/${s.id}`} className="inline-flex min-h-11 w-fit items-center text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
          Open the sprint with every check →
        </Link>
      </div>
      <div className="grid gap-3">
        {moves.map((m) => (
          <SprintMove key={`${m.id}:${m.status}:${m.aiNote ?? ""}`} line={line} id={m.id} title={m.title} owner={m.owner} steps={m.steps} why={m.why} impact={m.impact} status={m.status} note={m.note} aiNote={m.aiNote} onChange={reload} compact />
        ))}
      </div>
    </section>
  );
}

// ─── Notes: the #1 problem, the plan and the change history ─────────────────

function Notes({ r, sheet, klaviyo, onTab }: { r: ChannelRow; sheet: EmailSheet; klaviyo: boolean; onTab: (t: Tab) => void }) {
  const res = sheet.audit?.status === "ready" ? sheet.audit.result : null;
  const top = res?.causes[0] ?? null;
  const diagnosis = res?.diagnosis.split(/\n+/).filter(Boolean)[0] ?? null;
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <section className="grid content-start gap-2 rounded-[16px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>#1 problem</Eyebrow>
          {top ? (
            <>
              <p className="text-[15px] font-medium leading-snug">{top.title}</p>
              <ul className="grid gap-1 text-[13px] leading-relaxed text-muted">
                {top.evidence.slice(0, 3).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted">{sheet.audit ? "The latest audit hasn't finished." : "No audit yet: the #1 problem comes from it."}</p>
          )}
          {diagnosis && <p className="text-[12.5px] leading-relaxed text-faint">{diagnosis}</p>}
        </section>
        <section className="grid content-start gap-2 rounded-[16px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>The plan</Eyebrow>
          {sheet.sprint ? (
            <ul className="grid gap-1.5 text-[13px]">
              {sheet.sprint.moves.slice(0, 6).map((m) => (
                <li key={m.id} className="flex items-baseline gap-2">
                  <span aria-hidden className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${m.status === "done" ? "bg-ok" : m.status === "doing" ? "bg-warn" : m.status === "skipped" ? "bg-faint" : "bg-line"}`} />
                  <span className={m.status === "done" || m.status === "skipped" ? "text-faint line-through decoration-faint" : "text-fg"}>{m.title}</span>
                </li>
              ))}
            </ul>
          ) : res ? (
            <p className="text-[13px] leading-relaxed text-muted">{res.verdict.summary}</p>
          ) : (
            <p className="text-sm text-muted">No plan yet.</p>
          )}
          <button type="button" onClick={() => onTab("actions")} className="inline-flex min-h-11 w-fit items-center text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
            The moves →
          </button>
        </section>
      </div>
      {klaviyo ? (
        <ChangeHistory sheet={sheet} />
      ) : (
        <p className="rounded-[14px] border border-dashed border-line px-4 py-3 text-[13px] leading-relaxed text-muted">The change history reads Klaviyo accounts. {r.provider === "brevo" ? "Brevo" : "Customer.io"} isn&apos;t read for changes yet, so whether the moves are happening goes by what the team ticks.</p>
      )}
    </>
  );
}

const KIND_DOT: Record<string, string> = { created: "bg-ok", edited: "bg-fg/60", scheduled: "bg-brand", sent: "bg-faint", status: "bg-warn", published: "bg-ok", removed: "bg-bad" };

/** Every change seen in the account, newest first and grouped by day, with how busy the last two weeks were */
function ChangeHistory({ sheet }: { sheet: EmailSheet }) {
  const [all, setAll] = useState(false);
  const list = sheet.changes;
  const shown = all ? list : list.slice(0, 15);
  const last = lastManual(list);
  const week = list.filter((c) => c.manual && sheet.now - Date.parse(c.at) < 7 * 86_400_000).length;
  const active = activeDays(list, new Date(sheet.now - 14 * 86_400_000).toISOString());
  const days: { day: string; items: typeof list }[] = [];
  for (const c of shown) {
    const day = new Date(c.at).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
    if (days.at(-1)?.day === day) days.at(-1)!.items.push(c);
    else days.push({ day, items: [c] });
  }
  return (
    <section className="grid gap-4 rounded-[16px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Change history · Klaviyo</Eyebrow>
        {list.length > 0 && (
          <span className="text-[11px] text-faint">
            {week} {week === 1 ? "change" : "changes"} in 7 days · active on {active} of the last 14 days{last ? ` · latest ${agoShort(last.at, sheet.now)} ago` : ""}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted">{sheet.changesRead.readAt ? "No changes seen in the account yet: nothing created, edited, scheduled or switched on or off in the last 30 days." : "The change history fills in from the next Klaviyo sync (every 30 minutes in business hours), with the last 30 days."}</p>
      ) : (
        <ol className="grid gap-4">
          {days.map((d) => (
            <li key={d.day} className="grid gap-1.5">
              <p className="text-[11px] text-faint">{d.day}</p>
              <ul className="grid gap-0.5">
                {d.items.map((c) => (
                  <li key={c.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-surface-2/60">
                    <span aria-hidden className={`h-2 w-2 translate-y-[-1px] rounded-full ${KIND_DOT[c.kind] ?? "bg-faint"}`} />
                    <span className={`min-w-0 text-[13px] ${c.manual ? "text-fg" : "text-muted"}`}>
                      {changeText(c)}
                      {!c.manual && <span className="text-faint"> · went out as scheduled</span>}
                    </span>
                    <span className="tabular text-[11px] text-faint">{new Date(c.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {list.length > 15 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="min-h-11 justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
      <p className="text-[11px] leading-relaxed text-faint">
        Read from Klaviyo on each sync: when each campaign, flow, flow step, template, list, segment and form was created or last updated, and its status. Several edits between two reads show as one, and Klaviyo doesn&apos;t say who made a change.
        {sheet.changesRead.readAt && ` Last read ${stamp(sheet.changesRead.readAt)}.`}
        {sheet.changesRead.error && <span className="text-warn"> {sheet.changesRead.error}</span>}
      </p>
    </section>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

function Settings({ r, month, klaviyo }: { r: ChannelRow; month: Month; klaviyo: boolean }) {
  const synced = freshness(r.lastSyncedAt);
  return (
    <>
      <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
        <div>
          <h2 className="font-heading text-lg">Monthly revenue target</h2>
          <div className="mt-1 grid gap-1 text-xs text-faint">
            {r.revenueTarget?.floor != null ? (
              <p className="tabular text-sm text-fg">
                Last month {moneyShort(r.revenueTarget.lastMonth, r.currency)} · target +10% = {moneyShort(r.revenueTarget.floor, r.currency)}
              </p>
            ) : (
              <p>No revenue read for last month, so there is no automatic target yet.</p>
            )}
            <p>
              Every month aims at least 10% over the last, worked out by itself. A target set here counts only when it&apos;s higher.
              {r.revenueTarget?.source === "manual" && ` Now pacing against ${moneyShort(r.revenueTarget.manual, r.currency)}${r.targetBy ? `, set by ${r.targetBy}` : ""}.`}
              {r.revenueTarget?.source === "floor" && r.revenueTarget.manual != null && ` The ${moneyShort(r.revenueTarget.manual, r.currency)} set here is under the floor, so the floor holds.`} The score stays the account&apos;s health; this is the growth goal.
            </p>
          </div>
        </div>
        {r.canEdit ? (
          <ActionForm action={setChannelTarget.bind(null, r.clientId, "email")} submitLabel="Save target" autosave className="grid gap-3">
            <label className={labelCls}>
              {`A higher target for ${new Date(`${month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} (optional)`}
              <input name="target" defaultValue={r.targetManual == null ? "" : String(Math.round(r.targetManual))} inputMode="decimal" className={`${field} tabular`} placeholder={r.revenueTarget?.floor != null ? String(Math.ceil(r.revenueTarget.floor * 1.1)) : "12000"} autoComplete="off" />
            </label>
            <label className={labelCls}>
              Where it came from (optional)
              <input name="notes" defaultValue={r.targetNote ?? ""} className={field} placeholder="Agreed on the kickoff call" autoComplete="off" />
            </label>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted">{r.target == null ? "No target yet." : targetText(r)} The team on this client, leads and execs can change it.</p>
        )}
      </section>

      <section className="grid gap-2 rounded-[16px] border border-line bg-surface p-4 text-sm md:p-5">
        <h2 className="font-heading text-lg">Where the numbers come from</h2>
        <p className="text-muted">
          {r.data === "missing" ? "Email isn't connected." : r.account ? `${r.account}.` : "Connected."} {r.lastSyncedAt && <span suppressHydrationWarning>{synced.label}.</span>}
        </p>
        {needsConnecting(r) && <ConnectCta r={r} />}
        {r.warning && <p className="text-xs text-warn">{r.warning}</p>}
        {!needsConnecting(r) && r.problem && (
          <p className="text-xs text-muted">
            {r.problem.message}. {r.problem.fix}
          </p>
        )}
        {r.data !== "missing" && klaviyo && <KlaviyoMetricPicker clientId={r.clientId} current={r.conversionMetrics ?? []} fallback={r.conversionMetric ?? null} canPick={r.canConnect} />}
        {r.data !== "missing" && klaviyo && <KlaviyoLocations clientId={r.clientId} />}
        {r.team.length > 0 && <p className="text-xs text-faint">On it: {r.team.map((t) => `${t.name} (${t.seat})`).join(", ")}</p>}
      </section>
    </>
  );
}
