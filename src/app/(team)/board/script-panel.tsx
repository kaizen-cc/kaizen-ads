"use client";

import { useEffect, useState, useTransition } from "react";
import type { Script } from "@/lib/ai";
import { ticketScript, writeScript, type SavedScript } from "./script-actions";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

const STEPS = ["Reading the brief and client memory", "Picking the framework and style", "Writing three hooks", "Timing the beats", "Adding filming notes"];

/** Video tickets: the Video script writer's script, written on request and kept on the ticket. */
export function ScriptPanel({ requestId, demo }: { requestId: string; demo?: SavedScript | null }) {
  const [script, setScript] = useState<SavedScript | null | undefined>(demo === undefined ? undefined : demo);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [step, setStep] = useState(0);
  const [hook, setHook] = useState(0);

  useEffect(() => {
    if (demo !== undefined) return;
    let live = true;
    void ticketScript(requestId).then((s) => live && setScript(s));
    return () => {
      live = false;
    };
  }, [requestId, demo]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 5000);
    return () => clearInterval(t);
  }, [busy]);

  const run = () =>
    start(async () => {
      setError(null);
      setStep(0);
      const r = await writeScript(requestId, note);
      if (r.ok) {
        setScript(r.script);
        setNote("");
        setHook(0);
      } else setError(r.error);
    });

  const s: Script | undefined = script?.content;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Script</h3>
        {script && <span className="text-[11px] text-faint">v{script.version} · {script.by ?? "AI"} · {fmt(script.at)}</span>}
      </div>

      {busy ? (
        <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-all duration-[5000ms] ease-linear" style={{ width: `${((step + 1) / STEPS.length) * 92}%` }} />
          </div>
          <p className="text-sm text-muted">{STEPS[step]}…</p>
        </div>
      ) : script === undefined ? (
        <p className="text-xs text-faint">Loading…</p>
      ) : !s ? (
        <div className="grid justify-items-start gap-3 rounded-[12px] border border-dashed border-line p-5">
          <p className="text-sm text-muted">The Video script writer turns this brief into three hooks, a timed beat sheet, filming notes and a test plan.</p>
          <button onClick={run} className="h-9 rounded-full bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover max-md:h-11 max-md:px-5">
            Write the script
          </button>
        </div>
      ) : (
        <div className="grid gap-5 rounded-[12px] border border-line bg-bg p-5 max-md:p-4">
          <div className="grid gap-1">
            <p className="font-heading text-[16px]">{s.title}</p>
            <p className="text-xs text-muted">
              {s.framework} · {s.style} · {s.lengthSeconds}s · {s.placement}
            </p>
            <p className="text-xs leading-relaxed text-faint">{s.why}</p>
          </div>

          <div className="grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Hooks</p>
            <div className="flex flex-wrap gap-1.5">
              {s.hooks.map((h, i) => (
                <button key={i} onClick={() => setHook(i)} className={`h-7 rounded-full px-3 text-xs transition-colors max-md:h-10 max-md:px-3.5 ${hook === i ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg"}`}>
                  {i + 1}. {h.type}
                </button>
              ))}
            </div>
            {s.hooks[hook] && (
              <div className="grid gap-1 rounded-[10px] bg-surface px-4 py-3">
                <p className="text-sm font-medium">&ldquo;{s.hooks[hook].onScreen}&rdquo;</p>
                <p className="text-xs text-muted">Says: {s.hooks[hook].spoken}</p>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Beat sheet</p>
            <ol className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line">
              {s.beats.map((b, i) => (
                <li key={i} className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 bg-surface px-3 py-2.5 text-xs">
                  <span className="tabular font-medium text-brand-text">{b.time}</span>
                  <span className="grid gap-1">
                    <span className="text-fg">{b.shot}</span>
                    {b.onScreen && <span className="text-muted">On screen: &ldquo;{b.onScreen}&rdquo;</span>}
                    {b.voiceover && <span className="text-muted">VO: {b.voiceover}</span>}
                    {b.sound && <span className="text-faint">Sound: {b.sound}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-xs">
              <span className="text-faint">CTA: </span>
              {s.cta}
            </p>
          </div>

          {s.filming.length > 0 && (
            <div className="grid gap-1.5">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Filming notes</p>
              <ul className="grid list-disc gap-1 pl-4 text-xs leading-relaxed text-muted">
                {s.filming.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-1.5">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Test plan</p>
            <p className="text-xs leading-relaxed text-muted">{s.testPlan}</p>
          </div>
          {s.watchouts.length > 0 && (
            <ul className="grid gap-1 rounded-[10px] border border-warn/30 bg-warn-soft px-4 py-3 text-xs text-warn">
              {s.watchouts.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should change? e.g. shorter, funnier hook, use the founder"
              className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-xs outline-none focus:border-brand-text/60 max-md:h-11 max-md:basis-full"
            />
            <button onClick={run} className="h-9 rounded-full border border-line px-4 text-xs text-muted transition-colors hover:text-fg max-md:h-11 max-md:w-full max-md:text-sm">
              Rewrite
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
