"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Markdown } from "@/components/markdown";
import { buildBrandBible, markBrandBibleReviewed } from "./brand-bible-actions";

export type BrandBible = {
  status: "building" | "draft" | "reviewed" | "failed";
  version: string;
  markdown: string;
  readThisFirst: string;
  teamNotes: string[];
  openQuestions: { question: string; who: string }[];
  error: string | null;
  startedAt: string | null;
  generatedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  /** Living learnings: dated lessons from what their ads proved, added by the client playbook */
  learnings?: { at: string; kind: string; text: string }[];
};

const STEPS = [
  "Reading the website",
  "Pulling reviews, word for word",
  "Sizing up competitors",
  "Checking the rules for this category",
  "Mapping the year's marketing moments",
  "Writing audience profiles",
  "Building the claims table and review bank",
  "Writing Read this first",
];
const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

/**
 * The client's Brand Bible: built by the Brand bible builder (web research + everything Kaizen knows), reviewed
 * by the Head of Creative, then its "Read this first" feeds every agent working on this client.
 */
export function BrandBiblePanel({ clientId, slug, bible, canBuild }: { clientId: string; slug: string; bible: BrandBible | null; canBuild: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [pasted, setPasted] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  // A build older than 15 minutes didn't finish
  const [now] = useState(() => Date.now());
  const building = bible?.status === "building" && bible.startedAt && now - new Date(bible.startedAt).getTime() < 15 * 60_000;

  useEffect(() => {
    if (!building) return;
    const poll = setInterval(() => router.refresh(), 8000);
    const tick = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 6000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [building, router]);

  const build = () =>
    start(async () => {
      setError(null);
      const r = await buildBrandBible(clientId, slug, pasted);
      if (r.ok) {
        setComposing(false);
        router.refresh();
      } else setError(r.error);
    });

  const has = bible && bible.markdown;

  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[12px] border border-line bg-surface p-5 md:p-6">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#5b8def] opacity-[0.08] blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-[17px]">Brand Bible</h2>
            {bible?.status === "reviewed" && <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11px] text-ok">Reviewed · every agent reads it</span>}
            {bible?.status === "draft" && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-[11px] text-warn">Draft · waiting for the Head of Creative</span>}
            {has && <span className="text-[11px] text-faint">{bible.version}{bible.generatedAt && ` · ${fmt(bible.generatedAt)}`}</span>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {has
              ? "The client's foundation: audience profiles, voice, claims, reviews, look, competitors and calendar."
              : "Researches the website, reviews and competitors, then builds the foundation every agent and creative works from."}
          </p>
        </div>
        {canBuild && !building && !composing && (
          <button onClick={() => setComposing(true)} className="h-11 shrink-0 rounded-full border border-line px-4 text-sm md:h-9 text-muted transition-colors hover:text-fg">
            {has ? "Update" : "Build Brand Bible"}
          </button>
        )}
      </div>

      {building ? (
        <div className="relative grid gap-3 rounded-[12px] border border-line bg-bg p-5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
          </div>
          <p className="text-sm">{STEPS[step]}…</p>
          <p className="text-xs text-faint">This takes a few minutes. You can leave the page; it keeps going.</p>
        </div>
      ) : composing ? (
        <div className="relative grid gap-3 rounded-[12px] border border-line bg-bg p-5">
          <p className="text-sm">Anything the web can&apos;t see? <span className="text-muted">Paste the marketing intake form, sales call notes or transcript, brand guide text.</span></p>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={6}
            placeholder="Optional. The website, reviews, competitors, Slack, email, Drive and client memory are read automatically."
            className="min-w-0 rounded-[10px] border border-line bg-surface px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-brand-text/60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy} onClick={build} className="h-11 rounded-full bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 md:h-9">
              {busy ? "Starting…" : has ? "Update the Brand Bible" : "Build it"}
            </button>
            <button onClick={() => setComposing(false)} className="h-11 rounded-full px-3 text-sm text-muted hover:text-fg md:h-9">
              Cancel
            </button>
            <span className="text-xs text-faint">Runs on Opus with web research. A few minutes.</span>
          </div>
        </div>
      ) : null}

      {(error || (bible?.error && !building)) && <p className="relative text-xs text-bad">{error ?? bible?.error}</p>}

      {has && !building && (
        <div className="relative grid gap-4">
          <div className="min-w-0 rounded-[12px] border border-line bg-bg p-4 [overflow-wrap:anywhere] md:p-5">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Read this first</p>
            <Markdown text={bible.readThisFirst} />
          </div>

          {bible.learnings && bible.learnings.length > 0 && (
            <div className="min-w-0 rounded-[12px] border border-line bg-bg p-4 md:p-5">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">What their ads proved since</p>
              <p className="mb-3 text-xs text-faint">Kept current from the client playbook; newer than the Bible&apos;s text where they disagree.</p>
              <ul className="grid gap-2">
                {[...bible.learnings].reverse().slice(0, 12).map((l, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.kind === "avoid" ? "bg-bad" : "bg-ok"}`} />
                    <span className="min-w-0">
                      {l.text}
                      <span className="ml-1.5 text-[11px] text-faint">{l.at}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(bible.openQuestions.length > 0 || bible.teamNotes.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {bible.openQuestions.length > 0 && (
                <div className="rounded-[12px] border border-warn/30 bg-warn-soft/40 p-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-warn">Open questions</p>
                  <ul className="grid gap-1.5 text-xs leading-relaxed text-muted">
                    {bible.openQuestions.map((q, i) => (
                      <li key={i}>
                        {q.question} <span className="text-faint">· {q.who}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {bible.teamNotes.length > 0 && (
                <div className="rounded-[12px] border border-line p-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">For the team</p>
                  <ul className="grid gap-1.5 text-xs leading-relaxed text-muted">
                    {bible.teamNotes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setOpen((o) => !o)} className="h-11 rounded-full bg-fg px-4 text-sm text-bg md:h-9">
              {open ? "Hide the full Brand Bible" : "Open the full Brand Bible"}
            </button>
            {canBuild && bible.status === "draft" && (
              <button
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    const r = await markBrandBibleReviewed(clientId, slug);
                    if (r.ok) router.refresh();
                    else setError(r.error);
                  })
                }
                className="h-11 rounded-full bg-ok px-4 text-sm font-medium text-white disabled:opacity-50 md:h-9"
              >
                Mark reviewed
              </button>
            )}
            {bible.status === "reviewed" && bible.reviewedBy && <span className="text-xs text-faint">Reviewed by {bible.reviewedBy}{bible.reviewedAt && ` on ${fmt(bible.reviewedAt)}`}</span>}
          </div>
          {open && (
            <div className="max-h-[900px] min-w-0 overflow-y-auto rounded-[12px] border border-line bg-bg p-4 [overflow-wrap:anywhere] md:p-6">
              <Markdown text={bible.markdown} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
