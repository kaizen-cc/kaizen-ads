"use client";

import { useEffect, useState } from "react";
import type { MarketAd } from "@/lib/market";
import { marketFor } from "./actions";

/**
 * Live in this client's market, from Motion: their named competitors first, then what's proven or being tested in
 * the industry. "Use as inspiration" puts the idea in the brief and the Motion link in the references.
 */
export function MarketStrip({ clientId, onUse }: { clientId: string; onUse: (line: string, link: string | null) => void }) {
  const [data, setData] = useState<{ label: string | null; ads: MarketAd[] } | null>(null);
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    marketFor(clientId).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [clientId]);

  if (!data?.ads.length) return null;
  return (
    <section className="grid gap-3 rounded-[12px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Live in the {data.label ? data.label.toLowerCase() : "client's"} market</p>
        <span className="text-[11px] text-faint">From Motion · ideas, never copies</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {data.ads.map((a) => {
          const cover = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
          const link = a.motionUrl ?? a.libraryUrl ?? a.media[0]?.url ?? a.landingUrl ?? null;
          const on = used.includes(a.id);
          const line = `Inspiration from the market: ${a.brand}'s ${a.format ?? "ad"}${a.daysActive != null ? ` (running ${a.daysActive} days)` : ""}${a.angle ? `, angle "${a.angle}"` : ""}${a.hook ? `, hook "${a.hook}"` : ""}. Take the idea, not the ad.`;
          return (
            <div key={a.id} className="grid content-start gap-2 rounded-[10px] border border-line bg-bg/50 p-2">
              <span className="relative aspect-[4/5] overflow-hidden rounded-[6px] bg-surface-2">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cover} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] text-faint">{a.headline ?? a.angle ?? a.brand}</span>
                )}
                <span className="absolute left-1.5 top-1.5 flex gap-1">
                  {a.competitorOf.includes(clientId) && <span className="rounded-full bg-black/70 px-1.5 py-px text-[10px] text-white">Competitor</span>}
                  {a.proven && <span className="rounded-full bg-ok px-1.5 py-px text-[10px] font-semibold text-white">{a.daysActive}d</span>}
                </span>
              </span>
              <span className="line-clamp-2 text-[12px] font-medium leading-snug">{a.angle ?? a.headline ?? "Untitled ad"}</span>
              <span className="truncate text-[11px] text-faint">{a.brand}</span>
              <span className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={on}
                  onClick={() => {
                    onUse(line, link);
                    setUsed((u) => [...u, a.id]);
                  }}
                  className={`text-[11px] font-medium ${on ? "text-ok" : "text-brand-text hover:underline"}`}
                >
                  {on ? "Added" : "Use as inspiration"}
                </button>
                {a.motionUrl && (
                  <a href={a.motionUrl} target="_blank" rel="noreferrer" className="text-[11px] text-faint hover:text-fg">
                    Motion ↗
                  </a>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
