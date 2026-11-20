"use client";

import { PostHover } from "@/components/social-post-preview";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { ChannelSpark } from "@/components/channel-spark";
import { ChannelStatusPill, ConnectCta, TONE, needsConnecting, num, paceLine, signed, targetText } from "@/components/channel-parts";
import { BAND_TONE, ScoreBadge } from "@/components/email-score-parts";
import { CHECK_WHY, SocialChecks, SocialWeighingDown } from "@/components/social-score-parts";
import { field, label as labelCls } from "@/components/ui";
import { pctText, shiftDay, type Month } from "@/lib/channel-kpis/calc";
import { barFor, basisLabel, basisSentence } from "@/lib/social/rate";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { freshness } from "@/lib/dates";
import { SOCIAL_AREA_LABEL, type SocialAuditResult } from "@/lib/social-ops/audit-core";
import { PLATFORM_LABEL, socialCheckText, type SocialPlatform } from "@/lib/social-score";
import { parsePlatform, scoreFor, platformRate, topAndBottom, type PlatformPick } from "@/lib/social/split";
import { pushParams, useParam } from "@/lib/url-state";
import { ClientChat } from "../clients/[slug]/client-chat";
import { Layer } from "../clients/[slug]/layer";
import { setChannelTarget } from "./channel-actions";
import { AuditCard, FollowHere, SprintPanel, SprintStrip } from "./email-sheet";
import { EmailActionCard } from "./email-ops-parts";
import { loadSocialSheet, type SheetPost, type SocialSheet } from "./social-sheet-actions";

// One client's organic social, opened from its card on the Social KPI board: the same sheet the email and ads accounts
// get. The social score (overall, or the platform picked in the pills) with what weighs it down, the 7-day engagement
// against the target, every platform's numbers, the top and weakest posts, the audit and its sprint, the notes and the
// target. The tab and the platform live in the address (?tab=, ?sp=), so the browser's back walks through them.

type Tab = "overview" | "posts" | "actions" | "notes" | "settings";
const TABS: Tab[] = ["overview", "posts", "actions", "notes", "settings"];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "none yet");

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{children}</p>;
}

function Stat({ k, v, hint, tone }: { k: string; v: React.ReactNode; hint?: React.ReactNode; tone?: string }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5 rounded-[12px] border border-line bg-surface p-3">
      <dt className="text-[11px] text-faint">{k}</dt>
      <dd className={`tabular truncate font-heading text-lg leading-tight ${tone ?? ""}`}>{v}</dd>
      {hint && <dd className="truncate text-[11px] text-faint">{hint}</dd>}
    </div>
  );
}

function Skeleton({ h = "h-40" }: { h?: string }) {
  return <div className={`${h} animate-pulse rounded-[20px] bg-surface-2`} />;
}

