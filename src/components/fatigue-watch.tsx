"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { WatchRow } from "@/lib/fatigue";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import { briefRefresh, dismissFatigue } from "@/app/(team)/fatigue/actions";

// The fatigue watcher's list: each ad against its own last three weeks. Refresh it (the strategist writes the brief
// right here) or dismiss it with a reason. Used on Home and on the client page.

const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const pct = (x: number | null) => (x == null ? null : `${x > 0 ? "+" : "−"}${Math.round(Math.abs(x) * 100)}%`);
const REASONS = ["Planned rotation", "Seasonal dip", "Already replaced", "Testing on purpose", "Not worth refreshing"];

export function FatigueWatch({ rows, showClient = true, title = "Ads wearing out", empty, bare = false }: { rows: WatchRow[]; showClient?: boolean; title?: string; empty?: string; bare?: boolean }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const shown = rows.filter((r) => !hidden.includes(`${r.clientId}:${r.adId}`));
  const tired = shown.filter((r) => r.severity === "tired" && r.state === "open").length;
  if (!shown.length && !empty) return null;
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {!bare && (
          <h2 className="font-heading text-xl">
            {title} {shown.length > 0 && <span className="text-faint">{shown.length}</span>}
          </h2>
        )}
        <span className="text-xs text-faint">{tired ? `${tired} ready to replace · ` : ""}each ad against its own last three weeks, after every Meta sync</span>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-[14px] border border-line bg-surface px-5 py-4 text-sm text-muted">{empty}</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((r) => (
            <WatchCard key={`${r.clientId}:${r.adId}`} r={r} showClient={showClient} onGone={() => setHidden((h) => [...h, `${r.clientId}:${r.adId}`])} />
          ))}
        </div>
      )}
    </section>
  );
}

