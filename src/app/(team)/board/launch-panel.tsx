"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LaunchCheck } from "@/lib/launcher";
import { EVENTS, eventLabel, firedAgo } from "@/lib/meta-events";
import { LaunchManage } from "./launch-manage";
import { LaunchMove } from "./launch-move";
import { confirmLaunch, discardLaunch, launchFor, loadLaunch, replanLaunch, sandboxCampaign, startLaunch, type LaunchView } from "./launch-actions";

// Launch to Meta, on a ticket in Ready to launch. Kaizen Ads launches it on its own when the ticket gets here (the
// Media Buyer picks the ad set and names, Kaizen's checks and Meta's dry run, then the ads are created paused) and
// hands the ticket to the buyer to turn them on; the ticket completes itself once Meta shows them on. This panel shows
// how that went, and when something stopped it, it's where the buyer adjusts and launches by hand.

const field = "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-[#0866ff]/60 max-md:h-11";
const TONE: Record<LaunchCheck["level"], { dot: string; text: string; icon: string }> = {
  ok: { dot: "bg-ok/15 text-ok", text: "text-muted", icon: "✓" },
  warn: { dot: "bg-warn/15 text-warn", text: "text-muted", icon: "!" },
  block: { dot: "bg-bad/15 text-bad", text: "text-fg", icon: "×" },
};

