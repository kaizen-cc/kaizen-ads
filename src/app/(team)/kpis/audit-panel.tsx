"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { startAudit } from "./audit-actions";

export type AuditSummary = {
  id: string;
  status: "running" | "ready" | "failed";
  progress: number;
  step: string | null;
  createdAt: string;
  by: string | null;
  verdict: { status: "off" | "at_risk" | "on_track" | "winning"; headline: string; summary: string } | null;
  actions: number;
  done: number;
  error: string | null;
} | null;

export const VERDICT: Record<string, { label: string; tone: string; ring: string }> = {
  off: { label: "Off target", tone: "text-bad", ring: "border-bad/40 bg-bad-soft" },
  at_risk: { label: "At risk", tone: "text-warn", ring: "border-warn/40 bg-warn-soft" },
  on_track: { label: "On track", tone: "text-ok", ring: "border-ok/40 bg-ok-soft" },
  winning: { label: "Winning", tone: "text-ok", ring: "border-ok/40 bg-ok-soft" },
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The account audit on a KPI card: start one, follow it while it runs, then the verdict and the way into the full audit. */
export function AuditPanel({ targetId, audit, platform }: { targetId: string; audit: AuditSummary; platform: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const running = audit?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [running, router]);
  if (platform !== "meta") return null;

  const go = () =>
    start(async () => {
      setError(null);
      const r = await startAudit(targetId);
      if ("error" in r) setError(r.error);
      router.refresh();
    });
  const button = (label: string, primary = false) => (
    <button
      type="button"
      onClick={go}
      disabled={pending || running}
      className={`h-9 shrink-0 rounded-full px-4 text-sm transition-colors disabled:opacity-60 ${primary ? "bg-fg text-bg hover:bg-fg/90" : "border border-line text-muted hover:text-fg"}`}
    >
      {pending ? "Starting…" : label}
    </button>
  );

  return (
    <div className="relative overflow-hidden rounded-[16px] border border-line bg-surface">
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-brand/15 blur-[80px]" />
      <div className="relative grid gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">AI account audit</p>
            {!audit && <p className="font-heading text-lg">Why is it here, and what should the buyer do?</p>}
            {audit?.status === "ready" && audit.verdict && <p className="font-heading text-lg leading-snug">{audit.verdict.headline}</p>}
            {audit?.status === "failed" && <p className="font-heading text-lg">The last audit didn&apos;t finish</p>}
            {running && <p className="font-heading text-lg">Auditing the account…</p>}
          </div>
          {!audit && button("Audit this account", true)}
          {audit?.status === "ready" && (
            <div className="flex gap-2">
              {button("Run again")}
              <Link href={`/kpis/audit/${audit.id}`} className="grid h-9 place-items-center rounded-full bg-fg px-4 text-sm text-bg hover:bg-fg/90">
                Open the audit →
              </Link>
            </div>
          )}
          {audit?.status === "failed" && button("Try again", true)}
        </div>

        {!audit && (
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            Scrubs 90 days of the account by campaign, ad set and ad, its live setup in Meta (objectives, budgets, bidding, learning, audiences, placements), the funnel, tiring ads, the
            client&apos;s Brand Bible and strategy, the sub-vertical playbook and benchmarks, our Hall of Fame and the market. Then it writes the diagnosis and the action plan. A few
            minutes.
          </p>
        )}

        {running && (
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-muted">{audit.step ?? "Working"}</span>
              <span className="font-display text-xl tabular">{audit.progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div className="relative h-full rounded-full bg-brand transition-[width] duration-1000 ease-out" style={{ width: `${Math.max(3, audit.progress)}%` }}>
                <span className="absolute inset-0 animate-pulse rounded-full bg-white/25" />
              </div>
            </div>
            <p className="text-[11px] text-faint">It keeps going on the server if you leave or refresh.</p>
          </div>
        )}

        {audit?.status === "ready" && audit.verdict && (
          <div className="grid gap-3">
            <p className="max-w-3xl text-sm leading-relaxed text-muted">{audit.verdict.summary}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-full border px-2.5 py-1 ${VERDICT[audit.verdict.status]?.ring} ${VERDICT[audit.verdict.status]?.tone}`}>{VERDICT[audit.verdict.status]?.label}</span>
              <span className="rounded-full border border-line px-2.5 py-1 text-muted">
                <span className="tabular text-fg">{audit.done}</span> of <span className="tabular">{audit.actions}</span> actions done
              </span>
              <span className="text-faint">
                {when(audit.createdAt)}
                {audit.by ? ` · run by ${audit.by}` : ""}
              </span>
            </div>
          </div>
        )}
        {audit?.status === "failed" && <p className="text-sm text-bad">{audit.error}</p>}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </div>
  );
}
