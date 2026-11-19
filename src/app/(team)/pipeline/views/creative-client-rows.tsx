"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { OpenSuggestion } from "@/lib/suggestions";
import type { Brand } from "@/lib/overview-desk-load";
import { GROUPS, resetIn, sourceChip, type DeskGroup, type SourceChip } from "@/lib/creative-desk-core";
import { createBriefHref } from "@/lib/creative-allotments";
import { BrandChip } from "./overview-tabs";
import { SuggestionSheet } from "./suggested-briefs";
import { approveAllDraftedBriefs, approveDraftedBrief } from "../draft-actions";
import { declineSuggestion } from "../suggestion-actions";

// The creative leads' Clients tab (the head of creative every pool, the lead graphic designer images, the lead video
// editor video). A hero for the week (what to brief at a healthy pace against a usual week, the briefs ready, Approve
// all ready), then every client grouped: needs briefs now, on pace, covered, over allotment. Each card draws its
// pools (delivered, in motion, still to brief, any overage, where today sits in the cycle) and holds the briefs
// already drafted for it as rich cards, approved to Asana, edited (the full sheet, ?approve=id) or rejected right
// there. A client over its allotment gets no briefs and says why; Create brief anyway still opens the request form,
// which carries the over-allotment disclaimer.

export type PoolLine = {
  pool: "images" | "videos";
  line: string;
  pace: string;
  detail: string;
  requested: number;
  inMotion: number;
  delivered: number;
  cap: number;
  missing: number;
  over: number;
  dueThisWeek: number;
  state: "nothing" | "missing" | "covered" | "over";
  elapsed: number;
  daysLeft: number;
  urgent: boolean;
  nothing: boolean;
  format: "image" | "video";
};
export type ClientRow = {
  clientId: string;
  client: string;
  slug: string;
  brand: Brand;
  group: DeskGroup;
  pools: PoolLine[];
  fresh: string | null;
  watch: { id: string; title: string; severity: "critical" | "warn" | "info"; href: string }[];
  ideas: OpenSuggestion[];
  /** Over (or fully briefed) with nothing drafted: why there are no briefs */
  noBriefsWhy: string | null;
};
export type WeekLine = { pool: "images" | "videos"; due: number; capacity: number | null; line: string };

const POOL_LABEL = { images: "Images", videos: "Videos" } as const;
const POOL_ONE = { images: ["image", "images"], videos: ["video", "videos"] } as const;
const n = (pool: "images" | "videos", x: number) => `${x} ${POOL_ONE[pool][x === 1 ? 0 : 1]}`;
const GROUP_TONE: Record<DeskGroup, { dot: string; pill: string; ring: string; label: string }> = {
  now: { dot: "bg-bad", pill: "bg-bad-soft text-bad", ring: "var(--bad)", label: "Behind" },
  pace: { dot: "bg-fg/45", pill: "bg-ink/[0.07] text-fg", ring: "var(--fg-muted)", label: "On pace" },
  covered: { dot: "bg-ok", pill: "bg-ok-soft text-ok", ring: "var(--ok)", label: "Covered" },
  over: { dot: "bg-warn", pill: "bg-warn-soft text-warn", ring: "var(--warn)", label: "Over allotment" },
};
const CHIP_TONE: Record<SourceChip["tone"], string> = {
  brand: "bg-brand-soft text-brand-text",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  market: "bg-[color-mix(in_srgb,#8b7cf6_16%,transparent)] text-[#8b7cf6]",
  quiet: "bg-ink/[0.06] text-muted",
};
const REASONS = ["Not the right time", "Already handled", "Wrong angle", "Brief isn't strong enough", "The reason isn't real"];
const FORMAT_ONE = { image: "image", video: "video", carousel: "carousel" } as const;

