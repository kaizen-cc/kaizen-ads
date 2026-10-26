"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LaunchCheck } from "@/lib/launcher";
import { LaunchMove } from "./launch-move";
import { confirmLaunch, discardLaunch, launchFor, loadLaunch, replanLaunch, sandboxCampaign, startLaunch, type LaunchView } from "./launch-actions";

// Launch to Meta, on a ticket in Ready to launch. Kaizen Ads launches it on its own when the ticket gets here (the
// Media Buyer picks the ad set and names, Kaizen's checks and Meta's dry run, then the ads are created paused) and
// hands the ticket to the buyer to turn them on; the ticket completes itself once Meta shows them on. This panel shows
// how that went, and when something stopped it, it's where the buyer adjusts and launches by hand.

const field = "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-[#0866ff]/60";
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
  const [pending, start] = useTransition();
  // The buyer's edits, sent with "Check again"
  const [edits, setEdits] = useState<{ adsetId?: string; mode?: "existing" | "clone"; newAdsetName?: string; pageId?: string; igId?: string | null; link?: string; names: Record<string, string> }>({ names: {} });
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
  const recheck = () =>
    run(async () => {
      if (!l) return;
      const p = l.plan;
      const r = await replanLaunch(l.id, {
        adsetId: edits.adsetId ?? p?.adsetId,
        mode: edits.mode ?? p?.mode,
        newAdsetName: edits.newAdsetName ?? p?.newAdsetName ?? undefined,
        pageId: edits.pageId ?? p?.pageId ?? undefined,
        igId: edits.igId !== undefined ? edits.igId : (p?.igId ?? null),
        link: edits.link ?? p?.link ?? undefined,
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
      const r = await confirmLaunch(l.id);
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
      <section className="relative grid gap-4 overflow-hidden rounded-[18px] border border-[#0866ff]/30 bg-gradient-to-br from-[#0866ff]/[0.09] via-transparent to-transparent p-5">
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
          <button type="button" onClick={plan} disabled={pending} className="text-xs text-faint underline-offset-2 hover:text-fg hover:underline disabled:opacity-60">
            {pending ? "Starting…" : "Start it now"}
          </button>
          {error && <span className="text-sm text-bad">{error}</span>}
        </div>
      </section>
    );

  const p = l.plan;
  const adset = p?.options.adsets.find((a) => a.id === (edits.adsetId ?? p.adsetId));
  const mode = edits.mode ?? p?.mode ?? "existing";
  const dirty = Boolean(edits.adsetId || edits.mode || edits.newAdsetName !== undefined || edits.pageId || edits.igId !== undefined || edits.link !== undefined || Object.keys(edits.names).length);
  const blocks = l.checks.filter((c) => c.level === "block");
  const noAdset = l.checks.some((c) => c.key === "adset" && c.level === "block" && !p?.options.adsets.length);

  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[18px] border border-[#0866ff]/30 bg-gradient-to-br from-[#0866ff]/[0.07] via-transparent to-transparent p-5">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[#0866ff]/15 blur-[70px]" />
      <header className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7aa7ff]">
            Launch to Meta
            {l.sandbox && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-warn">Sandbox test</span>}
          </p>
          <p className="font-heading text-lg">
            {l.status === "launched"
              ? "Launched, paused: turn it on"
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
          <button type="button" onClick={() => run(async () => (await discardLaunch(l.id), setL(null)))} className="text-xs text-faint hover:text-fg">
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
          <ul className="grid gap-1.5">
            {l.result.ads.map((a) => (
              <li key={a.designId} className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-bg/40 px-3.5 py-2.5 text-sm">
                <span className="truncate">{a.name}</span>
                <span className={`shrink-0 text-xs ${a.adId ? "text-ok" : "text-bad"}`}>{a.adId ? "✓ created, paused" : `× ${a.error}`}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {l.result.link && (
              <a href={l.result.link} target="_blank" rel="noreferrer" className="h-10 content-center rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white hover:brightness-110">
                Open in Ads Manager ↗
              </a>
            )}
            <p className="text-xs text-faint">
              {l.sandbox ? "A test in Kaizen's account: the ticket stays in Ready to launch." : "QA them in Ads Manager and turn them on there: this ticket moves to Launched by itself once Meta shows them on."}
              {l.launchedBy ? ` Launched by ${l.launchedBy}.` : ""}
            </p>
          </div>
          <LaunchMove l={l} onDone={() => void loadLaunch(l.id).then((x) => x && setL(x))} />
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
                  <button key={m} type="button" onClick={() => setEdits((x) => ({ ...x, mode: m }))} className={`h-8 rounded-full px-3 text-xs transition-colors ${mode === m ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
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

          {p.ads.length > 0 && (
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">
                {p.ads.length} {p.ads.length === 1 ? "ad" : "ads"} · copy stacked ({p.copy.bodies.length} texts, {p.copy.titles.length} headlines) · {p.cta.replace(/_/g, " ").toLowerCase()}
              </p>
              {p.ads.map((a) => (
                <div key={a.designId} className="grid gap-1.5 rounded-[12px] border border-line bg-bg/40 p-3">
                  <input value={edits.names[a.designId] ?? a.name} onChange={(e) => setEdits((x) => ({ ...x, names: { ...x.names, [a.designId]: e.target.value } }))} className={`${field} h-9`} aria-label={`Ad name for ${a.designName}`} />
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                    <span className="text-muted">{a.designName}</span>
                    {a.assets.map((x) => (
                      <span key={x.fileId} className="rounded-full bg-surface-2 px-2 py-px">
                        {x.aspect} {x.kind}
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

          <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
            Link
            <input value={edits.link ?? p.link ?? ""} onChange={(e) => setEdits((x) => ({ ...x, link: e.target.value }))} placeholder="https://" className={`${field} normal-case tracking-normal`} />
            {p.urlTags && <span className="normal-case tracking-normal text-faint">+ {p.urlTags}</span>}
          </label>
        </div>
      )}

      {l.checks.length > 0 && !busy && l.status !== "launched" && (
        <ul className="relative grid gap-1.5">
          {l.checks.map((c) => (
            <li key={c.key} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-sm">
              <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ${TONE[c.level].dot}`}>{TONE[c.level].icon}</span>
              <span className={TONE[c.level].text}>
                <span className="font-medium text-fg">{c.label}</span> · {c.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {l.status === "failed" && l.error && <p className="relative rounded-[10px] bg-bad/10 px-3 py-2 text-sm text-bad">{l.error}</p>}

      {!busy && l.status !== "launched" && (
        <div className="relative flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {confirm ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                Create {p?.ads.length} {p?.ads.length === 1 ? "ad" : "ads"} paused in {l.sandbox ? "Kaizen's sandbox account" : "the client's ad account"}?
              </span>
              <button type="button" onClick={launch} disabled={pending} className="h-9 rounded-full bg-[#0866ff] px-4 text-sm font-medium text-white disabled:opacity-60">
                Yes, launch paused
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="h-9 px-2 text-sm text-faint hover:text-fg">
                Not yet
              </button>
            </span>
          ) : (
            <>
              {l.status === "ready" && !dirty && l.canLaunch && (
                <button type="button" onClick={() => setConfirm(true)} className="h-10 rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(8,102,255,0.9)] hover:brightness-110">
                  Launch {p?.ads.length} {p?.ads.length === 1 ? "ad" : "ads"} paused
                </button>
              )}
              {(dirty || l.status !== "ready") && (
                <button type="button" onClick={recheck} disabled={pending} className={`h-10 rounded-full px-5 text-sm font-medium disabled:opacity-60 ${dirty ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                  {pending ? "Checking…" : dirty ? "Check with these changes" : "Check again"}
                </button>
              )}
              {noAdset && l.sandbox && isExec && (
                <button type="button" onClick={() => run(async () => { const r = await sandboxCampaign(l.id); if (!r.ok) setError(r.error); else setL(await loadLaunch(l.id)); })} disabled={pending} className="h-10 rounded-full border border-warn/40 px-4 text-sm text-warn hover:bg-warn/10 disabled:opacity-60">
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
