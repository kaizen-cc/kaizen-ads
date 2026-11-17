"use client";

import { useEffect, useState, useTransition } from "react";
import { detectKlaviyoLocations, klaviyoLocationSetup, saveKlaviyoLocations } from "@/app/(team)/clients/[slug]/klaviyo-actions";
import { suggestedProp, type LocationCandidate } from "@/lib/klaviyo/locations";
import type { LocationSetup } from "@/lib/klaviyo/location-store";

// Multi-location clients (Crust's 40 restaurants on Toast and a custom POS): whether the email reports and the board break
// attributed orders down by location, and which event property holds the location for each ranked metric. The sync
// suggests it when a metric's orders carry more than one location; a lead or an exec confirms and picks, with a few of
// each property's values shown so the right one is picked. Saves on change.

const valuesText = (c: LocationCandidate) => `${c.distinct} ${c.distinct === 1 ? "value" : "values"}`;

export function KlaviyoLocations({ clientId }: { clientId: string }) {
  const [setup, setSetup] = useState<LocationSetup | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    klaviyoLocationSetup(clientId)
      .then((r) => {
        if (!live || !r.ok) return;
        setSetup(r.setup);
        setCanEdit(r.canEdit);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clientId]);

  // Nothing to say before the migration, or for an account with one location that nobody flagged
  if (!setup || (!setup.multi && !setup.suggested && !canEdit)) return null;

  const save = (multi: boolean, props: Record<string, string>) => {
    const was = setup;
    setSetup({ ...setup, multi, props, suggested: false });
    setError(null);
    start(async () => {
      const r = await saveKlaviyoLocations(clientId, { multi, props });
      if (!r.ok) {
        setSetup(was);
        return setError(r.error);
      }
      // The server picks the property itself when it was switched on without one
      setSetup((cur) => (cur ? { ...cur, props: r.props } : cur));
      setNote(multi ? (Object.keys(r.props).length ? "Saved. Reading the orders by location now; the first days land in a few minutes." : "Saved, but the latest orders don't name a location yet: check them again once orders come in.") : "Saved. Reports no longer break down by location.");
    });
  };
  const suggestedProps = () => Object.fromEntries(setup.metrics.flatMap((m) => {
    const s = suggestedProp(setup.detected[m.id] ?? []);
    return s ? [[m.id, s.prop]] : [];
  }));
  const check = () =>
    start(async () => {
      setError(null);
      setNote("Looking at the latest orders…");
      const r = await detectKlaviyoLocations(clientId);
      if (!r.ok) {
        setNote(null);
        return setError(r.error);
      }
      setSetup({ ...setup, detected: r.detected, detectedAt: new Date().toISOString(), suggested: !setup.multi && r.suggested });
      setNote(r.suggested ? "Found more than one location in the latest orders." : "The latest orders show a single location or none.");
    });

  // Opened before any look at the orders: look now, so the properties are there to pick from
  const openUp = () => {
    setOpen(true);
    if (!Object.keys(setup.detected).length) check();
  };

  const picked = setup.metrics.filter((m) => setup.props[m.id]);
  const best = setup.metrics.map((m) => ({ m, c: suggestedProp(setup.detected[m.id] ?? []) })).find((x) => x.c);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
        <span>By location:</span>
        {!open && <span className="text-fg">{setup.multi ? (picked.length ? picked.map((m) => `${setup.props[m.id]} on ${m.name}`).join(", ") : "on, no property picked yet") : "off"}</span>}
        {canEdit && !open && (
          <button type="button" onClick={openUp} className="inline-flex min-h-11 items-center text-sm text-brand-text underline-offset-4 hover:underline md:min-h-0">
            {setup.multi ? "Change" : "Set up"}
          </button>
        )}
      </div>

      {!open && setup.suggested && best && (
        <div className="grid gap-2 rounded-[14px] border border-line bg-surface-2/50 p-3">
          <p className="text-sm text-fg">
            This account looks multi-location: {valuesText(best.c!)} of <span className="font-medium">{best.c!.prop}</span> on {best.m.name} orders
            <span className="text-muted"> ({best.c!.samples.slice(0, 3).join(", ")}{best.c!.distinct > 3 ? "…" : ""})</span>.
          </p>
          <p className="text-xs text-faint">Turned on, every email report ends with a location breakdown and this account shows one on the Email board.</p>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={pending} onClick={() => save(true, suggestedProps())} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-60 md:min-h-9">
                Turn on
              </button>
              <button type="button" disabled={pending} onClick={openUp} className="inline-flex min-h-11 items-center rounded-full px-3 text-sm text-muted hover:text-fg md:min-h-9">
                Pick the properties
              </button>
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="grid gap-3 rounded-[14px] border border-line bg-surface-2/50 p-3">
          <button
            type="button"
            role="switch"
            aria-checked={setup.multi}
            disabled={pending}
            onClick={() => save(!setup.multi, setup.multi ? setup.props : Object.keys(setup.props).length ? setup.props : suggestedProps())}
            className="flex min-h-12 items-center justify-between gap-3 rounded-[10px] bg-surface px-3 text-left text-sm text-fg disabled:opacity-60"
          >
            <span>Break reports down by location</span>
            <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${setup.multi ? "bg-ok" : "bg-line"}`} aria-hidden>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${setup.multi ? "left-[18px]" : "left-0.5"}`} />
            </span>
          </button>
          {setup.metrics.map((m) => {
            const cands = setup.detected[m.id] ?? [];
            const value = setup.props[m.id] ?? "";
            const chosen = cands.find((c) => c.prop === value) ?? null;
            return (
              <label key={m.id} className="grid gap-1 text-xs text-faint">
                Where {m.name} orders name the location
                <select
                  value={value}
                  disabled={pending}
                  onChange={(e) => {
                    const props = { ...setup.props };
                    if (e.target.value) props[m.id] = e.target.value;
                    else delete props[m.id];
                    save(setup.multi, props);
                  }}
                  className="h-12 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-fg md:h-10"
                >
                  <option value="">{cands.length ? "Not split by location" : "No properties found yet: check the latest orders"}</option>
                  {value && !chosen && <option value={value}>{value}</option>}
                  {cands.map((c) => (
                    <option key={c.prop} value={c.prop}>
                      {c.prop} · {valuesText(c)}
                    </option>
                  ))}
                </select>
                {chosen && <span className="truncate text-faint">e.g. {chosen.samples.join(", ")}</span>}
              </label>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <button type="button" disabled={pending} onClick={check} className="inline-flex min-h-11 items-center text-xs text-brand-text underline-offset-4 hover:underline disabled:opacity-60 md:min-h-0">
              Check the latest orders again
            </button>
            <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs text-muted hover:text-fg md:min-h-0">
              Done
            </button>
          </div>
        </div>
      )}
      {(note || (setup.multi && setup.error)) && <p className={`text-xs ${note ? "text-faint" : "text-warn"}`}>{pending && !note ? "Saving…" : (note ?? setup.error)}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