export function CreativeClientRows({ rows, week, briefed, canApprove = true }: { rows: ClientRow[]; week: WeekLine[] | null; /** Clients fully briefed this cycle */ briefed: number; canApprove?: boolean }) {
  const open = useParam("approve");
  const current = rows.flatMap((r) => r.ideas).find((s) => s.id === open) ?? null;
  const byGroup = new Map<DeskGroup, ClientRow[]>(GROUPS.map((g) => [g.id, rows.filter((r) => r.group === g.id)]));
  return (
    <section id="allotments" className="grid scroll-mt-24 gap-8">
      <Hero rows={rows} week={week} briefed={briefed} byGroup={byGroup} canApprove={canApprove} />
      {rows.length === 0 && <p className="rounded-[20px] border border-dashed border-line px-5 py-8 text-center text-sm text-muted">No client in your slice has a creative allotment this cycle.</p>}
      {GROUPS.map((g) => {
        const list = byGroup.get(g.id) ?? [];
        if (!list.length) return null;
        const tone = GROUP_TONE[g.id];
        return (
          <div key={g.id} id={`group-${g.id}`} className="grid scroll-mt-24 gap-3">
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 px-1">
              <h3 className="flex items-center gap-2.5 font-heading text-[20px] leading-none">
                <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                {g.label}
                <span className="tabular text-[15px] text-faint">{list.length}</span>
              </h3>
              <p className="text-[12.5px] text-faint">{g.blurb}</p>
            </div>
            <ul className={`grid gap-3 ${g.id === "covered" ? "md:grid-cols-2" : ""}`}>
              {list.map((r) => (
                <ClientCard key={r.clientId} r={r} canApprove={canApprove} />
              ))}
            </ul>
          </div>
        );
      })}
      {current && <SuggestionSheet key={current.id} s={current} onClose={() => closeParams("approve")} />}
    </section>
  );
}

// ─── The week ──────────────────────────────────────────────────────────────────────────────────────────────────