function WatchCard({ r, showClient, onGone }: { r: WatchRow; showClient: boolean; onGone: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "writing" | "dismiss">("idle");
  // The refresh brief is a place of its own (?refresh=id): back closes it, forward opens it again
  const [written, setWritten] = useState<OpenSuggestion | null>(null);
  const briefId = useParam("refresh");
  const brief = written && written.id === briefId ? written : null;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const s = r.signals;
  const tired = r.severity === "tired";

  const refresh = async () => {
    setError(null);
    setStep("writing");
    const res = await briefRefresh(r.clientId, r.adId);
    setStep("idle");
    if (!res.ok) return setError(res.error);
    setWritten(res.suggestion);
    pushParams({ refresh: res.suggestion.id });
  };
  const dismiss = async () => {
    const res = await dismissFatigue(r.clientId, r.adId, reason);
    if (!res.ok) return setError(res.error);
    onGone();
  };

  const chips = [
    s.ctrChange <= -0.05 && { label: "CTR", from: `${s.ctrBefore.toFixed(2)}%`, to: `${s.ctrNow.toFixed(2)}%`, change: pct(s.ctrChange), bad: s.ctrChange <= -0.2 },
    s.cprChange != null && s.cprChange >= 0.05 && { label: `Cost per ${s.result ?? "result"}`, from: money(s.cprBefore), to: money(s.cprNow), change: pct(s.cprChange), bad: s.cprChange >= 0.25 },
    s.results7 === 0 && s.spend7 > 0 && { label: `${s.result ?? "Results"} this week`, from: null, to: "none", change: `${money(s.spend7)} spent`, bad: true },
    s.hookChange != null && s.hookChange <= -0.1 && { label: "Hook rate", from: `${s.hookBefore}%`, to: `${s.hookNow}%`, change: pct(s.hookChange), bad: s.hookChange <= -0.25 },
    s.freqBefore > 0 && s.freqNow / s.freqBefore >= 1.1 && { label: "Frequency", from: s.freqBefore.toFixed(2), to: s.freqNow.toFixed(2), change: pct(s.freqNow / s.freqBefore - 1), bad: false },
  ].filter(Boolean) as { label: string; from: string | null; to: string; change: string | null; bad: boolean }[];

  return (
    <article className={`grid content-start gap-3 rounded-[16px] border bg-surface p-4 ${tired && r.state === "open" ? "border-bad/35" : "border-line"}`}>
      <div className="flex gap-3">
        <span className="relative h-20 w-16 shrink-0 overflow-hidden rounded-[10px] bg-surface-2">
          {r.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
        </span>
        <div className="grid min-w-0 flex-1 content-start gap-1">
          <span className="flex flex-wrap items-center gap-2">
            {r.state === "refreshing" ? (
              <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">Being refreshed</span>
            ) : (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tired ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{tired ? "Tired: replace it" : "Tiring"}</span>
            )}
            {showClient && (
              <Link href={`/clients/${r.clientSlug}`} className="text-xs text-muted hover:text-fg">
                {r.client}
              </Link>
            )}
          </span>
          <p className="line-clamp-2 text-sm font-medium leading-snug">{r.headline ?? r.adName}</p>
          <p className="truncate text-[11px] text-faint" title={r.adName}>
            {r.adName} · {s.daysRunning} days running · {money(s.spend7)} this week
          </p>
        </div>
        <Spark series={r.series} />
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c.label} className="flex items-baseline gap-1.5 rounded-[8px] bg-bg/60 px-2.5 py-1.5 text-[11px]">
              <span className="text-faint">{c.label}</span>
              {c.from && <span className="tabular text-muted">{c.from} →</span>}
              <span className="tabular text-fg">{c.to}</span>
              {c.change && <span className={`tabular ${c.bad ? "text-bad" : "text-warn"}`}>{c.change}</span>}
            </span>
          ))}
          {s.accountCprChange != null && Math.abs(s.accountCprChange) >= 0.1 && (
            <span className="rounded-[8px] px-2 py-1.5 text-[11px] text-faint">Account overall {pct(s.accountCprChange)} (already allowed for)</span>
          )}
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}

      {r.state === "refreshing" ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Replacement in the works:
          {r.requestNumbers.map((n) => (
            <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 py-0.5 hover:border-faint">
              #{n}
            </Link>
          ))}
        </p>
      ) : step === "dismiss" ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((x) => (
              <button key={x} onClick={() => setReason(x)} className={`h-7 rounded-full px-3 text-xs ${reason === x ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                {x}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={dismiss} disabled={!reason.trim()} className="h-8 rounded-brand bg-fg px-3 text-xs text-bg disabled:opacity-40">
              Take it off the list
            </button>
            <button onClick={() => setStep("idle")} className="h-8 px-2 text-xs text-faint">
              Back
            </button>
          </div>
          <p className="text-[11px] text-faint">It comes back only if it goes from tiring to tired.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={refresh} disabled={step === "writing"} className="h-11 rounded-brand bg-fg px-4 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-70 md:h-9">
            {step === "writing" ? r.briefId ? "Opening…" : <Writing /> : r.briefId ? "Open the brief" : "Brief a refresh"}
          </button>
          {r.briefId && step !== "writing" && <span className="text-[11px] text-ok">Brief ready</span>}
          <button onClick={() => setStep("dismiss")} disabled={step === "writing"} className="h-9 px-3 text-sm text-faint hover:text-fg">
            Dismiss
          </button>
        </div>
      )}

      {brief && (
        <SuggestionSheet
          s={brief}
          onClose={() => closeThen(() => router.refresh(), "refresh")}
        />
      )}
    </article>
  );
}

function Writing() {
  const steps = ["Reading the ad and its numbers…", "Keeping what worked…", "Changing what's tired…", "Fitting the allotment…"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(steps.length - 1, n + 1)), 8000);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      {steps[i]}
    </span>
  );
}

/** Cost per result over the last four weeks (or CTR when there are no results), with this week shaded. */
function Spark({ series }: { series: WatchRow["series"] }) {
  const useCpr = series.filter((p) => p.cpr != null).length >= series.length / 2;
  const pts = series.map((p) => (useCpr ? p.cpr : p.ctr));
  const known = pts.filter((v): v is number => v != null);
  if (known.length < 4) return null;
  const w = 96;
  const h = 40;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * w;
  const y = (v: number) => h - 4 - ((v - min) / Math.max(1e-9, max - min)) * (h - 8);
  const line = pts.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
  const weekX = x(Math.max(0, pts.length - 7));
  return (
    <span className="hidden shrink-0 sm:grid" title={useCpr ? "Cost per result, last 4 weeks" : "Click-through rate, last 4 weeks"}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <rect x={weekX} y="0" width={w - weekX} height={h} fill="var(--bad)" opacity="0.08" rx="3" />
        <polyline points={line} fill="none" stroke={useCpr ? "var(--bad)" : "var(--warn)"} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="text-right text-[9px] text-faint">{useCpr ? "cost per result" : "CTR"} · 4 wks</span>
    </span>
  );
}
