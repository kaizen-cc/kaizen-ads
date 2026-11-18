"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { klaviyoCampaignPreview } from "@/app/(team)/clients/[slug]/klaviyo-actions";
import { HoverCard } from "@/components/hover-card";
import type { Sendbacks, TaskRef } from "@/lib/creative-kpis";
import type { BuildMaker, Cadence, EmailMaker, EmailResult, FixItem, LateTicket, StrategistCard, TiringFlow, Workload } from "@/lib/email-kpis";
import type { EmailErrorItem } from "@/lib/email-errors";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { matchesClientName } from "@/lib/allotment";
import { TaskRow } from "../kpi-parts";
import { dismissCadence, restoreCadence } from "./kpi-actions";

// The interactive pieces of the Email Board's KPI tabs, built like the Creative KPIs' own: each designer's card and
// everything on their plate (a sheet, in the address so back closes it), quick looks on hover (a sheet on a phone),
// each client's sending this cycle with Dismiss, the workload, late tickets, and the emails themselves as they land in
// the inbox: designs that out-click their account, the ones that fell short, and flows whose clicks are tiring.

const when = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
const money = (n: number | null, digits = 0) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`);
const stop = { onClick: (e: React.MouseEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() };

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

// Each email's HTML, read once per page (the same saved preview the client page's hover card shows)
const previews = new Map<string, Promise<string | null>>();
function previewHtml(clientId: string, campaignId: string) {
  const k = `${clientId}:${campaignId}`;
  let p = previews.get(k);
  if (!p) {
    p = klaviyoCampaignPreview(clientId, campaignId)
      .then((r) => (r.ok && r.preview.html && r.preview.channel !== "sms" ? r.preview.html : null))
      .catch(() => null);
    previews.set(k, p);
  }
  return p;
}

/**
 * The top of an email as it landed: the saved picture when there is one (the Board's uploaded design or the report's
 * drawing), otherwise the email itself in a frame that runs nothing (no scripts, no same origin), scaled to the card,
 * read from the client's email platform when the card comes into view.
 */
function EmailThumb({ r }: { r: EmailResult }) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [width, setWidth] = useState(320);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (r.image && !failed) return;
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth || 320);
    let live = true;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((x) => x.isIntersecting)) return;
      io.disconnect();
      void previewHtml(r.clientId, r.key.split(":").slice(1).join(":")).then((h) => live && setHtml(h));
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [r.image, r.clientId, r.key, failed]);
  if (r.image && !failed)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={r.image} alt={`The top of ${r.subject ?? r.name}`} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover object-top" />;
  const scale = width / 600;
  return (
    <div ref={box} className="absolute inset-0 bg-white">
      {html ? (
        <iframe title={`The top of ${r.subject ?? r.name}`} srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" loading="lazy" tabIndex={-1} className="pointer-events-none block border-0" style={{ width: 600, height: 900 / Math.max(scale, 0.1), transform: `scale(${scale})`, transformOrigin: "0 0" }} />
      ) : html === null ? (
        <div className="grid h-full place-items-center bg-surface-2 px-6 text-center text-[12.5px] text-faint">This email&apos;s preview couldn&apos;t be read from the client&apos;s email platform.</div>
      ) : (
        <div className="h-full animate-pulse bg-surface-2" aria-label="Loading the email" />
      )}
    </div>
  );
}

type Tone3 = "ok" | "warn" | "bad" | null;
const TONE_TEXT3 = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const rateText = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : null);
const rateTone = (n: number, of: number): Tone3 => {
  if (!of) return null;
  const r = (n / of) * 100;
  return r <= 20 ? "ok" : r <= 40 ? "warn" : "bad";
};

/** A card's numbers: label, the number, what it counts (two across on a phone, three wider) */
function StatGrid({ stats }: { stats: { label: string; value: string | null; sub: string; tone: Tone3 }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-3.5 sm:grid-cols-3">
      {stats.map((s) => (
        <div key={s.label} className="grid content-start gap-0.5">
          <dt className="text-[11px] text-muted">{s.label}</dt>
          <dd className={`tabular text-[19px] font-semibold leading-none ${s.tone ? TONE_TEXT3[s.tone] : "text-fg"}`}>{s.value ?? "—"}</dd>
          <span className="text-[10.5px] leading-snug text-faint">{s.sub}</span>
        </div>
      ))}
    </dl>
  );
}

/** What's on their plate, in a list that scrolls on its own (late first); tapping a row opens it, never the card */
function PlateBox({ items, late, label = "On their plate" }: { items: TaskRef[]; late: number; label?: string }) {
  return (
    <div {...stop} className="grid gap-1 rounded-[14px] bg-ink/[0.035] p-1.5">
      <p className="flex items-baseline justify-between px-2 pt-1 text-[11.5px]">
        <span className="font-medium text-fg">{label}</span>
        <span className="tabular text-faint">
          {items.length}
          {late ? <span className="text-bad"> · {late} late</span> : null}
        </span>
      </p>
      {items.length ? (
        <div className="max-h-52 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
          {items.map((t) => (
            <TaskRow key={t.key} t={t} compact />
          ))}
        </div>
      ) : (
        <p className="px-2 pb-2 text-[12.5px] text-muted">Nothing open right now.</p>
      )}
    </div>
  );
}

/** Real errors read from comments on someone's work, with what was said */
function ErrorList({ items, max = 8 }: { items: EmailErrorItem[]; max?: number }) {
  if (!items.length) return <p className="px-2.5 py-2 text-[13px] text-muted">No errors in comments on their work in the last 90 days.</p>;
  return (
    <div className="grid gap-1.5">
      {items.slice(0, max).map((e) => {
        const href = e.ticket ? `/board/email?t=${e.ticket}` : e.url;
        const body = (
          <>
            <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full bg-bad-soft px-2 py-0.5 font-medium text-bad">{e.type ?? "Error"}</span>
              <span className="text-faint">{[e.client, e.author, when(e.at)].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="line-clamp-3 text-[12.5px] leading-snug text-fg">{e.quote}</span>
            {(e.task || e.ticket) && <span className="truncate text-[11px] text-muted">{e.ticket ? `E-${e.ticket} ` : ""}{e.task ?? ""}</span>}
          </>
        );
        return href ? (
          <a key={e.id} href={href} target={e.ticket ? undefined : "_blank"} rel="noreferrer" className="grid gap-1 rounded-[12px] px-2.5 py-2 hover:bg-ink/[0.05]">
            {body}
          </a>
        ) : (
          <div key={e.id} className="grid gap-1 rounded-[12px] px-2.5 py-2">
            {body}
          </div>
        );
      })}
    </div>
  );
}

function CardHead({ name, sub, right }: { name: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink/[0.07] text-[13px] font-semibold text-fg">{initials(name)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-heading text-[17px] leading-tight">{name}</p>
        <p className="truncate text-[12px] text-muted">{sub}</p>
      </div>
      {right}
    </div>
  );
}

/** An email builder: builds, turnaround, what came back, real errors, pushback, and their plate */
export function BuildCard({ b }: { b: BuildMaker }) {
  return (
    <li className="grid content-start gap-4 rounded-[22px] border border-line bg-surface p-5">
      <CardHead name={b.name} sub={`${b.role} · ${b.builds} ${b.builds === 1 ? "build" : "builds"} this period`} />
      <StatGrid
        stats={[
          { label: "Turnaround", value: b.turnaround == null ? null : `${b.turnaround}d`, sub: `target ${b.turnaroundTarget}d · ${b.onTime == null ? "no builds yet" : `${b.onTime}% on time`}`, tone: b.turnaround == null ? null : b.turnaround <= b.turnaroundTarget ? "ok" : b.turnaround <= b.turnaroundTarget * 1.5 ? "warn" : "bad" },
          { label: "Came back", value: b.returnRate == null ? null : `${b.returnRate}%`, sub: `${b.returns} of ${b.builds} builds returned`, tone: b.returnRate == null ? null : b.returnRate <= 10 ? "ok" : b.returnRate <= 25 ? "warn" : "bad" },
          { label: "Errors", value: String(b.errors.d90), sub: `${b.errors.d45} in 45d · read from comments`, tone: b.errors.d45 >= 3 ? "bad" : b.errors.d90 ? "warn" : "ok" },
          { label: "Pushback", value: b.pushedBack.pct == null ? null : `${b.pushedBack.pct}%`, sub: `${b.pushedBack.items.length} of ${b.pushedBack.of} tasks rescheduled, 90d`, tone: b.pushedBack.pct == null ? null : b.pushedBack.pct <= 10 ? "ok" : b.pushedBack.pct <= 25 ? "warn" : "bad" },
        ]}
      />
      <PlateBox items={b.plate} late={b.late} />
      <div className="flex flex-wrap gap-1.5">
        <Peek label={b.errors.d90 === 1 ? "error" : "errors"} n={b.errors.d90} tone={b.errors.d45 >= 3 ? "bad" : b.errors.d90 ? "warn" : null} title={`Real errors in comments on their builds · ${b.errors.d45} in 45 days, ${b.errors.d90} in 90`}>
          <ErrorList items={b.errors.items} />
        </Peek>
        <Peek label="came back" n={b.returned.length} title="Builds that came back to them">
          <TaskList items={b.returned} empty="Nothing came back this period." />
        </Peek>
        <Peek label="rescheduled" n={b.pushedBack.items.length} tone={(b.pushedBack.pct ?? 0) >= 25 ? "warn" : null} title="Due dates they moved later, 90 days">
          <TaskList items={b.pushedBack.items} empty="They haven't moved a due date later in the last 90 days." />
        </Peek>
      </div>
      {b.act && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[12.5px] leading-snug text-warn">{b.act}</p>}
    </li>
  );
}

const TREND = { up: { t: "▲", c: "text-ok" }, down: { t: "▼", c: "text-bad" }, flat: { t: "steady", c: "text-faint" } } as const;

/** A strategist's scorecard: their accounts, how early requests come in, how long work sits with them, replies, reports */
export function StrategistScorecard({ s }: { s: StrategistCard }) {
  const tr = s.accounts.trend ? TREND[s.accounts.trend] : null;
  const scoreTone: Tone3 = s.accounts.avg == null ? null : s.accounts.avg >= 80 ? "ok" : s.accounts.avg >= 60 ? "warn" : "bad";
  return (
    <li className="grid content-start gap-4 rounded-[22px] border border-line bg-surface p-5">
      <CardHead
        name={s.name}
        sub={`${s.role} · ${s.accounts.n} ${s.accounts.n === 1 ? "account" : "accounts"}`}
        right={
          s.response.bottleneck ? <span className="shrink-0 rounded-full bg-bad-soft px-2.5 py-1 text-[11px] font-semibold text-bad">Bottleneck</span> : null
        }
      />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 rounded-[16px] bg-ink/[0.035] p-3.5">
        <div className="grid justify-items-start">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Accounts</span>
          <span className={`tabular font-display text-[34px] leading-none ${scoreTone ? TONE_TEXT3[scoreTone] : "text-faint"}`}>{s.accounts.avg ?? "—"}</span>
          {tr && (
            <span className={`tabular text-[11px] ${tr.c}`}>
              {tr.t}
              {s.accounts.trend !== "flat" && s.accounts.avg != null && s.accounts.before != null ? ` ${Math.abs(s.accounts.avg - s.accounts.before)}` : ""}
              {s.accounts.since ? ` since ${when(s.accounts.since)}` : ""}
            </span>
          )}
        </div>
        <div className="grid min-w-0 gap-1 text-[12px]">
          <span className="text-muted">Email score average · {s.accounts.scored} of {s.accounts.n} scored</span>
          {s.accounts.lowest.map((c) => (
            <Link key={c.slug} href={`/clients/${c.slug}?service=email`} className="flex items-baseline justify-between gap-2 hover:underline">
              <span className="min-w-0 truncate">{c.name}</span>
              <span className={`tabular shrink-0 ${c.score >= 80 ? "text-ok" : c.score >= 60 ? "text-warn" : "text-bad"}`}>{c.score}</span>
            </Link>
          ))}
          {!s.accounts.trend && s.accounts.scored > 0 && <span className="text-[11px] text-faint">The trend shows once a few days of scores are kept.</span>}
        </div>
      </div>
      <StatGrid
        stats={[
          { label: "Requests on time", value: s.requests.onTime == null ? null : `${s.requests.onTime}%`, sub: s.requests.of ? `${s.requests.of} with a send date${s.requests.avgShort ? ` · late ones ${s.requests.avgShort}d short` : ""}` : "no requests with a send date", tone: s.requests.onTime == null ? null : s.requests.onTime >= 80 ? "ok" : s.requests.onTime >= 60 ? "warn" : "bad" },
          { label: "Sent back to them", value: s.response.avgDays == null ? null : `${s.response.avgDays}d`, sub: `avg with them · ${s.response.sitting} past target now`, tone: s.response.bottleneck ? "bad" : s.response.avgDays == null ? null : s.response.avgDays <= 1 ? "ok" : "warn" },
          { label: "Slack and email", value: s.replies.medianHours == null ? null : s.replies.medianHours < 1 ? `${Math.round(s.replies.medianHours * 60)}m` : `${s.replies.medianHours}h`, sub: `median reply · ${s.replies.waiting} waiting${s.replies.escalated ? `, ${s.replies.escalated} escalated` : ""}`, tone: s.replies.escalated ? "bad" : s.replies.medianHours == null ? null : s.replies.medianHours <= 4 ? "ok" : s.replies.medianHours <= 24 ? "warn" : "bad" },
          { label: "Reports on time", value: s.reports.rate == null ? null : `${s.reports.rate}%`, sub: `weekly and monthly · ${s.reports.onTime} on time, ${s.reports.late} late`, tone: s.reports.rate == null ? null : s.reports.rate >= 90 ? "ok" : s.reports.rate >= 70 ? "warn" : "bad" },
        ]}
      />
      <PlateBox items={s.plate} late={s.plate.filter((t) => t.late).length} />
      <div className="flex flex-wrap gap-1.5">
        <Peek label="late requests" n={s.requests.late.length} tone={s.requests.late.length >= 3 ? "warn" : null} title="Requests that came in short of the lead a send needs">
          <TaskList items={s.requests.late} empty="Every request came in with the full lead." />
        </Peek>
        <Peek label="waiting on them" n={s.response.items.length} tone={s.response.bottleneck ? "bad" : null} title="Sitting with them past the stage's target">
          <TaskList items={s.response.items} empty="Nothing waiting on them past target." />
        </Peek>
        <Peek label="late reports" n={s.reports.lateItems.length} tone={s.reports.late >= 2 ? "warn" : null} title="Client reports sent late (or still not sent)">
          {s.reports.lateItems.length ? (
            <ul className="grid gap-1 px-2.5 py-1 text-[12.5px]">
              {s.reports.lateItems.map((r) => (
                <li key={`${r.client}:${r.kind}:${r.periodEnd}`} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {r.client} · {r.kind}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-faint">{r.postedAt ? `sent ${when(r.postedAt)}` : "not sent"} · due {when(r.due)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-[13px] text-muted">Every report went out on time.</p>
          )}
        </Peek>
      </div>
      {s.act && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[12.5px] leading-snug text-warn">{s.act}</p>}
    </li>
  );
}

/** The AI review's must-fix notes on someone's designs, each opening its ticket */
function FixList({ items, max = 6 }: { items: FixItem[]; max?: number }) {
  if (!items.length) return <p className="px-2.5 py-2 text-[13px] text-muted">The AI review found nothing to fix in the last 90 days.</p>;
  return (
    <div className="grid gap-1.5">
      {items.slice(0, max).map((f) => {
        const body = (
          <>
            <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full bg-bad-soft px-2 py-0.5 font-medium text-bad">Must fix</span>
              <span className="text-faint">{[f.client, f.message, when(f.at)].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="line-clamp-3 text-[12.5px] leading-snug text-fg">{f.quote}</span>
            {f.ticket && <span className="text-[11px] text-muted">E-{f.ticket}</span>}
          </>
        );
        return f.ticket ? (
          <Link key={f.id} href={`/board/email?t=${f.ticket}`} className="grid gap-1 rounded-[12px] px-2.5 py-2 hover:bg-ink/[0.05]">
            {body}
          </Link>
        ) : (
          <div key={f.id} className="grid gap-1 rounded-[12px] px-2.5 py-2">
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
    <span {...stop}>
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

/** How a designer's 0 to 100 score is worked out, with their own numbers */
function ScoreExplained({ m }: { m: EmailMaker }) {
  const parts: [string, string, string][] = [
    ["First-pass approval", "40%", m.firstPass == null ? "not enough yet" : `${m.firstPass}% went through with no design change asked`],
    ["Turnaround vs target", "30%", m.turnaround == null ? "not enough yet" : `${m.turnaround}d per design, target ${m.turnaroundTarget}d`],
    ["Revision turnaround", "15%", m.revisionTurnaround == null ? "no design revisions yet" : `${m.revisionTurnaround}d to send a revision back, target 1d`],
    ["Nothing left sitting", "15%", m.sitting ? `${m.sitting} ${m.sitting === 1 ? "email" : "emails"} in design with them 2+ business days` : "nothing waiting on them"],
  ];
  return (
    <div className="grid gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Score · {m.score ?? "not yet"}
        {m.level ? ` · ${m.level}` : ""}
      </p>
      <p className="text-[12.5px] leading-snug text-muted">Out of 100, from their own designs in this period:</p>
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

/** A designer on the email team: tap the card for everything on their plate; glance into the counts without leaving */
export function EmailPersonCard({ m }: { m: EmailMaker }) {
  const tone = m.score == null ? "text-faint" : m.score >= 75 ? "text-ok" : m.score >= 60 ? "text-warn" : "text-bad";
  const trend = m.score != null && m.previous != null ? m.score - m.previous : null;
  const open = () => pushParams({ person: m.profileId });
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open()}
        className="group grid h-full cursor-pointer content-start gap-4 rounded-[22px] border border-line bg-surface p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      >
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink/[0.07] text-[13px] font-semibold text-fg">{initials(m.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[17px] leading-tight">{m.name}</p>
            <p className="text-[12px] text-muted">{m.level}</p>
          </div>
          <span {...stop}>
            <HoverCard width={380} content={<ScoreExplained m={m} />}>
              <button type="button" className="grid justify-items-end rounded-[12px] px-1.5 py-1 text-right hover:bg-ink/[0.05]" aria-label={`Score ${m.score ?? "not yet"}: how it's worked out`}>
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Score</span>
                <span className={`tabular font-display text-[28px] leading-none ${tone}`}>{m.score ?? "—"}</span>
                {trend != null && trend !== 0 && <span className={`tabular text-[11px] ${trend > 0 ? "text-ok" : "text-bad"}`}>{trend > 0 ? "▲" : "▼"} {Math.abs(trend)}</span>}
              </button>
            </HoverCard>
          </span>
        </div>

        <StatGrid
          stats={[
            { label: "Turnaround", value: m.turnaround == null ? null : `${m.turnaround}d`, sub: `target ${m.turnaroundTarget}d · ${m.pieces} designed`, tone: m.turnaround == null ? null : m.turnaround <= m.turnaroundTarget ? "ok" : m.turnaround <= m.turnaroundTarget * 1.5 ? "warn" : "bad" },
            { label: "Internal revisions", value: rateText(m.sendbacks.d90.internal, m.sendbacks.d90.pieces), sub: `sent back in review · ${m.sendbacks.d90.internal} of ${m.sendbacks.d90.pieces}, 90d`, tone: rateTone(m.sendbacks.d90.internal, m.sendbacks.d90.pieces) },
            { label: "Client revisions", value: rateText(m.sendbacks.d90.client, m.sendbacks.d90.pieces), sub: `sent back by clients · ${m.sendbacks.d90.client} of ${m.sendbacks.d90.pieces}, 90d`, tone: rateTone(m.sendbacks.d90.client, m.sendbacks.d90.pieces) },
            { label: "Revision turnaround", value: m.revisionTurnaround == null ? null : `${m.revisionTurnaround}d`, sub: "client changes back to them", tone: m.revisionTurnaround == null ? null : m.revisionTurnaround <= 1 ? "ok" : m.revisionTurnaround <= 2 ? "warn" : "bad" },
            { label: "Errors", value: String(m.errors.d90), sub: `${m.errors.d45} in 45d · read from comments`, tone: m.errors.d45 >= 3 ? "bad" : m.errors.d90 ? "warn" : "ok" },
            { label: "Due dates pushed", value: m.pushedBack.pct == null ? null : `${m.pushedBack.pct}%`, sub: `${m.pushedBack.items.length} of ${m.pushedBack.of} tickets held, 90d`, tone: m.pushedBack.pct == null ? null : m.pushedBack.pct <= 10 ? "ok" : m.pushedBack.pct <= 25 ? "warn" : "bad" },
          ]}
        />

        <PlateBox items={m.plate} late={m.late} />

        <div className="flex flex-wrap gap-1.5">
          <Peek label={m.errors.d90 === 1 ? "error" : "errors"} n={m.errors.d90} tone={m.errors.d45 >= 3 ? "bad" : m.errors.d90 ? "warn" : null} title={`Real errors in comments on their work · ${m.errors.d45} in 45 days, ${m.errors.d90} in 90`}>
            <ErrorList items={m.errors.items} />
          </Peek>
          <Peek label="sent back" n={m.revisions.length} title="Sent back, last 90 days">
            <TaskList items={m.revisions} empty="Nothing sent back in the last 90 days." />
          </Peek>
          <Peek label={m.fixes.d90 === 1 ? "AI fix" : "AI fixes"} n={m.fixes.d90} tone={m.fixes.d45 >= 4 ? "bad" : m.fixes.d90 ? "warn" : null} title={`Must-fix notes from the AI review · ${m.fixes.d45} in 45 days, ${m.fixes.d90} in 90`}>
            <FixList items={m.fixes.items} />
          </Peek>
          <Peek label={`pushed back${m.pushedBack.pct != null ? ` · ${m.pushedBack.pct}%` : ""}`} n={m.pushedBack.items.length} tone={(m.pushedBack.pct ?? 0) >= 25 ? "warn" : null} title={`Due dates they moved later · ${m.pushedBack.items.length} of ${m.pushedBack.of} tickets, 90 days`}>
            <TaskList items={m.pushedBack.items} empty="They haven't moved a due date later in the last 90 days." />
          </Peek>
          <span {...stop}>
            <button
              type="button"
              disabled={!m.winners.length}
              onClick={() => pushParams({ winners: m.profileId })}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors max-md:min-h-11 ${m.winners.length ? "border-ok/30 bg-ok-soft text-ok hover:border-ok/60" : "border-line text-faint"}`}
            >
              <span className="tabular font-semibold">{m.winners.length}</span> winning {m.winners.length === 1 ? "email" : "emails"}
              {m.winners.length > 0 && <span aria-hidden>→</span>}
            </button>
          </span>
        </div>

        {m.act && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[12.5px] leading-snug text-warn">{m.act}</p>}
      </div>
    </li>
  );
}

/** A sheet that locks the page behind it and closes on Escape (its own address param, so back closes it) */
function useSheet(param: string, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams(param);
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [param, open]);
}

function Close({ param }: { param: string }) {
  return (
    <button type="button" onClick={() => closeParams(param)} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-fg">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

/** Everything on one designer's plate, what came back and the AI's fixes (?person=), a sheet over the tab */
export function EmailPersonSheet({ makers }: { makers: EmailMaker[] }) {
  const id = useParam("person");
  const m = makers.find((x) => x.profileId === id);
  useSheet("person", Boolean(m));
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
          <Close param="person" />
        </header>
        <div className="grid content-start gap-6 overflow-y-auto overscroll-contain px-5 py-5">
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["On their plate", m.plate.length, late.length ? `${late.length} late · ${m.messages} emails` : `none late · ${m.messages} emails`],
                ["Designed", m.pieces, m.turnaround == null ? "" : `${m.turnaround}d each`],
                ["AI fixes · 90d", m.fixes.d90, `${m.fixes.d45} in 45 days`],
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
                ["Request → client", m.briefToDone == null ? "—" : `${m.briefToDone}d`, "business days"],
                ["Met due date", m.metDue.pct == null ? "—" : `${m.metDue.pct}%`, `of ${m.metDue.of} with a due date`],
                ["Pushed back", m.pushedBack.pct == null ? "—" : `${m.pushedBack.pct}%`, `${m.pushedBack.items.length} of ${m.pushedBack.of} tickets`],
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
            <Rate label="Sent back in review" s={m.sendbacks} kind="internal" />
            <Rate label="Sent back by clients" s={m.sendbacks} kind="client" />
          </div>
          {m.winners.length > 0 && (
            <button type="button" onClick={() => pushParams({ winners: m.profileId, person: null })} className="flex min-h-12 items-center justify-between rounded-[16px] border border-ok/30 bg-ok-soft px-4 text-[14px] text-ok">
              <span>
                <b className="tabular">{m.winners.length}</b> winning {m.winners.length === 1 ? "email" : "emails"} from their designs
              </span>
              <span aria-hidden>See them →</span>
            </button>
          )}
          {m.act && <p className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] text-warn">{m.act}</p>}
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">On their plate right now</h3>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">{m.plate.length ? m.plate.map((t) => <TaskRow key={t.key} t={t} />) : <p className="px-3 py-3 text-[13px] text-muted">Nothing open right now.</p>}</div>
          </section>
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">Sent back, last 90 days</h3>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">{m.revisions.length ? m.revisions.map((t) => <TaskRow key={t.key} t={t} />) : <p className="px-3 py-3 text-[13px] text-muted">Nothing came back.</p>}</div>
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
              <h3 className="font-heading text-[16px]">Ready to send after the due date</h3>
              <div className="rounded-[16px] border border-line bg-surface p-1.5">
                {m.metDue.missed.map((t) => (
                  <TaskRow key={t.key} t={t} />
                ))}
              </div>
            </section>
          )}
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">Errors, last 90 days</h3>
            <p className="text-[12px] text-faint">Comments on their work that point at a real mistake (a wrong link, image or price, something broken), read by the AI from Asana and the Email Board.</p>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">
              <ErrorList items={m.errors.items} max={12} />
            </div>
          </section>
          <section className="grid gap-2">
            <h3 className="font-heading text-[16px]">AI review fixes, last 90 days</h3>
            <p className="text-[12px] text-faint">Must-fix notes the AI pinned on their designs before the strategist looked: copy that doesn&apos;t match, a tap target too small, the wrong colours or logo.</p>
            <div className="rounded-[16px] border border-line bg-surface p-1.5">
              <FixList items={m.fixes.items} max={12} />
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

/** A designer's winning emails, as they landed in the inbox (?winners=<profile id>) */
export function EmailWinnersSheet({ makers }: { makers: EmailMaker[] }) {
  const id = useParam("winners");
  const m = makers.find((x) => x.profileId === id);
  useSheet("winners", Boolean(m));
  if (!m) return null;
  const linked = m.winners.filter((w) => w.how === "linked").length;
  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={`${m.name}'s winning emails`}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => closeParams("winners")} aria-hidden />
      <aside className="pb-safe absolute inset-x-0 bottom-0 top-[5vh] grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.8)] md:inset-6 md:rounded-[26px]">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ok-soft text-[14px] font-semibold text-ok">{initials(m.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[20px] leading-tight">{m.name}&rsquo;s winning emails</p>
            <p className="text-[12.5px] text-muted">
              {m.winners.length} {m.winners.length === 1 ? "email" : "emails"} that beat their account&apos;s usual clicks, 90 days · {linked} from the Email Board
              {m.winners.length - linked ? `, ${m.winners.length - linked} from clients whose designer seat they hold` : ""}
            </p>
          </div>
          <Close param="winners" />
        </header>
        <div className="overflow-y-auto overscroll-contain px-5 py-6">
          <div className="mx-auto grid max-w-6xl gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {m.winners.map((w) => (
              <EmailResultCard key={w.key} r={w} on="click" credit />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** A late ticket in the list: hover for the ticket at a glance, click to open it on the Email Board */
