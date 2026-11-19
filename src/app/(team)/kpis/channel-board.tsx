"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChannelSpark } from "@/components/channel-spark";
import { ChannelStatusPill, Gauge, SupportChips, TONE, mainCaption, mainText, needsConnecting, num, paceLine, targetText } from "@/components/channel-parts";
import { BAND_TONE, ScoreBadge, WeighingDown, checkText, pointsLost } from "@/components/email-score-parts";
import { freshness } from "@/lib/dates";
import { basisLabel } from "@/lib/social/rate";
import { moneyShort, pctText, STATUS_LABEL, type ChannelStatus, type Month } from "@/lib/channel-kpis/calc";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { EmailRevenueChart, RevenuePace } from "@/components/email-revenue-chart";
import { klaviyoReadProgress, type ReadState } from "./channel-actions";
import { EmailAccountSheet } from "./email-sheet";
import { PlatformPills, SocialAccountSheet } from "./social-sheet";
import { SocialWeighingDown } from "@/components/social-score-parts";
import { PLATFORM_LABEL } from "@/lib/social-score";
import { boardTotals, hasPlatform, parsePlatform, platformsOf, scoreFor } from "@/lib/social/split";
import { closeParams, pushParams, replaceParams } from "@/lib/url-state";
import { KpiSwitch } from "./kpi-switch";

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
  // History API, so nothing reloads and the browser's back walks the board's states (closing a sheet goes back to
  // before it opened, its tabs and views with it)
  const go = (patch: Record<string, string | null>, how: "push" | "replace" = "push") => (how === "push" ? pushParams : replaceParams)(patch);
  const close = () => closeParams("open", "tab", "en", "et", "sug", "elr", "sp");
  const channel = line === "email" ? "Email" : "Social";
  const hasMine = rows.some((r) => r.mine);
  // Social: the platform filter (All, Instagram, Facebook, TikTok once read), in the address like the rest
  const socialPlatforms = line === "social" ? platformsOf(rows.map((r) => r.socialScore)) : [];
  const askedPlatform = parsePlatform(sp.get("pl"));
  const platform = socialPlatforms.includes(askedPlatform as never) ? askedPlatform : "all";
  const base = rows.filter((r) => (who === "all" || r.mine) && (line !== "social" || hasPlatform(r.socialScore, platform)));
  const term = q.trim().toLowerCase();
  const sortRaw = sp.get("sort");
  const sort: Sort = SORTS.some((x) => x.id === sortRaw) ? (sortRaw as Sort) : "score";
  const filtered = base.filter((r) => (status === "all" || r.status === status) && (term.length < 2 || `${r.name} ${r.kaizenId ?? ""}`.toLowerCase().includes(term)));
  // Email's rows arrive worst score first; the switch re-orders them here. Social keeps its own order (worst against
  // its target first) unless the worst score is asked for
  const socialScoreOf = (r: ChannelRow) => scoreFor(r.socialScore, platform)?.score ?? 1000;
  const shown =
    line === "email" && sort !== "score"
      ? [...filtered].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : (b.value ?? -1) - (a.value ?? -1)))
      : line === "social" && sortRaw === "score"
        ? [...filtered].sort((a, b) => socialScoreOf(a) - socialScoreOf(b) || a.name.localeCompare(b.name))
        : line === "social" && sortRaw === "name"
          ? [...filtered].sort((a, b) => a.name.localeCompare(b.name))
          : filtered;
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
  const scoreOfRow = (r: ChannelRow) => (email ? (r.score?.score ?? null) : (scoreFor(r.socialScore, platform)?.score ?? null));
  const scored = base.filter((r) => scoreOfRow(r) != null);
  const avgScore = scored.length ? Math.round(scored.reduce((t, r) => t + (scoreOfRow(r) ?? 0), 0) / scored.length) : null;
  // Social's overview: every account on the platform picked (or all), added up
  const totals = line === "social" ? boardTotals(base.map((r) => r.socialScore), platform) : null;

  return (
    <div className="grid gap-7">
      {/* The switcher keeps its place on every tab: the line under the title wraps beside it, never pushing it down */}
      <header className="flex flex-wrap items-end justify-between gap-4 lg:flex-nowrap">
        <div className="min-w-0 lg:flex-1">
          <h1 className="font-heading text-[32px] leading-tight">KPIs</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {line === "email" ? "Each client's email account score, 0 to 100, with what is weighing it down." : "Each client's engagement against its target, with the social score (0 to 100) per platform and what is weighing it down."}
            <span suppressHydrationWarning className="inline-flex items-center gap-1.5 text-xs text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${synced.tone === "ok" ? "bg-ok" : synced.tone === "warn" ? "bg-warn" : "bg-faint/60"}`} />
              {lastSync ? `${synced.label} · refreshed hourly` : "Not synced yet"}
            </span>
          </p>
        </div>
        {/* The same switch and Add KPI as the ads board, so moving between tabs only changes the board under it; each tab is
            prefetched as soon as the board shows, so switching opens a page that is already loaded */}
        {switcher && (
          <div className="flex w-full items-center gap-2 lg:w-auto lg:shrink-0">
            <KpiSwitch tabs={switcher} />
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
          <div className={`grid grid-cols-2 gap-3 ${email || line === "social" ? "xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]" : "xl:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.6fr)]"}`}>
            {(email || line === "social" ? EMAIL_TILES.map((t) => t.status) : TILES).map((t) => {
              const on = status === t;
              const n = count(t);
              const band = EMAIL_TILES.find((x) => x.status === t);
              return (
                <button key={t} onClick={() => go({ status: on ? null : t })} className={`group relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border bg-surface p-3.5 text-left transition-colors md:p-4 ${on ? "border-fg/40" : "border-line hover:border-faint/60"}`}>
                  <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${TONE[t].bar}`} />
                  <span className="text-xs text-muted">{(email || line === "social") && band ? BAND_TONE[band.band].label : STATUS_LABEL[t]}</span>
                  <span className={`tabular font-heading text-[30px] leading-none ${n ? TONE[t].text : "text-faint"}`}>{n}</span>
                  <span className="text-[11px] text-faint">{(email || line === "social") && band ? band.hint : TILE_HINT[t]}</span>
                </button>
              );
            })}
            {(email || line === "social") && (
              <div className="relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border border-line bg-surface p-3.5 md:p-4">
                <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${avgScore == null ? "bg-faint" : BAND_TONE[avgScore >= 80 ? "good" : avgScore >= 60 ? "watch" : "bad"].bar}`} />
                <span className="text-xs text-muted">Average score{!email && platform !== "all" ? ` · ${PLATFORM_LABEL[platform]}` : ""}</span>
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
                  <span className="text-xs text-muted">{platform === "all" ? "Engagement this month, every account" : `${PLATFORM_LABEL[platform]}, last 30 days, every account`}</span>
                  <span className="tabular font-heading text-[30px] leading-none">{pctText(platform === "all" ? (reach > 0 ? inter / reach : null) : (totals?.rate ?? null))}</span>
                  <span className="text-[11px] text-faint">
                    {platform === "all" ? (
                      <>
                        {num(inter)} interactions over {num(reach)} reach · {posts} {posts === 1 ? "post" : "posts"} published
                      </>
                    ) : (
                      <>
                        {num(totals?.interactions)} interactions over {num(totals?.reach)} reach · {totals?.posts ?? 0} posts
                      </>
                    )}
                  </span>
                  {totals && (
                    <span className="tabular text-[11px] text-faint">
                      {num(totals.followers)} followers ({totals.netFollowers == null ? "growth n/a" : `${totals.netFollowers >= 0 ? "+" : ""}${num(totals.netFollowers)} in 30 days`}) · {num(totals.views)} impressions · {num(totals.profileViews)} profile visits
                    </span>
                  )}
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
          {line === "social" && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-faint">
              <PlatformPills list={socialPlatforms} pick={platform} param="pl" />
              <div role="radiogroup" aria-label="Order accounts" className="flex gap-1 rounded-full border border-line bg-surface p-1">
                {([[null, "Against target"], ["score", "Worst score first"], ["name", "Name"]] as const).map(([id, name]) => (
                  <button key={name} type="button" role="radio" aria-checked={(sortRaw ?? null) === id} onClick={() => go({ sort: id })} className={`min-h-11 rounded-full px-3 text-[12.5px] transition-colors md:min-h-8 ${(sortRaw ?? null) === id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
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
                <Card key={r.clientId} r={r} reading={progress[r.clientId] ?? null} active={open === r.clientId} onOpen={() => go({ open: r.clientId, ...(line === "social" && platform !== "all" ? { sp: platform } : {}) })} />
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
      {openRow &&
        (openRow.line === "email" ? (
          <EmailAccountSheet key={openRow.clientId} r={openRow} month={month} onClose={close} onStep={step} />
        ) : (
          <SocialAccountSheet key={openRow.clientId} r={openRow} month={month} onClose={close} onStep={step} />
        ))}
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
 * Who is in charge of the account: the strategist alone (the designer, builder and creatives are in the sheet that opens).
 * A name the Account Overview sheet gives who isn't in the app yet is dimmed, with why on hover.
 */
function Crew({ r }: { r: ChannelRow }) {
  const lead = r.team.filter((t) => t.seat === "Strategist");
  return (
    <p className="mt-0.5 truncate text-xs text-faint">
      {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
      {lead.length ? (
        <>
          <span className="text-muted">Strategist</span>{" "}
          {lead.map((t, i) => [
            i ? " + " : "",
            <span key={t.name} className={t.pending ? "opacity-60" : undefined} title={t.pending ? `${t.name} is named in the Account Overview sheet but isn't in the app yet: invite them and the next sheet sync seats them` : undefined}>
              {/* First name, like the Meta and Google cards */}
              {t.name.split(" ")[0]}
            </span>,
          ])}
        </>
      ) : (
        "No strategist yet"
      )}
    </p>
  );
}

/**
 * The score with what drags it down on hover: every check under its bar and the points it costs, worst first, or a cheer
 * when nothing is. It sits inside the card's button, so it's hover only; a tap or the keyboard opens the sheet with the
 * same breakdown (and the card's footer lists the top two).
 */
function ScoreHover({ r }: { r: ChannelRow }) {
  if (!r.score) return null;
  const down = r.score.weighingDown;
  return (
    <span className="group/score relative inline-flex">
      <ScoreBadge r={r.score} />
      <span
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-[min(19rem,78vw)] translate-y-1 rounded-[14px] border border-line bg-surface-2 p-3 text-left opacity-0 shadow-xl transition-all duration-150 group-hover/score:visible group-hover/score:translate-y-0 group-hover/score:opacity-100"
      >
        {down.length ? (
          <span className="grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">What&apos;s dragging it down</span>
            {down.map((c) => (
              <span key={c.key} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="min-w-0 text-fg">
                  {c.label} <span className="tabular text-faint">{checkText(c.unit, c.value, r.currency, c.bar)} vs {checkText(c.unit, c.bar, r.currency)}</span>
                </span>
                <span className="tabular shrink-0 text-bad">-{pointsLost(c)} pts</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="block text-[13px] font-medium text-ok">This account is crushing it!</span>
        )}
      </span>
    </span>
  );
}

/** The social score with its biggest drags on hover (per platform), like the email card's */
function SocialScoreHover({ r, big = false }: { r: ChannelRow; big?: boolean }) {
  const s = r.socialScore;
  if (!s) return null;
  return (
    <span className="group/score relative inline-flex shrink-0 items-baseline gap-1.5">
      <span className={`tabular leading-none ${big ? "font-display text-[30px] tracking-tight" : "font-heading text-[18px]"} ${BAND_TONE[s.band].text}`}>{s.score}</span>
      <span className={`${big ? "text-xs" : "text-[10.5px]"} text-faint`}>{big ? "social score" : "score"}</span>
      <span aria-hidden className={`pointer-events-none invisible absolute ${big ? "left-0" : "right-0"} top-full z-30 mt-2 w-[min(19rem,78vw)] translate-y-1 rounded-[14px] border border-line bg-surface-2 p-3 text-left opacity-0 shadow-xl transition-all duration-150 group-hover/score:visible group-hover/score:translate-y-0 group-hover/score:opacity-100`}>
        {s.weighingDown.length ? <SocialWeighingDown drags={s.weighingDown} limit={4} /> : <span className="block text-[13px] font-medium text-ok">This account is crushing it!</span>}
      </span>
    </span>
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
                    <ScoreHover r={r} />
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
                {r.line === "social" ? (
                  // Social: the score is the headline and the card's colour; engagement against the 5% target is one part of it
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-baseline gap-2">
                      {r.socialScore ? <SocialScoreHover r={r} big /> : <span className="text-xs text-faint">No score yet</span>}
                    </span>
                    <span className="tabular truncate text-xs text-muted">
                      <span className={r.value != null && r.target != null && r.value >= r.target ? "text-ok" : "text-fg"}>{mainText(r)}</span> engagement <span className="text-faint">/ {targetText(r)}</span>
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className={`tabular font-display text-[30px] leading-none tracking-tight ${tone.text}`}>{mainText(r)}</span>
                        {r.target != null ? <span className="tabular truncate text-xs text-faint">/ {targetText(r)}</span> : <span className="truncate text-xs text-faint">{mainCaption(r)}</span>}
                      </span>
                    </div>
                    <Gauge r={r} />
                  </>
                )}
                {r.line !== "social" && (r.target == null ? <span className="text-[11.5px] text-muted">No target yet · open to set it</span> : pace && <span className="truncate text-[11.5px] text-muted">{pace}</span>)}
                <ChannelSpark values={r.series} span={r.span} goal={goal} tone={tone.text} label={`${r.name} trend`} />
              </>
            )}
            {r.line !== "email" && (
              <div className="mt-auto grid gap-2 pt-1">
                <SupportChips r={r} />
                {r.socialScore && r.socialScore.platforms.length > 0 && (
                  <span className="flex flex-wrap gap-1.5">
                    {r.socialScore.platforms.map((p) => (
                      <span key={p.platform} className="tabular inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-[11px]">
                        <span className="text-faint">{PLATFORM_LABEL[p.platform]}</span>
                        <span className={BAND_TONE[p.band].text}>{p.score}</span>
                        <span className="text-faint">· {pctText(p.numbers.rate)}{basisLabel(p.numbers.rateBasis) ? ` ${basisLabel(p.numbers.rateBasis)}` : ""}</span>
                      </span>
                    ))}
                  </span>
                )}
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