function Hero({ rows, week, briefed, byGroup, canApprove }: { rows: ClientRow[]; week: WeekLine[] | null; briefed: number; byGroup: Map<DeskGroup, ClientRow[]>; canApprove: boolean }) {
  const router = useRouter();
  const [busy, act] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const ready = rows.flatMap((r) => r.ideas).filter((s) => s.drafted && !s.draft.summary);
  const readyClients = new Set(ready.map((s) => s.clientId)).size;
  const due = (week ?? []).reduce((t, w) => t + w.due, 0);
  const approveAll = () =>
    act(async () => {
      setNote(null);
      const r = await approveAllDraftedBriefs(ready.map((s) => s.id));
      if (!r.ok) return setNote(r.error);
      setNote(`${r.approved} approved to Asana${r.failed.length ? ` · ${r.failed.length} couldn't go: ${r.failed[0].error}` : ""}`);
      router.refresh();
    });
  return (
    <div className="relative overflow-hidden rounded-[28px] border border-line bg-surface">
      <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full opacity-60 blur-3xl" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--brand) 22%, transparent), transparent 70%)" }} />
      <div className="relative grid gap-6 p-5 md:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-10">
        <div className="grid content-start gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">This week</p>
          <h2 className="font-heading text-[30px] leading-[1.08] tracking-tight md:text-[40px]">
            {due ? (
              <>
                <span className="tabular">{due}</span> to brief <span className="text-muted">at a healthy pace</span>
              </>
            ) : (
              "Everything is on pace"
            )}
          </h2>
          <p className="max-w-xl text-[14.5px] leading-relaxed text-muted">
            {ready.length ? (
              <>
                <span className="text-fg">
                  {ready.length} {ready.length === 1 ? "brief is" : "briefs are"} ready to approve
                </span>{" "}
                across {readyClients} {readyClients === 1 ? "client" : "clients"}, drafted from their pace, the market and what&apos;s winning for similar clients.
              </>
            ) : (
              "No briefs waiting on you. New ones land here the moment a client falls behind its healthy share."
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canApprove && ready.length > 1 && (
              <button type="button" onClick={approveAll} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 text-[14px] font-medium text-white shadow-[0_10px_30px_-12px_var(--brand)] transition hover:brightness-110 disabled:opacity-60">
                {busy ? "Sending to Asana…" : `Approve all ${ready.length} ready`}
              </button>
            )}
            {GROUPS.map((g) => {
              const c = byGroup.get(g.id)?.length ?? 0;
              if (!c) return null;
              return (
                <a key={g.id} href={`#group-${g.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-bg/50 px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${GROUP_TONE[g.id].dot}`} />
                  {g.label} <span className="tabular text-fg">{c}</span>
                </a>
              );
            })}
          </div>
          {note && <p className="text-[13px] text-muted">{note}</p>}
          {briefed > 0 && !byGroup.get("covered")?.length && <p className="text-[12.5px] text-faint">{briefed} fully briefed this cycle</p>}
        </div>
        {week && week.length > 0 && (
          <div className="flex justify-start gap-5 lg:justify-end">
            {week.map((w) => (
              <Ring key={w.pool} w={w} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** This week's healthy share against what the team makes in a usual week: the arc fills with the load, the dot is a usual week */
function Ring({ w }: { w: WeekLine }) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const span = 0.75; // a three-quarter arc, open at the bottom
  const cap = w.capacity ?? null;
  const max = Math.max(1, w.due, cap ?? 0) * (cap != null && w.due > cap ? 1.08 : 1);
  const fill = Math.min(1, w.due / max);
  const heavy = cap != null && w.due > cap;
  const rot = 135;
  const at = (f: number) => {
    const a = ((rot + f * span * 360) * Math.PI) / 180;
    return { x: 60 + R * Math.cos(a), y: 60 + R * Math.sin(a) };
  };
  const t = cap != null ? at(cap / max) : null;
  return (
    <figure className="grid justify-items-center gap-1.5" aria-label={`${POOL_LABEL[w.pool]}: ${w.due} to brief this week${cap != null ? `, a usual week makes ${cap}` : ""}`}>
      <svg viewBox="0 0 120 120" className="h-[124px] w-[124px] md:h-[148px] md:w-[148px]">
        <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" className="text-ink/10" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${C * span} ${C}`} transform={`rotate(${rot} 60 60)`} />
        <circle cx="60" cy="60" r={R} fill="none" stroke={heavy ? "var(--bad)" : "var(--fg)"} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${C * span * fill} ${C}`} transform={`rotate(${rot} 60 60)`} style={{ transition: "stroke-dasharray .6s cubic-bezier(.2,.8,.2,1)" }} />
        {t && <circle cx={t.x} cy={t.y} r="4.5" fill="var(--bg)" stroke="var(--fg)" strokeWidth="2" />}
        <text x="60" y="58" textAnchor="middle" dominantBaseline="central" fill="var(--fg)" fontSize="30" className="font-heading tabular">
          {w.due}
        </text>
        <text x="60" y="86" textAnchor="middle" fill="var(--fg-muted)" fontSize="10" letterSpacing="1">
          {POOL_LABEL[w.pool].toUpperCase()}
        </text>
      </svg>
      <figcaption className={`text-center text-[12px] ${heavy ? "text-bad" : "text-faint"}`}>{cap != null ? (heavy ? `${w.due - cap} over a usual week (${cap})` : `a usual week makes ${cap}`) : "no history yet"}</figcaption>
    </figure>
  );
}

// ─── A client ──────────────────────────────────────────────────────────────────────────────────────────────────

function ClientCard({ r, canApprove }: { r: ClientRow; canApprove: boolean }) {
  const tone = GROUP_TONE[r.group];
  const days = r.pools.length ? Math.min(...r.pools.map((p) => p.daysLeft)) : null;
  const over = r.group === "over";
  return (
    <li className="relative isolate overflow-hidden rounded-[24px] border border-line bg-surface">
      <span aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={{ backgroundImage: `radial-gradient(110% 70% at 0% 0%, color-mix(in srgb, ${r.brand.color ?? tone.ring} 11%, transparent), transparent 62%)` }} />
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: tone.ring }} />
      <div className="grid gap-4 p-4 pl-5 md:p-6 md:pl-7">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <BrandChip name={r.client} color={r.brand.color} logo={r.brand.logo} light={r.brand.light} size="sm" />
          <Link href={`/clients/${r.slug}?service=creative`} className="min-w-0 flex-1 font-heading text-[19px] leading-tight [overflow-wrap:anywhere] hover:text-brand-text">
            {r.client}
          </Link>
          {/* On a phone the state and the reset sit under the name, so the name is never cut */}
          <span className="flex w-full items-center gap-2 sm:w-auto">
            <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ${tone.pill}`}>{tone.label}</span>
            {days != null && <span className="text-[12px] text-faint">{resetIn(days)}</span>}
          </span>
        </div>

        <div className={`grid gap-4 ${r.pools.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {r.pools.map((p) => (
            <Pool key={p.pool} p={p} slug={r.slug} />
          ))}
        </div>

        {over && (
          <div className="grid gap-3 rounded-[18px] border border-warn/30 bg-warn-soft/50 p-4 sm:flex sm:items-center sm:justify-between">
            <p className="text-[14px] leading-relaxed text-fg/85">{r.noBriefsWhy ?? "Over the allotment this cycle: no briefs suggested."}</p>
            <div className="flex flex-wrap gap-2">
              {r.pools.map((p) => (
                <Link key={p.pool} href={`${createBriefHref(r.slug, p.format)}&over=1`} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-warn/40 px-4 text-[13px] font-medium text-fg transition-colors hover:bg-warn-soft sm:min-h-9">
                  Create {r.pools.length > 1 ? POOL_ONE[p.pool][0] : "brief"} anyway →
                </Link>
              ))}
            </div>
          </div>
        )}
        {!over && r.noBriefsWhy && <p className="text-[13px] text-muted">{r.noBriefsWhy}</p>}

        {(r.fresh || r.watch.length > 0) && (
          <ul className="grid gap-1.5">
            {r.fresh && (
              <li className="flex items-start gap-2 text-[13px] text-muted">
                <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-bad" />
                {r.fresh}: new hooks and visuals to bring it back
              </li>
            )}
            {r.watch.map((w) => (
              <li key={w.id}>
                <Link href={w.href} className="flex min-h-11 items-start gap-2 text-[13px] text-muted hover:text-fg md:min-h-0">
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${w.severity === "critical" ? "bg-bad" : w.severity === "warn" ? "bg-warn" : "bg-brand"}`} />
                  {w.title}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {r.ideas.length > 0 && (
          <div className="grid gap-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              {r.ideas.length} {r.ideas.length === 1 ? "brief" : "briefs"} ready
            </p>
            <div className="grid gap-2.5 xl:grid-cols-2">
              {r.ideas.map((s) => (
                <BriefCard key={s.id} s={s} canApprove={canApprove} />
              ))}
            </div>
          </div>
        )}
        {r.ideas.length === 0 && r.group === "now" && <p className="text-[12.5px] text-faint">This week&apos;s share is being drafted from their winners, the market and what&apos;s working for similar clients. It lands here within the hour.</p>}
      </div>
    </li>
  );
}

/** One pool: delivered, in motion, still to brief this cycle, any overage past the cap, and where today sits */
function Pool({ p, slug }: { p: PoolLine; slug: string }) {
  const scale = Math.max(p.cap, p.requested, 1);
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / scale) * 100))}%`;
  const delivered = Math.min(p.delivered, p.cap);
  const motion = Math.max(0, Math.min(p.requested, p.cap) - delivered);
  const overBy = Math.max(0, p.requested - p.cap);
  const tone = p.over > 0 ? "text-warn" : p.nothing || p.urgent ? "text-bad" : p.missing ? "text-fg" : "text-ok";
  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-faint">{POOL_LABEL[p.pool]}</span>
          <span className={`tabular font-heading text-[22px] leading-none ${tone}`}>
            {p.requested}
            <span className="text-[14px] text-faint">/{p.cap}</span>
          </span>
        </span>
        {!p.over && p.missing > 0 && (
          <Link href={createBriefHref(slug, p.format)} className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-[13px] text-muted transition-colors hover:bg-ink/[0.06] hover:text-fg md:min-h-8">
            Create brief <span aria-hidden>→</span>
          </Link>
        )}
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
        <span className="absolute inset-y-0 left-0 bg-[var(--ok)]" style={{ width: pct(delivered) }} />
        <span className="absolute inset-y-0 bg-fg/35" style={{ left: pct(delivered), width: pct(motion) }} />
        {overBy > 0 && <span className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--warn)_0_6px,color-mix(in_srgb,var(--warn)_55%,transparent)_6px_12px)]" style={{ left: pct(p.cap), width: pct(overBy) }} />}
        {overBy > 0 && <span className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: pct(p.cap) }} />}
        {/* Today in the cycle: where an even pace would be by now */}
        <span className="absolute inset-y-0 w-[2px] rounded-full bg-fg/70" style={{ left: `calc(${Math.min(100, p.elapsed * (p.cap / scale) * 100)}% - 1px)` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--ok)]" /> {p.delivered} delivered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-fg/35" /> {p.inMotion} in motion
        </span>
        {p.over > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-warn">
            <span className="h-2 w-2 rounded-full bg-warn" /> {n(p.pool, p.over)} over
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full ring-1 ring-line" /> {p.missing} to brief
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-faint">
          <span className="h-2.5 w-[2px] rounded-full bg-fg/70" /> today
        </span>
      </div>
      {p.missing > 0 && <p className={`text-[13px] ${p.urgent || p.nothing ? "text-bad" : "text-muted"}`}>{p.pace}</p>}
    </div>
  );
}

// ─── A brief, ready ────────────────────────────────────────────────────────────────────────────────────────────

const counts = (s: OpenSuggestion) =>
  s.draft.formats
    .map((f) => `${f.new ? `${f.new} new ${FORMAT_ONE[f.format]}${f.new === 1 ? "" : "s"}` : ""}${f.new && f.variations ? " · " : ""}${f.variations ? `${f.variations} variation${f.variations === 1 ? "" : "s"}` : ""}${f.format === "carousel" && f.cards ? ` · ${f.cards} slides` : ""}`)
    .filter(Boolean);

function BriefCard({ s, canApprove }: { s: OpenSuggestion; canApprove: boolean }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; links: { label: string; href: string }[] } | null>(null);
  const chip = sourceChip(s);
  const c = s.draft.concepts[0];
  const thumb = s.source?.thumbnail ?? null;
  const why = s.drafted?.citation?.quote ?? s.signal;
  const due = s.drafted?.deadline ? new Date(`${s.drafted.deadline}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;

  const approve = () =>
    act(async () => {
      setError(null);
      const r = await approveDraftedBrief(s.id);
      if (!r.ok) return setError(r.error);
      setDone({ text: r.where === "asana" ? "Approved · on the Creative board in Asana" : "Approved · with the makers", links: r.links });
      router.refresh();
    });
  const reject = () =>
    act(async () => {
      setError(null);
      const r = await declineSuggestion(s.id, reason, false);
      if (!r.ok) return setError(r.error);
      setDone({ text: "Rejected · the strategist reads why before it drafts again", links: [] });
      router.refresh();
    });

  if (done)
    return (
      <div className="flex min-h-[76px] flex-wrap items-center gap-2 rounded-[18px] border border-ok/30 bg-ok/10 px-4 py-3 text-[13.5px] text-ok">
        <span aria-hidden>✓</span> {done.text}
        {done.links.slice(0, 3).map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="max-w-[220px] truncate underline underline-offset-2">
            {l.label}
          </a>
        ))}
      </div>
    );

  return (
    <article className="grid gap-3 rounded-[18px] border border-line bg-bg/60 p-3.5 transition-colors hover:border-faint md:p-4">
      <div className="flex gap-3.5">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-[84px] w-[68px] shrink-0 rounded-[12px] object-cover ring-1 ring-line" />
        ) : (
          <span aria-hidden className={`grid h-[84px] w-[68px] shrink-0 place-items-center rounded-[12px] text-[22px] ${CHIP_TONE[chip.tone]}`}>
            {s.draft.formats.some((f) => f.format === "video") ? "▶" : s.draft.formats.some((f) => f.format === "carousel") ? "❒" : "◼"}
          </span>
        )}
        <div className="grid min-w-0 flex-1 content-start gap-1.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_TONE[chip.tone]}`}>{chip.label}</span>
            {due && <span className="rounded-full bg-bad px-2 py-0.5 text-[11px] font-medium text-white">Live by {due}</span>}
            {s.drafted?.pace?.over && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">Over this week&apos;s share</span>}
          </span>
          <button type="button" onClick={() => pushParams({ approve: s.id })} className="text-left font-heading text-[16px] leading-snug hover:text-brand-text">
            {s.draft.title}
          </button>
          {c?.hook && <p className="line-clamp-2 text-[13px] leading-snug text-fg/80">&ldquo;{c.hook}&rdquo;</p>}
        </div>
      </div>
      <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">
        <span className="text-faint">Why: </span>
        {why}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {counts(s).map((x) => (
          <span key={x} className="rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11.5px] text-muted">
            {x}
          </span>
        ))}
        {s.drafted?.mix && <span className="rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11.5px] text-muted">{s.drafted.mix.track === "iterate" ? "Iteration" : "Net new"}</span>}
      </div>
      {rejecting ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((x) => (
              <button key={x} type="button" onClick={() => setReason(x)} className={`min-h-10 rounded-full px-3 text-xs md:min-h-8 ${reason === x ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                {x}
              </button>
            ))}
          </div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why not? The strategist learns from it" className="w-full rounded-[12px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-faint" />
          <div className="flex gap-2">
            <button type="button" onClick={reject} disabled={busy || reason.trim().length < 3} className="min-h-11 flex-1 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-40 sm:min-h-9 sm:flex-none">
              {busy ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" onClick={() => setRejecting(false)} className="min-h-11 px-3 text-sm text-muted hover:text-fg sm:min-h-9">
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 sm:flex">
          {s.drafted && canApprove && (
            <button type="button" onClick={approve} disabled={busy} className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50 sm:min-h-9 sm:px-5">
              {busy ? "Sending…" : "Approve to Asana"}
            </button>
          )}
          <button type="button" onClick={() => pushParams({ approve: s.id })} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg sm:min-h-9">
            {s.draft.summary ? "Preview" : "Edit"}
          </button>
          <button type="button" onClick={() => setRejecting(true)} className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[13px] text-muted hover:text-fg sm:min-h-9">
            Reject
          </button>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </article>
  );
}