export function EmailLateRow({ t }: { t: LateTicket }) {
  return (
    <li>
      <HoverCard
        width={360}
        className="block"
        content={
          <div className="grid gap-2.5">
            <div className="grid gap-0.5">
              <span className="flex items-center gap-1.5 text-[11px] text-faint">
                E-{t.number} · {t.kind}
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
                  ["Messages", String(t.messages)],
                  ["Was due", when(t.due) ?? "—"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid">
                  <dt className="text-faint">{k}</dt>
                  <dd className={k === "Late by" ? "text-bad" : "text-fg"}>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] text-faint">Click to open the ticket</p>
          </div>
        }
      >
        <Link href={`/board/email?t=${t.number}`} className="flex items-start gap-3 rounded-[14px] px-3 py-2.5 hover:bg-ink/[0.04] max-md:min-h-11">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-start gap-1.5 text-[13.5px]">
              <span className="shrink-0 text-faint">E-{t.number}</span>
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

function Lift({ v }: { v: number | null }) {
  if (v == null) return null;
  return <span className={`tabular rounded-full px-1.5 py-px text-[10.5px] font-semibold ${v >= 0 ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{`${v >= 0 ? "+" : "−"}${Math.abs(v)}%`}</span>;
}

/**
 * A sent email as it landed: the inbox line (who, subject, preview) over the top of the email, then its numbers against
 * the account's usual and a way to brief more like it. On clicks for design, on opens for subject lines.
 */
export function EmailResultCard({ r, on, credit = false }: { r: EmailResult; on: "click" | "open"; credit?: boolean }) {
  const win = r.verdict === "winner";
  const lead = on === "click" ? { label: "Click rate", v: r.clickRate, usual: r.usualClick, lift: r.clickLift } : { label: "Open rate", v: r.openRate, usual: r.usualOpen, lift: r.openLift };
  const other = on === "click" ? { label: "Open rate", v: r.openRate, lift: r.openLift } : { label: "Click rate", v: r.clickRate, lift: r.clickLift };
  return (
    <article className="grid content-start gap-3">
      <div className="overflow-hidden rounded-[18px] border border-line bg-surface shadow-[0_18px_40px_-28px_rgba(0,0,0,0.6)]">
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink/[0.07] text-[12px] font-semibold">{initials(r.client)}</span>
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="truncate font-semibold text-fg">{r.client}</span>
              <span className="shrink-0 text-[11px] text-faint">{when(r.sent)}</span>
            </p>
            <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">{r.subject ?? r.name}</p>
            {r.preview && <p className="truncate text-[12px] text-muted">{r.preview}</p>}
          </div>
        </div>
        {on === "click" && (
          <div className="relative aspect-[2/3] max-h-[360px] w-full overflow-hidden bg-ink/[0.04]">
            <EmailThumb r={r} />
            <span className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-semibold shadow ${win ? "bg-ok text-white" : "bg-bad text-white"}`}>{win ? "Out-clicks their usual" : "Below their usual"}</span>
          </div>
        )}
      </div>
      <div className="grid gap-2 rounded-[16px] border border-line bg-surface p-3.5">
        <p className="text-[12px] text-muted">
          <span className={`font-medium ${win ? "text-ok" : "text-bad"}`}>{win ? "Why it wins" : "Why it fell short"}</span> · {r.recipients.toLocaleString("en-US")} recipients
        </p>
        {credit && (
          <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
            <span className={`rounded-full px-2 py-0.5 font-medium ${r.how === "linked" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{r.how === "linked" ? `From E-${r.ticket}` : "Their client's seat"}</span>
            <span className="min-w-0 truncate">{r.name}</span>
          </p>
        )}
        {!credit && r.credit && (
          <p className="text-[11.5px] text-muted">
            {on === "click" ? "Designed by" : "Copy by"} {r.credit}
            {r.how === "seat" ? " (the client's seat)" : r.ticket ? ` · E-${r.ticket}` : ""}
          </p>
        )}
        <dl className="tabular grid grid-cols-3 gap-2 text-center">
          <div className="grid gap-0.5 rounded-[10px] bg-ink/[0.04] px-1.5 py-2">
            <dt className="truncate text-[10.5px] text-muted">{lead.label}</dt>
            <dd className="text-[15px] font-semibold">{lead.v == null ? "—" : `${lead.v}%`}</dd>
            <span className="flex items-center justify-center gap-1 truncate text-[10.5px] text-faint">
              <Lift v={lead.lift} /> {lead.usual != null && `usual ${lead.usual}%`}
            </span>
          </div>
          <div className="grid gap-0.5 rounded-[10px] bg-ink/[0.04] px-1.5 py-2">
            <dt className="truncate text-[10.5px] text-muted">{other.label}</dt>
            <dd className="text-[15px] font-semibold">{other.v == null ? "—" : `${other.v}%`}</dd>
            <span className="flex justify-center">
              <Lift v={other.lift} />
            </span>
          </div>
          <div className="grid gap-0.5 rounded-[10px] bg-ink/[0.04] px-1.5 py-2">
            <dt className="truncate text-[10.5px] text-muted">Per recipient</dt>
            <dd className="text-[15px] font-semibold">{money(r.rpr, 2)}</dd>
            <span className="truncate text-[10.5px] text-faint">{money(r.revenue)} total</span>
          </div>
        </dl>
        <span className="flex items-center gap-2">
          <Link href={`/board/email/new?client=${r.slug}`} className="grid h-11 min-w-0 flex-1 place-items-center rounded-full bg-fg text-[14px] font-medium text-bg">
            {win ? (on === "click" ? "Request more like this" : "Write more like this") : "Request a better one"}
          </Link>
          {r.href && (
            <a href={r.href} target="_blank" rel="noreferrer" className="grid h-11 shrink-0 place-items-center rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg">
              Klaviyo ↗
            </a>
          )}
        </span>
      </div>
    </article>
  );
}

/** A flow whose clicks (or opens) are falling: last 30 days against the 60 before, and its refresh */
export function TiringFlowCard({ f, on = "click" }: { f: TiringFlow; on?: "click" | "open" }) {
  const tired = f.severity === "tired";
  return (
    <article className="grid content-start gap-3 rounded-[20px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-heading text-[16px] leading-tight">{f.flow}</p>
          <Link href={`/clients/${f.slug}`} className="text-[12px] text-muted hover:text-fg hover:underline">
            {f.client}
          </Link>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${f.refreshing ? "bg-ok-soft text-ok" : tired ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{f.refreshing ? "Being refreshed" : tired ? "Tired: redesign it" : "Tiring"}</span>
      </div>
      <div className="grid gap-1.5">
        <span className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-muted">{on === "click" ? "Click rate" : "Open rate"}</span>
          <span className="tabular text-fg">
            {f.before}% → {f.now}% <span className="text-bad">{`−${Math.abs(f.change)}%`}</span>
          </span>
        </span>
        <span className="relative h-2 overflow-hidden rounded-full bg-ink/[0.07]">
          <span className={`absolute inset-y-0 left-0 rounded-full ${tired ? "bg-bad" : "bg-warn"}`} style={{ width: `${Math.max(4, Math.min(100, (f.now / Math.max(f.before, 0.01)) * 100))}%` }} />
        </span>
        <span className="flex justify-between text-[11px] text-faint">
          <span>{f.recipients.toLocaleString("en-US")} recipients in 30 days</span>
          <span>{money(f.revenue)} in 30 days</span>
        </span>
      </div>
      {f.refreshing ? (
        <Link href={`/board/email?t=${f.refreshing}`} className="grid h-11 place-items-center rounded-full border border-line text-[13px] text-muted hover:text-fg">
          Refresh in the works: E-{f.refreshing} →
        </Link>
      ) : (
        <Link href={`/board/email/new?client=${f.slug}`} className="grid h-11 place-items-center rounded-full bg-fg text-[14px] font-medium text-bg">
          {on === "click" ? "Request a refresh" : "Write new subject lines"}
        </Link>
      )}
    </article>
  );
}

const STATUS: Record<Cadence["status"], { label: string; tone: "ok" | "warn" | "bad" }> = {
  none: { label: "Nothing in the works", tone: "bad" },
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

/** Every email client's sending this cycle against last cycle: critical first, in a list that scrolls on its own */
export function CadenceList({ rows, canDismiss }: { rows: Cadence[]; canDismiss: boolean }) {
  const router = useRouter();
  const asked = useParam("cadence");
  const filter = asked === "all" || asked === "on_track" ? asked : "critical";
  const [showDismissed, setShowDismissed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const found = rows.filter((r) => matchesClientName(r.name, query));
  const live = found.filter((r) => !r.dismissed);
  const dismissed = found.filter((r) => r.dismissed);
  // A client whose platform isn't reading needs attention for that, never shown as nothing sent
  const critical = live.filter((r) => !r.sync.ok || r.status === "none" || r.status === "behind");
  const good = live.filter((r) => r.sync.ok && (r.status === "on_track" || r.status === "ahead"));
  const shown = filter === "all" ? live : filter === "on_track" ? good : critical;

  const dismiss = async (a: Cadence) => {
    const r = await dismissCadence(a.id, a.periodStart, reason);
    if (!r.ok) return setError(r.error);
    setEditing(null);
    setReason("");
    setError(null);
    router.refresh();
  };
  const restore = async (a: Cadence) => {
    const r = await restoreCadence(a.id, a.periodStart);
    if (r.ok) router.refresh();
  };

  const row = (a: Cadence) => {
    const s = STATUS[a.status];
    const cap = Math.max(a.usual, a.sent, 1);
    if (!a.sync.ok)
      return (
        <li key={a.id} className="grid gap-1.5 border-b border-line/70 px-4 py-3 last:border-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/clients/${a.slug}?service=email`} className="min-w-0 truncate text-[14px] hover:underline">
              {a.name}
            </Link>
            <span className="whitespace-nowrap rounded-full bg-bad-soft px-2.5 py-0.5 text-[11px] font-medium text-bad">Not syncing</span>
          </div>
          <p className="text-[12.5px] leading-snug text-fg">
            {a.sync.label}: sends this cycle can&apos;t be counted{a.open ? ` · ${a.open} in the works on the Board` : ""}.
          </p>
          {a.sync.detail && <p className="text-[11.5px] leading-snug text-muted">{a.sync.detail}</p>}
        </li>
      );
    return (
      <li key={a.id} className="grid gap-2 border-b border-line/70 px-4 py-3 last:border-0">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] md:items-center md:gap-4">
          <Link href={`/clients/${a.slug}`} className="min-w-0 truncate text-[14px] hover:underline">
            {a.name}
          </Link>
          <span className="relative h-2 overflow-hidden rounded-full bg-ink/[0.07]" aria-label={`${a.sent} sent of ${a.usual} last cycle, ${Math.round(a.elapsed * 100)}% through the cycle`}>
            {a.sent > 0 && <span className={`absolute inset-y-0 left-0 rounded-full ${a.dismissed ? "bg-ink/25" : BAR[s.tone]}`} style={{ width: `${Math.max(3, Math.min(1, a.sent / cap) * 100)}%` }} />}
            {a.usual > 0 && <span className="absolute inset-y-[-2px] w-[2px] bg-fg/60" style={{ left: `${Math.min(1, (a.usual * a.elapsed) / cap) * 100}%` }} />}
          </span>
          <span className="flex items-center justify-between gap-2 md:justify-end">
            <span className="tabular text-[12px] text-muted">
              {a.sent} sent{a.usual ? ` of ${a.usual} last cycle` : ""}
              {a.open ? ` · ${a.open} in the works` : ""}
              {a.resets && <span className="text-faint"> · resets {when(a.resets)}</span>}
            </span>
            {a.dismissed ? <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-[11px] text-muted">Dismissed</span> : <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium ${SOFT[s.tone]}`}>{s.label}</span>}
            {canDismiss && (
              <button type="button" onClick={() => (a.dismissed ? void restore(a) : setEditing(editing === a.id ? null : a.id))} className="min-h-9 rounded-full px-2.5 text-[12px] text-faint hover:text-fg max-md:min-h-11">
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
        {editing === a.id && (
          <div className="grid gap-2 rounded-[12px] bg-ink/[0.035] p-3">
            <label className="grid gap-1 text-[12px] text-muted">
              Dismiss for this cycle: why?
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. paused on their side, billing dates out of step" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[14px] text-fg outline-none focus:border-brand-text/60" />
            </label>
            {error && <p className="text-[12px] text-bad">{error}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={!reason.trim()} onClick={() => void dismiss(a)} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40">
                Dismiss this cycle
              </button>
              <button type="button" onClick={() => setEditing(null)} className="h-11 px-3 text-[13px] text-muted">
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
          <button key={k} type="button" onClick={() => pushParams({ cadence: k === "critical" ? null : k })} className={`min-h-9 rounded-full px-3 text-[12.5px] max-md:min-h-11 ${filter === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
            {label}
            <span className="tabular ml-1 opacity-60">{k === "critical" ? critical.length : k === "all" ? live.length : good.length}</span>
          </button>
        ))}
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients" aria-label="Search clients" className="h-9 w-full rounded-full border border-line bg-surface px-3 text-[12.5px] text-fg outline-none focus:border-brand-text/60 max-md:h-11 sm:w-48" />
        <span className="ml-auto hidden text-[11px] text-faint md:inline">Bar: sent so far · line: last cycle&apos;s pace by now</span>
      </div>
      <ul className="max-h-[440px] overflow-y-auto overscroll-contain">
        {shown.length ? (
          shown.map(row)
        ) : query.trim() ? (
          <li className="px-4 py-6 text-center text-[13px] text-muted">No clients match “{query.trim()}” here.</li>
        ) : (
          <li className="px-4 py-6 text-center text-[13px] text-ok">{filter === "critical" ? "Every email client is sending on pace this cycle." : "No clients here."}</li>
        )}
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

const TAB_OF_ROLE: Record<string, string> = { email_designer: "design", email_builder: "build", email_strategist: "strategy" };

/**
 * Everyone on the email team's open tickets and emails right now (designers, builders and strategists): the busiest
 * first. Tap a designer on the Design tab for their plate; anyone else opens their own tab.
 */
export function WorkloadList({ rows, tab = "design" }: { rows: Workload[]; tab?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.open));
  const typical = rows.length ? rows.reduce((n, r) => n + r.open, 0) / rows.length : 0;
  if (!rows.length) return <p className="rounded-[18px] border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">Nobody on the email team has work open.</p>;
  return (
    <ul className="grid max-h-[520px] overflow-y-auto overscroll-contain rounded-[22px] border border-line bg-surface p-1.5">
      {rows.map((r) => {
        const heavy = typical && r.open >= Math.max(6, typical * 1.6);
        const tone = r.late ? "bad" : heavy ? "warn" : "ok";
        const theirTab = TAB_OF_ROLE[r.roleKey] ?? "design";
        const cls = "grid w-full gap-1.5 rounded-[14px] px-3 py-2.5 text-left hover:bg-ink/[0.04] max-md:min-h-11";
        const inner = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate">
                {r.name} <span className="text-[12px] text-faint">· {r.role}</span>
              </span>
              <span className="tabular shrink-0 text-[12px] text-muted">
                {r.open} {r.open === 1 ? "ticket" : "tickets"} · {r.messages} emails{r.late ? <span className="text-bad"> · {r.late} late</span> : null}
              </span>
            </span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
              <span className={`absolute inset-y-0 left-0 rounded-full ${BAR[tone]}`} style={{ width: `${Math.max(3, (r.open / max) * 100)}%` }} />
            </span>
            <span className="text-[11px] text-faint">
              {r.asana ? `${r.asana} still in Asana · ` : ""}
              {r.oldest ? `oldest with them ${r.oldest} business ${r.oldest === 1 ? "day" : "days"}` : "nothing sitting"}
            </span>
          </>
        );
        return (
          <li key={r.profileId}>
            {theirTab === "design" && tab === "design" ? (
              <button type="button" onClick={() => pushParams({ person: r.profileId })} className={cls}>
                {inner}
              </button>
            ) : (
              <Link href={`/board/email?view=kpis&tab=${theirTab}${theirTab === "design" ? `&person=${r.profileId}` : ""}`} className={cls}>
                {inner}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A client sending work back: hover for their five latest rounds */
export function EmailClientRevisions({ c }: { c: { client: string; slug: string | null; perPiece: number; recent: TaskRef[] } }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]">
      <HoverCard
        width={400}
        content={
          <div className="grid gap-1">
            <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{c.client}: latest design changes</p>
            <TaskList items={c.recent} empty="No design changes recorded in the last 90 days." max={5} />
          </div>
        }
      >
        <Link href={c.slug ? `/clients/${c.slug}` : "#"} className="min-w-0 truncate underline decoration-ink/20 underline-offset-4 hover:decoration-ink/60">
          {c.client}
        </Link>
      </HoverCard>
      <span className="tabular shrink-0 text-[12px] text-warn">{c.perPiece} per ticket</span>
    </div>
  );
}

/**
 * An "Act on this first" row. A link to this same KPI tab (a designer's plate, the clients behind, the tiring flows)
 * opens its panel or scrolls to its section right away: the address changes so back returns, with no reload of every
 * number. Anything else (a ticket, a client) is a normal link.
 */
export function EmailActionLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const here = href.startsWith("/board/email?view=");
  if (!here) return <Link href={href} className={className}>{children}</Link>;
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (new URL(href, window.location.origin).searchParams.get("view") !== new URLSearchParams(window.location.search).get("view")) return;
        e.preventDefault();
        const u = new URL(href, window.location.origin);
        const patch: Record<string, string | null> = {};
        for (const k of ["person", "cadence", "winners"]) if (u.searchParams.has(k)) patch[k] = u.searchParams.get(k);
        if (Object.keys(patch).length) pushParams(patch);
        const target = u.hash.slice(1) || (u.searchParams.has("cadence") ? "cadence" : "");
        if (target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }}
    >
      {children}
    </a>
  );
}
