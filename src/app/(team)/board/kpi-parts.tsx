"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HoverCard } from "@/components/hover-card";
import { AdPreview } from "@/components/ad-preview";
import type { ClientAllotment, CreativeKpis, Maker, Sendbacks, TaskRef, Winner, WinnerAd } from "@/lib/creative-kpis";
import { adMediaUrl } from "@/components/ad-img";
import type { ErrorItem } from "@/lib/creative-errors";
import type { WatchRow } from "@/lib/fatigue";
import type { OpenSuggestion } from "@/lib/suggestions";
import { closeParams, closeThen, pushParams, useParam } from "@/lib/url-state";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import { startRefreshBrief, startWinnerBrief } from "@/app/(team)/brief-job-actions";
import { BriefProgress, trackJob, useJobFor } from "@/components/brief-jobs";
import { BriefPreviewButton, QuickBriefSheet } from "@/components/quick-brief-sheet";
import type { QuickBrief } from "@/lib/quick-brief";
import { checkErrorsNow, dismissAllotment, restoreAllotment } from "./kpi-actions";

// The interactive pieces of the KPI tabs: tasks you can open from anywhere (a Board ticket opens its drawer, an Asana
// task opens Asana), quick looks on hover (a sheet on a phone), each person's card and everything on their plate, the
// allotments list, and the ads (winners to brief more of, tiring ones to refresh) as they run in the feed.

