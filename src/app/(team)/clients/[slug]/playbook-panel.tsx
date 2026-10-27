"use client";

import { useMemo, useState } from "react";
import type { LedgerItem } from "@/lib/ledger";

// The client playbook: everything they've run (creatives, message angles, audiences), kept forever with when it ran,
// how it did against their KPI and a verdict. Winners first; nothing disappears when an ad is turned off. The Brand
// Bible's living learnings sit on top: what the playbook taught, dated.

type Learning = { at: string; kind: string; text: string };
const KINDS = [
  { key: "angle", label: "Message angles" },
  { key: "audience", label: "Audiences" },
  { key: "creative", label: "Creatives" },
] as const;
const VERDICT = {
  winner: { label: "Winner", cls: "bg-ok-soft text-ok", dot: "bg-ok" },
  loser: { label: "Didn't work", cls: "bg-bad-soft text-bad", dot: "bg-bad" },
  testing: { label: "Testing", cls: "bg-warn-soft text-warn", dot: "bg-warn" },
  inconclusive: { label: "Not enough data", cls: "bg-surface-2 text-faint", dot: "bg-faint" },
} as const;
const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const day = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" }) : "—");

export function PlaybookPanel({ items, learnings }: { items: LedgerItem[]; learnings: Learning[] }) {
  const [kind, setKind] = useState<"angle" | "audience" | "creative">("angle");
  const [verdict, setVerdict] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(30);
  const counts = useMemo(() => {
    const c: Record<string, Record<string, number>> = {};
    for (const i of items) {
      c[i.kind] ??= {};
      c[i.kind][i.verdict] = (c[i.kind][i.verdict] ?? 0) + 1;
    }
    return c;
  }, [items]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const order = { winner: 0, testing: 1, loser: 2, inconclusive: 3 } as const;
    return items
      .filter((i) => i.kind === kind && (!verdict || i.verdict === verdict) && (!t || `${i.title} ${i.detail.text ?? ""} ${i.detail.angle ?? ""} ${i.detail.adset ?? ""}`.toLowerCase().includes(t)))
      .sort((a, b) => order[a.verdict] - order[b.verdict] || Number(b.live) - Number(a.live) || b.spend - a.spend);
  }, [items, kind, verdict, q]);
  const total = items.filter((i) => i.kind === "creative").length;
  const winners = items.filter((i) => i.verdict === "winner").length;

  return (
    <div className="grid gap-6">
      <section className="relative isolate grid gap-5 overflow-hidden rounded-[22px] border border-white/[0.07] bg-[#0b0a0e] p-5 md:p-7">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-28 -z-10 h-72 w-72 rounded-full bg-[rgba(91,227,165,0.14)] blur-[100px]" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">Client playbook</span>
            <h2 className="font-heading text-2xl">Everything they&apos;ve run, and what it taught us</h2>
            <p className="max-w-2xl text-sm text-white/55">Every ad, message angle and audience, kept forever with its results against their KPI. Briefs, suggestions and the Brand Bible all build on it.</p>
          </div>
          <div className="flex gap-2">
            {[
              { v: total, l: "creatives tracked" },
              { v: winners, l: "winners" },
              { v: items.filter((i) => i.live && i.kind === "creative").length, l: "live now" },
            ].map((s) => (
              <span key={s.l} className="grid min-w-[86px] gap-0.5 rounded-[14px] bg-white/[0.05] px-3 py-2">
                <span className="tabular font-display text-2xl leading-none">{s.v}</span>
                <span className="text-[10.5px] text-white/45">{s.l}</span>
              </span>
            ))}
          </div>
        </div>
        {learnings.length > 0 && (
          <div className="grid gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">Latest learnings · in the Brand Bible</span>
            <ul className="grid gap-1.5 md:grid-cols-2">
              {[...learnings].reverse().slice(0, 8).map((l, i) => (
                <li key={i} className="flex gap-2.5 rounded-[12px] bg-white/[0.04] px-3 py-2.5 text-[13px] leading-relaxed">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${l.kind === "avoid" ? "bg-[#ff4d5e]" : "bg-[#5be3a5]"}`} />
                  <span className="min-w-0">
                    {l.text}
                    <span className="block text-[11px] text-white/35">{day(l.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full bg-surface-2 p-1">
          {KINDS.map((k) => (
            <button key={k.key} type="button" onClick={() => (setKind(k.key), setShown(30))} className={`h-9 rounded-full px-4 text-sm transition-colors max-md:h-10 ${kind === k.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {k.label}
              <span className="ml-1.5 text-[11px] opacity-60">{Object.values(counts[k.key] ?? {}).reduce((a, b) => a + b, 0)}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(VERDICT) as (keyof typeof VERDICT)[]).map((v) => (
            <button key={v} type="button" onClick={() => setVerdict(verdict === v ? null : v)} className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs max-md:h-10 ${verdict === v ? "border-fg text-fg" : "border-line text-muted hover:text-fg"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${VERDICT[v].dot}`} />
              {VERDICT[v].label} {counts[kind]?.[v] ?? 0}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-9 w-full rounded-full border border-line bg-surface px-3.5 text-sm outline-none focus:border-brand-text/60 md:ml-auto md:w-56 max-md:h-11" />
      </div>

      {list.length ? (
        <ul className={`grid gap-2.5 ${kind === "creative" ? "md:grid-cols-2" : ""}`}>
          {list.slice(0, shown).map((i) => {
            const v = VERDICT[i.verdict];
            return (
              <li key={i.id} className="flex gap-3 rounded-[16px] border border-line bg-surface p-3.5">
                {kind === "creative" &&
                  (i.detail.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.detail.image} alt="" loading="lazy" className="h-20 w-16 shrink-0 rounded-[10px] bg-surface-2 object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  ) : (
                    <span className="h-20 w-16 shrink-0 rounded-[10px] bg-surface-2" />
                  ))}
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${v.cls}`}>{v.label}</span>
                    {i.live ? <span className="flex items-center gap-1 text-[11px] text-ok"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />Live</span> : <span className="text-[11px] text-faint">Off</span>}
                    <span className="text-[11px] text-faint">
                      {day(i.firstSeen)} → {day(i.lastSeen)}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{i.title}</p>
                  {kind === "creative" && i.detail.text && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{i.detail.text}</p>}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted">
                    <span className="tabular">{money(i.spend)} spent</span>
                    <span className="tabular">
                      {Math.round(i.results)} {i.resultLabel ?? "results"}
                    </span>
                    {i.roas != null ? <span className="tabular">{i.roas}x ROAS</span> : <span className="tabular">{money(i.costPerResult)} each</span>}
                    {i.kind !== "creative" && <span>{i.ads} ad{i.ads === 1 ? "" : "s"}</span>}
                  </div>
                  {kind === "creative" && (i.detail.angle || i.detail.adset) && (
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {i.detail.angle && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">Angle: {i.detail.angle}</span>}
                      {i.detail.avatar && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">For: {i.detail.avatar}</span>}
                      {i.detail.adset && <span className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-faint">Audience: {i.detail.adset}</span>}
                    </div>
                  )}
                  {i.reason && <p className="text-[11px] text-faint">{i.reason}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[16px] border border-dashed border-line px-5 py-10 text-center text-sm text-muted">{items.length ? "Nothing here with those filters." : "The playbook fills in from the Meta account on the next hourly run: every ad they've run since April, with its results."}</p>
      )}
      {list.length > shown && (
        <button type="button" onClick={() => setShown((s) => s + 30)} className="h-10 justify-self-center rounded-full border border-line px-5 text-sm text-muted hover:text-fg">
          Show more ({list.length - shown} left)
        </button>
      )}
    </div>
  );
}
