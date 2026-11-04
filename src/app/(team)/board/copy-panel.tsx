"use client";

import { CarouselCards } from "./carousel-cards";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adsHash, blockers, headsUp, isDismissed, type Ad, type Dismissed } from "@/lib/copy";
import type { CopyViolation } from "@/lib/ai";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { approveCopy, checkCopy, rebutFlag, redraftCopy, reuseCopy, saveCopy, ticketCopy, type CopyState } from "./copy-actions";
import { prefetchMedia } from "./media-cache";
import { CopyProgress, CopyStudio } from "./copy-studio";
import type { Ticket } from "./types";

/**
 * Copy on the ticket, kept small: progress while the AI writes, then a summary and "View copy", which opens the copy studio.
 * The Copywriter drafts as soon as the creative is approved; the copywriter is assigned when the draft is ready.
 */
export function CopyPanel({ ticket, canApprove, canForce = false, onMoved, demo }: { ticket: Ticket; canApprove: boolean; /** Execs and leads: approve past flagged client rules, with a reason */ canForce?: boolean; onMoved: (stage: Ticket["stage"]) => void; demo?: CopyState }) {
  const router = useRouter();
  const [state, setState] = useState<CopyState | null>(demo ?? null);
  const [ads, setAds] = useState<Ad[]>(demo?.set?.ads ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The copy studio is in the address (?copy=1), so back closes it. forced: "View copy" while the address already says
  // it's open (it can't push the same address again), so the studio shows anyway.
  const param = useParam("copy") === "1";
  const [forced, setForced] = useState(false);
  const open = param || forced;
  const closing = useRef(false);
  const close = () => {
    setForced(false);
    // One close per open: a second (Escape and a click together) would go back past the ticket too
    if (closing.current || !param) return;
    closing.current = true;
    closeParams("copy");
    setTimeout(() => (closing.current = false), 600);
  };
  const view = () => {
    if (new URLSearchParams(window.location.search).get("copy") === "1") setForced(true);
    else pushParams({ copy: "1" });
  };
  const [violations, setViolations] = useState<CopyViolation[]>([]);
  // The check against what the client told us, kept with the copy: the same status everywhere, before anyone approves
  const [check, setCheck] = useState<{ violations: CopyViolation[]; hash: string } | null>(demo?.set?.check ?? null);
  const [dismissed, setDismissed] = useState<Dismissed[]>(demo?.set?.dismissed ?? []);
  const [checking, setChecking] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const take = useCallback((s: CopyState) => {
    setState(s);
    if (s.set && s.set.status !== "drafting") {
      setAds(s.set.ads);
      setCheck(s.set.check);
      setDismissed(s.set.dismissed);
    }
  }, []);
  const load = useCallback(async () => {
    const s = await ticketCopy(ticket.id);
    take(s);
    return s;
  }, [ticket.id, take]);

  useEffect(() => {
    if (demo) return;
    let live = true;
    // A plain fetch: it doesn't wait behind the ticket's other requests
    fetch(`/api/copy/${ticket.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<CopyState>) : ticketCopy(ticket.id)))
      .then((s) => live && take(s))
      .catch(() => undefined);
    // The creative for the feed preview, fetched now so the studio opens with it
    prefetchMedia(ticket.id);
    return () => {
      live = false;
    };
  }, [ticket.id, demo, take]);

  // Re-check against the client's rules when the words change (a moment after typing stops), and once when it opens
  const set0 = state?.set ?? null;
  const hash = ads.length ? adsHash(ads) : "";
  useEffect(() => {
    if (demo || !set0 || set0.status !== "review" || !hash || check?.hash === hash) return;
    const t = setTimeout(async () => {
      setChecking(true);
      const r = await checkCopy(set0.id, ads);
      setChecking(false);
      if (r.ok) setCheck({ violations: r.violations, hash: r.hash });
    }, check ? 2500 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, set0?.id, set0?.status, check?.hash, demo]);
  const fresh = check && check.hash === hash;
  const flags = fresh ? check.violations.filter((v) => !isDismissed(v, dismissed)) : violations.filter((v) => !isDismissed(v, dismissed));
  const rebutted = fresh ? check.violations.filter((v) => isDismissed(v, dismissed)) : [];

  // Copy ready for review: opening the ticket opens the studio, once per time the ticket is opened
  const autoOpened = useRef(false);
  useEffect(() => {
    if (demo || autoOpened.current || !state?.set) return;
    autoOpened.current = true;
    if (state.set.status === "review" && canApprove && ["copy", "copy_review"].includes(ticket.stage) && !param) pushParams({ copy: "1" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.set?.status]);

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
      take(s);
      if (s.set && s.set.status !== "drafting") router.refresh();
    }, 2000);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [drafting, ticket.id, demo, router, take]);

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

  const approve = (force?: { reason: string }) =>
    run(async () => {
      // Approved: the ticket closes, and the studio with it
      if (demo) return onMoved("client_review");
      const r = await approveCopy(set!.id, ads, force);
      if (!r.ok) {
        setViolations(r.violations ?? []);
        if (r.violations) setCheck({ violations: r.violations, hash: adsHash(ads) });
        return setError(r.violations?.length ? null : r.error);
      }
      setViolations([]);
      await load();
      onMoved("client_review");
    });

  /** The copywriter or a lead: this flag reads the client's rule too strictly */
  const rebut = async (v: CopyViolation, reason: string) => {
    if (demo || !set) return;
    const r = await rebutFlag(set.id, { rule: v.rule, quote: v.quote, field: v.field }, reason);
    if (!r.ok) return setError(r.error);
    setDismissed(r.dismissed);
  };

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
        <div className="grid gap-3 rounded-[12px] border border-line bg-surface p-4 transition-colors hover:border-faint">
          <button type="button" onClick={view} className="grid gap-3 text-left">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">
                {ads.length} ads · {short} short, {ads.length - short} long
              </span>
              <StatusBadge approved={set.status === "approved"} missing={missing.length} flags={flags.length} checking={checking || (!fresh && set.status === "review" && !demo)} notes={notes.length} client={ticket.clientName} />
            </div>
            {hook && <p className="line-clamp-2 text-sm leading-relaxed text-muted">&ldquo;{hook}&rdquo;</p>}
          </button>
          <span className="flex flex-wrap items-center justify-between gap-2 max-md:gap-3">
            <span className="text-[11px] text-faint">{set.status === "approved" ? "See the approved set" : flags.length ? `${flags.length} conflict${flags.length === 1 ? "" : "s"} to fix first` : "Read it on the creative, edit, chat with the Copywriter, approve"}</span>
            <span className="flex flex-wrap items-center gap-2 max-md:w-full">
              {set.status === "review" && canApprove && (
                <QuickApprove
                  disabled={busy || missing.length > 0 || checking || !fresh}
                  blocked={flags.length}
                  canForce={canForce}
                  busy={busy}
                  onApprove={(force) => approve(force)}
                  onView={view}
                />
              )}
              <button type="button" onClick={view} className="rounded-full bg-fg px-3.5 py-1.5 text-xs font-medium text-bg transition-transform hover:translate-x-0.5 max-md:flex-1 max-md:px-4 max-md:py-3 max-md:text-sm">
                View copy →
              </button>
            </span>
          </span>
        </div>
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
          violations={flags}
          rebutted={rebutted}
          dismissed={dismissed}
          checking={checking || (!fresh && set.status === "review" && !demo)}
          busy={busy}
          error={error}
          canApprove={canApprove}
          canForce={canForce}
          demo={Boolean(demo)}
          onChange={change}
          onApprove={() => approve()}
          onForce={(reason) => approve({ reason })}
          onRebut={rebut}
          onRewrite={rewrite}
          onRewriting={() => void load()}
          onClose={close}
        />
      )}
    </section>
  );
}

/** One status for the copy, the same in the ticket and the studio: never "On standard" while a client rule is broken */
function StatusBadge({ approved, missing, flags, checking, notes, client }: { approved: boolean; missing: number; flags: number; checking: boolean; notes: number; client: string }) {
  if (approved) return <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">Approved</span>;
  if (missing) return <span className="rounded-full bg-bad-soft px-2 py-0.5 text-bad">Copy missing</span>;
  if (flags)
    return (
      <span className="rounded-full bg-bad-soft px-2 py-0.5 text-bad">
        {flags} thing{flags === 1 ? "" : "s"} go{flags === 1 ? "es" : ""} against what {client} told us
      </span>
    );
  if (checking) return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-faint">Checking against what {client} told us…</span>;
  if (notes)
    return (
      <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">
        {notes} heads-up{notes === 1 ? "" : "s"}
      </span>
    );
  return <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">On standard</span>;
}

/**
 * Approve from the ticket, for whoever has already been through the copy: confirm once, and it moves on like any
 * approval. With client-rule conflicts it's off (fix them in the studio), and execs and leads can force it with a reason.
 */
function QuickApprove({ disabled, blocked, canForce, busy, onApprove, onView }: { disabled: boolean; blocked: number; canForce: boolean; busy: boolean; onApprove: (force?: { reason: string }) => void; onView: () => void }) {
  const [step, setStep] = useState<null | "confirm" | "force">(null);
  const [reason, setReason] = useState("");
  if (step === "confirm")
    return (
      <span className="flex items-center gap-1.5 max-md:w-full">
        <button type="button" disabled={busy} onClick={() => (onApprove(), setStep(null))} className="rounded-full bg-ok px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-60 max-md:flex-1 max-md:py-3 max-md:text-sm">
          {busy ? "Approving…" : "Yes, approve the copy"}
        </button>
        <button type="button" onClick={() => setStep(null)} className="rounded-full px-3 py-1.5 text-xs text-muted hover:text-fg max-md:py-3">
          Cancel
        </button>
      </span>
    );
  if (step === "force")
    return (
      <span className="grid w-full gap-1.5">
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it's fine to approve over the flags" className="h-9 rounded-full border border-line bg-bg px-3.5 text-xs outline-none focus:border-brand-text/60 max-md:h-11 max-md:text-base" />
        <span className="flex gap-1.5">
          <button type="button" disabled={busy || reason.trim().length < 4} onClick={() => (onApprove({ reason }), setStep(null))} className="rounded-full bg-fg px-3.5 py-1.5 text-xs font-medium text-bg disabled:opacity-40 max-md:flex-1 max-md:py-3">
            Force approve
          </button>
          <button type="button" onClick={() => setStep(null)} className="rounded-full px-3 py-1.5 text-xs text-muted hover:text-fg">
            Cancel
          </button>
        </span>
      </span>
    );
  if (blocked)
    return (
      <span className="flex items-center gap-2 max-md:w-full">
        <button type="button" onClick={onView} className="text-[11px] text-bad hover:underline">
          {blocked} conflict{blocked === 1 ? "" : "s"} to fix · View copy
        </button>
        {canForce && (
          <button type="button" onClick={() => setStep("force")} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:text-fg max-md:py-3">
            Force approve
          </button>
        )}
      </span>
    );
  return (
    <button type="button" disabled={disabled} onClick={() => setStep("confirm")} className="rounded-full bg-ok px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-40 max-md:flex-1 max-md:py-3 max-md:text-sm">
      ✓ Approve copy
    </button>
  );
}
