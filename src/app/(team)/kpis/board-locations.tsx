"use client";

import { useEffect, useState } from "react";
import { LocationBreakdownView } from "@/components/location-breakdown";
import { isLocationRange, LOCATION_RANGES, type LocationBreakdown, type LocationRange } from "@/lib/klaviyo/locations";
import { pushParams, useParam } from "@/lib/url-state";
import { loadLocationBreakdown } from "./location-actions";

// The location breakdown inside an opened account on the Email board, for multi-location clients only: fetched when the
// sheet opens (and when the dates change, which live in the address), so the board stays light. Nothing shows for a
// client that isn't flagged.

type Got = { key: string; flagged: boolean; breakdown: LocationBreakdown | null; currency: string | null; error: string | null };

export function BoardLocations({ clientId }: { clientId: string }) {
  const raw = useParam("elr");
  const range: LocationRange = isLocationRange(raw) ? raw : "month";
  const key = `${clientId}:${range}`;
  const [got, setGot] = useState<Got | null>(null);
  useEffect(() => {
    let live = true;
    loadLocationBreakdown(clientId, range)
      .then((r) => live && setGot(r.ok ? (r.flagged ? { key, flagged: true, breakdown: r.breakdown, currency: r.currency, error: null } : { key, flagged: false, breakdown: null, currency: null, error: null }) : { key, flagged: true, breakdown: null, currency: null, error: r.error }))
      .catch(() => live && setGot({ key, flagged: true, breakdown: null, currency: null, error: "Couldn't read the orders by location." }));
    return () => {
      live = false;
    };
  }, [clientId, range, key]);
  // A client that isn't multi-location: nothing at all
  if (got && got.key.startsWith(`${clientId}:`) && !got.flagged) return null;
  const loading = !got || got.key !== key;

  return (
    <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg">By location</h2>
          <p className="text-xs text-faint">Attributed orders from the campaigns sent in these dates, by the restaurant they came from</p>
        </div>
        <div role="tablist" aria-label="Dates" className="no-scrollbar flex gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
          {LOCATION_RANGES.map((o) => (
            <button key={o.id} type="button" role="tab" aria-selected={range === o.id} onClick={() => pushParams({ elr: o.id === "month" ? null : o.id })} className={`min-h-11 shrink-0 rounded-full px-3.5 text-[12.5px] transition-colors md:min-h-8 ${range === o.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading orders by location">
          <div className="grid grid-cols-3 gap-2.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-[12px] bg-surface-2" />
            ))}
          </div>
          <div className="h-56 animate-pulse rounded-[14px] bg-surface-2" />
        </div>
      ) : got.error ? (
        <p className="text-sm text-bad">{got.error}</p>
      ) : got.breakdown ? (
        <LocationBreakdownView b={got.breakdown} currency={got.currency} />
      ) : (
        <p className="text-sm text-muted">No orders with a location were attributed to the campaigns sent in these dates yet. The orders by location are read once a day.</p>
      )}
    </section>
  );
}
