"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { chooseKlaviyoMetric, klaviyoMetrics } from "@/app/(team)/clients/[slug]/klaviyo-actions";

// What counts as the sale for a client's Klaviyo account (its Conversion metric: Placed Order from Toast or Shopify,
// Bought Ticket from Eventbrite...). The account's own metrics are listed with their integration, since several can share
// a name; picking one saves it and reads the 90 days again with it. Leads and execs pick; everyone sees which it is.

type Metric = { id: string; name: string; integration: string | null };

export function KlaviyoMetricPicker({ clientId, current, canPick }: { clientId: string; current: string | null; canPick: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<Metric[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      setOpen(true);
      setError(null);
      const r = await klaviyoMetrics(clientId);
      if (!r.ok) return setError(r.error);
      setMetrics(r.metrics);
      setChosen(r.current);
    });

  const pick = (id: string) => {
    const m = metrics?.find((x) => x.id === id);
    if (!m) return;
    setChosen(id);
    start(async () => {
      const r = await chooseKlaviyoMetric(clientId, m.id, m.name);
      if (!r.ok) return setError(r.error);
      setName(m.integration ? `${m.name} · ${m.integration}` : m.name);
      setOpen(false);
      // The board shows the read starting again (the reading bar); elsewhere the page catches up
      window.dispatchEvent(new CustomEvent("klaviyo-connected", { detail: clientId }));
      if (!window.location.pathname.startsWith("/kpis")) router.refresh();
    });
  };

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted">
        Counts as the sale: <span className="text-fg">{name ?? "Placed Order (found by itself)"}</span>
        {canPick && !open && (
          <button type="button" onClick={load} disabled={pending} className="ml-2 inline-flex min-h-11 items-center text-sm text-brand-text underline-offset-4 hover:underline disabled:opacity-60 md:min-h-0">
            {pending ? "Loading…" : "Change"}
          </button>
        )}
      </p>
      {open && metrics && (
        <select
          value={chosen ?? ""}
          disabled={pending}
          onChange={(e) => pick(e.target.value)}
          aria-label="The metric that counts as the sale"
          className="h-12 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-fg md:h-10"
        >
          <option value="" disabled>
            Pick the metric that counts as the sale
          </option>
          {metrics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.integration ? ` · ${m.integration}` : ""}
            </option>
          ))}
        </select>
      )}
      {open && <p className="text-xs text-faint">{pending ? "Saving and reading the 90 days again…" : "Use the one Klaviyo shows as the Conversion metric on the account's home page."}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
