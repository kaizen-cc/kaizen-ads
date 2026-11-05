"use client";

import { useEffect, useState } from "react";
import { promisesFor, type Promise_ } from "./actions";
import type { PreviewItem } from "./start-flow";

/**
 * What we promised this client on calls and haven't started. "Brief on this" opens its quick preview (the brief from
 * the call when it's written, a first look when it isn't); the full brief fills the form, and sending the request marks
 * the promise as in motion.
 */
export function PromisesStrip({ clientId, used, onPreview, preloaded }: { clientId: string; used: string | null; onPreview: (item: PreviewItem) => void; /** Already read with the rest of the start page: no fetch of its own */ preloaded?: Promise_[] }) {
  const [fetched, setList] = useState<Promise_[] | null>(null);
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

  const use = (p: Promise_) =>
    onPreview({ key: `pr-${p.id}`, source: { kind: "promise", commitmentId: p.id }, from: { kicker: "Promised on a call", label: p.what }, progressLabel: "brief from a call+brief self-review", promiseId: p.id });

  return (
    <section className="grid gap-3 rounded-[14px] border border-warn/40 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(224,166,58,0.14),transparent_60%)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          Promised on calls <span className="text-faint">· not started yet</span>
        </p>
        <span className="text-[11px] text-faint">Brief one and the brief from the call fills this request in</span>
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
                disabled={on}
                className={`min-h-11 shrink-0 rounded-full text-xs font-medium md:min-h-8 ${on ? "px-3.5 text-ok" : "bg-fg px-3.5 text-bg disabled:opacity-60"}`}
              >
                {on ? "Loaded into this request" : "Brief on this"}
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
    </section>
  );
}
