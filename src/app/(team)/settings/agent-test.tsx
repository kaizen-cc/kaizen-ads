"use client";

import { useEffect, useState } from "react";
import type { EvalResult, EvalRow, Proposal } from "@/lib/agent-evals";
import { agentTest, testAgentChange } from "./learning-actions";

// "Test this change": before a change to an agent is saved, replay up to 8 of its recent real runs with the change and
// without it, and show the judge's verdicts side by side. Saving is never blocked; the result goes in the agent's history.

const VERDICT: Record<EvalResult["verdict"], { label: string; tone: string }> = {
  better: { label: "Better", tone: "bg-ok-soft text-ok" },
  same: { label: "Same", tone: "bg-surface-2 text-muted" },
  worse: { label: "Worse", tone: "bg-bad-soft text-bad" },
  error: { label: "Couldn't run", tone: "bg-warn-soft text-warn" },
};

/** Pretty JSON when it is JSON, the text as it is otherwise */
const pretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

/** A test's verdicts: the tally, then each replay with its two answers side by side */
export function EvalView({ e }: { e: EvalRow }) {
  const [open, setOpen] = useState<string | null>(null);
  if (e.status === "running")
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> Replaying recent runs with and without the change, then judging each pair. Usually a minute or two.
      </p>
    );
  if (e.status === "failed") return <p className="text-[13px] text-bad">The test failed: {e.error ?? "try again"}</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["better", "same", "worse"] as const).map((v) => (
          <span key={v} className={`tabular rounded-full px-2.5 py-1 text-[12px] font-medium ${VERDICT[v].tone}`}>
            {e[v]} {VERDICT[v].label.toLowerCase()}
          </span>
        ))}
      </div>
      {e.summary && <p className="text-[13px] leading-relaxed text-muted">{e.summary}</p>}
      {e.results.length > 0 && (
        <ul className="grid gap-1.5">
          {e.results.map((r) => (
            <li key={r.sampleId} className="rounded-[12px] border border-line bg-bg">
              <button type="button" onClick={() => setOpen(open === r.sampleId ? null : r.sampleId)} className="flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left">
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${VERDICT[r.verdict].tone}`}>{VERDICT[r.verdict].label}</span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-[13px]">{r.moment}</span>
                  <span className="text-[12px] text-muted [overflow-wrap:anywhere]">{r.why}</span>
                </span>
                <span className="shrink-0 text-[11px] text-faint">{open === r.sampleId ? "Hide" : "Compare"}</span>
              </button>
              {open === r.sampleId && (
                <div className="grid gap-3 border-t border-line p-3 md:grid-cols-2">
                  {[
                    [r.reused ? "What it did (the real run)" : "Now", r.current],
                    ["With the change", r.proposed],
                  ].map(([h, body]) => (
                    <div key={h} className="grid min-w-0 gap-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{h}</p>
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-[10px] bg-surface p-3 font-sans text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]">{pretty(body) || "—"}</pre>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The button and its result, wherever a change to an agent is about to be saved */
export function TestChange({ agentKey = null, roleKey = null, target, proposal, disabled = false }: { agentKey?: string | null; roleKey?: string | null; target: string; proposal: Proposal; disabled?: boolean }) {
  const [id, setId] = useState<string | null>(null);
  const [e, setE] = useState<EvalRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Poll while it runs
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      const next = await agentTest(id).catch(() => null);
      if (stop) return;
      if (next) setE(next);
      if (!next || next.status === "running") setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);

  return (
    <div className="grid gap-3 rounded-[14px] border border-dashed border-line p-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || starting || e?.status === "running"}
          onClick={async () => {
            setStarting(true);
            setError(null);
            setE(null);
            const r = await testAgentChange({ agentKey, roleKey, target, proposal });
            setStarting(false);
            if (r.ok) setId(r.id);
            else setError(r.error);
          }}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] text-fg transition-colors hover:border-faint disabled:opacity-50 md:min-h-9"
        >
          {starting || e?.status === "running" ? "Testing…" : e ? "Test again" : "Test this change"}
        </button>
        <p className="min-w-0 flex-1 text-[12px] text-faint">Replays up to 8 of its recent real runs with the change and without it, and a judge compares them. Saving isn&apos;t blocked; the result is kept with the change.</p>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      {e && <EvalView e={e} />}
    </div>
  );
}