const when = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** One piece of work: opens the ticket on the Board, or the task in Asana */
export function TaskRow({ t, compact = false }: { t: TaskRef; compact?: boolean }) {
  const body = (
    <>
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${t.late ? "bg-bad" : "bg-ink/25"}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          {t.urgent && <span className="mt-0.5 shrink-0 rounded-full bg-bad-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-bad">Urgent</span>}
          <span className="line-clamp-2 min-w-0 text-[13.5px] leading-snug text-fg [overflow-wrap:anywhere]">{t.title}</span>
        </span>
        <span className="block truncate text-[11.5px] text-muted">
          {[t.client, t.stage, t.late ? "late" : t.due ? `due ${when(t.due)}` : null].filter(Boolean).join(" · ")}
        </span>
        {t.note && !compact && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-faint">{t.note}</span>}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{t.external ? "Asana ↗" : "Open →"}</span>
    </>
  );
  const cls = "flex items-start gap-2.5 rounded-[12px] px-2.5 py-2 hover:bg-ink/[0.05]";
  return t.external ? (
    <a href={t.href} target="_blank" rel="noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <Link href={t.href} className={cls}>
      {body}
    </Link>
  );
}

function TaskList({ items, empty, max = 8 }: { items: TaskRef[]; empty: string; max?: number }) {
  if (!items.length) return <p className="px-2.5 py-2 text-[13px] text-muted">{empty}</p>;
  return (
    <div className="grid">
      {items.slice(0, max).map((t) => (
        <TaskRow key={t.key} t={t} compact />
      ))}
      {items.length > max && <p className="px-2.5 pt-1 text-[11.5px] text-faint">and {items.length - max} more on their card</p>}
    </div>
  );
}

function ErrorList({ items, max = 6 }: { items: ErrorItem[]; max?: number }) {
  if (!items.length) return <p className="px-2.5 py-2 text-[13px] text-muted">No real errors in the last 90 days.</p>;
  return (
    <div className="grid gap-1.5">
      {items.slice(0, max).map((e) => {
        const where = e.ticket ? `/board?t=${e.ticket}` : e.url;
        const body = (
          <>
            <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full bg-bad-soft px-2 py-0.5 font-medium text-bad">{e.type ?? "Error"}</span>
              <span className="text-faint">{[e.client, e.round === "client" ? "from the client" : "internal", when(e.at)].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="line-clamp-3 text-[12.5px] leading-snug text-fg">&ldquo;{e.quote}&rdquo;</span>
            <span className="truncate text-[11px] text-muted">
              {e.author ? `${e.author} · ` : ""}
              {e.ticket ? `#${e.ticket} ` : ""}
              {e.task}
            </span>
          </>
        );
        return where ? (
          e.ticket ? (
            <Link key={e.id} href={where} className="grid gap-1 rounded-[12px] px-2.5 py-2 hover:bg-ink/[0.05]">
              {body}
            </Link>
          ) : (
            <a key={e.id} href={where} target="_blank" rel="noreferrer" className="grid gap-1 rounded-[12px] px-2.5 py-2 hover:bg-ink/[0.05]">
              {body}
            </a>
          )
        ) : (
          <div key={e.id} className="grid gap-1 rounded-[12px] px-2.5 py-2">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** A count you can glance into: hover on a computer, tap on a phone */
function Peek({ label, n, tone, title, children }: { label: string; n: number; tone?: "bad" | "warn" | null; title: string; children: React.ReactNode }) {
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <HoverCard
        width={380}
        content={
          <div className="grid gap-1">
            <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{title}</p>
            {children}
          </div>
        }
      >
        <button type="button" className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors max-md:min-h-11 ${tone === "bad" ? "border-bad/30 bg-bad-soft text-bad" : tone === "warn" ? "border-warn/30 bg-warn-soft text-warn" : "border-line text-muted hover:border-faint hover:text-fg"}`}>
          <span className="tabular font-semibold">{n}</span> {label}
        </button>
      </HoverCard>
    </span>
  );
}

function Rate({ label, s, kind }: { label: string; s: { d45: Sendbacks; d90: Sendbacks }; kind: "internal" | "client" }) {
  const p45 = pct(s.d45[kind], s.d45.pieces);
  const p90 = pct(s.d90[kind], s.d90.pieces);
  const tone = p90 == null ? "text-faint" : p90 <= 20 ? "text-ok" : p90 <= 40 ? "text-warn" : "text-bad";
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={`tabular text-[15px] font-semibold leading-tight ${tone}`}>
        {p45 == null ? "—" : `${p45}%`} <span className="text-[11px] font-normal text-faint">45d</span>
      </span>
      <span className="tabular text-[12px] text-muted">
        {p90 == null ? "—" : `${p90}%`} <span className="text-[11px] text-faint">90d · {s.d90[kind]} of {s.d90.pieces}</span>
      </span>
    </div>
  );
}

/** How a person's 0–100 score is worked out, with their own numbers */
function ScoreExplained({ m }: { m: Maker }) {
  const parts: [string, string, string][] = [
    ["First-pass approval", "40%", m.firstPass == null ? "not enough yet" : `${m.firstPass}% went through with no changes`],
    ["Turnaround vs target", "30%", m.turnaround == null ? "not enough yet" : `${m.turnaround}d per piece, target ${m.turnaroundTarget}d`],
    ["Revision turnaround", "15%", m.revisionTurnaround == null ? "no revisions yet" : `${m.revisionTurnaround}d to send a revision back, target 1d`],
    ["Nothing left sitting", "15%", m.sitting.length ? `${m.sitting.length} ${m.sitting.length === 1 ? "piece" : "pieces"} on them 2+ business days` : "nothing waiting on them"],
  ];
  return (
    <div className="grid gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Score · {m.score ?? "not yet"}{m.level ? ` · ${m.level}` : ""}</p>
      <p className="text-[12.5px] leading-snug text-muted">Out of 100, from their own work in this period:</p>
      <ul className="grid gap-1.5">
        {parts.map(([k, w, v]) => (
          <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[12.5px]">
            <span className="text-fg">{k}</span>
            <span className="tabular text-faint">{w}</span>
            <span className="col-span-2 text-[11.5px] text-muted">{v}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-faint">90+ on fire · 75+ strong · 60+ steady. The ▲▼ is against the period before.</p>
    </div>
  );
}

/** A person on the team: tap the card for everything on their plate; glance into the counts without leaving */
export function PersonCard({ m }: { m: Maker }) {
  const tone = m.score == null ? "text-faint" : m.score >= 75 ? "text-ok" : m.score >= 60 ? "text-warn" : "text-bad";
  const trend = m.score != null && m.previous != null ? m.score - m.previous : null;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => m.profileId && pushParams({ person: m.profileId })}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && m.profileId && pushParams({ person: m.profileId })}
        className="group grid h-full cursor-pointer content-start gap-4 rounded-[22px] border border-line bg-surface p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      >
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink/[0.07] text-[13px] font-semibold text-fg">{initials(m.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[17px] leading-tight">{m.name}</p>
            <p className="text-[12px] text-muted">{m.level}</p>
          </div>
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <HoverCard width={380} content={<ScoreExplained m={m} />}>
              <button type="button" className="grid justify-items-end rounded-[12px] px-1.5 py-1 text-right hover:bg-ink/[0.05]" aria-label={`Score ${m.score ?? "not yet"}: how it's worked out`}>
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Score</span>
                <span className={`tabular font-display text-[28px] leading-none ${tone}`}>{m.score ?? "—"}</span>
                {trend != null && trend !== 0 && <span className={`tabular text-[11px] ${trend > 0 ? "text-ok" : "text-bad"}`}>{trend > 0 ? "▲" : "▼"} {Math.abs(trend)}</span>}
              </button>
            </HoverCard>
          </span>
        </div>

        <dl className="grid grid-cols-3 gap-3">
          {(
            [
              ["Passed on", String(m.pieces), null],
              ["First pass", m.firstPass == null ? "—" : `${m.firstPass}%`, m.firstPass == null ? null : m.firstPass >= 70 ? "text-ok" : m.firstPass >= 50 ? "text-warn" : "text-bad"],
              ["Met due date", m.metDue.pct == null ? "—" : `${m.metDue.pct}%`, m.metDue.pct == null ? null : m.metDue.pct >= 80 ? "text-ok" : m.metDue.pct >= 60 ? "text-warn" : "text-bad"],
            ] as const
          ).map(([k, v, c]) => (
            <div key={k} className="grid gap-0.5">
              <dt className="text-[11px] text-muted">{k}</dt>
              <dd className={`tabular text-[20px] font-semibold leading-none ${c ?? "text-fg"}`}>{v}</dd>
            </div>
          ))}
        </dl>

        <dl className="grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div className="grid gap-0.5">
            <dt className="text-[11px] text-muted">Brief → client</dt>
            <dd className="tabular text-[15px] font-semibold leading-tight">{m.briefToDone == null ? "—" : `${m.briefToDone}d`}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-[11px] text-muted">Revision back in</dt>
            <dd className={`tabular text-[15px] font-semibold leading-tight ${m.revisionTurnaround == null ? "" : m.revisionTurnaround <= 1 ? "text-ok" : m.revisionTurnaround <= 2 ? "text-warn" : "text-bad"}`}>{m.revisionTurnaround == null ? "—" : `${m.revisionTurnaround}d`}</dd>
          </div>
        </dl>

        <div className="grid grid-cols-2 gap-3 rounded-[14px] bg-ink/[0.035] p-3">
          <Rate label="Sent back internally" s={m.sendbacks} kind="internal" />
          <Rate label="Sent back by clients" s={m.sendbacks} kind="client" />
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Peek label="on their plate" n={m.plate.length} tone={m.late ? "warn" : null} title={`On their plate · ${m.late} late`}>
            <TaskList items={m.plate} empty="Nothing open right now." />
          </Peek>
          <Peek label="sent back" n={m.revisions.length} title="Sent back, last 90 days">
            <TaskList items={m.revisions} empty="Nothing sent back in the last 90 days." />
          </Peek>
          <Peek label={m.errors.d90 === 1 ? "error" : "errors"} n={m.errors.d90} tone={m.errors.d45 >= 3 ? "bad" : m.errors.d90 ? "warn" : null} title={`Real errors · ${m.errors.d45} in 45 days, ${m.errors.d90} in 90`}>
            <ErrorList items={m.errors.items} />
          </Peek>
          <Peek label={`pushed back${m.pushedBack.pct != null ? ` · ${m.pushedBack.pct}%` : ""}`} n={m.pushedBack.items.length} tone={(m.pushedBack.pct ?? 0) >= 25 ? "warn" : null} title={`Due dates they moved later · ${m.pushedBack.items.length} of ${m.pushedBack.of} pieces, 90 days`}>
            <TaskList items={m.pushedBack.items} empty="They haven't moved a due date later in the last 90 days." />
          </Peek>
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={!m.winners.length || !m.profileId}
              onClick={() => m.profileId && pushParams({ winners: m.profileId })}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors max-md:min-h-11 ${m.winners.length ? "border-ok/30 bg-ok-soft text-ok hover:border-ok/60" : "border-line text-faint"}`}
            >
              <span className="tabular font-semibold">{m.winners.length}</span> winning {m.winners.length === 1 ? "ad" : "ads"}
              {m.winners.length > 0 && <span aria-hidden>→</span>}
            </button>
          </span>
        </div>

        {m.act && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[12.5px] leading-snug text-warn">{m.act}</p>}
      </div>
    </li>
  );
}

/** Everything on one person's plate, what came back and their errors (?person=), a sheet on any page of the tab */
export function PersonSheet({ makers }: { makers: Maker[] }) {
  const id = useParam("person");
  const m = makers.find((x) => x.profileId === id);
  useEffect(() => {
    if (!m) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams("person");
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [m]);
  if (!m) return null;
  const late = m.plate.filter((t) => t.late);
  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={m.name}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => closeParams("person")} aria-hidden />
      <aside className="pb-safe absolute inset-x-0 bottom-0 top-[6vh] grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.8)] md:inset-y-3 md:left-auto md:right-3 md:top-3 md:w-[560px] md:rounded-[26px]">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ink/[0.07] text-[14px] font-semibold">{initials(m.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[20px] leading-tight">{m.name}</p>
            <p className="text-[12.5px] text-muted">
              {m.role} · {m.level}
              {m.score != null ? ` · score ${m.score}` : ""}
            </p>
          </div>
          <button type="button" onClick={() => closeParams("person")} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-fg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="grid content-start gap-6 overflow-y-auto overscroll-contain px-5 py-5">
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["On their plate", m.plate.length, late.length ? `${late.length} late` : "none late"],
                ["Passed on", m.pieces, m.turnaround == null ? "" : `${m.turnaround}d each`],
                ["Errors · 90d", m.errors.d90, `${m.errors.d45} in 45 days`],
              ] as const
            ).map(([k, v, sub]) => (
              <div key={k} className="grid gap-1 rounded-[16px] border border-line bg-surface p-3">
                <span className="text-[11px] text-muted">{k}</span>
                <span className="tabular font-display text-[26px] leading-none">{v}</span>
                <span className="text-[11px] text-faint">{sub}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["Brief → client", m.briefToDone == null ? "—" : `${m.briefToDone}d`, "business days"],
                ["Met due date", m.metDue.pct == null ? "—" : `${m.metDue.pct}%`, `of ${m.metDue.of} with a due date`],
                ["Pushed back", m.pushedBack.pct == null ? "—" : `${m.pushedBack.pct}%`, `${m.pushedBack.items.length} of ${m.pushedBack.of} pieces`],
                ["Revision back in", m.revisionTurnaround == null ? "—" : `${m.revisionTurnaround}d`, "business days"],
              ] as const
            ).map(([k, v, sub]) => (
              <div key={k} className="grid gap-1 rounded-[16px] border border-line bg-surface p-3">
                <span className="text-[11px] text-muted">{k}</span>
                <span className="tabular font-display text-[22px] leading-none">{v}</span>
                <span className="text-[11px] text-faint">{sub}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-[16px] border border-line bg-surface p-4">
            <Rate label="Sent back internally" s={m.sendbacks} kind="internal" />
            <Rate label="Sent back by clients" s={m.sendbacks} kind="client" />
          </div>
          {m.winners.length > 0 && m.profileId && (
            <button type="button" onClick={() => pushParams({ winners: m.profileId, person: null })} className="flex min-h-12 items-center justify-between rounded-[16px] border border-ok/30 bg-ok-soft px-4 text-[14px] text-ok">
              <span>
                <b className="tabular">{m.winners.length}</b> winning {m.winners.length === 1 ? "ad" : "ads"} from their work
              </span>
              <span aria-hidden>See them →</span>
            </button>
          )}
          {m.act && <p className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] text-warn">{m.act}</p>}
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">On their plate right now</h3>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">
              {m.plate.length ? m.plate.map((t) => <TaskRow key={t.key} t={t} />) : <p className="px-3 py-3 text-[13px] text-muted">Nothing open right now.</p>}
            </div>
          </section>
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">Sent back, last 90 days</h3>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">
              {m.revisions.length ? m.revisions.map((t) => <TaskRow key={t.key} t={t} />) : <p className="px-3 py-3 text-[13px] text-muted">Nothing came back.</p>}
            </div>
          </section>
          {m.pushedBack.items.length > 0 && (
            <section className="grid gap-2">
              <h3 className="font-heading text-[16px]">Due dates they moved later</h3>
              <div className="rounded-[16px] border border-line bg-surface p-1.5">
                {m.pushedBack.items.map((t) => (
                  <TaskRow key={t.key} t={t} />
                ))}
              </div>
            </section>
          )}
          {m.metDue.missed.length > 0 && (
            <section className="grid gap-2">
              <h3 className="font-heading text-[16px]">Reached the client after the due date</h3>
              <div className="rounded-[16px] border border-line bg-surface p-1.5">
                {m.metDue.missed.map((t) => (
                  <TaskRow key={t.key} t={t} />
                ))}
              </div>
            </section>
          )}
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">Real errors, last 90 days</h3>
            <p className="text-[12px] text-faint">Objective mistakes only (a typo, a missing button, the wrong size, logo, offer or link), not changes of taste.</p>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">
              <ErrorList items={m.errors.items} max={12} />
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

/** A person's winning ads, as they run in the feed (?winners=<profile id>) */
export function WinnersSheet({ makers }: { makers: Maker[] }) {
  const id = useParam("winners");
  const m = makers.find((x) => x.profileId === id);
  useEffect(() => {
    if (!m) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams("winners");
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [m]);
  if (!m) return null;
  const launched = m.winners.filter((w) => w.how === "launched").length;
  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={`${m.name}'s winning ads`}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => closeParams("winners")} aria-hidden />
      <aside className="pb-safe absolute inset-x-0 bottom-0 top-[5vh] grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.8)] md:inset-6 md:rounded-[26px]">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ok-soft text-[14px] font-semibold text-ok">{initials(m.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[20px] leading-tight">{m.name}&rsquo;s winning ads</p>
            <p className="text-[12.5px] text-muted">
              {m.winners.length} profitable {m.winners.length === 1 ? "winner" : "winners"} · {launched} launched from Kaizen Ads{m.winners.length - launched ? `, ${m.winners.length - launched} matched to their Asana work by name` : ""}
            </p>
          </div>
          <button type="button" onClick={() => closeParams("winners")} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-fg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="overflow-y-auto overscroll-contain px-5 py-6">
          <div className="mx-auto grid max-w-6xl gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {m.winners.map((w) => (
              <WinnerCard key={w.key} w={w} credit={w} />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** A late ticket at a glance: its newest creative, where it is, who has it, and the last comment (loaded on hover) */
function TicketPeek({ t }: { t: CreativeKpis["late"][number] }) {
  const [media, setMedia] = useState<{ thumb: string | null; comment: { body: string; author: string | null } | null } | "loading" | null>("loading");
  useEffect(() => {
    let off = false;
    fetch(`/api/board/media/${t.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { designs?: { versions: { files: { thumbUrl: string | null; url: string | null }[] }[] }[]; comments?: { body: string; author: string | null; at: string }[] } | null) => {
        if (off) return;
        const file = j?.designs?.[0]?.versions?.[0]?.files?.[0];
        const last = [...(j?.comments ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0];
        setMedia({ thumb: file?.thumbUrl ?? file?.url ?? null, comment: last ? { body: last.body, author: last.author } : null });
      })
      .catch(() => !off && setMedia(null));
    return () => {
      off = true;
    };
  }, [t.id]);
  const m = media === "loading" ? null : media;
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-0.5">
        <span className="flex items-center gap-1.5 text-[11px] text-faint">
          #{t.number}
          {t.urgent && <span className="rounded-full bg-bad-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-bad">Urgent</span>}
        </span>
        <span className="text-[14px] font-medium leading-snug [overflow-wrap:anywhere]">{t.title}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
        {(
          [
            ["Client", t.client || "—"],
            ["Stage", t.stage],
            ["With", t.assignee ?? "nobody yet"],
            ["Late by", `${t.hoursOver}h`],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="grid">
            <dt className="text-faint">{k}</dt>
            <dd className={k === "Late by" ? "text-bad" : "text-fg"}>{v}</dd>
          </div>
        ))}
      </dl>
      {media === "loading" ? (
        <span className="h-28 animate-pulse rounded-[10px] bg-ink/[0.06]" />
      ) : m?.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.thumb} alt="" className="max-h-40 w-full rounded-[10px] object-cover" />
      ) : null}
      {m?.comment && (
        <p className="rounded-[10px] bg-ink/[0.04] px-2.5 py-2 text-[12px] leading-snug text-muted">
          <span className="text-fg">{m.comment.author ?? "Last comment"}:</span> {m.comment.body.slice(0, 220)}
        </p>
      )}
      <p className="text-[11px] text-faint">Click to open the ticket</p>
    </div>
  );
}

/** A late ticket in the list: hover for the ticket, click to open it on the Board */
export function LateRow({ t }: { t: CreativeKpis["late"][number] }) {
  return (
    <li>
      <HoverCard width={400} className="block" content={<TicketPeek t={t} />}>
        <Link href={`/board?t=${t.number}`} className="flex items-start gap-3 rounded-[14px] px-3 py-2.5 hover:bg-ink/[0.04]">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-start gap-1.5 text-[13.5px]">
              <span className="shrink-0 text-faint">#{t.number}</span>
              {t.urgent && <span className="mt-0.5 shrink-0 rounded-full bg-bad-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-bad">Urgent</span>}
              <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{t.title}</span>
            </span>
            <span className="block truncate text-[11.5px] text-muted">{[t.client, t.stage, t.assignee].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="tabular shrink-0 text-[12px] text-bad">{t.hoursOver}h over</span>
        </Link>
      </HoverCard>
    </li>
  );
}

/** Sort the feedback into errors now (execs and leads) */
export function CheckErrors({ unsorted }: { unsorted: number }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={Boolean(state)}
      onClick={async () => {
        setState("Reading feedback…");
        const r = await checkErrorsNow();
        setState(r.ok ? "Reading: back in a minute or two" : r.error);
      }}
      className="inline-flex min-h-9 items-center rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg disabled:opacity-70 max-md:min-h-11"
    >
      {state ?? (unsorted ? `Sort ${unsorted} new feedback` : "Check feedback for errors")}
    </button>
  );
}

const STATUS: Record<ClientAllotment["status"], { label: string; tone: "ok" | "warn" | "bad" }> = {
  missed: { label: "Missed last cycle", tone: "bad" },
  at_risk: { label: "At risk", tone: "bad" },
  behind: { label: "Behind", tone: "warn" },
  on_track: { label: "On track", tone: "ok" },
  ahead: { label: "Ahead", tone: "ok" },
};
const SOFT = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" } as const;
const BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
const FILTERS = [
  ["critical", "Needs attention"],
  ["all", "All"],
  ["on_track", "On track"],
] as const;

/** Every creative-package client's allotment this cycle: critical first, in a list that scrolls on its own */
export function AllotmentList({ rows, canDismiss }: { rows: ClientAllotment[]; canDismiss: boolean }) {
  const router = useRouter();
  const asked = useParam("allot");
  const filter = asked === "all" || asked === "on_track" ? asked : asked === "behind" ? "critical" : "critical";
  const [showDismissed, setShowDismissed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const live = rows.filter((r) => !r.dismissed);
  const dismissed = rows.filter((r) => r.dismissed);
  const critical = live.filter((r) => ["missed", "at_risk", "behind"].includes(r.status));
  const shown = filter === "all" ? live : filter === "on_track" ? live.filter((r) => r.status === "on_track" || r.status === "ahead") : critical;

  const dismiss = async (a: ClientAllotment) => {
    if (!a.periodStart) return;
    const r = await dismissAllotment(a.id, a.periodStart, reason);
    if (!r.ok) return setError(r.error);
    setEditing(null);
    setReason("");
    setError(null);
    router.refresh();
  };
  const restore = async (a: ClientAllotment) => {
    if (!a.periodStart) return;
    const r = await restoreAllotment(a.id, a.periodStart);
    if (r.ok) router.refresh();
  };

  const row = (a: ClientAllotment) => {
    const s = STATUS[a.status];
    const share = a.cap ? Math.min(1, a.used / a.cap) : null;
    return (
      <li key={a.id} className="grid gap-2 border-b border-line/70 px-4 py-3 last:border-0">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] md:items-center md:gap-4">
          <Link href={`/clients/${a.slug}`} className="min-w-0 truncate text-[14px] hover:underline">
            {a.name}
          </Link>
          <span className="relative h-2 overflow-hidden rounded-full bg-ink/[0.07]" aria-label={`${a.used} of ${a.cap ?? "?"} made, ${Math.round(a.elapsed * 100)}% through the cycle`}>
            {share != null && <span className={`absolute inset-y-0 left-0 rounded-full ${a.dismissed ? "bg-ink/25" : BAR[s.tone]}`} style={{ width: `${Math.max(3, share * 100)}%` }} />}
            <span className="absolute inset-y-[-2px] w-[2px] bg-fg/60" style={{ left: `${a.elapsed * 100}%` }} />
          </span>
          <span className="flex items-center justify-between gap-2 md:justify-end">
            <span className="tabular text-[12px] text-muted">
              {a.used}/{a.cap ?? "?"}
              {a.resets && <span className="text-faint"> · resets {when(a.resets)}</span>}
            </span>
            {a.dismissed ? (
              <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-[11px] text-muted">Dismissed</span>
            ) : (
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${SOFT[s.tone]}`}>{s.label}</span>
            )}
            {canDismiss && a.periodStart && (
              <button
                type="button"
                onClick={() => (a.dismissed ? void restore(a) : setEditing(editing === a.id ? null : a.id))}
                className="min-h-9 rounded-full px-2.5 text-[12px] text-faint hover:text-fg max-md:min-h-11"
              >
                {a.dismissed ? "Count again" : "Dismiss"}
              </button>
            )}
          </span>
        </div>
        {a.dismissed && (
          <p className="text-[11.5px] text-faint">
            {a.dismissed.reason ? `“${a.dismissed.reason}”` : "Set aside"} · {a.dismissed.by ?? "an exec"}, {when(a.dismissed.at)}
          </p>
        )}
        {/* One concept per brief: Asana tasks that bundled several, each should have been that many briefs */}
        {a.bundled.length > 0 && (
          <ul className="grid gap-1">
            {a.bundled.slice(0, 3).map((t, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2 text-[12px] text-warn">
                <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span className="min-w-0">
                  {t.concepts} distinct concepts in one task: should be {t.concepts} briefs.{" "}
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:text-fg hover:underline">
                      {t.name}
                    </a>
                  ) : (
                    <span className="text-muted">{t.name}</span>
                  )}
                </span>
              </li>
            ))}
            {a.bundled.length > 3 && <li className="pl-3.5 text-[11.5px] text-faint">and {a.bundled.length - 3} more</li>}
          </ul>
        )}
        {editing === a.id && (
          <div className="grid gap-2 rounded-[12px] bg-ink/[0.035] p-3">
            <label className="grid gap-1 text-[12px] text-muted">
              Dismiss for this billing cycle: why?
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. delayed on our side, billing dates out of step" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[14px] text-fg outline-none focus:border-brand-text/60" />
            </label>
            {error && <p className="text-[12px] text-bad">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={!reason.trim()} onClick={() => void dismiss(a)} className="h-10 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40">
                Dismiss this cycle
              </button>
              <button type="button" onClick={() => setEditing(null)} className="h-10 px-3 text-[13px] text-muted">
                Cancel
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="overflow-hidden rounded-[22px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => pushParams({ allot: k === "critical" ? null : k })}
            className={`min-h-9 rounded-full px-3 text-[12.5px] max-md:min-h-11 ${filter === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
          >
            {label}
            <span className="tabular ml-1 opacity-60">{k === "critical" ? critical.length : k === "all" ? live.length : live.filter((r) => r.status === "on_track" || r.status === "ahead").length}</span>
          </button>
        ))}
        <span className="ml-auto hidden text-[11px] text-faint md:inline">Bar: made so far · line: where they should be by now</span>
      </div>
      <ul className="max-h-[440px] overflow-y-auto overscroll-contain">
        {shown.length ? shown.map(row) : <li className="px-4 py-6 text-center text-[13px] text-ok">{filter === "critical" ? "Every client is on track this cycle." : "No clients here."}</li>}
      </ul>
      {dismissed.length > 0 && (
        <div className="border-t border-line">
          <button type="button" onClick={() => setShowDismissed(!showDismissed)} className="flex min-h-11 w-full items-center justify-between px-4 text-[12.5px] text-muted hover:text-fg">
            <span>Dismissed this cycle · {dismissed.length}</span>
            <span aria-hidden>{showDismissed ? "−" : "+"}</span>
          </button>
          {showDismissed && <ul className="max-h-[260px] overflow-y-auto">{dismissed.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}

/** A client sending work back: hover for their five latest pieces with revisions */
export function ClientRevisions({ c }: { c: { client: string; slug: string | null; perPiece: number; recent: TaskRef[] } }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]">
      <HoverCard
        width={400}
        content={
          <div className="grid gap-1">
            <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{c.client}: latest revisions</p>
            <TaskList items={c.recent} empty="No revisions recorded in the last 90 days." max={5} />
          </div>
        }
      >
        <Link href={c.slug ? `/clients/${c.slug}` : "#"} className="min-w-0 truncate underline decoration-ink/20 underline-offset-4 hover:decoration-ink/60">
          {c.client}
        </Link>
      </HoverCard>
      <span className="tabular shrink-0 text-[12px] text-warn">{c.perPiece} per piece</span>
    </div>
  );
}

/** The ad's picture for a preview: the kept copy (Meta's own links expire), else the link we have */
export function pictureOf(adId: string | null | undefined, image: string | null) {
  const url = adMediaUrl(adId) ?? image;
  return url ? ({ kind: "single", feed: { thumb: url, url, mime: "image/jpeg", aspect: "4x5" }, story: null } as const) : null;
}

/** The ad a background brief is written from */
const jobKey = (j: { key?: string | null }) => j.key ?? null;

const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);

/** A winning ad as it runs in the feed, why it wins, and a brief for more like it */
export function WinnerCard({ w, credit, copy }: { w: Winner; credit?: WinnerAd; /** Shown for its copy: click-through and angle, and a copy-led brief */ copy?: { ctr: number | null; angle: string | null } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
  const open = useParam("brief");
  const job = useJobFor("winner", (j) => (j.status === "queued" || j.status === "writing") && jobKey(j) === w.key);
  const better = w.target && w.costPerResult ? Math.round(((w.target - w.costPerResult) / w.target) * 100) : null;
  const source = { adId: w.key, client: w.client, detail: null, headline: w.headline, text: w.text, thumbnail: w.image, ratio: w.target && w.costPerResult ? Math.round((w.target / w.costPerResult) * 10) / 10 : 1, result: w.result, costPerResult: w.costPerResult ?? 0, usual: w.target ?? w.costPerResult ?? 0 };
  // The quick preview first (in the address, so back closes it); the full brief is then written in the background
  const previewing = useParam("preview") === `kw-${w.key}`;
  const go = async (seed: QuickBrief, part = 0) => {
    setBusy(true);
    setError(null);
    const r = await startWinnerBrief(source, w.clientId, `${window.location.pathname}${window.location.search}`, seed, part).catch(() => ({ ok: false as const, error: "Couldn't start the brief. Try again." }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if ("job" in r) return trackJob(r.job);
    setBrief(r.suggestion);
    pushParams({ brief: r.suggestion.id });
  };
  const closePreview = () => closeParams("preview");
  return (
    <article className="grid content-start gap-3">
      <div className="pointer-events-none">
        <AdPreview page={w.client} primaryText={w.text ?? ""} headline={w.headline ?? ""} description="" cta={w.cta ?? "Learn more"} media={pictureOf(w.key, w.image)} adId={/^\d{5,25}$/.test(w.key) ? w.key : null} />
      </div>
      <div className="grid gap-2 rounded-[16px] border border-line bg-surface p-3.5">
        <p className="text-[12px] text-muted">
          <span className="font-medium text-ok">Why it wins</span> · {w.client} · {w.days} days live
        </p>
        {copy && (
          <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
            {copy.angle && <span className="rounded-full bg-brand/10 px-2 py-0.5 font-medium text-brand-text">{copy.angle}</span>}
            {copy.ctr != null && <span className="rounded-full bg-ink/[0.05] px-2 py-0.5">CTR {copy.ctr}%</span>}
          </p>
        )}
        {credit && (
          <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
            <span className={`rounded-full px-2 py-0.5 font-medium ${credit.how === "launched" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{credit.how === "launched" ? "Launched from Kaizen Ads" : "Matched by name"}</span>
            {credit.task && <span className="min-w-0 truncate">{credit.task}</span>}
          </p>
        )}
        <dl className="tabular grid grid-cols-3 gap-2 text-center">
          {(
            [
              [`Cost per ${w.result ?? "result"}`, money(w.costPerResult), better != null ? `${better > 0 ? better : 0}% under target` : w.target ? `target ${money(w.target)}` : ""],
              ["ROAS", w.roas == null ? "—" : `${w.roas}x`, ""],
              ["Spend", money(w.spend), `${w.results} ${w.result ?? "results"}`],
            ] as const
          ).map(([k, v, sub]) => (
            <div key={k} className="grid gap-0.5 rounded-[10px] bg-ink/[0.04] px-1.5 py-2">
              <dt className="truncate text-[10.5px] text-muted">{k}</dt>
              <dd className="text-[15px] font-semibold">{v}</dd>
              {sub && <span className="truncate text-[10.5px] text-ok">{sub}</span>}
            </div>
          ))}
        </dl>
        {error && <p className="text-[12px] text-bad">{error}</p>}
        {job ? (
          <BriefProgress job={job} />
        ) : (
          <button type="button" onClick={() => pushParams({ preview: `kw-${w.key}` })} disabled={busy} className="h-11 rounded-full bg-fg text-[14px] font-medium text-bg disabled:opacity-60">
            {busy ? "Starting…" : copy ? "Brief new copy like this" : "Brief more like this"}
          </button>
        )}
        <p className="text-center text-[11px] text-faint">A quick preview first. The full brief only if you choose it, then it opens in Ready to send</p>
      </div>
      {previewing && (
        <QuickBriefSheet
          clientId={w.clientId}
          source={{ kind: "winner", winner: source }}
          from={{ kicker: copy ? "New copy like a winner" : "More like a winner", label: w.headline ?? w.name, thumb: w.image, adId: /^\d{5,25}$/.test(w.key) ? w.key : null }}
          progressLabel="brief from a winner"
          background
          onWrite={(seed) => {
            closePreview();
            void go(copy && !seed.note.trim() ? { ...seed, note: "A copy-led brief: new copy on the same creative." } : seed);
          }}
          onWriteAll={(seeds) => {
            closePreview();
            seeds.forEach((seed, i) => void go(seed, i));
          }}
          onClose={closePreview}
        />
      )}
      {brief && open === brief.id && <SuggestionSheet s={brief} onClose={() => closeThen(() => router.refresh(), "brief")} />}
    </article>
  );
}

const pctChange = (x: number | null) => (x == null ? null : `${x > 0 ? "+" : "−"}${Math.round(Math.abs(x) * 100)}%`);

/** A tiring ad as it runs, what's wearing out, and three ways to replace it */
export function TiringCard({ r, copy = false }: { r: WatchRow; /** Shown as copy wearing out (clicks falling, the creative still stopping people) */ copy?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
  const open = useParam("refresh");
  const job = useJobFor("refresh", (j) => (j.status === "queued" || j.status === "writing") && jobKey(j) === r.adId);
  const s = r.signals;
  const tired = r.severity === "tired";
  const chips = [
    s.ctrChange <= -0.05 && { label: "CTR", v: `${s.ctrBefore.toFixed(2)}% → ${s.ctrNow.toFixed(2)}%`, c: pctChange(s.ctrChange) },
    s.cprChange != null && s.cprChange >= 0.05 && { label: `Cost per ${s.result ?? "result"}`, v: `${money(s.cprBefore)} → ${money(s.cprNow)}`, c: pctChange(s.cprChange) },
    s.freqBefore > 0 && s.freqNow / s.freqBefore >= 1.1 && { label: "Frequency", v: `${s.freqBefore.toFixed(2)} → ${s.freqNow.toFixed(2)}`, c: pctChange(s.freqNow / s.freqBefore - 1) },
    s.hookChange != null && s.hookChange <= -0.1 && { label: "Hook rate", v: `${s.hookBefore}% → ${s.hookNow}%`, c: pctChange(s.hookChange) },
  ].filter(Boolean) as { label: string; v: string; c: string | null }[];
  const previewing = useParam("preview") === `kr-${r.adId}`;
  const closePreview = () => closeParams("preview");
  const refresh = async (seed: QuickBrief | null, part = 0) => {
    setBusy(true);
    setError(null);
    const res = await startRefreshBrief(r.clientId, r.adId, r.headline ?? r.adName, `${window.location.pathname}${window.location.search}`, seed, part).catch(() => ({ ok: false as const, error: "Couldn't start the brief. Try again." }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    if ("job" in res) return trackJob(res.job);
    setBrief(res.suggestion);
    pushParams({ refresh: res.suggestion.id });
  };
  return (
    <article className="grid content-start gap-3">
      <div className="relative">
        <div className="pointer-events-none">
          <AdPreview page={r.client} primaryText="" headline={r.headline ?? r.adName} description="" cta="Learn more" media={pictureOf(r.adId, r.thumbnail)} adId={r.adId && /^\d{5,25}$/.test(r.adId) ? r.adId : null} />
        </div>
        <span className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-semibold shadow ${r.state === "refreshing" ? "bg-ok text-white" : tired ? "bg-bad text-white" : "bg-warn text-white"}`}>
          {r.state === "refreshing" ? "Being refreshed" : copy ? "Copy wearing out" : tired ? "Tired: replace it" : "Tiring"}
        </span>
      </div>
      <div className="grid gap-2.5 rounded-[16px] border border-line bg-surface p-3.5">
        <p className="text-[12px] text-muted">
          {r.client} · {s.daysRunning} days running · {money(s.spend7)} this week
        </p>
        {chips.length > 0 && (
          <ul className="grid gap-1">
            {chips.map((c) => (
              <li key={c.label} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="text-muted">{c.label}</span>
                <span className="tabular text-fg">
                  {c.v} {c.c && <span className="text-bad">{c.c}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-[12px] text-bad">{error}</p>}
        {r.state === "refreshing" ? (
          <p className="flex flex-wrap gap-1.5 text-[12px] text-muted">
            Replacement in the works:
            {r.requestNumbers.map((n) => (
              <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 hover:border-faint">
                #{n}
              </Link>
            ))}
          </p>
        ) : (
          <div className="grid gap-1.5">
            {job ? (
              <BriefProgress job={job} />
            ) : (
              <button type="button" onClick={() => (r.briefId ? void refresh(null) : pushParams({ preview: `kr-${r.adId}` }))} disabled={busy} className="h-11 rounded-full bg-fg text-[14px] font-medium text-bg disabled:opacity-60">
                {busy ? "Starting…" : r.briefId ? "Open the refresh brief" : copy ? "Write new copy for this" : "Brief a refresh"}
              </button>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <Link href={`/requests/new?client=${r.clientSlug}`} className="grid h-10 place-items-center rounded-full border border-line text-[12.5px] text-muted hover:text-fg">
                Brief from a winner
              </Link>
              {/* A new concept to replace it: its quick preview right here, like the refresh */}
              <BriefPreviewButton
                previewKey={`kn-${r.adId}`}
                clientId={r.clientId}
                source={{
                  kind: "idea",
                  label: `New creative to replace "${r.headline ?? r.adName}"`.slice(0, 200),
                  text: [`This ad is ${tired ? "tired" : "tiring"} after ${s.daysRunning} days (${money(s.spend7)} this week).`, ...chips.map((c) => `${c.label}: ${c.v}${c.c ? ` (${c.c})` : ""}`), "Brief a new concept to replace it: a different angle, hook or format, not a refresh of this one."].join("\n"),
                }}
                from={{ kicker: "New creative for a tiring ad", label: r.headline ?? r.adName, thumb: r.thumbnail, adId: r.adId && /^\d{5,25}$/.test(r.adId) ? r.adId : null }}
                className="grid h-11 place-items-center rounded-full border border-line text-[12.5px] text-muted hover:text-fg md:h-10"
              >
                New creative
              </BriefPreviewButton>
            </div>
          </div>
        )}
      </div>
      {previewing && (
        <QuickBriefSheet
          clientId={r.clientId}
          source={{ kind: "refresh", adId: r.adId }}
          from={{ kicker: copy ? "New copy for a tiring ad" : "Refresh a tiring ad", label: r.headline ?? r.adName, thumb: r.thumbnail, adId: r.adId && /^\d{5,25}$/.test(r.adId) ? r.adId : null }}
          progressLabel="refresh a tiring ad"
          background
          onWrite={(seed) => {
            closePreview();
            void refresh(copy && !seed.note.trim() ? { ...seed, note: "Copy is wearing out: new copy on the same creative." } : seed);
          }}
          onWriteAll={(seeds) => {
            closePreview();
            seeds.forEach((seed, i) => void refresh(seed, i));
          }}
          onClose={closePreview}
        />
      )}      {brief && open === brief.id && <SuggestionSheet s={brief} onClose={() => closeThen(() => router.refresh(), "refresh")} />}
    </article>
  );
}
