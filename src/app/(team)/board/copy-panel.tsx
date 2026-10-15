"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CTA_BUTTONS, meters, problems, type Ad, type Meter } from "@/lib/copy";
import { approveCopy, redraftCopy, reuseCopy, saveCopy, ticketCopy, type CopyState } from "./copy-actions";
import type { Ticket } from "./types";

const TONE = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
const DRAFT_STEPS = ["Reading the brief and the creative", "Picking five formulas", "Writing the short ads", "Writing the long ads", "Counting every character"];

/** A live counter under a field: value / max, a thin bar, and the tone (green, amber, red). */
function Count({ m }: { m: Meter }) {
  const pct = Math.min(100, (m.value / m.max) * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-14 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full transition-all ${BAR[m.tone]}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`tabular text-[11px] ${TONE[m.tone]}`}>
        {m.value}
        {m.min != null ? ` / ${m.min}–${m.max}` : ` / ${m.max}`} {m.unit === "words" ? "words" : ""}
      </span>
    </span>
  );
}

function AdCard({ i, ad, ai, editable, onChange }: { i: number; ad: Ad; ai?: Ad; editable: boolean; onChange: (ad: Ad) => void }) {
  const m = meters(ad);
  const edited = (k: keyof Ad) => ai && ai[k] !== ad[k];
  const field = "w-full rounded-[10px] border border-line bg-bg px-3.5 py-2.5 text-sm leading-relaxed outline-none transition-colors focus:border-brand-text/60 disabled:opacity-80";
  const bad = [m.primary, m.headline, m.description].some((x) => x.tone === "bad");
  return (
    <li className={`grid gap-3 rounded-[14px] border bg-surface p-4 transition-colors ${bad ? "border-bad/40" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-fg text-[11px] font-semibold text-bg">{i + 1}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${ad.kind === "short" ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted"}`}>{ad.kind === "short" ? "Short-form" : "Long-form"}</span>
        <span className="text-xs text-muted">{ad.formula}</span>
        {ad.angle && <span className="truncate text-xs text-faint">· {ad.angle}</span>}
      </div>

      <label className="grid gap-1.5">
        <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            Primary text {edited("primaryText") && <span className="text-[10px] text-brand-text">edited</span>}
          </span>
          <span className="flex items-center gap-3">
            <Count m={m.primary} />
          </span>
        </span>
        <textarea
          value={ad.primaryText}
          disabled={!editable}
          onChange={(e) => onChange({ ...ad, primaryText: e.target.value })}
          rows={ad.kind === "short" ? 3 : 12}
          className={field}
        />
        <span className="flex items-center justify-between text-[11px] text-faint">
          <span>Hook shown before &ldquo;See more&rdquo;</span>
          <Count m={m.hook} />
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_150px]">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Headline {edited("headline") && <span className="text-[10px] text-brand-text">edited</span>}</span>
            <Count m={m.headline} />
          </span>
          <input value={ad.headline} disabled={!editable} onChange={(e) => onChange({ ...ad, headline: e.target.value })} className={field} />
        </label>
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Link description</span>
            <Count m={m.description} />
          </span>
          <input value={ad.linkDescription} disabled={!editable} onChange={(e) => onChange({ ...ad, linkDescription: e.target.value })} className={field} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs text-muted">CTA button</span>
          <select value={ad.cta} disabled={!editable} onChange={(e) => onChange({ ...ad, cta: e.target.value })} className={field}>
            {CTA_BUTTONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
    </li>
  );
}

/**
 * Copy for the ticket in Kaizen's copy standard. The Copywriter drafts it as soon as the creative is approved; copy review edits
 * with live counts on every field and can't approve while anything is over a limit. Her edits teach later drafts.
 */
