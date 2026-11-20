"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ReviewCard } from "@/lib/line-review/act";
import { REVIEW_LINE_LABEL, usdFmt, pctFmt, type Confidence, type ReviewItem } from "@/lib/line-review/core";
import { approveAndSendReview, redraftReview, saveReviewMessage, skipWeeklyReview } from "./actions";

// The weekly review cards: what the review found (to-dos first, the rest one tap away), the internal message to edit,
// and Approve and send (posted as you in the client's internal channel), Save or Skip. The execs' rollup lists every
// client worst first with a jump to each line's card.

type Result = { ok: true; message?: string; permalink?: string } | { ok: false; error: string; issues?: string[]; needsConnect?: boolean };

const btn = "inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint disabled:opacity-50 md:min-h-9";
const primary = "inline-flex min-h-11 items-center justify-center rounded-full bg-fg px-5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50 md:min-h-9";
const CONF: Record<Confidence, string> = { certain: "bg-ok-soft text-ok", likely: "bg-brand-soft text-brand-text", guessing: "bg-warn-soft text-warn" };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[]; link?: string; connect?: boolean } | null>(null);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.message ?? "Saved.", link: r.permalink } : { ok: false, text: r.error, issues: r.issues, connect: r.needsConnect });
      if (r.ok) router.refresh();
    });
  return { pending, msg, run };
}

function riskTone(risk: number) {
  if (risk >= 50) return { label: "High risk", cls: "bg-bad-soft text-bad", bar: "bg-bad" };
  if (risk >= 25) return { label: "Watch", cls: "bg-warn-soft text-warn", bar: "bg-warn" };
  return { label: "Steady", cls: "bg-ok-soft text-ok", bar: "bg-ok" };
}

export function RedraftAll() {
  const { pending, msg, run } = useAct();
  return (
    <div className="grid justify-items-end gap-1">
      <button type="button" className={btn} disabled={pending} onClick={() => run(() => redraftReview(null, null))}>
        {pending ? "Drafting every review…" : "Draft missing reviews"}
      </button>
      {msg && <span className={`text-xs ${msg.ok ? "text-muted" : "text-bad"}`}>{msg.text}</span>}
    </div>
  );
}

