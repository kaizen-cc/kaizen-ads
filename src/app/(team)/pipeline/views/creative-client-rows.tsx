"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { KIND_LABEL } from "@/lib/suggestion-kinds";
import type { OpenSuggestion } from "@/lib/suggestions";
import { CreateBriefLink } from "@/components/allotment-brief-actions";
import { DraftedChips, DraftedLine } from "@/components/drafted-brief-parts";
import { SuggestionSheet } from "./suggested-briefs";
import { approveDraftedBrief } from "../draft-actions";
import { declineSuggestion } from "../suggestion-actions";

// The creative leads' Clients tab (the head of creative every pool, the lead graphic designer images, the lead video
// editor video): one row per client, most urgent first, each with where its allotment stands, this week's healthy
// share, anything on the account watch, and the briefs already drafted for it, ready to approve right there (to
// Asana), edit (the full sheet, ?approve=id) or reject with a reason. Create brief opens the normal request form.

export type PoolLine = { pool: "images" | "videos"; line: string; pace: string; detail: string; requested: number; cap: number; elapsed: number; urgent: boolean; nothing: boolean; format: "image" | "video" };
export type ClientRow = {
  clientId: string;
  client: string;
  slug: string;
  pools: PoolLine[];
  fresh: string | null;
  watch: { id: string; title: string; severity: "critical" | "warn" | "info"; href: string }[];
  ideas: OpenSuggestion[];
};
export type WeekLine = { pool: "images" | "videos"; due: number; capacity: number | null; line: string };

