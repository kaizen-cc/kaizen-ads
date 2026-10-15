"use client";

import { useEffect, useState } from "react";
import { industryWinnersFor, type WinnersResult } from "./actions";
import { inspireLine } from "./draft";

/**
 * What's working for other clients in the same industry: the ads beating their own account the most, from live Meta
 * data. "Use as inspiration" adds the winner to the brief as a reference (internal only: the client never sees it).
 */
export function WinnersStrip({ clientId, onUse }: { clientId: string; onUse: (line: string) => void }) {
  const [data, setData] = useState<WinnersResult | null>(null);
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    industryWinnersFor(clientId).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [clientId]);

  if (!data?.industry || !data.winners.length) return null;
  return (
    <section className="grid gap-3 rounded-[12px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          Working for other {data.detail ? data.detail.toLowerCase() : data.label?.toLowerCase()} clients
        </p>
        <span className="text-[11px] text-faint">Live in our accounts · best vs their own usual cost</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {data.winners.map((w) => {
          const key = `${w.clientId}:${w.name}`;
          const line = inspireLine(w);
          return (
            <div key={key} className="grid w-44 shrink-0 content-start gap-2 rounded-[10px] border border-line bg-bg/50 p-2">
              <span className="relative aspect-[4/5] overflow-hidden rounded-[6px] bg-surface-2">
                {w.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center p-2 text-center text-[10px] text-faint">{w.headline ?? w.name}</span>
                )}
                <span className="absolute left-1.5 top-1.5 rounded-full bg-ok px-1.5 py-px text-[10px] font-semibold text-white">{w.ratio}x</span>
              </span>
              <span className="grid gap-0.5 px-0.5">
                <span className="line-clamp-2 text-xs font-medium">{w.headline ?? w.name}</span>
                <span className="text-[10.5px] text-faint">
                  {w.detail ?? "Similar business"} · ${w.costPerResult.toFixed(2)} vs ${w.usual.toFixed(2)} per {w.result ?? "result"}
                </span>
              </span>
              <button
                type="button"
                disabled={used.includes(key)}
                onClick={() => {
                  onUse(line);
                  setUsed([...used, key]);
                }}
                className="h-7 rounded-full border border-line text-[11px] text-muted hover:border-faint hover:text-fg disabled:border-ok/40 disabled:text-ok"
              >
                {used.includes(key) ? "Added to the brief" : "Use as inspiration"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