export function Rollup({ rows }: { rows: { clientId: string; client: string; slug: string; risk: number; atRisk: boolean; lines: ReviewCard[] }[] }) {
  if (!rows.length) return <Empty text="No reviews drafted yet this week. They're drafted every Monday morning." />;
  return (
    <ol className="grid gap-2">
      {rows.map((r, i) => {
        const t = riskTone(r.risk);
        const todo = r.lines.flatMap((l) => l.review?.todos ?? []).slice(0, 2);
        return (
          <li key={r.clientId} className="relative grid gap-2 overflow-hidden rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[2rem_1fr_auto] md:items-center md:gap-4">
            <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${t.bar}`} />
            <span className="tabular hidden text-[13px] text-faint md:block">{i + 1}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/clients/${r.slug}`} className="font-heading text-[17px] leading-tight hover:underline">
                  {r.client}
                </Link>
                {r.atRisk && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] font-medium text-bad">Retention risk</span>}
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${t.cls}`}>{t.label}</span>
              </div>
              {todo.length > 0 && <p className="mt-1 line-clamp-2 text-[13px] text-muted">{todo.join(" · ")}</p>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {r.lines.map((l) => (
                <Link key={l.id} href={`/reviews?tab=${l.status === "draft" ? l.line : "done"}#r-${l.id}`} className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] ${l.status === "draft" ? "border-line text-fg hover:border-faint" : "border-transparent bg-bg text-faint"}`}>
                  {REVIEW_LINE_LABEL[l.line]}
                  <span aria-hidden>{l.status === "sent" ? "✓" : l.status === "skipped" ? "–" : "→"}</span>
                </Link>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
      <p className="font-heading text-lg">All clear</p>
      <p className="text-sm text-muted">{text}</p>
    </section>
  );
}

export function ReviewList({ cards, empty }: { cards: ReviewCard[]; empty: string }) {
  if (!cards.length) return <Empty text={empty} />;
  return (
    <ul className="grid gap-4">
      {cards.map((c) => (
        <Card key={c.id} c={c} />
      ))}
    </ul>
  );
}

function Items({ title, items }: { title: string; items: ReviewItem[] }) {
  if (!items.length) return null;
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{title}</p>
      <ul className="grid gap-1.5">
        {items.map((x, i) => (
          <li key={i} className="flex items-start justify-between gap-3 text-[13.5px]">
            <span className="min-w-0">
              {x.who && !x.who.startsWith("<@") ? <span className="text-muted">{x.who}: </span> : null}
              {x.text}
              {x.due ? <span className="text-faint"> · due {x.due}</span> : null}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${CONF[x.confidence]}`}>{x.confidence}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({ c }: { c: ReviewCard }) {
  const r = c.review;
  const { pending, msg, run } = useAct();
  const [text, setText] = useState(c.message);
  const [open, setOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const t = riskTone(c.risk);
  const draft = c.status === "draft";
  const budget: ReviewItem[] = (r?.budget ?? []).map((b) => ({ text: `${b.platform === "google" ? "Google" : b.platform === "tiktok" ? "TikTok" : "Meta"}: ${usdFmt(b.spent)} of ${usdFmt(b.budget)} (${pctFmt(b.pacePct)} vs pace), on course for ${usdFmt(b.projected)}${b.over ? " · over" : ""}`, confidence: b.confidence }));
  const health: ReviewItem[] = r
    ? [
        { text: `Client channel: ${r.health.clientSilent == null ? "no human update on record" : `${r.health.clientSilent} days since our last update`}`, confidence: "certain" },
        { text: `Internal channel: ${r.health.internalSilent == null ? "nothing on record" : `${r.health.internalSilent} days since the last update`}`, confidence: "certain" },
        ...(r.health.atRisk ? [{ text: r.health.atRisk, confidence: "certain" as const }] : []),
        ...r.health.blockers.map((b) => ({ text: `Onboarding: ${b}`, confidence: "certain" as const })),
      ]
    : [];
  return (
    <li id={`r-${c.id}`} className="relative grid scroll-mt-24 gap-4 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${t.bar}`} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{REVIEW_LINE_LABEL[c.line]}{r?.strategyOnly ? " · strategy only" : ""}</p>
          <Link href={`/clients/${c.slug}`} className="mt-0.5 block font-heading text-[21px] leading-tight hover:underline">
            {c.client}
          </Link>
          {r?.owner && <p className="mt-0.5 text-[12.5px] text-muted">Seat: {r.owner.name}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {c.status !== "draft" && <span className="rounded-full bg-bg px-2.5 py-1 text-[11px] text-muted">{c.status === "sent" ? "Sent" : `Skipped${c.skipReason ? `: ${c.skipReason}` : ""}`}</span>}
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${t.cls}`}>{t.label}</span>
        </div>
      </div>

      {r && (
        <div className="grid gap-2 rounded-[14px] bg-bg p-3.5 md:p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Today</p>
          <ol className="grid gap-1.5">
            {r.todos.map((x, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-snug">
                <span className="tabular mt-px text-[12px] text-faint">{i + 1}</span>
                <span>{x}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {r && (
        <div className="grid gap-3">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 items-center justify-between rounded-[12px] border border-line px-3.5 text-left text-[13px] text-muted hover:text-fg md:min-h-9">
            <span>What the review found</span>
            <span aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>⌄</span>
          </button>
          {open && (
            <div className="grid gap-4 px-0.5">
              {(r.scope.tiers.length > 0 || r.scope.services.length > 0) && <p className="text-[13px] text-muted">Scope: {[...r.scope.tiers].join(" · ") || "no tier set on the Services panel"}</p>}
              <Items title="Delivered this week" items={r.scope.delivered} />
              <Items title="Promised, not done" items={r.scope.promised} />
              <Items title="Budget pace" items={budget} />
              {r.changes.readable ? (
                <Items title={`Account changes: ${r.changes.ours} by us, ${r.changes.client} by the client${r.changes.unknown ? `, ${r.changes.unknown} unknown` : ""}`} items={[...r.changes.unapproved.map((x) => ({ ...x, text: `Without sign-off: ${x.text}` })), ...r.changes.clientPauses, ...r.changes.notable.slice(0, 5)]} />
              ) : (
                (r.line === "meta" || r.line === "google") && <p className="text-[13px] text-muted">Change history isn&apos;t readable for this account right now.</p>
              )}
              <Items title="Open commitments" items={r.commitments} />
              <Items title="Results vs target" items={[...r.results, ...(r.conversions && r.conversions.from !== "platform" ? [{ text: `Orders: ${r.conversions.note}`, confidence: r.conversions.confidence }] : [])]} />
              <Items title="Health" items={health} />
            </div>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <label htmlFor={`m-${c.id}`} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
          Internal message {r && !r.health.hasInternalChannel ? <span className="normal-case tracking-normal text-bad">· no internal channel linked</span> : null}
        </label>
        <textarea
          id={`m-${c.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={!draft}
          rows={Math.min(22, Math.max(8, text.split("\n").length + 1))}
          className="w-full resize-y rounded-[14px] border border-line bg-bg px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-fg outline-none focus:border-faint"
        />
      </div>

      {draft && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} disabled={pending} onClick={() => run(() => approveAndSendReview(c.id, text))}>
            {pending ? "Working…" : "Approve and send"}
          </button>
          {text !== c.message && (
            <button type="button" className={btn} disabled={pending} onClick={() => run(() => saveReviewMessage(c.id, text))}>
              Save
            </button>
          )}
          <button type="button" className={btn} disabled={pending} onClick={() => run(() => redraftReview(c.clientId, c.line))}>
            Refresh numbers
          </button>
          {!skipping ? (
            <button type="button" className={`${btn} border-transparent text-muted`} disabled={pending} onClick={() => setSkipping(true)}>
              Skip this week
            </button>
          ) : (
            <span className="flex w-full flex-wrap gap-2 md:w-auto">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional)" className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg px-4 text-[13px] text-fg outline-none focus:border-faint md:min-h-9" />
              <button type="button" className={btn} disabled={pending} onClick={() => run(() => skipWeeklyReview(c.id, reason))}>
                Skip
              </button>
            </span>
          )}
        </div>
      )}
      {c.status === "sent" && c.permalink && (
        <a href={c.permalink} target="_blank" rel="noreferrer" className="text-[13px] text-brand-text hover:underline">
          Open in Slack
        </a>
      )}
      {(msg || c.error) && (
        <div className={`grid gap-1 text-[13px] ${msg?.ok ? "text-muted" : "text-bad"}`}>
          <span>
            {msg?.text ?? c.error}
            {msg?.link && (
              <a href={msg.link} target="_blank" rel="noreferrer" className="ml-1 text-brand-text hover:underline">
                Open in Slack
              </a>
            )}
            {msg?.connect && (
              <a href="/api/slack/connect" className="ml-1 text-brand-text hover:underline">
                Connect Slack
              </a>
            )}
          </span>
          {msg?.issues?.map((x, i) => (
            <span key={i}>· {x}</span>
          ))}
        </div>
      )}
    </li>
  );
}
