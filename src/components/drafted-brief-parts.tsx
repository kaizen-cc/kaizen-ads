"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Drafted } from "@/lib/suggestions";
import { ASKED_LABEL, dueLabel, mixLine } from "@/lib/brief-drafting-core";
import { draftSwapOptions, swapDraftedBrief } from "@/app/(team)/pipeline/draft-actions";

// The pieces a drafted brief shows (src/lib/brief-drafting.ts): why now (its real reason, quoted), the deadline, the
// iteration / net new split with its reason, and how it sits against this week's share. Plus the swap panel.

const SOURCE_LABEL = { call: "On the call", slack: "In Slack", email: "By email", ad: "The ad", numbers: "The numbers", pattern: "Proven for similar businesses" } as const;
const localToday = () => new Date().toISOString().slice(0, 10);

/** The small chips a drafted brief's card carries: the deadline, over the week's share, whose ask */
export function DraftedChips({ d, today }: { d: Drafted; today?: string }) {
  const due = dueLabel(d.deadline, today ?? localToday());
  return (
    <>
      {due && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${due === "Due today" || due === "Due tomorrow" || due === "Past due" ? "bg-bad text-white" : "bg-bad-soft text-bad"}`}>{due}</span>}
      {d.pace?.over && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">Over this week&apos;s share</span>}
      {d.askedBy === "client" && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-text">Client asked</span>}
    </>
  );
}

/** One line under a card's title: the real reason, quoted, and the mix */
export function DraftedLine({ d }: { d: Drafted }) {
  return (
    <span className="grid gap-1">
      {d.citation && (
        <span className="line-clamp-2 text-sm text-muted">
          <span className="text-faint">{SOURCE_LABEL[d.citation.source]}: </span>
          {d.citation.source === "call" || d.citation.source === "slack" || d.citation.source === "email" ? <>&ldquo;{d.citation.quote}&rdquo;</> : d.citation.quote}
        </span>
      )}
      {d.mix && <span className="text-xs text-faint">{mixLine(d.mix)}</span>}
    </span>
  );
}

/** The sheet's "Why now": what set it off (quoted, with where and when), the deadline, the split and the pace */
export function WhyNow({ d }: { d: Drafted }) {
  const due = dueLabel(d.deadline, localToday());
  const c = d.citation;
  return (
    <div className="grid gap-3 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-faint">Why now</p>
        <span className="flex flex-wrap gap-1.5">
          <DraftedChips d={d} />
          {d.askedBy && d.askedBy !== "client" && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{ASKED_LABEL[d.askedBy]}</span>}
        </span>
      </div>
      {c && (
        <blockquote className="grid gap-1 border-l-2 border-brand pl-3">
          <p className="text-sm leading-relaxed">{c.source === "call" || c.source === "slack" || c.source === "email" ? <>&ldquo;{c.quote}&rdquo;</> : c.quote}</p>
          <p className="text-[11px] text-faint">
            {SOURCE_LABEL[c.source]}
            {c.at ? ` · ${new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
            {c.ref && /^https?:\/\//.test(c.ref) ? (
              <>
                {" · "}
                <a href={c.ref} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-fg">
                  Open the message
                </a>
              </>
            ) : null}
          </p>
        </blockquote>
      )}
      {due && d.deadline && <p className="text-sm">Live by {new Date(`${d.deadline}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })} · {due.toLowerCase()}</p>}
      {d.mix && (
        <div className="grid gap-1.5 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{mixLine(d.mix)}</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className="bg-ok" style={{ width: `${d.mix.iterate}%` }} />
            <span className="bg-brand" style={{ width: `${d.mix.netNew}%` }} />
          </div>
          <p className="text-xs text-muted">{d.mix.reason}</p>
        </div>
      )}
      {d.pace && <p className={`border-t border-line pt-3 text-xs ${d.pace.over ? "text-warn" : "text-muted"}`}>{d.pace.line}</p>}
    </div>
  );
}

type Option = { kind: "draft" | "request" | "asana"; ref: string; title: string; stage: string | null; stageLabel: string; verdict: "swap" | "adapt" | "never" };

/**
 * Swap this brief in for another piece of the client's: what isn't made yet first (nobody loses hours); work in
 * production only forced by a lead, and then it's adapted, never restarted (a direction change on the piece).
 */
export function SwapPanel({ id, onDone }: { id: string; onDone: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<{ options: Option[]; swaps: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Option | null>(null);
  const [reason, setReason] = useState("");
  const [busy, act] = useTransition();
  const [done, setDone] = useState<{ href: string | null; churning: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    draftSwapOptions(id).then((r) => live && (r.ok ? setState({ options: r.options, swaps: r.swaps }) : setError(r.error)));
    return () => {
      live = false;
    };
  }, [id]);

  const swap = () =>
    picked &&
    act(async () => {
      setError(null);
      const r = await swapDraftedBrief(id, { kind: picked.kind, ref: picked.ref }, picked.verdict === "adapt", reason);
      if (!r.ok) return setError(r.error);
      setDone({ href: r.href, churning: r.churning });
      router.refresh();
    });

  if (done)
    return (
      <div className="grid gap-2 rounded-[14px] border border-ok/40 bg-ok/10 p-4 text-sm">
        <p className="text-ok">Swapped. {done.href ? "The piece in production is flagged to adapt, not restart." : "Nothing made was lost."}</p>
        {done.churning && <p className="text-warn">That&apos;s three or more swaps this cycle: the leads were told.</p>}
        <span className="flex flex-wrap gap-2">
          {done.href && (
            <Link href={done.href} className="rounded-full border border-line px-4 py-2.5 text-xs hover:border-faint md:py-1.5">
              See what&apos;s already done
            </Link>
          )}
          <button onClick={onDone} className="rounded-full border border-line px-4 py-2.5 text-xs text-muted hover:text-fg md:py-1.5">
            Close
          </button>
        </span>
      </div>
    );

  return (
    <div className="grid gap-3 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Swap it in for…</p>
        {state && <p className={`text-xs ${state.swaps >= 2 ? "text-warn" : "text-faint"}`}>{state.swaps} swap{state.swaps === 1 ? "" : "s"} this cycle</p>}
      </div>
      <p className="text-xs text-muted">Only what isn&apos;t made yet swaps freely. Work in production keeps its slot; a lead can force it, and then what&apos;s done is adapted, never restarted.</p>
      {!state && !error && <p className="text-xs text-faint">Reading the client&apos;s work…</p>}
      {state && !state.options.length && <p className="text-xs text-faint">Nothing to swap: this brief takes the next open slot.</p>}
      {state && state.options.length > 0 && (
        <div className="grid max-h-64 gap-1.5 overflow-y-auto overscroll-contain">
          {state.options.map((o) => (
            <button
              key={`${o.kind}:${o.ref}`}
              type="button"
              onClick={() => setPicked(o)}
              className={`flex min-h-11 items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left text-sm ${picked?.ref === o.ref ? "border-fg" : "border-line hover:border-faint"}`}
            >
              <span className="min-w-0 truncate">{o.title}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${o.verdict === "adapt" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}>{o.verdict === "adapt" ? `${o.stageLabel} · adapt` : o.stageLabel}</span>
            </button>
          ))}
        </div>
      )}
      {picked && (
        <div className="grid gap-2">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={picked.verdict === "adapt" ? "Why it can't wait (the maker reads this)" : "Why (optional)"} className="w-full rounded-brand border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-faint" />
          <button onClick={swap} disabled={busy || (picked.verdict === "adapt" && reason.trim().length < 3)} className="h-11 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-40 md:h-9 md:justify-self-start">
            {busy ? "Swapping…" : picked.verdict === "adapt" ? "Force the swap and adapt it" : "Swap it in"}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
