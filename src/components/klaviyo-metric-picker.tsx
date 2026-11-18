"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { chooseKlaviyoMetrics, klaviyoMetrics } from "@/app/(team)/clients/[slug]/klaviyo-actions";
import { MAX_CONVERSION_METRICS, RANK_LABEL, rankWeights, type ConversionMetric } from "@/lib/email-metrics";

// What counts as the sale for a client's Klaviyo account, ranked: a restaurant's Toast online orders first, its
// reservations second... (Placed Order from Shopify, Bought Ticket from Eventbrite). The account's own metrics are listed
// with their integration, since several can share a name. Each pick, move or removal saves at once; the primary drives
// the chart and the revenue target, and the score's money checks blend them by rank. Leads and execs pick; everyone
// sees the list.

const label = (m: ConversionMetric) => (m.integration ? `${m.name} · ${m.integration}` : m.name);

export function KlaviyoMetricPicker({ clientId, current, fallback, canPick }: { clientId: string; current: ConversionMetric[]; /** The primary's name when no list is saved yet */ fallback?: string | null; canPick: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<ConversionMetric[] | null>(null);
  const [list, setList] = useState<ConversionMetric[]>(current);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const weights = rankWeights(list.length);

  const load = () =>
    start(async () => {
      setOpen(true);
      setError(null);
      const r = await klaviyoMetrics(clientId);
      if (!r.ok) return setError(r.error);
      setAll(r.metrics);
      // A primary found by itself (no list saved yet) shows with its integration once the account's metrics are in
      if (!list.length && r.current) {
        const found = r.metrics.find((m) => m.id === r.current);
        if (found) setList([found]);
      } else setList((l) => l.map((m) => r.metrics.find((x) => x.id === m.id) ?? m));
    });

  // Save on change: the new order goes in at once, and the board shows a read starting when one is needed
  const save = (next: ConversionMetric[]) => {
    if (!next.length) return;
    const was = list;
    setList(next);
    setError(null);
    start(async () => {
      const r = await chooseKlaviyoMetrics(clientId, next);
      if (!r.ok) {
        setList(was);
        return setError(r.error);
      }
      setNote(r.reading ? "Saved. Reading the 90 days again with these metrics." : "Saved.");
      if (r.reading) window.dispatchEvent(new CustomEvent("klaviyo-connected", { detail: clientId }));
      if (!window.location.pathname.startsWith("/kpis")) router.refresh();
    });
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const left = (all ?? []).filter((m) => !list.some((x) => x.id === m.id));

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
        <span>Counts as the sale:</span>
        {!open && (
          <span className="text-fg">
            {list.length ? list.map((m, i) => `${i + 1}. ${label(m)}`).join("  ") : (fallback ?? "Placed Order (found by itself)")}
          </span>
        )}
        {canPick && !open && (
          <button type="button" onClick={load} disabled={pending} className="inline-flex min-h-11 items-center text-sm text-brand-text underline-offset-4 hover:underline disabled:opacity-60 md:min-h-0">
            {pending ? "Loading…" : "Change"}
          </button>
        )}
      </div>
      {open && all && (
        <div className="grid gap-2 rounded-[14px] border border-line bg-surface-2/50 p-2">
          <ol className="grid gap-1">
            {list.map((m, i) => (
              <li key={m.id} className="flex min-h-12 items-center gap-2 rounded-[10px] bg-surface px-3">
                <span className="w-16 shrink-0 text-[11px] text-faint">
                  {RANK_LABEL[i]}
                  {list.length > 1 && <span className="tabular block">{weights[i]}%</span>}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {m.name}
                  {m.integration && <span className="text-faint"> · {m.integration}</span>}
                </span>
                {i > 0 && (
                  <select
                    value={m.revenueSource === true ? "yes" : m.revenueSource === false ? "no" : "auto"}
                    disabled={pending}
                    onChange={(e) => save(list.map((x) => (x.id === m.id ? { id: x.id, name: x.name, integration: x.integration, ...(e.target.value === "auto" ? {} : { revenueSource: e.target.value === "yes" }) } : x)))}
                    aria-label={`Whether ${m.name} is a revenue source in the email report`}
                    title="A revenue source gets its own section in the email report (a second order system, like a custom POS next to Toast), and the combined total counts each order once"
                    className="h-11 shrink-0 rounded-[8px] border border-line bg-surface px-2 text-xs text-muted md:h-8"
                  >
                    <option value="auto">Revenue: auto</option>
                    <option value="yes">Revenue source</option>
                    <option value="no">Not revenue</option>
                  </select>
                )}
                <button type="button" aria-label={`Move ${m.name} up`} disabled={pending || i === 0} onClick={() => move(i, -1)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30 md:h-8 md:w-8">
                  ↑
                </button>
                <button type="button" aria-label={`Move ${m.name} down`} disabled={pending || i === list.length - 1} onClick={() => move(i, 1)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30 md:h-8 md:w-8">
                  ↓
                </button>
                <button type="button" aria-label={`Remove ${m.name}`} disabled={pending || list.length === 1} onClick={() => save(list.filter((x) => x.id !== m.id))} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-bad disabled:opacity-30 md:h-8 md:w-8">
                  ×
                </button>
              </li>
            ))}
          </ol>
          {list.length < MAX_CONVERSION_METRICS && (
            <select
              value=""
              disabled={pending}
              onChange={(e) => {
                const m = left.find((x) => x.id === e.target.value);
                if (m) save([...list, m]);
              }}
              aria-label="Add a metric that counts as a sale"
              className="h-12 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-fg md:h-10"
            >
              <option value="" disabled>
                {list.length ? `Add a ${RANK_LABEL[list.length].toLowerCase()} metric` : "Pick the metric that counts as the sale"}
              </option>
              {left.map((m) => (
                <option key={m.id} value={m.id}>
                  {label(m)}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="text-xs text-faint">{pending ? "Saving…" : (note ?? "The primary is the one Klaviyo shows as the Conversion metric on the account's home page. A second order system (a custom POS next to Toast) set as a revenue source gets its own section in the email report.")}</p>
            <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs text-muted hover:text-fg md:min-h-0">
              Done
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