export function CopyPanel({ ticket, canApprove, onMoved, demo }: { ticket: Ticket; canApprove: boolean; onMoved: (stage: Ticket["stage"]) => void; demo?: CopyState }) {
  const [state, setState] = useState<CopyState | null>(demo ?? null);
  const [ads, setAds] = useState<Ad[]>(demo?.set?.ads ?? []);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const s = await ticketCopy(ticket.id);
    setState(s);
    if (s.set) setAds(s.set.ads);
    return s;
  }, [ticket.id]);

  useEffect(() => {
    if (demo) return;
    let live = true;
    ticketCopy(ticket.id).then((s) => {
      if (!live) return;
      setState(s);
      if (s.set) setAds(s.set.ads);
    });
    return () => {
      live = false;
    };
  }, [ticket.id, demo]);

  // While the AI drafts, check back every few seconds
  const drafting = state?.set?.status === "drafting" || (!state?.set && ticket.stage === "copy" && state !== null && !busy);
  useEffect(() => {
    if (demo || !drafting) return;
    const poll = setInterval(() => void load(), 5000);
    const tick = setInterval(() => setStep((s) => Math.min(s + 1, DRAFT_STEPS.length - 1)), 6000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [drafting, load, demo]);

  const set = state?.set ?? null;
  const editable = Boolean(set && set.status !== "approved" && set.status !== "drafting");
  const issues = problems(ads);

  // Save edits a moment after typing stops
  const change = (i: number, ad: Ad) => {
    const next = ads.map((a, j) => (j === i ? ad : a));
    setAds(next);
    setDirty(true);
    if (demo || !set) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveCopy(set.id, next).then((r) => (r.ok ? setDirty(false) : setError(r.error))), 900);
  };

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      await fn();
    });

  if (!state) return <p className="text-xs text-faint">Loading copy…</p>;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-[16px]">Copy</h3>
        {set && (
          <span className="text-xs text-faint">
            v{set.version}
            {set.status === "approved" ? ` · approved${set.approvedBy ? ` by ${set.approvedBy}` : ""}` : dirty ? " · saving…" : " · saved"}
          </span>
        )}
      </div>

      {state.reusable && canApprove && set?.status !== "approved" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-ok/30 bg-ok-soft/40 px-4 py-3">
          <p className="text-sm">
            Copy for this angle was already approved on <span className="font-medium">&ldquo;{state.reusable.title}&rdquo;</span>. No need to ask the client again.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await reuseCopy(ticket.id, state.reusable!.id);
                if (!r.ok) return setError(r.error);
                await load();
                onMoved("ready_for_client");
              })
            }
            className="h-9 rounded-full bg-ok px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            Reuse it
          </button>
        </div>
      )}

      {drafting || (busy && !set) ? (
        <div className="grid gap-3 rounded-[12px] border border-line bg-surface p-5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-all duration-[6000ms] ease-linear" style={{ width: `${((step + 1) / DRAFT_STEPS.length) * 92}%` }} />
          </div>
          <p className="text-sm">{DRAFT_STEPS[step]}…</p>
          <p className="text-xs text-faint">The Copywriter is drafting 3 short and 2 long ads. It lands in Copy review.</p>
        </div>
      ) : !set || set.status === "failed" ? (
        <div className="grid justify-items-start gap-3 rounded-[12px] border border-dashed border-line p-5">
          <p className="text-sm text-muted">{set?.error ?? "No copy yet."} The Copywriter writes Kaizen&apos;s set: 3 short-form and 2 long-form ads.</p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await redraftCopy(ticket.id);
                if (!r.ok) return setError(r.error);
                setState(r.state);
                if (r.state.set) setAds(r.state.set.ads);
                if (ticket.stage === "copy") onMoved("copy_review");
              })
            }
            className="h-9 rounded-full bg-brand px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? "Writing…" : "Write the copy"}
          </button>
        </div>
      ) : (
        <>
          {set.notes && (
            <p className="rounded-[12px] border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-faint">From the Copywriter</span>
              {set.notes}
            </p>
          )}
          <ol className="grid gap-3">
            {ads.map((ad, i) => (
              <AdCard key={i} i={i} ad={ad} ai={set.aiAds[i]} editable={editable} onChange={(a) => change(i, a)} />
            ))}
          </ol>

          {set.status !== "approved" && (
            <div className="sticky bottom-0 grid gap-2.5 rounded-[14px] border border-line bg-surface/95 p-3.5 shadow-[0_-12px_30px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
              {issues.length > 0 ? (
                <ul className="grid gap-1 text-xs text-bad">
                  {issues.slice(0, 2).map((x) => (
                    <li key={x}>• {x}</li>
                  ))}
                  {issues.length > 2 && <li>• and {issues.length - 2} more</li>}
                </ul>
              ) : (
                <p className="text-xs text-ok">Every field is within Kaizen&apos;s copy limits.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {canApprove && (
                  <button
                    disabled={busy || issues.length > 0}
                    onClick={() =>
                      run(async () => {
                        if (demo) return onMoved("ready_for_client");
                        const r = await approveCopy(set.id, ads);
                        if (!r.ok) return setError(r.error);
                        await load();
                        onMoved("ready_for_client");
                      })
                    }
                    className="h-10 rounded-brand bg-ok px-5 text-sm font-medium text-white disabled:opacity-40"
                    title={issues[0]}
                  >
                    Approve copy
                  </button>
                )}
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Rewrite with a note, e.g. warmer, lead with the price"
                  className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
                />
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (demo) return;
                      const r = await redraftCopy(ticket.id, note);
                      if (!r.ok) return setError(r.error);
                      setNote("");
                      setState(r.state);
                      if (r.state.set) setAds(r.state.set.ads);
                    })
                  }
                  className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60"
                >
                  {busy ? "Rewriting…" : "Rewrite"}
                </button>
              </div>

            </div>
          )}
        </>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
