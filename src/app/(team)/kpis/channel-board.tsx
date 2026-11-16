"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { ChannelSpark } from "@/components/channel-spark";
import { KlaviyoMetricPicker } from "@/components/klaviyo-metric-picker";
import { ChannelStatusPill, ConnectCta, Gauge, SupportChips, TONE, mainCaption, mainText, needsConnecting, num, paceLine, signed, targetText } from "@/components/channel-parts";
import { BAND_TONE, ScoreBadge, ScoreChecks, WeighingDown, checkText } from "@/components/email-score-parts";
import { field, label as labelCls } from "@/components/ui";
import { freshness } from "@/lib/dates";
import { moneyShort, pctText, STATUS_LABEL, type ChannelStatus, type Month } from "@/lib/channel-kpis/calc";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { Layer } from "../clients/[slug]/layer";
import { EmailRevenueChart, RevenuePace } from "@/components/email-revenue-chart";
import { RANK_LABEL } from "@/lib/email-metrics";
import { BoardBreakdown } from "./board-breakdown";
import { klaviyoReadProgress, setChannelTarget, type ReadState } from "./channel-actions";

// The Email and Social KPI boards: every client of the line against this month's target, worst first. One board for both
// lines (the main number and the supporting numbers differ). Where you are (filters, the open client) lives in the
// address, so back and forward walk through it.

export type BoardSwitch = { id: string; label: string; count?: number | null; href: string; active: boolean };

const TILES: ChannelStatus[] = ["excellent", "good", "close", "off"];
// Email boards read the score's bands in the same status slots: green is "good", yellow "close", red "off"
const EMAIL_TILES: { status: ChannelStatus; band: "good" | "watch" | "bad"; hint: string }[] = [
  { status: "good", band: "good", hint: "Score 80 and up" },
  { status: "close", band: "watch", hint: "Score 60 to 79" },
  { status: "off", band: "bad", hint: "Score under 60" },
];
type Sort = "score" | "name" | "revenue";
const SORTS: { id: Sort; label: string }[] = [
  { id: "score", label: "Worst score first" },
  { id: "name", label: "Name" },
  { id: "revenue", label: "Revenue" },
];

const TILE_HINT: Record<string, string> = { excellent: "20%+ better than target", good: "At or better than target", close: "Up to 15% off target", off: "More than 15% off target" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "none yet");