export function LaunchPanel({ requestId, isExec, launched = false }: { requestId: string; isExec: boolean; launched?: boolean }) {
  const router = useRouter();
  const [l, setL] = useState<LaunchView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // The buyer ticked that they checked what Meta locks (for the settings shown: the fingerprint)
  const [ticked, setTicked] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The buyer's edits, sent with "Check again"
  const [edits, setEdits] = useState<{ adsetId?: string; mode?: "existing" | "clone"; newAdsetName?: string; pageId?: string; igId?: string | null; link?: string; dailyBudget?: number | null; pixelId?: string | null; event?: string | null; trackingPixel?: string | null; urlTags?: string; leadFormId?: string; names: Record<string, string> }>({ names: {} });
  const busy = l?.status === "planning" || l?.status === "launching";

  useEffect(() => {
    let live = true;
    void launchFor(requestId).then((x) => {
      if (!live) return;
      setL(x);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [requestId]);

  useEffect(() => {
    if (!l || !busy) return;
    const t = setInterval(async () => {
      const next = await loadLaunch(l.id);
      if (next) setL(next);
    }, 2500);
    return () => clearInterval(t);
  }, [l, busy]);

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      await fn();
    });
  const plan = () =>
    run(async () => {
      const r = await startLaunch(requestId);
      if (!r.ok) return setError(r.error);
      setEdits({ names: {} });
      setL(await loadLaunch(r.id));
    });
  const recheck = (ack?: string) =>
    run(async () => {
      if (!l) return;
      const p = l.plan;
      const r = await replanLaunch(l.id, {
        acks: [...(p?.acks ?? []), ...(ack ? [ack] : [])],
        adsetId: edits.adsetId ?? p?.adsetId,
        mode: edits.mode ?? p?.mode,
        newAdsetName: edits.newAdsetName ?? p?.newAdsetName ?? undefined,
        pageId: edits.pageId ?? p?.pageId ?? undefined,
        igId: edits.igId !== undefined ? edits.igId : (p?.igId ?? null),
        link: edits.link ?? p?.link ?? undefined,
        dailyBudget: edits.dailyBudget !== undefined ? edits.dailyBudget : (p?.budget?.value ?? null),
        pixelId: edits.pixelId !== undefined ? edits.pixelId : (p?.pixelId ?? undefined),
        event: edits.event !== undefined ? edits.event : (p?.event ?? undefined),
        trackingPixel: edits.trackingPixel !== undefined ? edits.trackingPixel : (p?.trackingPixel ?? null),
        urlTags: edits.urlTags !== undefined ? edits.urlTags : (p?.urlTags ?? null),
        leadFormId: edits.leadFormId ?? p?.leadFormId ?? undefined,
        names: { ...Object.fromEntries((p?.ads ?? []).map((a) => [a.designId, a.name])), ...edits.names },
      });
      if (!r.ok) return setError(r.error);
      setL(await loadLaunch(l.id));
    });
  const launch = () =>
    run(async () => {
      if (!l) return;
      setConfirm(false);
      setL({ ...l, status: "launching" });
      const r = await confirmLaunch(l.id, l.plan?.locked?.fingerprint);
      if (!r.ok) setError(r.error);
      setL(await loadLaunch(l.id));
      router.refresh();
    });

  if (!loaded) return null;
  // Launched by hand: nothing to show here
  if (!l && launched) return null;

  // Not planned yet
  if (!l)
    return (
      <section className="relative grid gap-4 overflow-hidden rounded-[18px] border border-[#0866ff]/30 bg-gradient-to-br from-[#0866ff]/[0.09] via-transparent to-transparent p-5 max-md:p-4">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[#0866ff]/20 blur-[70px]" />
        <div className="relative grid gap-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7aa7ff]">Launch to Meta</p>
          <p className="flex items-center gap-2.5 font-heading text-lg">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#7aa7ff] border-t-transparent" />
            Launching automatically
          </p>
          <p className="max-w-[56ch] text-sm text-muted">
            Kaizen Ads picks up tickets in Ready to launch within five minutes: it places the ads, names them, runs the checks and Meta&apos;s dry run, and creates them paused. The ticket then comes to the buyer with the link to turn them on.
          </p>
        </div>
        <div className="relative flex flex-wrap items-center gap-3">
          <button type="button" onClick={plan} disabled={pending} className="text-xs text-faint underline-offset-2 hover:text-fg hover:underline disabled:opacity-60 max-md:h-11 max-md:rounded-full max-md:border max-md:border-line max-md:px-4 max-md:text-sm max-md:text-muted">
            {pending ? "Starting…" : "Start it now"}
          </button>
          {error && <span className="text-sm text-bad">{error}</span>}
        </div>
      </section>
    );

  const p = l.plan;
  const adset = p?.options.adsets.find((a) => a.id === (edits.adsetId ?? p.adsetId));
  const mode = edits.mode ?? p?.mode ?? "existing";
  const dirty = Boolean(edits.adsetId || edits.mode || edits.newAdsetName !== undefined || edits.pageId || edits.igId !== undefined || edits.link !== undefined || edits.dailyBudget !== undefined || edits.pixelId !== undefined || edits.event !== undefined || edits.trackingPixel !== undefined || edits.urlTags !== undefined || edits.leadFormId !== undefined || Object.keys(edits.names).length);
  const blocks = l.checks.filter((c) => c.level === "block");
  const noAdset = l.checks.some((c) => c.key === "adset" && c.level === "block" && !p?.options.adsets.length);

  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[18px] border border-[#0866ff]/30 bg-gradient-to-br from-[#0866ff]/[0.07] via-transparent to-transparent p-5 max-md:p-4">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[#0866ff]/15 blur-[70px]" />
      <header className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7aa7ff]">
            Launch to Meta
            {l.sandbox && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-warn">Sandbox test</span>}
          </p>
          <p className="font-heading text-lg">
            {l.status === "launched"
              ? "Launched to Meta"
              : l.status === "launching"
                ? "Creating the ads…"
                : l.status === "planning"
                  ? "Planning the launch…"
                  : l.status === "failed" || blocks.length
                    ? "Couldn't launch automatically"
                    : "Ready to launch"}
          </p>
        </div>
        {!busy && l.status !== "launched" && (
          <button type="button" onClick={() => run(async () => (await discardLaunch(l.id), setL(null)))} className="text-xs text-faint hover:text-fg max-md:-my-2 max-md:px-2 max-md:py-3">
            Discard
          </button>
        )}
      </header>

      {busy && (
        <p className="relative flex items-center gap-2.5 text-sm text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#7aa7ff] border-t-transparent" />
          {l.progress ?? (l.status === "launching" ? "Creating the ads in Meta" : "Working")}…
        </p>
      )}

      {l.status === "launched" && l.result && (
        <div className="relative grid gap-3">
          <LaunchManage l={l} onDone={() => void loadLaunch(l.id).then((x) => x && setL(x))} />
          <p className="text-xs text-faint">
            {l.sandbox ? "A test in Kaizen's account: the ticket stays in Ready to launch." : "Turning the ads on (here or in Ads Manager) moves this ticket to Launched."}
            {l.launchedBy ? ` Launched by ${l.launchedBy}.` : ""}
          </p>
          {!l.plan?.dynamic && <LaunchMove l={l} onDone={() => void loadLaunch(l.id).then((x) => x && setL(x))} />}
        </div>
      )}

      {p && !busy && l.status !== "launched" && (
        <div className="relative grid gap-5">
          {p.options.adsets.length > 0 && (
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Where</p>
              <select value={edits.adsetId ?? p.adsetId} onChange={(e) => setEdits((x) => ({ ...x, adsetId: e.target.value }))} className={field}>
                {[...new Set(p.options.adsets.map((a) => a.campaign))].map((c) => (
                  <optgroup key={c} label={c}>
                    {p.options.adsets
                      .filter((a) => a.campaign === c)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.status !== "ACTIVE" ? " (paused)" : ""}
                          {a.spend14 ? ` · $${a.spend14.toLocaleString()} in 14 days` : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {(["existing", "clone"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setEdits((x) => ({ ...x, mode: m }))} className={`h-8 rounded-full px-3 text-xs transition-colors max-md:h-11 max-md:px-4 ${mode === m ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                    {m === "existing" ? "Add to this ad set" : "New ad set, copied from it"}
                  </button>
                ))}
              </div>
              {mode === "clone" && (
                <input value={edits.newAdsetName ?? p.newAdsetName ?? (adset ? `${adset.name} | New` : "")} onChange={(e) => setEdits((x) => ({ ...x, newAdsetName: e.target.value }))} placeholder="New ad set name" className={field} />
              )}
              {p.reason && !dirty && <p className="text-xs italic leading-relaxed text-faint">{p.reason}</p>}
            </div>
          )}

          {p.budget && p.budget.level && p.budget.level !== "lifetime" && (
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">
                Daily budget <span className="normal-case tracking-normal">· on {p.budget.level === "campaign" ? "the campaign (shared by its ad sets)" : (edits.mode ?? p.mode) === "clone" ? "the new ad set" : "this ad set"}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex h-10 w-40 items-center gap-1.5 rounded-[10px] border border-line bg-bg px-3 text-sm focus-within:border-[#0866ff]/60 max-md:h-11 max-md:flex-1">
                  <span className="text-faint">$</span>
                  <input
                    inputMode="decimal"
                    value={edits.dailyBudget !== undefined ? (edits.dailyBudget ?? "") : (p.budget.value ?? "")}
                    placeholder={p.budget.current != null ? `${p.budget.current} (now)` : "Daily budget"}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d.]/g, "");
                      setEdits((x) => ({ ...x, dailyBudget: v ? Number(v) : null }));
                    }}
                    className="h-full min-w-0 flex-1 bg-transparent tabular outline-none placeholder:text-faint"
                  />
                  <span className="text-xs text-faint">/day</span>
                </label>
                {p.budget.suggested != null && (edits.dailyBudget !== undefined ? edits.dailyBudget : p.budget.value) !== p.budget.suggested && (
                  <button type="button" onClick={() => setEdits((x) => ({ ...x, dailyBudget: p.budget!.suggested }))} className="h-10 rounded-full border border-[#0866ff]/40 px-3.5 text-xs text-[#7aa7ff] hover:bg-[#0866ff]/10 max-md:h-11">
                    Use the suggested ${p.budget.suggested}
                  </button>
                )}
                {(edits.dailyBudget !== undefined ? edits.dailyBudget : p.budget.value) != null && (
                  <button type="button" onClick={() => setEdits((x) => ({ ...x, dailyBudget: null }))} className="h-10 px-2 text-xs text-faint hover:text-fg max-md:h-11">
                    Keep it as it is
                  </button>
                )}
              </div>
              {p.budget.why && <p className="text-xs italic leading-relaxed text-faint">{p.budget.why}</p>}
            </div>
          )}

          {p.ads.length > 0 && (
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">
                {p.ads.length} {p.ads.length === 1 ? "ad" : "ads"} · copy stacked ({p.copy.bodies.length} texts, {p.copy.titles.length} headlines) · {p.cta.replace(/_/g, " ").toLowerCase()}
              </p>
              {p.ads.map((a) => (
                <div key={a.designId} className="grid gap-1.5 rounded-[12px] border border-line bg-bg/40 p-3">
                  <input value={edits.names[a.designId] ?? a.name} onChange={(e) => setEdits((x) => ({ ...x, names: { ...x.names, [a.designId]: e.target.value } }))} className={`${field} h-9 max-md:h-11`} aria-label={`Ad name for ${a.designName}`} />
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                    <span className="text-muted">{a.designName}</span>
                    {a.assets.map((x) => (
                      <span key={x.fileId} className="rounded-full bg-surface-2 px-2 py-px">
                        {x.card ? `card ${x.card}` : x.aspect} {x.kind}
                      </span>
                    ))}
                    {a.check && <span className={a.check.ok ? "text-ok" : "text-bad"}>{a.check.ok ? "✓ Meta would accept it" : `× ${a.check.error}`}</span>}
                  </p>
                </div>
              ))}
            </div>
          )}

          {p.options.pages.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
                Facebook Page
                <select value={edits.pageId ?? p.pageId ?? ""} onChange={(e) => setEdits((x) => ({ ...x, pageId: e.target.value }))} className={`${field} normal-case tracking-normal`}>
                  {p.options.pages.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
                Instagram
                <select value={(edits.igId !== undefined ? edits.igId : p.igId) ?? ""} onChange={(e) => setEdits((x) => ({ ...x, igId: e.target.value || null }))} className={`${field} normal-case tracking-normal`}>
                  <option value="">Use the Facebook Page</option>
                  {p.options.igs.map((x) => (
                    <option key={x.id} value={x.id}>
                      @{x.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {adset?.leadForm && (
            <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
              Instant form
              <select value={edits.leadFormId ?? p.leadFormId ?? ""} onChange={(e) => setEdits((x) => ({ ...x, leadFormId: e.target.value }))} className={`${field} normal-case tracking-normal`}>
                <option value="" disabled>
                  Pick the form these ads open
                </option>
                {(p.options.leadForms ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {adset.forms?.includes(x.id) ? " (this ad set's)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
            {adset?.leadForm ? "Website (shown on the form's end screen)" : "Link"}
            <input value={edits.link ?? p.link ?? ""} onChange={(e) => setEdits((x) => ({ ...x, link: e.target.value }))} placeholder="https://" className={`${field} normal-case tracking-normal`} />
          </label>

          {/* Tracking: what a new ad set optimizes for, where each ad reports website events, the UTMs on its link */}
          <div className="grid gap-3 rounded-[14px] border border-line bg-bg/30 p-3.5">
            <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Tracking</p>
            {mode === "clone" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-[11px] text-faint">
                  New ad set optimizes on
                  <select value={(edits.pixelId !== undefined ? edits.pixelId : (p.pixelId ?? adset?.pixel)) ?? ""} onChange={(e) => setEdits((x) => ({ ...x, pixelId: e.target.value || null }))} className={field}>
                    <option value="">No pixel</option>
                    {(p.options.pixels ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} · {firedAgo(x.lastFired)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-[11px] text-faint">
                  For the event
                  <select value={(edits.event !== undefined ? edits.event : (p.event ?? adset?.event)) ?? ""} onChange={(e) => setEdits((x) => ({ ...x, event: e.target.value || null }))} className={field}>
                    <option value="">As the copied ad set</option>
                    {EVENTS.map((x) => (
                      <option key={x} value={x}>
                        {eventLabel(x)}
                        {x === p.suggestedEvent ? " (the KPI's)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted">
                {adset?.pixel ? (
                  <>
                    Optimizes for {eventLabel(adset.event ?? adset.optimization ?? "?")} on {(p.options.pixels ?? []).find((x) => x.id === adset.pixel)?.name ?? adset.pixel}
                    <span className="text-faint">, the ad set&apos;s own (pick &ldquo;New ad set&rdquo; to set a different one)</span>
                  </>
                ) : (
                  <span className="text-faint">This ad set doesn&apos;t optimize for a pixel event.</span>
                )}
              </p>
            )}
            <label className="grid gap-1 text-[11px] text-faint">
              Each ad reports website events to
              <select value={(edits.trackingPixel !== undefined ? edits.trackingPixel : p.trackingPixel) ?? ""} onChange={(e) => setEdits((x) => ({ ...x, trackingPixel: e.target.value || null }))} className={field}>
                <option value="">Meta&apos;s default</option>
                {(p.options.pixels ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {firedAgo(x.lastFired)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-faint">
              UTM parameters
              <input value={edits.urlTags ?? p.urlTags ?? ""} onChange={(e) => setEdits((x) => ({ ...x, urlTags: e.target.value }))} placeholder="None" className={`${field} font-mono text-[12px]`} />
            </label>
          </div>
        </div>
      )}

      {l.checks.length > 0 && !busy && l.status !== "launched" && (
        <ul className="relative grid gap-1.5">
          {l.checks.map((c) => (
            <li key={c.key} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-sm">
              <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ${TONE[c.level].dot}`}>{TONE[c.level].icon}</span>
              <span className={TONE[c.level].text}>
                <span className="font-medium text-fg">{c.label}</span> · {c.detail}
                {c.level === "block" && (c.key === "goal" || c.key === "event") && p?.locked && l.canLaunch && (
                  <button
                    type="button"
                    onClick={() => recheck(`${c.key}:${c.key === "goal" ? p.locked!.objective : (p.locked!.event ?? "none")}`)}
                    disabled={pending}
                    className="ml-2 inline-flex h-7 items-center rounded-full border border-line px-2.5 text-xs text-muted hover:text-fg disabled:opacity-60 max-md:mt-1.5 max-md:h-10"
                  >
                    It&apos;s meant this way
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {l.status === "failed" && l.error && <p className="relative rounded-[10px] bg-bad/10 px-3 py-2 text-sm text-bad">{l.error}</p>}

      {p?.locked && !busy && l.status !== "launched" && (
        <Locked
          locked={p.locked}
          checks={l.checks}
          signed={l.signed}
          signoff={l.signoff}
          ticked={ticked === p.locked.fingerprint}
          onTick={(v) => setTicked(v ? p.locked!.fingerprint : null)}
          canSign={l.status === "ready" && l.canLaunch && !dirty}
        />
      )}

      {!busy && l.status !== "launched" && (
        <div className="relative flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {confirm ? (
            <span className="flex flex-wrap items-center gap-2 text-sm max-md:w-full">
              <span className="max-md:basis-full">
                {p?.dynamic?.adId
                  ? `Add ${p.ads.length === 1 ? "this design" : `these ${p.ads.length} designs`} and the copy to "${p.dynamic.adName}"${p.dynamic.status === "ACTIVE" ? ", which is on: the new mix serves once Meta approves it" : ""}?`
                  : `Create ${p?.dynamic ? "1 dynamic ad" : `${p?.ads.length} ${p?.ads.length === 1 ? "ad" : "ads"}`} paused in ${l.sandbox ? "Kaizen's sandbox account" : "the client's ad account"}?`}
              </span>
              <button type="button" onClick={launch} disabled={pending} className="h-9 rounded-full bg-[#0866ff] px-4 text-sm font-medium text-white disabled:opacity-60 max-md:h-12 max-md:flex-1">
                {p?.dynamic?.adId ? "Yes, update the ad" : "Yes, launch paused"}
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="h-9 px-2 text-sm text-faint hover:text-fg max-md:h-12 max-md:px-4">
                Not yet
              </button>
            </span>
          ) : (
            <>
              {l.status === "ready" && !dirty && l.canLaunch && (
                <button type="button" onClick={() => setConfirm(true)} disabled={!l.signed && ticked !== p?.locked?.fingerprint} title={!l.signed && ticked !== p?.locked?.fingerprint ? "Sign off the locked settings first" : undefined} className="h-10 rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(8,102,255,0.9)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none max-md:h-12 max-md:w-full">
                  {p?.dynamic?.adId ? `Add to "${p.dynamic.adName}"` : p?.dynamic ? "Launch 1 dynamic ad paused" : `Launch ${p?.ads.length} ${p?.ads.length === 1 ? "ad" : "ads"} paused`}
                </button>
              )}
              {(dirty || l.status !== "ready") && (
                <button type="button" onClick={() => recheck()} disabled={pending} className={`h-10 rounded-full px-5 text-sm font-medium disabled:opacity-60 max-md:h-11 max-md:w-full ${dirty ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                  {pending ? "Checking…" : dirty ? "Check with these changes" : "Check again"}
                </button>
              )}
              {noAdset && l.sandbox && isExec && (
                <button type="button" onClick={() => run(async () => { const r = await sandboxCampaign(l.id); if (!r.ok) setError(r.error); else setL(await loadLaunch(l.id)); })} disabled={pending} className="h-10 rounded-full border border-warn/40 px-4 text-sm text-warn hover:bg-warn/10 disabled:opacity-60 max-md:h-auto max-md:min-h-11 max-md:w-full max-md:py-2">
                  Create a paused test campaign in the sandbox
                </button>
              )}
              {!l.canLaunch && <span className="text-xs text-faint">The client&apos;s Meta buyer, the Head of Meta or an exec launches.</span>}
            </>
          )}
          {error && <span className="text-sm text-bad">{error}</span>}
        </div>
      )}
    </section>
  );
}

const OBJ = (o: string) => o.replace(/^OUTCOME_/, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/**
 * What Meta locks once the ad set is published, laid out for a human to sign off: the client's goal, the campaign's
 * objective, the pixel, the conversion event, attribution and the budget, each with how it checked.
 */
function Locked({ locked, checks, signed, signoff, ticked, onTick, canSign }: { locked: NonNullable<NonNullable<LaunchView["plan"]>["locked"]>; checks: LaunchCheck[]; signed: boolean; signoff: LaunchView["signoff"]; ticked: boolean; onTick: (v: boolean) => void; canSign: boolean }) {
  const level = (key: string) => checks.find((c) => c.key === key)?.level ?? "ok";
  const rows: { label: string; value: string; key: string | null }[] = [
    { label: "Client's goal", value: locked.goal ? `${locked.goal === "sales" ? "Sales" : "Leads"} (KPI: ${locked.conversion})` : (locked.conversion ?? "Not set"), key: "goal" },
    { label: "Campaign objective", value: `${OBJ(locked.objective)} · ${locked.campaign}`, key: "goal" },
    { label: locked.mode === "clone" ? "New ad set" : "Ad set", value: locked.adset, key: null },
    { label: "Pixel", value: locked.pixel ?? "None", key: "pixel" },
    { label: "Conversion event", value: locked.event ? OBJ(locked.event) : "None", key: "event" },
    { label: "Attribution", value: locked.attribution ?? "Unknown", key: "attribution" },
    { label: "Budget", value: locked.budget, key: "budget" },
  ];
  const at = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className={`relative grid gap-3 rounded-[16px] border p-4 ${signed ? "border-ok/30 bg-ok/[0.04]" : "border-[#0866ff]/30 bg-[#0866ff]/[0.05]"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7aa7ff]">Locked once published</p>
        <p className="text-[11px] text-faint">Meta won&apos;t let these change after the ad set goes out</p>
      </div>
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {rows.map((x, i) => {
          const lv = x.key ? level(x.key) : "ok";
          return (
            <div key={i} className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-2.5">
              <span className={`mt-1.5 h-2 w-2 rounded-full ${lv === "block" ? "bg-bad" : lv === "warn" ? "bg-warn" : "bg-ok"}`} />
              <span className="grid min-w-0">
                <dt className="text-[11px] text-faint">{x.label}</dt>
                <dd className={`truncate text-sm ${lv === "block" ? "text-bad" : "text-fg"}`} title={x.value}>{x.value}</dd>
              </span>
            </div>
          );
        })}
      </dl>
      {signed ? (
        <p className="flex items-center gap-2 text-sm text-ok">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-ok/15 text-[11px]">✓</span>
          {signoff?.fingerprint === locked.fingerprint ? `Signed off by ${signoff.name}, ${at(signoff.at)}` : locked.remembered ? `Signed off for this ad set by ${locked.remembered.by}, ${at(locked.remembered.at)}: same settings, so it goes on its own` : "Signed off"}
        </p>
      ) : canSign ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-[12px] bg-bg/60 px-3 py-3 text-sm max-md:min-h-12">
          <input type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#0866ff]" />
          <span>I&apos;ve checked the objective, pixel, event and attribution are right for this client. Nothing is created until I launch.</span>
        </label>
      ) : (
        <p className="text-xs text-faint">A buyer signs these off before anything is created.</p>
      )}
    </div>
  );
}
