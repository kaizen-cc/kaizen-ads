"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Markdown } from "@/components/markdown";
import { buildGtmNow, markGtmReviewed } from "./gtm-actions";

export type GtmStrategy = {
  status: "waiting" | "building" | "draft" | "reviewed" | "failed";
  missing: string[];
  version: string;
  markdown: string;
  readThisFirst: string;
  openItems: { item: string; who: string }[];
  quality: { check: string; pass: boolean; note: string }[];
  error: string | null;
  startedAt: string | null;
  generatedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

const STEPS = [
  "Reading the intake form and call notes",
  "Scrubbing the website: offers, pricing, funnel",
  "Pulling real reviews, word for word",
  "Sizing up competitors on Meta",
  "Finding sourced Meta benchmarks",
  "Building the angles and ad copy",
  "Laying out the campaign structure",
  "Doing the breakeven CPA math",
  "Running the quality gate",
];
const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
const GATE = [
  { label: "The marketing intake form", key: "intake" },
  { label: "Notes from a call (access call, Ad Hawk or deep-dive)", key: "call" },
  { label: "The client's website", key: "website" },
];

/**
 * The client's Meta go-to-market strategy: written once the intake form, call notes and website are in (the hard
 * gate), every fact sourced, open items in plain sight. Its summary joins what every agent reads for this client.
 */
export function GtmPanel({ clientId, slug, gtm, canReview }: { clientId: string; slug: string; gtm: GtmStrategy | null; canReview: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  // A build older than 20 minutes didn't finish
  const [now] = useState(() => Date.now());
  const building = gtm?.status === "building" && gtm.startedAt && now - new Date(gtm.startedAt).getTime() < 20 * 60_000;

  useEffect(() => {
    if (!building) return;
    const poll = setInterval(() => router.refresh(), 8000);
    const tick = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 7000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [building, router]);

  const build = () =>
    start(async () => {
      setError(null);
      const r = await buildGtmNow(clientId, slug);
      if (!r.ok) setError(r.error);
      router.refresh();
    });

  const has = Boolean(gtm?.markdown);
  const failing = (gtm?.quality ?? []).filter((q) => !q.pass);
  const missing = gtm?.status === "waiting" ? gtm.missing : [];

  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[12px] border border-line bg-surface p-6">
      <span aria-hidden className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-brand opacity-[0.08] blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-[17px]">Meta go-to-market strategy</h2>
            {gtm?.status === "reviewed" && <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11px] text-ok">Reviewed · every agent reads it</span>}
            {gtm?.status === "draft" && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-[11px] text-warn">Draft · agents read it as a draft until it&apos;s reviewed</span>}
            {has && gtm && <span className="text-[11px] text-faint">{gtm.version}{gtm.generatedAt && ` · ${fmt(gtm.generatedAt)}`}</span>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {has
              ? "Business, customer, competitors on Meta, angles with ad copy, the campaign plan and the 90-day profitability roadmap. Every fact sourced."
              : "Written at onboarding once the intake form, call notes and website are in. Every fact is sourced; nothing is invented."}
          </p>
        </div>
        {!building && (
          <button onClick={build} disabled={busy} className="h-9 shrink-0 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:text-fg disabled:opacity-50">
            {busy ? "Starting…" : has ? "Update" : "Build it now"}
          </button>
        )}
      </div>

      {building ? (
        <div className="relative grid gap-3 rounded-[12px] border border-line bg-bg p-5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
          </div>
          <p className="text-sm">{STEPS[step]}…</p>
          <p className="text-xs text-faint">Research and writing take several minutes. You can leave the page; it keeps going.</p>
        </div>
      ) : !has ? (
        <div className="relative grid gap-2 rounded-[12px] border border-line bg-bg p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Before it can be written</p>
          <ul className="grid gap-1.5 text-sm">
            {GATE.map((g) => {
              const known = gtm?.status === "waiting";
              const miss = missing.some((m) => m.includes(g.key));
              return (
                <li key={g.key} className="flex items-center gap-2">
                  <span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${!known ? "bg-surface-2 text-faint" : miss ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}>{!known ? "·" : miss ? "!" : "✓"}</span>
                  <span className={known && miss ? "text-fg" : "text-muted"}>{g.label}</span>
                  {known && miss && <span className="text-[11px] text-warn">missing</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-faint">It builds by itself the hour all three are in.</p>
        </div>
      ) : null}

      {(error || (gtm?.error && !building)) && <p className="relative text-xs text-bad">{error ?? gtm?.error}</p>}

      {has && gtm && !building && (
        <div className="relative grid gap-4">
          <div className="rounded-[12px] border border-line bg-bg p-5">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">What every agent reads</p>
            <Markdown text={gtm.readThisFirst} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {gtm.openItems.length > 0 && (
              <div className="rounded-[12px] border border-warn/30 bg-warn-soft/40 p-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-warn">Open items · {gtm.openItems.length}</p>
                <ul className="grid gap-1.5 text-xs leading-relaxed text-muted">
                  {gtm.openItems.map((q, i) => (
                    <li key={i}>
                      {q.item} <span className="text-faint">· {q.who}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {gtm.quality.length > 0 && (
              <div className="rounded-[12px] border border-line p-4">
                <p className={`mb-2 text-[11px] font-medium uppercase tracking-[0.12em] ${failing.length ? "text-bad" : "text-ok"}`}>
                  Quality gate · {failing.length ? `${failing.length} not passing` : "all passing"}
                </p>
                <ul className="grid gap-1.5 text-xs leading-relaxed">
                  {gtm.quality.map((q, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={q.pass ? "text-ok" : "text-bad"}>{q.pass ? "✓" : "✕"}</span>
                      <span className="text-muted">
                        {q.check}
                        {!q.pass && q.note && <span className="block text-faint">{q.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setOpen((o) => !o)} className="h-9 rounded-full bg-fg px-4 text-sm text-bg">
              {open ? "Hide the strategy" : "Open the full strategy"}
            </button>
            {canReview && gtm.status === "draft" && (
              <button
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    const r = await markGtmReviewed(clientId, slug);
                    if (r.ok) router.refresh();
                    else setError(r.error);
                  })
                }
                className="h-9 rounded-full bg-ok px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                Mark reviewed
              </button>
            )}
            {gtm.status === "reviewed" && gtm.reviewedBy && <span className="text-xs text-faint">Reviewed by {gtm.reviewedBy}{gtm.reviewedAt && ` on ${fmt(gtm.reviewedAt)}`}</span>}
          </div>
          {open && (
            <div className="max-h-[900px] overflow-y-auto rounded-[12px] border border-line bg-bg p-6">
              <Markdown text={gtm.markdown} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
