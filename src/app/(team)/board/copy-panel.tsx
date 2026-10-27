"use client";

import { CarouselCards } from "./carousel-cards";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { blockers, headsUp, type Ad } from "@/lib/copy";
import type { CopyViolation } from "@/lib/ai";
import { approveCopy, redraftCopy, reuseCopy, saveCopy, ticketCopy, type CopyState } from "./copy-actions";
import { CopyProgress, CopyStudio } from "./copy-studio";
import type { Ticket } from "./types";

/**
 * Copy on the ticket, kept small: progress while the AI writes, then a summary and "View copy", which opens the copy studio.
 * The Copywriter drafts as soon as the creative is approved; the copywriter is assigned when the draft is ready.
 */
export function CopyPanel({ ticket, canApprove, onMoved, demo }: { ticket: Ticket; canApprove: boolean; onMoved: (stage: Ticket["stage"]) => void; demo?: CopyState }) {
  const router = useRouter();
  const [state, setState] = useState<CopyState | null>(demo ?? null);
  const [ads, setAds] = useState<Ad[]>(demo?.set?.ads ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [violations, setViolations] = useState<CopyViolation[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const s = await ticketCopy(ticket.id);
    setState(s);
    if (s.set && s.set.status !== "drafting") setAds(s.set.ads);
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

  // While the AI writes, check back every couple of seconds (the progress is real: ads counted as they're written).
  // A plain fetch, so it never waits behind another action; when the copy lands the ticket refreshes too.
  const drafting = state?.set?.status === "drafting" || (!state?.set && ticket.stage === "copy" && state !== null);
  useEffect(() => {
    if (demo || !drafting) return;
    let live = true;
    const poll = setInterval(async () => {
      const res = await fetch(`/api/copy/${ticket.id}`, { cache: "no-store" }).catch(() => null);
      if (!live || !res?.ok) return;
      const s = (await res.json()) as CopyState;
      setState(s);
      if (s.set && s.set.status !== "drafting") {
        setAds(s.set.ads);
        router.refresh();
      }
    }, 2000);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [drafting, ticket.id, demo, router]);

  const set = state?.set ?? null;
  const missing = blockers(ads);
  const notes = headsUp(ads);

  // Save edits a moment after typing stops
  const change = (i: number, ad: Ad) => {
    const next = ads.map((a, j) => (j === i ? ad : a));
    setAds(next);
    // An edit may fix what the client check found; it runs again on the next approve
    if (violations.length) setViolations(violations.filter((v) => v.ad !== i + 1));
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

  const rewrite = (note?: string) =>
    run(async () => {
      if (demo) return;
      const r = await redraftCopy(ticket.id, note);
      if (!r.ok) return setError(r.error);
      setState(r.state);
    });

  const approve = () =>
    run(async () => {
      if (demo) {
        setOpen(false);
        return onMoved("client_review");
      }
      const r = await approveCopy(set!.id, ads);
      if (!r.ok) {
        setViolations(r.violations ?? []);
        return setError(r.violations?.length ? null : r.error);
      }
      setViolations([]);
      await load();
      setOpen(false);
      onMoved("client_review");
    });

  if (!state) return <p className="text-xs text-faint">Loading copy…</p>;

  const short = ads.filter((a) => a.kind === "short").length;
  const hook = ads[0]?.primaryText.split("\n")[0] ?? "";

  return (
    <section data-copy className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-[16px]">Copy</h3>
        {set && set.status !== "drafting" && (
          <span className="text-xs text-faint">
            v{set.version}
            {set.status === "approved" ? ` · approved${set.approvedBy ? ` by ${set.approvedBy}` : ""}` : ""}
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
                onMoved("client_review");
              })
            }
            className="h-9 rounded-full bg-ok px-4 text-sm font-medium text-white disabled:opacity-60 max-md:h-11 max-md:w-full"
          >
            Reuse it
          </button>
        </div>
      )}

      {drafting ? (
        <div className="grid gap-3 rounded-[12px] border border-line bg-surface p-5">
          <CopyProgress progress={set?.progress ?? {}} />
          <p className="text-xs text-faint">The Copywriter is writing 3 short and 2 long ads to the approved creative. The copywriter is assigned when it&apos;s ready.</p>
        </div>
      ) : !set || set.status === "failed" ? (
        <div className="grid justify-items-start gap-3 rounded-[12px] border border-dashed border-line p-5">
          <p className="text-sm text-muted">{set?.error ?? "No copy yet."} The Copywriter writes Kaizen&apos;s set: 3 short-form and 2 long-form ads.</p>
          <button disabled={busy} onClick={() => rewrite()} className="h-9 rounded-full bg-brand px-4 text-sm font-medium text-white disabled:opacity-60 max-md:h-11 max-md:px-5">
            {busy ? "Starting…" : "Write the copy"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="group grid gap-3 rounded-[12px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">
              {ads.length} ads · {short} short, {ads.length - short} long
            </span>
            {set.status === "approved" ? (
              <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">Approved</span>
            ) : missing.length ? (
              <span className="rounded-full bg-bad-soft px-2 py-0.5 text-bad">Copy missing</span>
            ) : notes.length ? (
              <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">
                {notes.length} heads-up{notes.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">On standard</span>
            )}
          </div>
          {hook && <p className="line-clamp-2 text-sm leading-relaxed text-muted">&ldquo;{hook}&rdquo;</p>}
          <span className="flex items-center justify-between max-md:gap-3">
            <span className="text-[11px] text-faint">{set.status === "approved" ? "See the approved set" : "Read it on the creative, edit, chat with the Copywriter, approve"}</span>
            <span className="rounded-full bg-fg px-3.5 py-1.5 text-xs font-medium text-bg transition-transform group-hover:translate-x-0.5 max-md:shrink-0 max-md:px-4 max-md:py-3 max-md:text-sm">View copy →</span>
          </span>
        </button>
      )}
      {error && !open && <p className="text-xs text-bad">{error}</p>}
      {ticket.format === "carousel" && set && set.status !== "drafting" && !demo && <CarouselCards requestId={ticket.id} />}

      {open && set && (
        <CopyStudio
          ticket={ticket}
          state={state}
          ads={ads}
          dirty={dirty}
          missing={missing}
          notes={notes}
          violations={violations}
          busy={busy}
          error={error}
          canApprove={canApprove}
          demo={Boolean(demo)}
          onChange={change}
          onApprove={approve}
          onRewrite={rewrite}
          onRewriting={() => void load()}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