/** All, Instagram, Facebook, TikTok (only the ones with anything read), saved in the address */
export function PlatformPills({ list, pick, param = "sp" }: { list: SocialPlatform[]; pick: PlatformPick; param?: string }) {
  if (list.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="Platform" className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
      {(["all", ...list] as PlatformPick[]).map((p) => (
        <button key={p} type="button" role="radio" aria-checked={pick === p} onClick={() => pushParams({ [param]: p === "all" ? null : p })} className={`min-h-11 shrink-0 rounded-full px-3.5 text-[12.5px] transition-colors md:min-h-8 ${pick === p ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
          {p === "all" ? "All" : PLATFORM_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

export function SocialAccountSheet({ r, month, onClose, onStep }: { r: ChannelRow; month: Month; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  const tone = TONE[r.status];
  const connect = needsConnecting(r);
  const pace = paceLine(r);
  const raw = useParam("tab");
  const asked: Tab = (TABS as string[]).includes(raw ?? "") ? (raw as Tab) : "overview";
  const tab: Tab = connect && asked !== "settings" ? "overview" : asked;
  const setTab = (t: Tab) => pushParams({ tab: t === "overview" ? null : t });
  const s = r.socialScore ?? null;
  const list = (s?.platforms ?? []).map((p) => p.platform);
  const askedPlatform = parsePlatform(useParam("sp"));
  const pick: PlatformPick = askedPlatform !== "all" && !list.includes(askedPlatform) ? "all" : askedPlatform;
  const shown = scoreFor(s, pick);

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

  const [got, setGot] = useState<{ id: string; sheet: SocialSheet | null; error: string | null } | null>(null);
  const reload = useCallback(async () => {
    const res = await loadSocialSheet(r.clientId).catch(() => ({ ok: false as const, error: "Couldn't read this account." }));
    setGot({ id: r.clientId, sheet: res.ok ? res.sheet : null, error: res.ok ? null : res.error });
  }, [r.clientId]);
  useEffect(() => {
    let live = true;
    loadSocialSheet(r.clientId)
      .then((res) => live && setGot({ id: r.clientId, sheet: res.ok ? res.sheet : null, error: res.ok ? null : res.error }))
      .catch(() => live && setGot({ id: r.clientId, sheet: null, error: "Couldn't read this account." }));
    return () => {
      live = false;
    };
  }, [r.clientId]);
  const sheet = got?.id === r.clientId ? got.sheet : null;
  const loading = !got || got.id !== r.clientId;
  const running = sheet?.audit?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [running, reload]);

  const audit = sheet?.audit ?? null;
  const sprint = sheet?.sprint ?? null;
  const openMoves = sprint ? sprint.moves.filter((m) => m.status === "todo" || m.status === "doing").length : audit?.status === "ready" && audit.result ? audit.result.actions.filter((_, i) => !audit.done[String(i)]).length : 0;
  const tabs: { id: Tab; label: string; count?: number | null; hint: string }[] = [
    { id: "overview", label: "Overview", hint: "The social score, engagement against the target, every platform's numbers and the next move" },
    { id: "posts", label: "Posts", hint: "The best and weakest posts and everything posted in the last 90 days" },
    { id: "actions", label: "Actions", count: openMoves || null, hint: "The social audit and the sprint of moves" },
    { id: "notes", label: "Notes", hint: "The #1 problem, the plan and what went up lately" },
    { id: "settings", label: "Settings", hint: "The engagement target, the posting promise and where the numbers come from" },
  ];
  const visible = connect ? tabs.filter((t) => t.id === "overview" || t.id === "settings") : tabs;
  const strategists = r.team.filter((t) => t.seat === "Strategist");

  return (
    <Layer>
      <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${r.name} social KPI`}>
        <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-deep/70 backdrop-blur-[2px] motion-safe:animate-[fadeIn_.18s_ease-out]" />
        <div className="relative flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg motion-safe:animate-[sheetIn_.24s_cubic-bezier(.2,.8,.2,1)] md:w-[min(980px,94vw)]">
          <header className="relative isolate shrink-0 border-b border-line bg-surface/80 backdrop-blur" style={{ backgroundImage: `radial-gradient(90% 140% at 0% 0%, color-mix(in srgb, ${shown ? BAND_TONE[shown.band].css : tone.css} 18%, transparent), transparent 60%)` }}>
            <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${shown ? BAND_TONE[shown.band].bar : tone.bar}`} />
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+16px)] sm:px-6 md:pt-5">
              <div className="grid min-w-0 gap-1">
                <p className="truncate font-heading text-xl leading-tight md:text-2xl">{r.name}</p>
                <p className="truncate text-xs text-faint">
                  {r.kaizenId != null && <span className="tabular">ID {r.kaizenId} · </span>}
                  Social{r.account ? ` · ${r.account}` : ""}
                  {strategists.length > 0 && ` · ${strategists.map((t) => t.name.split(" ")[0]).join(" + ")}`}
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
                <ChannelStatusPill status={r.status} line="social" />
              ) : (
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    {shown ? <ScoreBadge r={shown} size="lg" /> : <span className="tabular font-display text-[34px] leading-none tracking-tight text-faint">n/a</span>}
                    <span className="text-sm text-faint">{pick === "all" ? "social score" : `${PLATFORM_LABEL[pick]} score`}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelStatusPill status={r.status} line="social" />
                    <span className="tabular text-xs text-muted">
                      Engagement {pctText(r.value)}
                      {r.target != null ? ` / ${targetText(r)} target` : " · no target yet"}
                    </span>
                    {pace && <span className="text-xs text-faint">{pace}</span>}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <ClientChat variant="inline" clientId={r.clientId} client={r.name} live targets={[]} desk="social" />
                <Link href={`/clients/${r.slug}?service=social`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
                  Client page →
                </Link>
                <Link href={`/reports?client=${r.slug}`} className="hidden h-9 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:inline-flex">
                  Reports →
                </Link>
              </div>
            </div>
            <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 sm:px-5" role="tablist" aria-label="Account sheet">
              {visible.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} title={t.hint} onClick={() => setTab(t.id)} className={`relative inline-flex h-12 shrink-0 items-center gap-1.5 px-3 text-sm transition-colors md:h-11 ${tab === t.id ? "text-fg" : "text-muted hover:text-fg"}`}>
                  {t.label}
                  {t.count ? <span className="tabular rounded-full bg-brand-soft px-1.5 text-[10px] leading-4 text-brand-text">{t.count}</span> : null}
                  {tab === t.id && <span aria-hidden className={`absolute inset-x-2 bottom-0 h-[2px] rounded-full ${shown ? BAND_TONE[shown.band].bar : tone.bar}`} />}
                </button>
              ))}
            </nav>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)] sm:px-6 md:py-6">
            <div className="grid gap-5 md:gap-6">
              <div className="-mb-1 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-faint">{visible.find((t) => t.id === tab)?.hint}</p>
                {!connect && (tab === "overview" || tab === "posts") && <PlatformPills list={list} pick={pick} />}
              </div>
              {got?.error && got.id === r.clientId && <p className="rounded-[12px] border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad">{got.error}</p>}
              {tab === "overview" && (connect ? <ConnectCta r={r} /> : <Overview r={r} sheet={sheet} loading={loading} pick={pick} onTab={setTab} />)}
              {tab === "posts" && (loading ? <Skeleton h="h-72" /> : sheet && <Posts sheet={sheet} pick={pick} />)}
              {tab === "actions" && (loading ? <Skeleton h="h-72" /> : sheet && <Actions r={r} sheet={sheet} reload={reload} />)}
              {tab === "notes" && (loading ? <Skeleton h="h-72" /> : sheet && <Notes r={r} sheet={sheet} onTab={setTab} />)}
              {tab === "settings" && <Settings r={r} month={month} />}
            </div>
          </div>
        </div>
      </div>
    </Layer>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

/** A client with a Page or Instagram per location: each account's score and numbers, the client's score above rolls them up */
function Locations({ r, pick }: { r: ChannelRow; pick: PlatformPick }) {
  const list = (r.socialScore?.accounts ?? []).filter((a) => pick === "all" || a.platform.toLowerCase().includes(pick));
  if (list.length < 2) return null;
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <Eyebrow>By location, last 30 days</Eyebrow>
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((a) => (
          <li key={`${a.platform}:${a.accountId}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5">
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-[13px] text-fg">
                {a.location ?? (a.platform === "instagram" && a.name ? `@${a.name}` : (a.name ?? "Unnamed"))}
              </span>
              <span className="truncate text-[11px] text-faint">
                {a.platform} · {num(a.followers)} followers · reach {num(a.reach)} · {pctText(a.rate)} · {a.posts} posts
              </span>
            </span>
            <span className={`tabular font-heading text-[22px] leading-none ${a.band ? BAND_TONE[a.band].text : "text-faint"}`}>{a.score ?? "n/a"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Overview({ r, sheet, loading, pick, onTab }: { r: ChannelRow; sheet: SocialSheet | null; loading: boolean; pick: PlatformPick; onTab: (t: Tab) => void }) {
  const s = r.socialScore ?? null;
  const shown = scoreFor(s, pick);
  const n = shown?.numbers ?? null;
  const platform = pick === "all" ? null : (s?.platforms.find((p) => p.platform === pick) ?? null);
  const checks = platform?.checks ?? s?.checks ?? [];
  const drags = (s?.weighingDown ?? []).filter((d) => pick === "all" || d.platform === pick);
  const today = sheet?.today ?? null;
  const series = sheet && today ? platformRate(sheet.days, pick, shiftDay(today, -29), today) : pick === "all" ? r.series : [];
  const target = r.target;
  const rateBasis = n?.rateBasis ?? r.social?.rateBasis ?? null;
  const tone = shown ? BAND_TONE[shown.band].text : TONE[r.status].text;
  const vsBefore = n?.reach != null && n.reachBefore ? n.reach / n.reachBefore - 1 : null;
  const a = sheet?.audit ?? null;
  const res = a?.status === "ready" ? (a.result as SocialAuditResult | null) : null;
  const next = sheet?.sprint?.moves.find((m) => m.status === "doing") ?? sheet?.sprint?.moves.find((m) => m.status === "todo") ?? null;
  const firstAction = res ? (res.actions.find((x, i) => !a!.done[String(i)] && (pick === "all" || x.platform === pick || x.platform === "all")) ?? null) : null;
  const { top } = sheet ? topAndBottom(sheet.posts.filter((p) => today && (p.postedAt ?? "") >= shiftDay(today, -30)), pick, 1) : { top: [] as (SheetPost & { rate: number | null })[] };

  return (
    <>
      <Locations r={r} pick={pick} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <span aria-hidden className="pointer-events-none absolute -left-20 -top-24 -z-10 h-64 w-64 rounded-full opacity-25 blur-[90px]" style={{ background: shown ? BAND_TONE[shown.band].css : TONE[r.status].css }} />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="grid gap-0.5">
              <Eyebrow>Engagement, last 30 days{pick === "all" ? "" : ` · ${PLATFORM_LABEL[pick]}`}</Eyebrow>
              <p className="text-sm text-muted">The rate over the 7 days up to each day{target != null ? ", with the target as the dashed line" : ""}</p>
            </div>
            <span className={`tabular font-heading text-[26px] leading-none ${tone}`}>
              {pctText(n?.rate ?? r.value)}
              {basisLabel(rateBasis, r.social?.reachFrom) ? <span title={basisSentence(rateBasis, r.social?.reachFrom)} className="ml-1.5 align-middle font-sans text-[11px] font-normal text-faint">{basisLabel(rateBasis, r.social?.reachFrom)}</span> : null}
            </span>
          </div>
          {loading && pick !== "all" ? <div className="h-28 animate-pulse rounded-[12px] bg-surface-2" /> : <ChannelSpark values={series} span={30} goal={target != null ? { from: target, to: target } : null} tone={tone} tall label={`${r.name} engagement trend`} />}
          <p className="text-[11px] text-faint">{rateBasis === "views" || rateBasis === "followers" ? `Meta gave no reach, so this rate is ${rateBasis === "views" ? "over views" : "per post over followers"} and is held to its own ${pctText(barFor(rateBasis, null), 0)} bar, never to the reach target.` : target != null ? `Target ${pctText(target)}${r.targetBy ? `, set by ${r.targetBy}` : ""}.` : "No target yet: set one in Settings and the engagement check scores against it (3.5% until then)."}</p>
          {(r.social?.rateNotes ?? []).filter((x) => pick === "all" && !/^Engagement is /.test(x)).map((x) => (
            <p key={x} className="text-[11px] text-warn">{x}</p>
          ))}
        </section>
        <section className="grid content-start gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>The score{pick === "all" ? ", every platform by reach" : ` · ${PLATFORM_LABEL[pick]}`}</Eyebrow>
          {s ? (
            <>
              {pick === "all" && s.platforms.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {s.platforms.map((p) => (
                    <button key={p.platform} type="button" onClick={() => pushParams({ sp: p.platform })} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-3 text-[12.5px] hover:border-faint/70 md:min-h-8">
                      <span className="text-muted">{PLATFORM_LABEL[p.platform]}</span>
                      <span className={`tabular font-medium ${BAND_TONE[p.band].text}`}>{p.score}</span>
                    </button>
                  ))}
                </div>
              )}
              <SocialWeighingDown drags={drags} limit={4} />
              <p className="text-[11px] text-faint">Last 30 days, to {when(`${s.window.to}T12:00:00Z`)}. {s.promised.fromPackage ? `The package promises ${s.promised.perMonth} posts a month.` : `No package says how many posts, so ${s.promised.perMonth} a month (three a week) is the bar.`}</p>
            </>
          ) : (
            <p className="text-sm text-muted">No score yet: the first read hasn&apos;t landed.</p>
          )}
        </section>
      </div>

      {n && (
        <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <Stat k="Followers" v={num(n.followers)} hint={n.netFollowers == null ? "Net growth not given" : `${signed(n.netFollowers)} in 30 days`} tone={n.netFollowers != null && n.netFollowers < 0 ? "text-bad" : undefined} />
          <Stat k="Reach" v={num(n.reach)} hint={vsBefore == null ? "Last 30 days" : `${vsBefore >= 0 ? "+" : ""}${Math.round(vsBefore * 100)}% vs the 30 before`} />
          <Stat k="Impressions" v={num(n.views)} hint="Views, last 30 days" />
          <Stat k="Interactions" v={num(n.interactions)} hint="Likes, comments, shares, saves" />
          <Stat k="Posts published" v={String(n.posts)} hint={`${n.postsThisMonth} this month · ${n.videoPosts} video`} />
          <Stat k="Profile visits" v={num(n.profileViews)} hint={n.reach && n.profileViews != null ? `${pctText(n.profileViews / n.reach)} of reach` : "Last 30 days"} />
          <Stat k="Saves and shares" v={n.saves == null && n.shares == null ? "n/a" : num((n.saves ?? 0) + (n.shares ?? 0))} hint={`${num(n.saves)} saves · ${num(n.shares)} shares`} />
          <Stat k="Last post" v={when(n.lastPostAt)} hint={r.quietDays != null && r.quietDays >= 7 ? `${r.quietDays} days ago` : undefined} tone={r.quietDays != null && r.quietDays >= 7 ? "text-warn" : undefined} />
        </dl>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <button type="button" onClick={() => onTab("actions")} className="group grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
          <span className="flex items-center justify-between gap-2">
            <Eyebrow>What to do</Eyebrow>
            <span className="text-xs text-muted group-hover:text-fg">Actions →</span>
          </span>
          {loading ? (
            <span className="h-5 w-48 animate-pulse rounded-full bg-surface-2" />
          ) : next || firstAction ? (
            <>
              <span className="font-heading text-[17px] leading-snug">{next?.title ?? firstAction!.title}</span>
              {(next?.impact ?? firstAction?.impact) && <span className="line-clamp-2 text-sm leading-relaxed text-ok">{next?.impact ?? firstAction?.impact}</span>}
              <span className="text-[11px] text-faint">{sheet?.sprint ? "On the sprint" : "From the audit"}{a?.status === "ready" ? ` · audited ${when(a.createdAt)}${a.auto ? ", by itself" : ""}` : ""}</span>
            </>
          ) : a?.status === "running" ? (
            <span className="text-sm text-brand-text">The audit is running ({a.progress}%)</span>
          ) : (
            <span className="text-sm text-muted">No audit yet. Run one and the moves to make show up here.{r.socialScore?.band === "bad" ? " A red account audits itself and opens its sprint." : ""}</span>
          )}
        </button>
        <div className="grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>Top post, last 30 days</Eyebrow>
          {top[0] ? <PostLine p={top[0]} /> : <p className="text-sm text-muted">{loading ? "Reading the posts" : "No post with reach in the last 30 days."}</p>}
        </div>
      </div>

      {sheet?.sprint && <SprintStrip s={sheet.sprint} onOpen={() => onTab("actions")} />}

      {checks.length > 0 && (
        <section className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>The checks{pick === "all" ? ", every platform blended by reach" : ` · ${PLATFORM_LABEL[pick]}`}</Eyebrow>
          <SocialChecks checks={checks} why />
          <p className="text-[11px] text-faint">Tap a check for why it counts and what moves it. A check with nothing to measure is left out and the rest scaled up.</p>
        </section>
      )}
    </>
  );
}

function PostLine({ p }: { p: SheetPost & { rate: number | null } }) {
  // The whole row opens the post; hovering shows it larger with every number (a tap on a phone)
  const body = (
    <>
      <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-[12px] border border-line bg-surface-2">
        {p.thumbnail ? (
          // A platform's thumbnail URL (signed, short-lived): a plain img, no optimisation round trip
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumbnail} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy" />
        ) : (
          <span aria-hidden className="grid h-full w-full place-items-center text-[10px] uppercase text-faint">{p.format ?? "post"}</span>
        )}
        {(p.format === "reel" || p.format === "video") && (
          <span aria-hidden className="absolute bottom-1 right-1 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-[8px] text-white">▶</span>
        )}
      </span>
      <span className="grid min-w-0 content-center gap-1">
        <span className="line-clamp-2 text-[13px] leading-snug text-fg">{p.caption?.trim() || "No caption"}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-faint">
          <span className="text-muted">{PLATFORM_LABEL[p.platform as SocialPlatform] ?? p.platform}</span>
          <span>· {p.format ?? "post"}</span>
          <span>· {when(p.postedAt)}</span>
        </span>
      </span>
      <span className="tabular grid shrink-0 content-center justify-items-end gap-0.5 text-right">
        <span className="text-[13px] text-fg">{pctText(p.rate)}</span>
        <span className="text-[10.5px] text-faint">reach {num(p.reach)}</span>
      </span>
    </>
  );
  const cls = "group grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] p-2 text-left transition-colors hover:bg-surface-2/70";
  return (
    <PostHover p={p}>
      {p.permalink ? (
        <a href={p.permalink} target="_blank" rel="noreferrer" className={cls} aria-label="Open the post">
          {body}
        </a>
      ) : (
        <span className={cls}>{body}</span>
      )}
    </PostHover>
  );
}

// ─── Posts ───────────────────────────────────────────────────────────────────

/** The posts the ads team is boosting, with the spend behind each (last 30 days); nothing boosted says so */
function Boosts({ sheet, pick }: { sheet: SocialSheet; pick: PlatformPick }) {
  const list = (sheet.boosts ?? []).filter((b) => pick === "all" || b.platform === pick);
  const total = list.reduce((n, b) => n + b.spend, 0);
  const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Boosted by the ads team, last 30 days</Eyebrow>
        {list.length > 0 && <span className="tabular text-sm text-fg">{money(total)} across {list.length} post{list.length === 1 ? "" : "s"}</span>}
      </div>
      {list.length ? (
        <ul className="grid gap-2">
          {list.map((b) => (
            <li key={`${b.platform}:${b.postId}`}>
              <PostHover p={{ ...b, reach: null, interactions: null }}>
                <a href={b.permalink ?? undefined} target="_blank" rel="noreferrer" className="group grid w-full grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] p-2 text-left transition-colors hover:bg-surface-2/70">
                  <span className="h-12 w-12 overflow-hidden rounded-[10px] border border-line bg-surface-2">
                    {b.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="line-clamp-1 text-[13px] text-fg">{b.caption?.trim() || "No caption"}</span>
                    <span className="truncate text-[11px] text-faint">
                      {PLATFORM_LABEL[b.platform as SocialPlatform] ?? b.platform} · {b.ads} ad{b.ads === 1 ? "" : "s"}
                      {b.adNames[0] ? ` · ${b.adNames[0]}` : ""}
                    </span>
                  </span>
                  <span className="tabular grid justify-items-end text-right">
                    <span className="text-[13px] font-medium text-fg">{money(b.spend)}</span>
                    <span className="text-[10.5px] text-faint">{b.impressions.toLocaleString("en-US")} impressions</span>
                  </span>
                </a>
              </PostHover>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing boosted: none of their ads is running one of these posts. Pick the best recent posts with the media buyer.</p>
      )}
    </section>
  );
}

function Posts({ sheet, pick }: { sheet: SocialSheet; pick: PlatformPick }) {
  const [all, setAll] = useState(false);
  const { top, bottom } = topAndBottom(sheet.posts.filter((p) => (p.postedAt ?? "") >= shiftDay(sheet.today, -30)), pick, 3);
  const list = sheet.posts.filter((p) => pick === "all" || p.platform === pick).map((p) => ({ ...p, rate: p.reach && p.reach > 0 && p.interactions != null ? p.interactions / p.reach : null }));
  const shown = all ? list : list.slice(0, 12);
  return (
    <>
      <Boosts sheet={sheet} pick={pick} />
      <div className="grid gap-3 md:grid-cols-2">
        <section className="grid content-start gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>Top posts, last 30 days</Eyebrow>
          {top.length ? top.map((p) => <PostLine key={p.id} p={p} />) : <p className="text-sm text-muted">No post with reach yet.</p>}
        </section>
        <section className="grid content-start gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
          <Eyebrow>Weakest posts, last 30 days</Eyebrow>
          {bottom.length ? bottom.map((p) => <PostLine key={p.id} p={p} />) : <p className="text-sm text-muted">Too few posts to call any weak.</p>}
        </section>
      </div>
      <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
        <Eyebrow>Everything posted, last 90 days · {list.length}</Eyebrow>
        <ul className="grid gap-3">
          {shown.map((p) => (
            <li key={p.id}>
              <PostLine p={p} />
            </li>
          ))}
        </ul>
        {list.length > 12 && (
          <button type="button" onClick={() => setAll((x) => !x)} className="min-h-11 justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
            {all ? "Show fewer" : `Show all ${list.length}`}
          </button>
        )}
      </section>
    </>
  );
}

// ─── Actions: the audit and its sprint ──────────────────────────────────────

const WHEN: [string, string][] = [
  ["now", "Today"],
  ["this_week", "This week"],
  ["next", "Next"],
];

function Actions({ r, sheet, reload }: { r: ChannelRow; sheet: SocialSheet; reload: () => Promise<void> }) {
  const a = sheet.audit;
  const res = a?.status === "ready" ? (a.result as SocialAuditResult | null) : null;
  const s = sheet.sprint;
  const sprintOfThis = Boolean(s && a && s.auditId === a.id);
  const listed = new Set<number>();
  if (s && sprintOfThis) for (const m of s.moves) if (m.auditIndex != null) listed.add(m.auditIndex);
  const rest = res ? res.actions.map((x, i) => ({ x, i })).filter(({ i }) => !listed.has(i)) : [];
  const lastPost = sheet.posts[0]?.postedAt ?? null;
  const quiet = !lastPost || sheet.now - Date.parse(lastPost) > 7 * 86_400_000;
  return (
    <>
      {(r.socialScore?.band === "bad" || r.socialScore?.band === "watch") && !s && a?.status !== "running" && quiet && (
        <p className="rounded-[14px] border border-dashed border-bad/50 px-4 py-3 text-sm text-bad">Nothing has gone up in a week{lastPost ? `: the last post was ${when(lastPost)}` : ""}. Run the audit and make the first moves below.</p>
      )}
      <AuditCard r={r} a={a} reload={reload} line="social" />
      {s ? (
        <SprintPanel s={s} replaced={Boolean(a && s.auditId !== a.id && a.status === "ready")} reload={reload} line="social" />
      ) : (
        res && (
          <section className="grid gap-3 rounded-[20px] border border-dashed border-line p-4 md:flex md:items-center md:justify-between md:p-5">
            <div className="grid gap-0.5">
              <p className="font-heading text-[16px]">Follow the plan as a sprint</p>
              <p className="text-[13px] leading-relaxed text-muted">Every few days the sprint re-measures the social score, reads what went up and tells the social media manager what moved.</p>
            </div>
            <FollowHere auditId={a!.id} reload={reload} line="social" />
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
                <Eyebrow>{title}</Eyebrow>
                <div className="grid gap-3 lg:grid-cols-2">
                  {items.map(({ x, i }) => (
                    <EmailActionCard key={`${a!.id}:${i}`} line="social" auditId={a!.id} index={i} action={x} areaLabel={SOCIAL_AREA_LABEL[x.area] ?? x.area} done={a!.done[String(i)] ?? null} listed={null} onChange={reload} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}

// ─── Notes: the #1 problem, the plan, and what went up ───────────────────────

function Notes({ r, sheet, onTab }: { r: ChannelRow; sheet: SocialSheet; onTab: (t: Tab) => void }) {
  const res = sheet.audit?.status === "ready" ? (sheet.audit.result as SocialAuditResult | null) : null;
  const top = res?.causes[0] ?? null;
  const drag = r.socialScore?.weighingDown[0] ?? null;
  const recent = sheet.posts.slice(0, 10);
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
          ) : drag ? (
            <p className="text-sm leading-relaxed">
              {PLATFORM_LABEL[drag.platform]} {drag.label.toLowerCase()} is {socialCheckText(drag.unit, drag.value)} against a {socialCheckText(drag.unit, drag.bar)} bar. {CHECK_WHY[drag.key].moves}
            </p>
          ) : (
            <p className="text-sm text-muted">Nothing is weighing the score down.</p>
          )}
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
      <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
        <Eyebrow>What went up lately</Eyebrow>
        {recent.length ? (
          <ol className="grid gap-1">
            {recent.map((p) => (
              <li key={p.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-surface-2/60">
                <span aria-hidden className={`h-2 w-2 translate-y-[-1px] rounded-full ${p.format === "reel" || p.format === "video" ? "bg-brand" : "bg-fg/60"}`} />
                <span className="min-w-0 truncate text-[13px] text-fg">
                  {PLATFORM_LABEL[p.platform as SocialPlatform] ?? p.platform} {p.format ?? "post"}
                  {p.caption ? <span className="text-muted"> · {p.caption.replace(/\s+/g, " ").slice(0, 80)}</span> : null}
                </span>
                <span className="tabular text-[11px] text-faint">{when(p.postedAt)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">Nothing posted in the last 90 days.</p>
        )}
        <p className="text-[11px] leading-relaxed text-faint">Meta gives no edit history for a Page or an Instagram account (who changed the bio, what was scheduled), so there is no change history here: the posts are the record of the work, and the sprint checks read them.</p>
      </section>
    </>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

function Settings({ r, month }: { r: ChannelRow; month: Month }) {
  const synced = freshness(r.lastSyncedAt);
  const s = r.socialScore;
  void month;
  return (
    <>
      <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
        <div>
          <h2 className="font-heading text-lg">Engagement target</h2>
          <p className="mt-0.5 text-xs text-faint">{r.target == null ? "Set it and the engagement check, the card's colour and the reports read against it (3.5% until then)." : r.targetBy ? `Set by ${r.targetBy}${r.targetAt ? ` on ${when(r.targetAt)}` : ""}.` : "Saved."} It is the bar for the score&apos;s heaviest check, on every platform.</p>
        </div>
        {r.canEdit ? (
          <ActionForm action={setChannelTarget.bind(null, r.clientId, "social")} submitLabel="Save target" autosave className="grid gap-3">
            <label className={labelCls}>
              Engagement rate target (%)
              <input name="target" defaultValue={r.target == null ? "" : String(Math.round(r.target * 10000) / 100)} inputMode="decimal" className={`${field} tabular`} placeholder="3.5" autoComplete="off" />
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
        <h2 className="font-heading text-lg">The posting promise</h2>
        <p className="text-muted">{s ? (s.promised.fromPackage ? `${s.promised.perMonth} posts a month per platform, from the client's social package.` : `The client's package doesn't say how many posts, so the score expects ${s.promised.perMonth} a month per platform (three a week). Add it to the package on the client page and the score follows.`) : "Read once the accounts are linked."}</p>
      </section>
      <section className="grid gap-2 rounded-[16px] border border-line bg-surface p-4 text-sm md:p-5">
        <h2 className="font-heading text-lg">Where the numbers come from</h2>
        <p className="text-muted">
          {r.data === "missing" ? "Facebook and Instagram aren't linked." : r.account ? `${r.account}.` : "Linked."} {r.lastSyncedAt && <span suppressHydrationWarning>{synced.label}.</span>} Meta&apos;s insights, read only, every few hours. TikTok shows here once its organic numbers are read.
        </p>
        {needsConnecting(r) && <ConnectCta r={r} />}
        {!needsConnecting(r) && r.problem && (
          <p className="text-xs text-muted">
            {r.problem.message}. {r.problem.fix}
          </p>
        )}
        {r.team.length > 0 && <p className="text-xs text-faint">On it: {r.team.map((t) => `${t.name} (${t.seat})`).join(", ")}</p>}
      </section>
    </>
  );
}
