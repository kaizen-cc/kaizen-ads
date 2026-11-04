"use client";

import { AiProgressButton } from "@/components/ai-progress";

import { useEffect, useState } from "react";
import type { Draft } from "./draft";
import { promiseDraft, promisesFor, type Promise_ } from "./actions";

/**
 * What we promised this client on calls and haven't started. "Use this" loads a brief written from the call into the
 * form (written on the spot if it wasn't already), and sending the request marks the promise as in motion.
 */
export function PromisesStrip({ clientId, used, onUse, preloaded }: { clientId: string; used: string | null; onUse: (commitmentId: string, patch: Partial<Draft>) => void; /** Already read with the rest of the start page: no fetch of its own */ preloaded?: Promise_[] }) {
  const [fetched, setList] = useState<Promise_[] | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (preloaded) return;
    let live = true;
    promisesFor(clientId).then((p) => live && setList(p));
    return () => {
      live = false;
    };
  }, [clientId, preloaded]);

  const list = preloaded ?? fetched;
  if (!list?.length) return null;
  // Compact: three, the rest a tap away
  const shown = all ? list : list.slice(0, 3);

  const use = async (p: Promise_) => {
    setError(null);
    setLoading(p.id);
    const r = await promiseDraft(p.id);
    setLoading(null);
    if (!r.ok) return setError(r.error);
    onUse(p.id, r.patch);
  };

  return (
    <section className="grid gap-3 rounded-[14px] border border-warn/40 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(224,166,58,0.14),transparent_60%)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          Promised on calls <span className="text-faint">· not started yet</span>
        </p>
        <span className="text-[11px] text-faint">Use one and the brief from the call fills this request in</span>
      </div>
      <div className="grid gap-2">
        {shown.map((p) => {
          const on = used === p.id;
          return (
            <div key={p.id} className={`flex flex-wrap items-center gap-3 rounded-[10px] border px-3 py-2.5 ${on ? "border-ok/50 bg-ok/10" : "border-line bg-bg/60"}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">&ldquo;{p.what}&rdquo;</span>
                <span className="block text-[11px] text-faint">
                  {p.internal ? "Internal meeting" : "Call"} &ldquo;{p.callTitle}&rdquo;
                  {p.callAt && ` · ${new Date(p.callAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`}
                  {p.briefed && " · brief ready"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => use(p)}
                disabled={Boolean(loading) || on}
                className={`h-10 shrink-0 rounded-full text-xs font-medium md:h-8 ${on ? "px-3.5 text-ok" : loading === p.id && !p.briefed ? "w-full bg-brand-soft text-brand-text md:w-72" : "bg-fg px-3.5 text-bg disabled:opacity-60"}`}
              >
                {on ? "Loaded into this request" : loading === p.id ? (p.briefed ? "Loading…" : <AiProgressButton label="brief from a call+brief self-review" fallbackMs={110_000} />) : "Use this"}
              </button>
            </div>
          );
        })}
      </div>
      {list.length > 3 && (
        <button type="button" onClick={() => setAll(!all)} className="justify-self-start text-[12.5px] text-muted hover:text-fg">
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