const POOL_LABEL = { images: "Images", videos: "Videos" } as const;
const DOT = { critical: "bg-bad", warn: "bg-warn", info: "bg-brand" } as const;
const REASONS = ["Not the right time", "Already handled", "Wrong angle", "Brief isn't strong enough", "The reason isn't real"];
const FORMAT_ONE = { image: "image", video: "video", carousel: "carousel" } as const;
const counts = (s: OpenSuggestion) =>
  s.draft.formats
    .map((f) => [f.new ? `${f.new} new ${FORMAT_ONE[f.format]}${f.new === 1 ? "" : "s"}` : "", f.variations ? `${f.variations} variation${f.variations === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "))
    .filter(Boolean)
    .join(" · ");

export function CreativeClientRows({ rows, week, briefed }: { rows: ClientRow[]; week: WeekLine[] | null; /** Allotments fully briefed this cycle */ briefed: number }) {
  const open = useParam("approve");
  const current = rows.flatMap((r) => r.ideas).find((s) => s.id === open) ?? null;
  const ready = rows.reduce((n, r) => n + r.ideas.length, 0);
  return (
    <section id="allotments" className="grid scroll-mt-24 gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Clients <span className="tabular text-[15px] text-faint">{rows.length}</span>
        </h2>
        <span className="text-xs text-faint">{ready ? `${ready} brief${ready === 1 ? "" : "s"} ready to approve · ` : ""}most urgent first</span>
      </div>

      {week && (
        <div className="grid gap-2 sm:grid-cols-2">
          {week.map((w) => {
            const heavy = w.capacity != null && w.due > w.capacity;
            return (
              <div key={w.pool} className="grid gap-1.5 rounded-[18px] border border-line bg-ink/[0.025] px-4 py-3.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">This week · {POOL_LABEL[w.pool]}</span>
                <span className="flex items-baseline gap-2">
                  <span className={`tabular font-heading text-[26px] leading-none ${heavy ? "text-bad" : "text-fg"}`}>{w.due}</span>
                  <span className="text-[13px] text-muted">{w.capacity != null ? `at a healthy pace · a usual week makes ${w.capacity}` : "at a healthy pace"}</span>
                </span>
                <span className="text-[12.5px] text-muted">{w.line}</span>
              </div>
            );
          })}
        </div>
      )}

      {rows.length ? (
        <ul className="grid gap-3">
          {rows.map((r) => (
            <Row key={r.clientId} r={r} />
          ))}
        </ul>
      ) : (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">Every allotment in your slice is briefed for this cycle, and nothing is waiting on you.</p>
      )}
      {briefed > 0 && <p className="text-[12.5px] text-faint">{briefed} {briefed === 1 ? "allotment" : "allotments"} fully briefed this cycle</p>}

      {current && <SuggestionSheet key={current.id} s={current} onClose={() => closeParams("approve")} />}
    </section>
  );
}

function Row({ r }: { r: ClientRow }) {
  const urgent = r.pools.some((p) => p.urgent || p.nothing) || r.watch.some((w) => w.severity === "critical");
  return (
    <li className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/clients/${r.slug}?service=creative`} className="flex min-h-11 items-center gap-2 md:min-h-0">
          {urgent && <span className="h-2 w-2 rounded-full bg-bad" aria-hidden />}
          <span className="font-heading text-[17px] text-fg hover:underline">{r.client}</span>
        </Link>
        {r.ideas.length > 0 && <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-medium text-brand-text">{r.ideas.length} ready to approve</span>}
      </div>

      {r.pools.map((p) => (
        <div key={p.pool} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="grid min-w-0 flex-1 gap-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{POOL_LABEL[p.pool]}</span>
              <span className={`text-[14px] leading-snug ${p.nothing ? "text-bad" : p.urgent ? "text-warn" : "text-fg"}`}>{p.line}</span>
            </p>
            <span className="relative h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-ink/10" aria-label={`${p.requested} of ${p.cap} requested`}>
              <span className="block h-full rounded-full bg-[var(--brand)]" style={{ width: `${Math.min(100, (p.requested / Math.max(1, p.cap)) * 100)}%` }} />
              <span aria-hidden className="absolute inset-y-0 w-[2px] bg-fg/50" style={{ left: `${Math.min(100, p.elapsed * 100)}%` }} />
            </span>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {p.detail} · {p.pace}
            </p>
          </div>
          <CreateBriefLink idea={{ slug: r.slug, format: p.format }} />
        </div>
      ))}

      {r.fresh && <p className="text-[13px] text-muted">{r.fresh}: new hooks and visuals to bring it back.</p>}

      {r.watch.length > 0 && (
        <ul className="grid gap-1">
          {r.watch.map((w) => (
            <li key={w.id}>
              <Link href={w.href} className="flex min-h-11 items-start gap-2 text-[13px] text-muted hover:text-fg md:min-h-0">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[w.severity]}`} />
                {w.title}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {r.ideas.length > 0 ? (
        <div className="grid gap-2 border-t border-line pt-3">
          {r.ideas.map((s) => (
            <Idea key={s.id} s={s} />
          ))}
        </div>
      ) : r.pools.some((p) => !p.pace.startsWith("Nothing more") && !p.pace.startsWith("On pace")) ? (
        <p className="border-t border-line pt-3 text-[12.5px] text-faint">This week&apos;s share is being drafted from their winners, the market and what&apos;s working for similar clients. It lands here within the hour.</p>
      ) : null}
    </li>
  );
}

/** One brief in a client's row: its reason at a glance; open it to approve, edit or reject right there */
function Idea({ s }: { s: OpenSuggestion }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; links: { label: string; href: string }[] } | null>(null);
  const c = s.draft.concepts[0];

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
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] bg-ok/10 px-3 py-2.5 text-[13px] text-ok">
        {done.text}
        {done.links.slice(0, 3).map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="max-w-[220px] truncate underline underline-offset-2">
            {l.label}
          </a>
        ))}
      </div>
    );

  return (
    <div className={`grid gap-2 rounded-[14px] border px-3 py-3 ${open ? "border-faint bg-bg" : "border-line"}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((x) => !x)} className="grid gap-1.5 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{KIND_LABEL[s.kind]}</span>
          {s.drafted && <DraftedChips d={s.drafted} />}
          <span className="ml-auto text-[11px] text-faint">{counts(s)}</span>
        </span>
        <span className="flex items-start justify-between gap-3">
          <span className="font-heading text-[15.5px] leading-snug">{s.draft.title}</span>
          <span aria-hidden className={`mt-0.5 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
            ⌄
          </span>
        </span>
        {s.drafted ? <DraftedLine d={s.drafted} /> : <span className="line-clamp-2 text-[13px] text-muted">{s.signal}</span>}
      </button>

      {open && (
        <div className="grid gap-3">
          {c && (
            <div className="grid gap-1 rounded-[12px] bg-ink/[0.03] p-3 text-[13px]">
              {c.hook && <p>&ldquo;{c.hook}&rdquo;</p>}
              {c.visual && <p className="text-muted">{c.visual}</p>}
            </div>
          )}
          {s.drafted?.mix && <p className="text-[12.5px] text-muted">{s.drafted.mix.reason}</p>}
          {s.drafted?.pace && <p className={`text-[12.5px] ${s.drafted.pace.over ? "text-warn" : "text-muted"}`}>{s.drafted.pace.line}</p>}
          {rejecting ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((x) => (
                  <button key={x} type="button" onClick={() => setReason(x)} className={`h-10 rounded-full px-3 text-xs md:h-8 ${reason === x ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                    {x}
                  </button>
                ))}
              </div>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why not? The strategist learns from it" className="w-full rounded-brand border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-faint" />
              <div className="flex gap-2">
                <button type="button" onClick={reject} disabled={busy || reason.trim().length < 3} className="h-11 flex-1 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-40 sm:h-9 sm:flex-none">
                  {busy ? "Rejecting…" : "Reject"}
                </button>
                <button type="button" onClick={() => setRejecting(false)} className="h-11 px-3 text-sm text-muted hover:text-fg sm:h-9">
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {s.drafted ? (
                <button type="button" onClick={approve} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand px-5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50 sm:min-h-9">
                  {busy ? "Sending to Asana…" : "Approve"}
                </button>
              ) : null}
              <button type="button" onClick={() => pushParams({ approve: s.id })} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg sm:min-h-9">
                {s.drafted ? "Edit" : s.draft.summary ? "Preview" : "Open"}
              </button>
              <button type="button" onClick={() => setRejecting(true)} className="inline-flex min-h-11 items-center justify-center rounded-full px-4 text-[13px] text-muted hover:text-fg sm:min-h-9">
                Reject
              </button>
            </div>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
        </div>
      )}
    </div>
  );
}
