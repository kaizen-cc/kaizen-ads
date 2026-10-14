"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Section } from "@/components/ui";

type Result = { ok: true } | { ok: false; error: string };

// What the AI really does on a refresh, in order
const WORK = [
  "Reading messages in Slack",
  "Reading client emails",
  "Checking Drive for new files",
  "Pulling the latest from Meta",
  "Looking back at past requests",
  "Cross-checking client memory",
  "Comparing this week's ads to last week's",
  "Writing the briefing",
];

// A couple of these get shuffled in each time
const JOKES = [
  "Grabbing a quick coffee (jk)",
  "Asking the algorithm nicely",
  "Untangling FINAL_final_v3.mp4",
  "Bribing the pixel",
  "Checking if the hook actually hooks",
  "Skipping the 'quick question' threads",
  "Arguing with the attribution window",
  "Pretending the CPM didn't just go up",
  "Reading the room (and the Slack)",
  "Telling the frequency to calm down",
];

const STEP_MS = 2400;

function plan() {
  const jokes = [...JOKES].sort(() => Math.random() - 0.5).slice(0, 2 + Math.round(Math.random()));
  const steps = [...WORK];
  // Jokes go between real steps, never first or last
  for (const j of jokes) steps.splice(1 + Math.floor(Math.random() * (steps.length - 2)), 0, j);
  return steps.map((text) => ({ text, joke: JOKES.includes(text) }));
}

/** The briefing card, with a refresh that shows the AI working through each source while it runs. */
export function BriefingPanel({
  description,
  refresh,
  demo = false,
  children,
}: {
  description: React.ReactNode;
  refresh: () => Promise<Result>;
  demo?: boolean;
  children: React.ReactNode;
}) {
  const [steps, setSteps] = useState<{ text: string; joke: boolean }[] | null>(null);
  const [at, setAt] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const run = () => {
    const p = plan();
    setSteps(p);
    setAt(0);
    setFinished(false);
    setError(null);
    // Walk the steps while the AI works; hold on the last one until it's actually done
    timer.current = setInterval(() => setAt((i) => Math.min(i + 1, p.length - 1)), STEP_MS);
    start(async () => {
      const res = demo ? await new Promise<Result>((r) => setTimeout(() => r({ ok: true }), STEP_MS * 9)) : await refresh();
      if (timer.current) clearInterval(timer.current);
      if (!res.ok) {
        setError(res.error);
        setSteps(null);
        return;
      }
      setAt(p.length);
      setFinished(true);
      setTimeout(() => setSteps(null), 900); // the page has the new briefing by now (the action revalidates it)
    });
  };

  const busy = steps !== null;
  const progress = !steps ? 0 : finished ? 100 : Math.min(94, ((at + 0.6) / steps.length) * 100);

  return (
    <Section
      title="Briefing"
      description={description}
      action={
        <button
          onClick={run}
          disabled={busy}
          className="h-8 rounded-full border border-line px-3.5 text-xs text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50"
        >
          {busy ? "Refreshing…" : "Refresh now"}
        </button>
      }
    >
      {error && <p className="rounded-[8px] border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">Couldn&apos;t refresh: {error}</p>}

      {busy ? (
        <div className="grid gap-6 py-2 animate-[sheet-fade_.3s_ease-out]" role="status" aria-live="polite">
          <div className="grid gap-2.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">{finished ? "Done" : "Analyzing"}</span>
              <span className="tabular text-faint">{Math.round(progress)}%</span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out ${finished ? "bg-ok" : "bg-gradient-to-r from-brand to-brand-text"}`}
                style={{ width: `${progress}%` }}
              />
              {!finished && <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent animate-[ai-sweep_1.6s_ease-in-out_infinite]" />}
            </div>
          </div>

          <ol className="grid gap-3">
            {steps.map((s, i) => {
              const state = finished || i < at ? "done" : i === at ? "now" : "later";
              // Show what's done, what's happening, and a peek at what's next
              if (state === "later" && i > at + 1) return null;
              return (
                <li
                  key={s.text}
                  className={`flex items-center gap-3 text-sm transition-opacity duration-500 animate-[step-in_.35s_ease-out] ${state === "later" ? "opacity-30" : ""}`}
                >
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] ${
                      state === "done" ? "bg-ok/15 text-ok" : state === "now" ? "border-2 border-brand-text/30 border-t-brand-text animate-spin" : "border border-line"
                    }`}
                  >
                    {state === "done" ? "✓" : ""}
                  </span>
                  <span className={state === "now" ? "text-fg" : s.joke ? "italic text-faint" : "text-muted"}>
                    {s.text}
                    {state === "now" && "…"}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="grid min-w-0 gap-5 [overflow-wrap:anywhere] animate-[sheet-fade_.4s_ease-out]">{children}</div>
      )}
    </Section>
  );
}
