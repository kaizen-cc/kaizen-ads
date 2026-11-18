"use client";

import { useEffect, useState } from "react";
import { pushParams, useParam } from "@/lib/url-state";
import { PATTERN_LABEL, type SegAdvice, type SegmentReport, type SegmentStat } from "@/lib/klaviyo/segments-core";
import { segmentReportFor } from "./segment-actions";

// Segment performance for an email account: which lists and segments the campaigns went to and how each did (campaigns,
// recipients, open, click, revenue, revenue per recipient), the ones to trim or rest, advice on who to include and
// leave out, and what earns for similar clients. Used on the client page's Audience tab and on the KPI board's email
// sheet; it reads when it opens (the window lives in the address, ?sdays=).

const pct = (x: number | null, d = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);
const count = (x: number) => Math.round(x).toLocaleString("en-US");
const money = (x: number, cur: string | null, cents = false) => `${!cur || cur === "USD" ? "$" : `${cur} `}${cents ? x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(x).toLocaleString("en-US")}`;

const KIND: Record<SegAdvice["kind"], { label: string; cls: string }> = {
  include: { label: "Include", cls: "bg-ok-soft text-ok" },
  exclude: { label: "Exclude", cls: "bg-bad-soft text-bad" },
  target: { label: "Target", cls: "bg-brand-soft text-brand-text" },
  rotate: { label: "Rotate", cls: "bg-warn-soft text-warn" },
  try: { label: "Try", cls: "bg-surface-2 text-muted" },
};

function Advice({ a }: { a: SegAdvice }) {
  const k = KIND[a.kind];
  return (
    <li className="grid content-start gap-1.5 rounded-[14px] border border-line bg-bg/40 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] ${k.cls}`}>{k.label}</span>
        <span className="text-[13.5px] font-medium">{a.title}</span>
        {!a.exists && <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10.5px] text-faint">Create in Klaviyo</span>}
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">{a.detail}</p>
      <p className="flex flex-wrap gap-1.5">
        {a.segments.map((s) => (
          <span key={s} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-fg">
            {s}
          </span>
        ))}
      </p>
    </li>
  );
}

function Row({ s, cur }: { s: SegmentStat; cur: string | null }) {
  return (
    <li className="grid gap-2 border-t border-line/60 px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_56px_88px_60px_60px_92px_84px] md:items-center md:gap-3">
      <span className="grid min-w-0 gap-1">
        <span className="truncate text-[13.5px] font-medium">{s.name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">{s.type}</span>
          {s.pattern !== "other" && <span>{PATTERN_LABEL[s.pattern]}</span>}
          {s.profiles != null && <span>· {count(s.profiles)} people</span>}
          {s.excludedIn > 0 && <span>· left out of {s.excludedIn}</span>}
        </span>
        {s.flags.map((f) => (
          <span key={f.kind} className={`w-fit max-w-full rounded-[10px] px-2 py-1 text-[11.5px] leading-snug ${f.kind === "overused" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}>
            <span className="font-medium">{f.kind === "overused" ? "Overused" : "Underperforming"}:</span> {f.why}
          </span>
        ))}
      </span>
      <span className="grid grid-cols-3 gap-2 text-[12px] sm:grid-cols-6 md:contents">
        {[
          ["Sent", String(s.campaigns)],
          ["Recipients", count(s.recipients)],
          ["Open", pct(s.openRate)],
          ["Click", pct(s.clickRate, 2)],
          ["Revenue", money(s.revenue, cur)],
          ["Per recip.", s.rpr != null ? money(s.rpr, cur, true) : "n/a"],
        ].map(([key, v]) => (
          <span key={key} className="grid gap-0.5 md:text-right">
            <span className="text-[10px] text-faint md:hidden">{key}</span>
            <span className="tabular text-fg">{v}</span>
          </span>
        ))}
      </span>
    </li>
  );
}

export function SegmentPerformance({ clientId, currency = null }: { clientId: string; currency?: string | null }) {
  const raw = Number(useParam("sdays"));
  const days = raw === 30 || raw === 120 ? raw : 90;
  const [got, setGot] = useState<{ key: string; report: SegmentReport | null; error: string | null } | null>(null);
  const key = `${clientId}:${days}`;
  useEffect(() => {
    let live = true;
    void segmentReportFor(clientId, days).then((r) => live && setGot({ key, report: r.ok ? r.report : null, error: r.ok ? null : r.error }));
    return () => {
      live = false;
    };
  }, [clientId, days, key]);
  const state = got && got.key === key ? got : null;
  const r = state?.report ?? null;
  return (
    <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="font-heading text-[16px]">Segment performance</h3>
          <span className="text-[12px] text-faint">Who the campaigns went to and how each list and segment did. A campaign sent to two segments counts for both.</span>
        </div>
        <div role="radiogroup" aria-label="Window" className="flex gap-1 rounded-full border border-line bg-bg/40 p-1">
          {[30, 90, 120].map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => pushParams({ sdays: d === 90 ? null : String(d) })} className={`min-h-9 rounded-full px-3 text-[12.5px] transition-colors md:min-h-8 ${days === d ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {!state ? (
        <div className="h-40 animate-pulse rounded-[12px] bg-surface-2" aria-label="Reading the segments" />
      ) : state.error ? (
        <p className="text-sm text-faint">{state.error}</p>
      ) : !r ? (
        <p className="text-sm text-faint">No email campaigns read yet.</p>
      ) : (
        <>
          {r.withAudiences < r.campaigns && (
            <p className="rounded-[12px] border border-line px-3 py-2 text-[12px] text-muted">
              {r.withAudiences ? `${r.withAudiences} of ${r.campaigns} campaigns` : `None of the ${r.campaigns} campaigns`} have their audiences recorded yet; the next full Klaviyo read fills in the rest.
            </p>
          )}
          {r.advice.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Who to include and leave out</h4>
              <ul className="grid gap-2 md:grid-cols-2">
                {r.advice.map((a, i) => (
                  <Advice key={`${a.kind}-${a.title}-${i}`} a={a} />
                ))}
              </ul>
            </div>
          )}
          {r.segments.length > 0 && (
            <div className="grid gap-1 rounded-[14px] border border-line p-1.5 md:p-2">
              <div className="hidden grid-cols-[minmax(0,1fr)_56px_88px_60px_60px_92px_84px] gap-3 px-3 pb-1 pt-1 text-right text-[11px] uppercase tracking-[0.08em] text-faint md:grid">
                <span className="text-left">Segment</span>
                <span>Sent</span>
                <span>Recipients</span>
                <span>Open</span>
                <span>Click</span>
                <span>Revenue</span>
                <span>Per recip.</span>
              </div>
              <ul className="grid">
                {r.segments.map((s) => (
                  <Row key={s.id} s={s} cur={currency} />
                ))}
              </ul>
            </div>
          )}
          {r.peers.length > 0 && r.peerScope && (
            <div className="grid gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Working for similar clients</h4>
              <p className="text-[12px] text-faint">
                {r.peerScope.clients} other {r.peerScope.detail ? `${r.peerScope.industry} (${r.peerScope.detail})` : r.peerScope.industry} clients, last {r.days} days, by kind of segment.
              </p>
              <ul className="grid gap-1.5">
                {r.peers.slice(0, 6).map((p) => (
                  <li key={p.pattern} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-[12px] border border-line bg-bg/40 px-3 py-2 text-[13px]">
                    <span>{p.label}</span>
                    <span className="tabular text-[12px] text-muted">
                      {p.rpr != null ? `${money(p.rpr, currency, true)} per recipient` : "no revenue"} · {pct(p.openRate, 0)} opens · {p.clients} clients
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