export function ChannelBoard({ line, rows: given, month, switcher, initialWho, lastSync }: { line: "email" | "social"; rows: ChannelRow[]; month: Month; switcher: BoardSwitch[] | null; initialWho: "all" | "mine"; lastSync: string | null }) {
  const sp = useSearchParams();
  const who = (sp.get("who") as "all" | "mine" | null) ?? initialWho;
  const status = (sp.get("status") as ChannelStatus | null) ?? "all";
  const open = sp.get("open");
  // A key pasted on the board marks its card at once ("First read in progress") instead of working the whole board out
  // again, so the next client can be connected straight away; the numbers show the next time the board loads
  const [justConnected, setJustConnected] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const on = (e: Event) => setJustConnected((s) => new Set(s).add(String((e as CustomEvent).detail)));
    window.addEventListener("klaviyo-connected", on);
    return () => window.removeEventListener("klaviyo-connected", on);
  }, []);
  const rows = justConnected.size ? given.map((r) => (justConnected.has(r.clientId) && (r.data === "missing" || r.data === "failing") ? { ...r, data: "pending" as ChannelRow["data"], problem: null } : r)) : given;
  // The cards still reading Klaviyo show how far along the first read is (polled every few seconds, only while some are
  // reading); one that finishes brings the board up to date once, so its numbers appear
  const router = useRouter();
  const readingKey = rows.filter((r) => r.line === "email" && r.data === "pending").map((r) => r.clientId).join(",");
  const [progress, setProgress] = useState<Record<string, ReadState>>({});
  const refreshedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!readingKey) return;
    const ids = readingKey.split(",");
    let stopped = false;
    const tick = async () => {
      const got = await klaviyoReadProgress(ids).catch(() => ({}) as Record<string, ReadState>);
      if (stopped) return;
      setProgress((p) => ({ ...p, ...got }));
      const finished = ids.filter((id) => got[id]?.done && !got[id]?.error && !refreshedFor.current.has(id));
      if (finished.length) {
        for (const id of finished) refreshedFor.current.add(id);
        router.refresh();
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [readingKey, router]);
  const [q, setQ] = useState(() => sp.get("q") ?? "");
  // History API, so nothing reloads and the browser's back walks the board's states
  const go = (patch: Record<string, string | null>, how: "push" | "replace" = "push") => {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    if (u.href !== window.location.href) window.history[how === "push" ? "pushState" : "replaceState"](null, "", u);
  };
  const channel = line === "email" ? "Email" : "Social";
  const hasMine = rows.some((r) => r.mine);
  const base = rows.filter((r) => who === "all" || r.mine);
  const term = q.trim().toLowerCase();
  const sortRaw = sp.get("sort");
  const sort: Sort = SORTS.some((x) => x.id === sortRaw) ? (sortRaw as Sort) : "score";
  const filtered = base.filter((r) => (status === "all" || r.status === status) && (term.length < 2 || `${r.name} ${r.kaizenId ?? ""}`.toLowerCase().includes(term)));
  // Email's rows arrive worst score first; the switch re-orders them here (social keeps its own order)
  const shown = line === "email" && sort !== "score" ? [...filtered].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : (b.value ?? -1) - (a.value ?? -1))) : filtered;
  const count = (s: ChannelStatus) => base.filter((r) => r.status === s).length;
  const unset = count("unset");
  const connecting = base.filter(needsConnecting).length;
  const openRow = open ? (rows.find((r) => r.clientId === open) ?? null) : null;
  const step = (dir: 1 | -1) => {
    const at = shown.findIndex((r) => r.clientId === open);
    if (at >= 0 && shown.length > 1) go({ open: shown[(at + dir + shown.length) % shown.length].clientId });
  };
  const synced = freshness(lastSync);

  // The summary tile: email adds revenue up, social reads the whole line's rate
  const email = line === "email";
  const mtd = base.reduce((t, r) => t + (r.value ?? 0), 0);
  const projected = base.reduce((t, r) => t + (r.projected ?? 0), 0);
  const targeted = base.filter((r) => r.target != null && r.value != null);
  const targetSum = targeted.reduce((t, r) => t + (r.target ?? 0), 0);
  const reach = base.reduce((t, r) => t + (r.social?.reach ?? 0), 0);
  const inter = base.reduce((t, r) => t + (r.social?.interactions ?? 0), 0);
  const posts = base.reduce((t, r) => t + (r.social?.posts ?? 0), 0);
  const scored = base.filter((r) => r.score);
  const avgScore = scored.length ? Math.round(scored.reduce((t, r) => t + (r.score?.score ?? 0), 0) / scored.length) : null;

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">KPIs</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {line === "email" ? "Each client's email account score, 0 to 100, with what is weighing it down." : "How each client's engagement rate is holding against its target."}
            <span suppressHydrationWarning className="inline-flex items-center gap-1.5 text-xs text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${synced.tone === "ok" ? "bg-ok" : synced.tone === "warn" ? "bg-warn" : "bg-faint/60"}`} />
              {lastSync ? `${synced.label} · refreshed hourly` : "Not synced yet"}
            </span>
          </p>
        </div>
        {/* The same switch and Add KPI as the ads board, so moving between tabs only changes the board under it; each tab is
            prefetched as soon as the board shows, so switching opens a page that is already loaded */}
        {switcher && (
          <div className="flex w-full items-center gap-2 md:w-auto">
            <nav aria-label="KPI board" className="flex flex-1 rounded-full border border-line bg-surface p-1 md:inline-flex md:flex-none">
              {switcher.map((s) => (
                <Link key={s.id} href={s.href} prefetch aria-current={s.active ? "page" : undefined} className={`inline-flex h-10 flex-1 items-center justify-center gap-1 rounded-full px-3 text-sm transition-colors md:h-8 md:flex-none md:px-4 ${s.active ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {s.label}
                  {s.count != null && <span className="tabular opacity-60">{s.count}</span>}
                </Link>
              ))}
            </nav>
            <Link href="/kpis?p=meta&add=new" className="inline-flex h-12 shrink-0 items-center rounded-[8px] bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover md:h-10">
              Add KPI
            </Link>
          </div>
        )}
      </header>

      {!rows.length ? (
        <div className="grid justify-items-start gap-3 rounded-[18px] border border-dashed border-line p-6 md:p-8">
          <p className="font-heading text-xl">No {channel.toLowerCase()} clients yet</p>
          <p className="max-w-prose text-sm text-muted">Clients show here once they buy {line === "email" ? "Email Marketing" : "Social Media"} and you hold a seat on them.</p>
          <Link href="/clients" className="inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg">
            Open your clients
          </Link>
        </div>
      ) : (
        <>
          {/* Where things stand */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
            {(email ? EMAIL_TILES.map((t) => t.status) : TILES).map((t) => {
              const on = status === t;
              const n = count(t);
              const band = EMAIL_TILES.find((x) => x.status === t);
              return (
                <button key={t} onClick={() => go({ status: on ? null : t })} className={`group relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border bg-surface p-3.5 text-left transition-colors md:p-4 ${on ? "border-fg/40" : "border-line hover:border-faint/60"}`}>
                  <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${TONE[t].bar}`} />
                  <span className="text-xs text-muted">{email && band ? BAND_TONE[band.band].label : STATUS_LABEL[t]}</span>
                  <span className={`tabular font-heading text-[30px] leading-none ${n ? TONE[t].text : "text-faint"}`}>{n}</span>
                  <span className="text-[11px] text-faint">{email && band ? band.hint : TILE_HINT[t]}</span>
                </button>
              );
            })}
            {email && (
              <div className="relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border border-line bg-surface p-3.5 md:p-4">
                <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${avgScore == null ? "bg-faint" : BAND_TONE[avgScore >= 80 ? "good" : avgScore >= 60 ? "watch" : "bad"].bar}`} />
                <span className="text-xs text-muted">Average score</span>
                <span className={`tabular font-heading text-[30px] leading-none ${avgScore == null ? "text-faint" : BAND_TONE[avgScore >= 80 ? "good" : avgScore >= 60 ? "watch" : "bad"].text}`}>{avgScore ?? "n/a"}</span>
                <span className="text-[11px] text-faint">{scored.length} scored {scored.length === 1 ? "account" : "accounts"}</span>
              </div>
            )}
            <div className="col-span-2 grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-4 xl:col-span-1">
              {email ? (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-muted">Attributed revenue this month, all accounts</span>
                    {targetSum > 0 && (
                      <span className="tabular text-xs text-faint">
                        lands at <span className="text-fg">{moneyShort(targeted.reduce((t, r) => t + (r.projected ?? 0), 0))}</span> of {moneyShort(targetSum)}
                      </span>
                    )}
                  </div>
                  <span className="tabular font-heading text-[30px] leading-none">{moneyShort(mtd)}</span>
                  <SplitBar a={base.reduce((t, r) => t + (r.email?.campaignRevenue ?? 0), 0)} b={base.reduce((t, r) => t + (r.email?.flowRevenue ?? 0), 0)} />
                  <span className="text-[11px] text-faint">All {base.filter((r) => r.value != null).length} connected clients at this pace: {moneyShort(projected)}</span>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted">Engagement this month</span>
                  <span className="tabular font-heading text-[30px] leading-none">{pctText(reach > 0 ? inter / reach : null)}</span>
                  <span className="text-[11px] text-faint">
                    {num(inter)} interactions over {num(reach)} reach · {posts} {posts === 1 ? "post" : "posts"} published
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav className="flex items-center gap-1.5">
              {([["all", "Everyone"], ...(hasMine ? ([["mine", "Mine"]] as const) : [])] as const).map(([id, name]) => (
                <button key={id} onClick={() => go({ who: id === initialWho ? null : id })} className={`inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm transition-colors md:h-9 ${who === id ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
                  {name}
                </button>
              ))}
            </nav>
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                go({ q: e.target.value.trim() || null }, "replace");
              }}
              placeholder="Search clients"
              aria-label="Search clients"
              className="h-11 w-full max-w-full rounded-full border border-line bg-surface px-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70 md:h-10 md:w-64"
            />
          </div>
          {email && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
              Order
              <div role="radiogroup" aria-label="Order accounts" className="flex gap-1 rounded-full border border-line bg-surface p-1">
                {SORTS.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={sort === o.id} onClick={() => go({ sort: o.id === "score" ? null : o.id })} className={`min-h-11 rounded-full px-3 text-[12.5px] transition-colors md:min-h-8 ${sort === o.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {status !== "all" && (
            <p className="-mt-3 text-xs text-faint">
              Showing {shown.length} <span className={TONE[status].text}>{(email && EMAIL_TILES.find((x) => x.status === status) ? BAND_TONE[EMAIL_TILES.find((x) => x.status === status)!.band].label : STATUS_LABEL[status]).toLowerCase()}</span>
              <button onClick={() => go({ status: null })} className="ml-2 py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
                Show all
              </button>
            </p>
          )}

          {shown.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shown.map((r) => (
                <Card key={r.clientId} r={r} reading={progress[r.clientId] ?? null} active={open === r.clientId} onOpen={() => go({ open: r.clientId })} />
              ))}
            </ul>
          ) : (
            <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">Nothing here.</p>
          )}

          {status === "all" && ((!email && unset > 0) || connecting > 0) && (
            <p className="text-center text-xs text-faint">
              {!email && unset > 0 && (
                <>
                  <button type="button" onClick={() => go({ status: "unset" })} className="py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
                    {unset} with no target set
                  </button>{" "}
                  · their numbers show without colors until one is set
                </>
              )}
              {!email && unset > 0 && connecting > 0 && " · "}
              {connecting > 0 && (
                <button type="button" onClick={() => go({ status: "setup" })} className="py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
                  {connecting} {connecting === 1 ? "needs" : "need"} connecting
                </button>
              )}
            </p>
          )}
        </>
      )}
      {openRow && <Detail key={openRow.clientId} r={openRow} month={month} onClose={() => go({ open: null })} onStep={step} />}
    </div>
  );
}

/** Campaign against flow revenue, as one bar and its numbers */
function SplitBar({ a, b }: { a: number; b: number }) {
  const t = a + b;
  return (
    <div className="grid gap-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Campaign and flow revenue">
        <span className="h-full bg-brand" style={{ width: t ? `${(a / t) * 100}%` : "0%" }} />
        <span className="h-full bg-fg/60" style={{ width: t ? `${(b / t) * 100}%` : "0%" }} />
      </div>
      <span className="tabular flex justify-between text-[11px] text-faint">
        <span>Campaigns {moneyShort(a)}</span>
        <span>Flows {moneyShort(b)}</span>
      </span>
    </div>
  );
}

/**
 * Who is on the account: the strategist (in charge) first, then the designer and builder (graphic designer and video
 * editor on social). A name the Account Overview sheet gives who isn't in the app yet is dimmed, with why on hover.
 */
function Crew({ r }: { r: ChannelRow }) {
  const lead = r.team.filter((t) => t.seat === "Strategist");
  const rest = r.team.filter((t) => t.seat !== "Strategist");
  const who = (t: ChannelRow["team"][number]) => (
    <span key={`${t.seat}-${t.name}`} className={t.pending ? "opacity-60" : undefined} title={t.pending ? `${t.name} is named in the Account Overview sheet but isn't in the app yet: invite them and the next sheet sync seats them` : undefined}>
      {t.name}
    </span>
  );
  return (
    <>
      <p className="mt-0.5 truncate text-xs text-faint">
        {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
        {lead.length ? (
          <>
            <span className="text-muted">Strategist</span> {lead.map((t, i) => [i ? " + " : "", who(t)])}
          </>
        ) : (
          "No strategist yet"
        )}
      </p>
      {rest.length > 0 && (
        <p className="truncate text-xs text-faint">
          {rest.map((t, i) => (
            <span key={`${t.seat}-${t.name}`}>
              {i ? " · " : ""}
              <span className="text-muted">{t.seat}</span> {who(t)}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function Card({ r, reading, active, onOpen }: { r: ChannelRow; reading: ReadState | null; active: boolean; onOpen: () => void }) {
  const tone = TONE[r.status];
  const connect = needsConnecting(r);
  const pace = paceLine(r);
  const goal = r.target != null && r.series.length ? (r.line === "email" ? { from: 0, to: r.target } : { from: r.target, to: r.target }) : null;
  return (
    <li id={`kpi-${r.clientId}`} className="scroll-mt-24">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={`group relative isolate flex h-full w-full flex-col gap-3 overflow-hidden rounded-[20px] border bg-surface p-4 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/40 ${active ? "border-fg/40" : "border-line hover:border-faint/60"}`}
        style={{ backgroundImage: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tone.css} 15%, transparent), transparent 55%)` }}
      >
        <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-heading text-[16px] leading-snug">{r.name}</p>
            <Crew r={r} />
          </div>
          <ChannelStatusPill status={r.status} line={r.line} />
        </div>

        {/* Every card keeps the same shell (header, a body that fills the card, the footer at the bottom), so a card
            waiting on a connection sits as evenly in the grid as one with numbers */}
        {connect && r.line === "email" && r.data === "pending" ? (
          // Reading: a live bar (how far along, and the step), so it doesn't look like every other card waiting
          <div className="flex flex-1 flex-col justify-center gap-2.5 rounded-[14px] border border-brand/30 bg-brand/5 px-4 py-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-fg">Reading Klaviyo</span>
              <span className="tabular text-sm font-medium text-brand-text">{reading ? `${reading.pct}%` : "Starting"}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading?.pct ?? 0} aria-label={`${r.name}: reading Klaviyo`}>
              <span className="block h-full rounded-full bg-brand transition-[width] duration-700 ease-out" style={{ width: `${Math.max(4, reading?.pct ?? 0)}%` }} />
            </div>
            <span className="truncate text-xs text-faint">{reading?.error ? `Couldn't finish: ${reading.error}` : (reading?.step ?? "The first 90 days, a few minutes")}</span>
          </div>
        ) : connect ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-1 rounded-[14px] border border-dashed border-line px-4 py-5">
            <span className="text-sm text-fg">{r.data === "missing" ? (r.line === "email" ? "Klaviyo isn't connected" : "Social isn't linked") : r.data === "failing" ? "Not reading right now" : r.data === "pending" ? "First read in progress" : "No numbers yet"}</span>
            <span className="text-xs text-faint">{r.data === "pending" ? "Numbers show once the first read lands" : "Open to connect it"}</span>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-1.5">
            {r.line === "email" ? (
              // Email, top to bottom: the score and the key numbers, the month's revenue to scrub, what weighs the score down
              <>
                {r.score ? (
                  <div className="flex items-baseline gap-2">
                    <ScoreBadge r={r.score} />
                    <span className="truncate text-xs text-faint">{mainCaption(r)}</span>
                  </div>
                ) : (
                  <span className="text-xs text-faint">No score yet</span>
                )}
                <Gauge r={r} />
                <SupportChips r={r} />
                {r.revenue && (
                  <div className="grid gap-1.5 pt-1">
                    <span className="truncate text-[10.5px] text-faint">{r.conversionMetrics?.[0]?.name ?? r.conversionMetric ?? "Placed Order"} revenue this month</span>
                    <div className="kpi-chart">
                      <EmailRevenueChart id={r.clientId} m={r.revenue} currency={r.currency} compact height={44} />
                    </div>
                    <RevenuePace m={r.revenue} currency={r.currency} compact />
                  </div>
                )}
                {r.score && (
                  <div className="mt-auto min-h-[3.25rem] border-t border-line pt-2.5">
                    <WeighingDown score={r.score} limit={2} currency={r.currency} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-2">
                  <span className={`tabular font-display text-[30px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
                  {r.target != null ? <span className="tabular truncate text-xs text-faint">/ {targetText(r)}</span> : <span className="truncate text-xs text-faint">{mainCaption(r)}</span>}
                </div>
                <Gauge r={r} />
                {r.target == null ? <span className="text-[11.5px] text-muted">No target yet · open to set it</span> : pace && <span className="truncate text-[11.5px] text-muted">{pace}</span>}
                <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} label={`${r.name} trend`} />
              </>
            )}
            {r.line !== "email" && (
              <div className="mt-auto pt-1">
                <SupportChips r={r} />
              </div>
            )}
          </div>
        )}
        {r.warning && !connect && <span className="line-clamp-2 text-[11px] text-warn">Part of the read failed, so this may be low</span>}
        <span className="self-end text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">Open →</span>
      </button>
    </li>
  );
}

/** "Last month $X · target +10% = $Y", or the manual target that beats it */
function targetLine(r: ChannelRow): string {
  const t = r.revenueTarget;
  if (!t || t.target == null) return "";
  if (t.source === "manual") return `Target ${moneyShort(t.target, r.currency)} (set by hand, above +10%)`;
  return `Last month ${moneyShort(t.lastMonth, r.currency)} · target +10% = ${moneyShort(t.target, r.currency)}`;
}

/** Each ranked metric that counts as the sale, side by side: this month's numbers and its weight in the score */
function MetricsSideBySide({ r }: { r: ChannelRow }) {
  const list = r.metricNumbers ?? [];
  const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="grid gap-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">What counts as the sale</p>
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
              <dd className="tabular text-right text-fg">{m.rpr == null ? "n/a" : `${moneyShort(0, r.currency).replace("0", "")}${m.rpr.toFixed(2)}`}</dd>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
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

function Detail({ r, month, onClose, onStep }: { r: ChannelRow; month: Month; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  const tone = TONE[r.status];
  const connect = needsConnecting(r);
  const pace = paceLine(r);
  const goal = r.target != null && r.series.length ? (r.line === "email" ? { from: 0, to: r.target } : { from: r.target, to: r.target }) : null;
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

  const e = r.email;
  const s = r.social;
  const vsLast = r.line === "email" ? (r.projected != null && r.prev ? r.projected / r.prev - 1 : null) : r.value != null && r.prev ? r.value / r.prev - 1 : null;
  const synced = freshness(r.lastSyncedAt);
  // Email edits the manual target only (the floor is worked out by itself)
  const targetDefault = r.line === "email" ? (r.targetManual == null ? "" : String(Math.round(r.targetManual))) : r.target == null ? "" : String(Math.round(r.target * 10000) / 100);

  return (
    <Layer>
      <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${r.name} ${r.line} KPI`}>
        <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-deep/70 backdrop-blur-[2px] motion-safe:animate-[fadeIn_.18s_ease-out]" />
        <div className="relative flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg motion-safe:animate-[sheetIn_.24s_cubic-bezier(.2,.8,.2,1)] md:w-[min(880px,94vw)]">
          <header className="relative isolate shrink-0 border-b border-line bg-surface/80 backdrop-blur" style={{ backgroundImage: `radial-gradient(90% 140% at 0% 0%, color-mix(in srgb, ${tone.css} 18%, transparent), transparent 60%)` }}>
            <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+16px)] sm:px-6 md:pt-5">
              <div className="grid min-w-0 gap-1">
                <p className="truncate font-heading text-xl leading-tight md:text-2xl">{r.name}</p>
                <p className="truncate text-xs text-faint">
                  {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
                  {r.line === "email" ? "Email" : "Social"}
                  {r.account ? ` · ${r.account}` : ""}
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
                <div className="flex items-center gap-2">
                  <ChannelStatusPill status={r.status} line={r.line} />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {r.score ? <ScoreBadge r={r.score} size="lg" /> : <span className={`tabular font-display text-[34px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>}
                    <span className="tabular text-sm text-faint">{r.line === "email" ? "" : r.target != null ? `/ ${targetText(r)} · ` : ""}{mainCaption(r)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelStatusPill status={r.status} line={r.line} />
                    {pace && <span className="text-xs text-muted">{pace}</span>}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/clients/${r.slug}?service=${r.line}`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
                  Client page →
                </Link>
                <Link href={`/reports?client=${r.slug}`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
                  Reports →
                </Link>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)] sm:px-6">
            <div className="grid gap-5">
              {connect && <ConnectCta r={r} />}

              {!connect && r.line === "email" && e && (
                <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                  <Stat k="Campaign revenue" v={moneyShort(e.campaignRevenue, r.currency)} hint={`${e.campaignsSent} ${e.campaignsSent === 1 ? "campaign" : "campaigns"} sent`} />
                  <Stat k="Flow revenue" v={moneyShort(e.flowRevenue, r.currency)} hint={r.value ? `${Math.round((e.flowRevenue / r.value) * 100)}% of the total` : undefined} />
                  <Stat k="vs last month" v={vsLast == null ? "n/a" : `${vsLast >= 0 ? "+" : "-"}${Math.abs(Math.round(vsLast * 100))}%`} hint={r.prev != null ? `Last month ${moneyShort(r.prev, r.currency)}, this month at pace` : undefined} />
                  <Stat k="Open rate" v={pctText(e.openRate)} hint="Email campaigns this month" />
                  <Stat k="Click rate" v={pctText(e.clickRate)} hint="Email campaigns this month" />
                  <Stat k="List growth" v={signed(e.listNet)} hint="Subscribed less unsubscribed" />
                  <Stat k="Orders attributed" v={num(e.orders)} hint="Placed by email and SMS" />
                  <Stat k="Store orders" v={num(e.storeOrders)} hint="All orders Klaviyo sees" />
                  <Stat k="Last campaign" v={when(e.lastSendAt)} hint={r.quietDays != null && r.quietDays >= 14 ? `${r.quietDays} days ago` : undefined} />
                </dl>
              )}

              {!connect && r.line === "email" && r.metricNumbers && r.metricNumbers.length > 1 && <MetricsSideBySide r={r} />}

              {!connect && r.line === "email" && r.revenue && (
                <section className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="grid gap-0.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{r.conversionMetrics?.[0]?.name ?? r.conversionMetric ?? "Placed Order"} revenue this month</p>
                      <p className="text-sm text-muted">Running total against the target&apos;s even pace (dashed), last month in grey. Slide across to read any day.</p>
                    </div>
                    {r.revenueTarget?.target != null && <p className="tabular text-xs text-faint">{targetLine(r)}</p>}
                  </div>
                  <EmailRevenueChart id={`${r.clientId}-sheet`} m={r.revenue} currency={r.currency} />
                  <RevenuePace m={r.revenue} currency={r.currency} />
                </section>
              )}

              {!connect && r.line === "email" && r.score && (
                <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4 md:grid-cols-2 md:p-5">
                  <div className="grid content-start gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">The seven checks</p>
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

              {!connect && r.line === "social" && (
                <div className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
                  <div className="grid gap-0.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Last 30 days</p>
                    <p className="text-sm text-muted">Engagement rate over the 7 days up to each day, with the target as the dashed line</p>
                  </div>
                  <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} tall label={`${r.name} trend`} />
                </div>
              )}
              {!connect && r.line === "social" && s && (
                <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                  <Stat k="Followers" v={num(s.followers)} hint={s.followersChange == null ? undefined : `${signed(s.followersChange)} ${r.basis === "month" ? "this month" : "in 30 days"}`} />
                  <Stat k="Reach" v={num(s.reach)} hint={r.basis === "month" ? "This month" : "Last 30 days"} />
                  <Stat k="Views" v={num(s.views)} hint={r.basis === "month" ? "This month" : "Last 30 days"} />
                  <Stat k="Interactions" v={num(s.interactions)} hint="Likes, comments, shares, saves" />
                  <Stat k="Posts published" v={String(s.posts)} hint={s.lastPostAt ? `Last one ${when(s.lastPostAt)}` : "None in this window"} />
                  <Stat k="vs last month" v={vsLast == null ? "n/a" : `${vsLast >= 0 ? "+" : "-"}${Math.abs(Math.round(vsLast * 100))}%`} hint={r.prev != null ? `Last month ${pctText(r.prev)}` : undefined} />
                  {s.topPost && (
                    <div className="col-span-2 grid gap-1 rounded-[12px] border border-line bg-surface p-3 md:col-span-3">
                      <dt className="text-[11px] text-faint">Top post · {s.topPost.interactions.toLocaleString("en-US")} interactions · {s.topPost.platform === "instagram" ? "Instagram" : "Facebook"}</dt>
                      <dd className="line-clamp-2 text-sm text-fg">{s.topPost.caption?.trim() || "No caption"}</dd>
                      {s.topPost.permalink && (
                        <dd>
                          <a href={s.topPost.permalink} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
                            Open the post
                          </a>
                        </dd>
                      )}
                    </div>
                  )}
                </dl>
              )}

              {!connect && r.line === "email" && r.score && <BoardBreakdown clientId={r.clientId} currency={r.currency} />}

              {/* The target */}
              <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
                <div>
                  <h2 className="font-heading text-lg">{r.line === "email" ? "Monthly revenue target" : "Engagement target"}</h2>
                  {r.line === "email" ? (
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
                  ) : (
                    <p className="mt-0.5 text-xs text-faint">{r.target == null ? "Set it and every number on this client gets its color." : r.targetBy ? `Set by ${r.targetBy}${r.targetAt ? ` on ${when(r.targetAt)}` : ""}.` : "Saved."} The reports use it too.</p>
                  )}
                </div>
                {r.canEdit ? (
                  <ActionForm action={setChannelTarget.bind(null, r.clientId, r.line)} submitLabel="Save target" autosave className="grid gap-3">
                    <label className={labelCls}>
                      {r.line === "email" ? `A higher target for ${new Date(`${month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} (optional)` : "Engagement rate target (%)"}
                      <input name="target" defaultValue={targetDefault} inputMode="decimal" className={`${field} tabular`} placeholder={r.line === "email" ? (r.revenueTarget?.floor != null ? String(Math.ceil(r.revenueTarget.floor * 1.1)) : "12000") : "3.5"} autoComplete="off" />
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

              {/* Where the numbers come from */}
              <section className="grid gap-2 rounded-[16px] border border-line bg-surface p-4 text-sm md:p-5">
                <h2 className="font-heading text-lg">Where the numbers come from</h2>
                <p className="text-muted">
                  {r.data === "missing" ? (r.line === "email" ? "Klaviyo isn't connected." : "Facebook and Instagram aren't linked.") : r.account ? `${r.account}.` : "Connected."}{" "}
                  {r.lastSyncedAt && <span suppressHydrationWarning>{synced.label}.</span>}
                </p>
                {r.warning && <p className="text-xs text-warn">{r.warning}</p>}
                {!connect && r.problem && (
                  <p className="text-xs text-muted">
                    {r.problem.message}. {r.problem.fix}
                  </p>
                )}
                {r.line === "email" && r.data !== "missing" && <KlaviyoMetricPicker clientId={r.clientId} current={r.conversionMetrics ?? []} fallback={r.conversionMetric ?? null} canPick={r.canConnect} />}
                {r.team.length > 0 && <p className="text-xs text-faint">On it: {r.team.map((t) => `${t.name} (${t.seat})`).join(", ")}</p>}
              </section>
            </div>
          </div>
        </div>
      </div>
    </Layer>
  );
}
