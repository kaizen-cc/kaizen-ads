"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { ChannelSpark } from "@/components/channel-spark";
import { ChannelStatusPill, ConnectCta, Gauge, SupportChips, TONE, mainCaption, mainText, needsConnecting, num, paceLine, signed, targetText } from "@/components/channel-parts";
import { field, label as labelCls } from "@/components/ui";
import { freshness } from "@/lib/dates";
import { moneyShort, pctText, STATUS_LABEL, type ChannelStatus, type Month } from "@/lib/channel-kpis/calc";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { Layer } from "../clients/[slug]/layer";
import { setChannelTarget } from "./channel-actions";

// The Email and Social KPI boards: every client of the line against this month's target, worst first. One board for both
// lines (the main number and the supporting numbers differ). Where you are (filters, the open client) lives in the
// address, so back and forward walk through it.

export type BoardSwitch = { id: string; label: string; href: string; active: boolean };

const TILES: ChannelStatus[] = ["excellent", "good", "close", "off"];
const TILE_HINT: Record<string, string> = { excellent: "20%+ better than target", good: "At or better than target", close: "Up to 15% off target", off: "More than 15% off target" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "none yet");

export function ChannelBoard({ line, rows, month, switcher, initialWho, lastSync }: { line: "email" | "social"; rows: ChannelRow[]; month: Month; switcher: BoardSwitch[] | null; initialWho: "all" | "mine"; lastSync: string | null }) {
  const sp = useSearchParams();
  const who = (sp.get("who") as "all" | "mine" | null) ?? initialWho;
  const status = (sp.get("status") as ChannelStatus | null) ?? "all";
  const open = sp.get("open");
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
  const shown = base.filter((r) => (status === "all" || r.status === status) && (term.length < 2 || `${r.name} ${r.kaizenId ?? ""}`.toLowerCase().includes(term)));
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

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">KPIs</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {line === "email" ? "How each client's Klaviyo revenue is pacing toward its monthly target." : "How each client's engagement rate is holding against its target."}
            <span suppressHydrationWarning className="inline-flex items-center gap-1.5 text-xs text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${synced.tone === "ok" ? "bg-ok" : synced.tone === "warn" ? "bg-warn" : "bg-faint/60"}`} />
              {lastSync ? `${synced.label} · refreshed hourly` : "Not synced yet"}
            </span>
          </p>
        </div>
        {switcher && (
          <nav aria-label="KPI board" className="flex w-full rounded-full border border-line bg-surface p-1 md:inline-flex md:w-auto">
            {switcher.map((s) => (
              <Link key={s.id} href={s.href} aria-current={s.active ? "page" : undefined} className={`inline-flex h-10 flex-1 items-center justify-center rounded-full px-3 text-sm transition-colors md:h-8 md:flex-none md:px-4 ${s.active ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {s.label}
              </Link>
            ))}
          </nav>
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
            {TILES.map((t) => {
              const on = status === t;
              const n = count(t);
              return (
                <button key={t} onClick={() => go({ status: on ? null : t })} className={`group relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border bg-surface p-3.5 text-left transition-colors md:p-4 ${on ? "border-fg/40" : "border-line hover:border-faint/60"}`}>
                  <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${TONE[t].bar}`} />
                  <span className="text-xs text-muted">{STATUS_LABEL[t]}</span>
                  <span className={`tabular font-heading text-[30px] leading-none ${n ? TONE[t].text : "text-faint"}`}>{n}</span>
                  <span className="text-[11px] text-faint">{TILE_HINT[t]}</span>
                </button>
              );
            })}
            <div className="col-span-2 grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-4 xl:col-span-1">
              {email ? (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-muted">Attributed revenue this month</span>
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
          {status !== "all" && (
            <p className="-mt-3 text-xs text-faint">
              Showing {shown.length} <span className={TONE[status].text}>{STATUS_LABEL[status].toLowerCase()}</span>
              <button onClick={() => go({ status: null })} className="ml-2 py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
                Show all
              </button>
            </p>
          )}

          {shown.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shown.map((r) => (
                <Card key={r.clientId} r={r} active={open === r.clientId} onOpen={() => go({ open: r.clientId })} />
              ))}
            </ul>
          ) : (
            <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">Nothing here.</p>
          )}

          {status === "all" && (unset > 0 || connecting > 0) && (
            <p className="text-center text-xs text-faint">
              {unset > 0 && (
                <>
                  <button type="button" onClick={() => go({ status: "unset" })} className="py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
                    {unset} with no target set
                  </button>{" "}
                  · their numbers show without colors until one is set
                </>
              )}
              {unset > 0 && connecting > 0 && " · "}
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

function Card({ r, active, onOpen }: { r: ChannelRow; active: boolean; onOpen: () => void }) {
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
        className={`group relative isolate grid h-full w-full content-start gap-3 overflow-hidden rounded-[20px] border bg-surface p-4 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/40 ${active ? "border-fg/40" : "border-line hover:border-faint/60"}`}
        style={{ backgroundImage: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tone.css} 15%, transparent), transparent 55%)` }}
      >
        <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-heading text-[16px] leading-snug">{r.name}</p>
            <p className="mt-0.5 truncate text-xs text-faint">
              {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
              {r.team.length ? r.team.map((t) => t.name).join(" + ") : "No one seated"}
            </p>
          </div>
          <ChannelStatusPill status={r.status} />
        </div>

        {connect ? (
          <div className="grid gap-1">
            <span className="text-sm text-muted">{r.data === "missing" ? (r.line === "email" ? "Klaviyo isn't connected" : "Social isn't linked") : r.data === "failing" ? "Not reading right now" : r.data === "pending" ? "First read in progress" : "No numbers yet"}</span>
            <span className="text-xs text-faint">Open for the next step</span>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className={`tabular font-display text-[30px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
              {r.target != null ? <span className="tabular truncate text-xs text-faint">/ {targetText(r)}</span> : <span className="truncate text-xs text-faint">{mainCaption(r)}</span>}
            </div>
            <Gauge r={r} />
            {r.target == null ? <span className="text-[11.5px] text-muted">No target yet · open to set it</span> : pace && <span className="truncate text-[11.5px] text-muted">{pace}</span>}
            <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} label={`${r.name} trend`} />
            <SupportChips r={r} />
          </div>
        )}
        {r.warning && !connect && <span className="line-clamp-2 text-[11px] text-warn">Part of the read failed, so this may be low</span>}
        <span className="ml-auto text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">Open →</span>
      </button>
    </li>
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
  const targetDefault = r.target == null ? "" : r.line === "email" ? String(Math.round(r.target)) : String(Math.round(r.target * 10000) / 100);

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
                  <ChannelStatusPill status={r.status} />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`tabular font-display text-[34px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
                    <span className="tabular text-sm text-faint">{r.target != null ? `/ ${targetText(r)} · ` : ""}{mainCaption(r)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelStatusPill status={r.status} />
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

              {!connect && (
                <div className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
                  <div className="grid gap-0.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{r.line === "email" ? "This month" : "Last 30 days"}</p>
                    <p className="text-sm text-muted">{r.line === "email" ? "Revenue so far, with the dashed line to the target at month end" : "Engagement rate over the 7 days up to each day, with the target as the dashed line"}</p>
                  </div>
                  <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} tall label={`${r.name} trend`} />
                </div>
              )}

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

              {/* The target */}
              <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
                <div>
                  <h2 className="font-heading text-lg">{r.line === "email" ? "Monthly revenue target" : "Engagement target"}</h2>
                  <p className="mt-0.5 text-xs text-faint">
                    {r.target == null ? "Set it and every number on this client gets its color." : r.targetBy ? `Set by ${r.targetBy}${r.targetAt ? ` on ${when(r.targetAt)}` : ""}.` : "Saved."} The reports use it too.
                  </p>
                </div>
                {r.canEdit ? (
                  <ActionForm action={setChannelTarget.bind(null, r.clientId, r.line)} submitLabel="Save target" autosave className="grid gap-3">
                    <label className={labelCls}>
                      {r.line === "email" ? `Revenue target for ${new Date(`${month.start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}, per month` : "Engagement rate target (%)"}
                      <input name="target" defaultValue={targetDefault} inputMode="decimal" className={`${field} tabular`} placeholder={r.line === "email" ? "12000" : "3.5"} autoComplete="off" />
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
                {r.team.length > 0 && <p className="text-xs text-faint">On it: {r.team.map((t) => `${t.name} (${t.seat})`).join(", ")}</p>}
              </section>
            </div>
          </div>
        </div>
      </div>
    </Layer>
  );
}
