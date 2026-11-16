"use client";

import { pushParams, useParam } from "@/lib/url-state";
import type { LocationBreakdown } from "@/lib/klaviyo/locations";

// A multi-location client's attributed orders by restaurant, the way the Head of Email builds it by hand: each conversion
// metric's totals and the two summed, then for the metric picked (its tab lives in the address) revenue by location and
// campaign, and the locations ranked. Read only.

const moneyOf = (cur: string | null) => (x: number) => `${!cur || cur === "USD" ? "$" : `${cur} `}${Math.round(x).toLocaleString("en-US")}`;
const shortDay = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");

export function LocationBreakdownView({ b, currency }: { b: LocationBreakdown; currency: string | null }) {
  const money = moneyOf(currency);
  const raw = useParam("elm");
  const metric = b.metrics.find((m) => m.metricId === raw) ?? b.metrics[0];
  const top = metric.ranked[0]?.revenue ?? 0;
  const colTotals = metric.columns.map((_, i) => metric.rows.reduce((s, r) => s + (r.cells[i] ?? 0), 0));

  return (
    <div className="grid gap-4">
      {/* The overall summary: each metric, then the two summed */}
      <div className={`grid gap-2.5 ${b.metrics.length > 1 ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2"}`}>
        {b.metrics.map((m) => (
          <div key={m.metricId} className="grid gap-0.5 rounded-[12px] border border-line bg-surface p-3">
            <span className="truncate text-[11px] text-faint">{m.name}</span>
            <span className="tabular font-heading text-xl text-fg">{money(m.revenue)}</span>
            <span className="tabular text-xs text-muted">{m.conversions.toLocaleString("en-US")} conversions · {m.ranked.length} locations</span>
          </div>
        ))}
        {b.metrics.length > 1 ? (
          <div className="col-span-2 grid gap-0.5 rounded-[12px] border border-line bg-surface-2/60 p-3 md:col-span-1">
            <span className="text-[11px] text-faint">Combined</span>
            <span className="tabular font-heading text-xl text-fg">{money(b.combined.revenue)}</span>
            <span className="tabular text-xs text-muted">{b.combined.conversions.toLocaleString("en-US")} conversions</span>
          </div>
        ) : (
          <div className="grid gap-0.5 rounded-[12px] border border-line bg-surface p-3">
            <span className="text-[11px] text-faint">Campaigns</span>
            <span className="tabular font-heading text-xl text-fg">{b.campaigns}</span>
            <span className="text-xs text-muted">sent with orders by location</span>
          </div>
        )}
      </div>
      {b.metrics.length > 1 && <p className="text-xs text-faint">{b.note}</p>}

      {b.metrics.length > 1 && (
        <div role="tablist" aria-label="Conversion metric" className="no-scrollbar flex gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1 justify-self-start">
          {b.metrics.map((m) => (
            <button key={m.metricId} type="button" role="tab" aria-selected={m.metricId === metric.metricId} onClick={() => pushParams({ elm: m.metricId === b.metrics[0].metricId ? null : m.metricId })} className={`min-h-11 shrink-0 rounded-full px-3.5 text-[12.5px] transition-colors md:min-h-8 ${m.metricId === metric.metricId ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {m.name}
            </button>
          ))}
        </div>
      )}

      {/* Part 1: revenue by location and campaign */}
      <section className="grid gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Revenue by location and campaign</h4>
        <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="w-full min-w-max border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left align-bottom">
                <th scope="col" className="sticky left-0 z-10 min-w-36 max-w-48 bg-surface px-3 py-2.5 text-[11px] font-medium text-faint">
                  Location
                </th>
                {metric.columns.map((c) => (
                  <th key={c.id} scope="col" className="max-w-32 px-2.5 py-2.5 text-right text-[11px] font-medium text-faint">
                    <span className="line-clamp-2 text-muted" title={c.name}>
                      {c.name}
                    </span>
                    {c.sendDay && <span className="block font-normal">{shortDay(c.sendDay)}</span>}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2.5 text-right text-[11px] font-medium text-faint">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {metric.rows.map((r) => (
                <tr key={r.location} className="border-b border-line/60 last:border-0">
                  <th scope="row" className="sticky left-0 z-10 max-w-48 truncate bg-surface px-3 py-2 text-left font-normal text-fg" title={r.location}>
                    {r.location}
                  </th>
                  {r.cells.map((v, i) => (
                    <td key={metric.columns[i].id} className={`tabular px-2.5 py-2 text-right ${v ? "text-fg" : "text-faint"}`}>
                      {v ? money(v) : "–"}
                    </td>
                  ))}
                  <td className="tabular px-3 py-2 text-right font-medium text-fg">{money(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-surface-2/50">
                <th scope="row" className="sticky left-0 z-10 bg-surface-2 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Total
                </th>
                {colTotals.map((t, i) => (
                  <td key={metric.columns[i].id} className="tabular px-2.5 py-2.5 text-right font-medium text-fg">
                    {money(t)}
                  </td>
                ))}
                <td className="tabular px-3 py-2.5 text-right font-semibold text-fg">{money(metric.revenue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Part 2: the locations ranked */}
      <section className="grid gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Locations ranked</h4>
        <ol className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line">
          {metric.ranked.map((x) => (
            <li key={x.location} className="relative grid min-h-11 grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-3 bg-surface px-3 py-2 text-sm">
              <span className="pointer-events-none absolute inset-y-0 left-0 bg-surface-2" style={{ width: `${top > 0 ? (x.revenue / top) * 100 : 0}%` }} aria-hidden />
              <span className="tabular relative text-xs text-faint">{x.rank}</span>
              <span className="relative truncate text-fg" title={x.location}>
                {x.location}
              </span>
              <span className="tabular relative text-xs text-muted">{x.conversions.toLocaleString("en-US")}</span>
              <span className="tabular relative w-20 text-right font-medium text-fg">{money(x.revenue)}</span>
            </li>
          ))}
          <li className="grid min-h-11 grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-3 bg-surface-2 px-3 py-2 text-sm">
            <span />
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Total</span>
            <span className="tabular text-xs text-muted">{metric.conversions.toLocaleString("en-US")}</span>
            <span className="tabular w-20 text-right font-semibold text-fg">{money(metric.revenue)}</span>
          </li>
        </ol>
        <p className="text-xs text-muted">{metric.summary}</p>
      </section>
    </div>
  );
}
