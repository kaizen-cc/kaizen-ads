"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardPart } from "@/lib/client-dashboard";
import { askAboutNumbers, dashboardFor } from "./actions";

// The client's dashboard: every account together first (Meta and Google as one business), then each on its own. Pick
// the dates (or a preset); the hero says how it went in one line; tap any number to chart it day by day, with the period
// before drawn behind it; then where the money went (each platform's share), their campaigns and their best ads. "Ask
// about your numbers" at the bottom answers from what they're looking at, and tells their buyer when it's a worry.

type Asked = { id: string; question: string; answer: string; flagged: boolean; created_at: string };
type Key = "spend" | "results" | "cpr" | "revenue" | "roas" | "ctr" | "cpc" | "clicks" | "cpm" | "impressions";
type Totals = { spend: number; results: number; revenue: number; clicks: number; impressions: number };
type View = { key: string; label: string; conversion: string; target: number | null; roasKpi: boolean; main: Totals; compare: Totals; daily: (Totals & { date: string })[]; before: (Totals & { date: string })[]; campaigns: (DashboardPart["campaigns"][number] & { platform: string })[]; topAds: DashboardPart["topAds"]; split: { platform: string; spend: number; results: number }[] };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const nyNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const ago = (n: number) => {
  const d = nyNow();
  d.setDate(d.getDate() - n);
  return ymd(d);
};
const PRESETS: { key: string; label: string; range: () => { start: string; end: string } }[] = [
  { key: "7", label: "7 days", range: () => ({ start: ago(7), end: ago(1) }) },
  { key: "14", label: "14 days", range: () => ({ start: ago(14), end: ago(1) }) },
  { key: "30", label: "30 days", range: () => ({ start: ago(30), end: ago(1) }) },
  { key: "90", label: "90 days", range: () => ({ start: ago(90), end: ago(1) }) },
  { key: "mtd", label: "This month", range: () => ({ start: ymd(new Date(nyNow().getFullYear(), nyNow().getMonth(), 1, 12)), end: ago(1) }) },
  {
    key: "last",
    label: "Last month",
    range: () => {
      const t = nyNow();
      return { start: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1, 12)), end: ymd(new Date(t.getFullYear(), t.getMonth(), 0, 12)) };
    },
  },
];

const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 })}`);
const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}%`);
const mult = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}x`);
const one = (conv: string) => conv.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");
const FMT: Record<Key, (n: number | null) => string> = { spend: money, results: num, cpr: money, revenue: money, roas: mult, ctr: pct, cpc: money, clicks: num, cpm: money, impressions: num };
const BETTER: Record<Key, "up" | "down" | "none"> = { spend: "none", results: "up", cpr: "down", revenue: "up", roas: "up", ctr: "up", cpc: "down", clicks: "up", cpm: "down", impressions: "up" };

function value(t: Totals, k: Key): number | null {
  return { spend: t.spend, results: t.results, cpr: t.results ? t.spend / t.results : null, revenue: t.revenue, roas: t.spend ? t.revenue / t.spend : null, ctr: t.impressions ? (t.clicks / t.impressions) * 100 : null, cpc: t.clicks ? t.spend / t.clicks : null, clicks: t.clicks, cpm: t.impressions ? (t.spend / t.impressions) * 1000 : null, impressions: t.impressions }[k];
}
const sum = (list: Totals[]): Totals => list.reduce((a, b) => ({ spend: a.spend + b.spend, results: a.results + b.results, revenue: a.revenue + b.revenue, clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions }), { spend: 0, results: 0, revenue: 0, clicks: 0, impressions: 0 });
const totals = (p: DashboardPart["main"]): Totals => ({ spend: p.spend, results: p.results, revenue: p.revenue, clicks: p.clicks, impressions: p.impressions });
const platformName = (p: string) => (p === "google" ? "Google Ads" : "Meta Ads");

/** One account, or every account together */
function viewOf(parts: DashboardPart[], key: string, before: DashboardPart[] | null): View {
  const chosen = key === "all" ? parts : parts.filter((p) => p.platform === key);
  const byDate = (list: DashboardPart[]) => {
    const m = new Map<string, Totals>();
    for (const p of list) for (const d of p.daily) m.set(d.date, sum([m.get(d.date) ?? sum([]), d]));
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => ({ date, ...t }));
  };
  const sameConversion = new Set(chosen.map((p) => p.conversion)).size === 1;
  return {
    key,
    label: key === "all" ? "All accounts" : platformName(key),
    conversion: sameConversion ? (chosen[0]?.conversion ?? "Results") : "Results",
    target: chosen.length === 1 ? chosen[0].target : null,
    roasKpi: chosen.some((p) => p.roasKpi),
    main: sum(chosen.map((p) => totals(p.main))),
    compare: sum(chosen.map((p) => totals(p.compare))),
    daily: byDate(chosen),
    before: before ? byDate(key === "all" ? before : before.filter((p) => p.platform === key)) : [],
    campaigns: chosen.flatMap((p) => p.campaigns.map((c) => ({ ...c, platform: p.platform }))).sort((a, b) => b.spend - a.spend),
    topAds: chosen.flatMap((p) => p.topAds),
    split: chosen.map((p) => ({ platform: p.platform, spend: p.main.spend, results: p.main.results })),
  };
}

function useCount(target: number, ms = 700) {
  const [n, setN] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      setN(a + (target - a) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

export function DashboardView({ slug, brand, asked: initial, demo }: { slug: string; brand: string; asked: Asked[]; /** Sample numbers instead of the live ones (design previews) */ demo?: { parts: DashboardPart[]; before: DashboardPart[] } }) {
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState(PRESETS[2].range());
  const [parts, setParts] = useState<DashboardPart[] | null>(demo?.parts ?? null);
  const [before, setBefore] = useState<DashboardPart[] | null>(demo?.before ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!demo);
  const [which, setWhich] = useState("all");
  const [chart, setChart] = useState<Key>("results");

  useEffect(() => {
    if (demo) return;
    let live = true;
    void (async () => {
      setLoading(true);
      // The period before, the same length, for the chart's shadow line
      const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
      const pe = new Date(Date.parse(`${range.start}T12:00:00Z`) - 86_400_000);
      const ps = new Date(pe.getTime() - (days - 1) * 86_400_000);
      const [r, b] = await Promise.all([dashboardFor(slug, range), dashboardFor(slug, { start: ymd(ps), end: ymd(pe) })]);
      if (!live) return;
      setLoading(false);
      if (!r.ok) return setError(r.error);
      setError(null);
      setParts(r.parts);
      setBefore(b.ok ? b.parts : null);
    })();
    return () => {
      live = false;
    };
  }, [slug, range, demo]);

  const keys = parts ? (parts.length > 1 ? ["all", ...parts.map((p) => p.platform)] : parts.map((p) => p.platform)) : [];
  const key = keys.includes(which) ? which : (keys[0] ?? "all");
  const view = parts?.length ? viewOf(parts, key, before) : null;
  const roas = view ? view.main.revenue > 0 || view.compare.revenue > 0 || view.roasKpi : false;

  return (
    <div className="grid gap-5">
      {/* The controls: dates and which account */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-full bg-surface-2 p-1">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setPreset(p.key);
                setRange(p.range());
              }}
              className={`h-9 rounded-full px-3 text-[13px] transition-colors ${preset === p.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-[13px] text-muted">
          <input type="date" value={range.start} max={range.end} onChange={(e) => (setPreset("custom"), setRange({ ...range, start: e.target.value }))} className="h-10 rounded-full border border-line bg-bg px-3 text-[13px]" />
          –
          <input type="date" value={range.end} min={range.start} max={ago(0)} onChange={(e) => (setPreset("custom"), setRange({ ...range, end: e.target.value }))} className="h-10 rounded-full border border-line bg-bg px-3 text-[13px]" />
        </span>
        {keys.length > 1 && (
          <div className="flex rounded-full border border-line p-1 md:ml-auto">
            {keys.map((k) => (
              <button key={k} type="button" onClick={() => setWhich(k)} className={`h-9 rounded-full px-3.5 text-[13px] transition-colors ${key === k ? "bg-brand text-white" : "text-muted hover:text-fg"}`}>
                {k === "all" ? "All accounts" : platformName(k)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="rounded-[14px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-[13.5px] text-bad">{error}</p>}
      {!parts && !error && <Skeleton />}
      {parts && !view && <p className="rounded-[24px] border border-dashed border-line p-12 text-center text-[14px] text-muted">No ad account with results yet. It shows here the moment your first ads run.</p>}

      {view && (
        <div className={`grid gap-5 transition-opacity duration-300 ${loading ? "opacity-50" : ""}`}>
          <Hero brand={brand} view={view} roas={roas} />
          <Tiles view={view} roas={roas} chart={chart} setChart={setChart} />
          <Trend view={view} metric={chart} />
          {view.key === "all" && view.split.length > 1 && <Split view={view} />}
          <Campaigns view={view} roas={roas} />
          {view.topAds.length > 0 && <TopAds view={view} />}
        </div>
      )}

      <Ask slug={slug} range={range} initial={initial} />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-4">
      <div className="h-48 animate-pulse rounded-[28px] bg-surface" />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-[18px] bg-surface" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-[22px] bg-surface" />
    </div>
  );
}

function delta(now: number | null, before: number | null, better: "up" | "down" | "none") {
  if (now == null || before == null || !before) return null;
  const p = ((now - before) / Math.abs(before)) * 100;
  if (Math.round(p) === 0) return { text: "flat", good: null as boolean | null };
  return { text: `${p > 0 ? "▲" : "▼"} ${Math.abs(Math.round(p))}%`, good: better === "none" ? null : (p > 0) === (better === "up") };
}
const toneOf = (good: boolean | null) => (good == null ? "bg-surface-2 text-muted" : good ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad");

/** How it went, in one line, with the big number counting up */
function Hero({ brand, view, roas }: { brand: string; view: View; roas: boolean }) {
  const lead: Key = roas ? "revenue" : "results";
  const big = useCount(value(view.main, lead) ?? 0);
  const d = delta(value(view.main, lead), value(view.compare, lead), "up");
  const cpr = value(view.main, "cpr");
  const r = value(view.main, "roas");
  return (
    <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-7 pt-7 md:px-9 md:pb-9 md:pt-9">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-28 -z-10 h-[26rem] w-[26rem] rounded-full bg-brand/30 blur-[120px]" />
      <span aria-hidden className="pointer-events-none absolute -bottom-36 left-1/3 -z-10 h-80 w-80 rounded-full bg-[#5b8def]/15 blur-[120px]" />
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">
        {brand} · {view.label}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <span className="tabular font-heading text-[56px] leading-none tracking-tight md:text-[84px]">{roas ? money(big) : num(Math.round(big))}</span>
        <span className="pb-2 text-[16px] text-muted md:text-[18px]">{roas ? "in revenue" : view.conversion.toLowerCase()}</span>
        {d && <span className={`mb-3 rounded-full px-3 py-1 text-[13px] font-semibold ${toneOf(d.good)}`}>{d.text} vs before</span>}
      </div>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted md:text-[16px]">
        From <b className="text-fg">{money(view.main.spend)}</b> in ads
        {roas ? (
          <>
            , a <b className="text-fg">{mult(r)}</b> return on ad spend
          </>
        ) : (
          <>
            , at <b className="text-fg">{money(cpr)}</b> per {one(view.conversion)}
            {view.target != null && !view.roasKpi && <> against a <b className="text-fg">{money(view.target)}</b> target</>}
          </>
        )}
        , reaching people <b className="text-fg">{num(view.main.impressions)}</b> times and bringing <b className="text-fg">{num(view.main.clicks)}</b> clicks.
      </p>
    </section>
  );
}

/** A tiny line of the day-by-day, behind each tile */
function Spark({ pts, on }: { pts: (number | null)[]; on: boolean }) {
  const vals = pts.map((v) => v ?? 0);
  if (vals.length < 2) return null;
  const max = Math.max(...vals) || 1;
  const min = Math.min(...vals);
  const d = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 26}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
      <polyline points={d} fill="none" strokeWidth="1.8" vectorEffect="non-scaling-stroke" className={on ? "stroke-brand" : "stroke-faint/60"} />
    </svg>
  );
}

function Tiles({ view, roas, chart, setChart }: { view: View; roas: boolean; chart: Key; setChart: (k: Key) => void }) {
  const keys: { k: Key; label: string }[] = [
    { k: "spend", label: "Spend" },
    { k: "results", label: view.conversion },
    { k: "cpr", label: `Cost per ${one(view.conversion)}` },
    ...(roas ? [{ k: "revenue" as Key, label: "Revenue" }, { k: "roas" as Key, label: "Return on ad spend" }] : []),
    { k: "ctr", label: "Click-through rate" },
    { k: "cpc", label: "Cost per click" },
    { k: "clicks", label: "Link clicks" },
    // Even rows of four: the reach numbers fill out an account without revenue
    ...(roas ? [] : [{ k: "cpm" as Key, label: "Cost per 1,000 views" }, { k: "impressions" as Key, label: "Impressions" }]),
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {keys.map(({ k, label }) => {
        const now = value(view.main, k);
        const d = delta(now, value(view.compare, k), BETTER[k]);
        return (
          <button key={k} type="button" onClick={() => setChart(k)} className={`group grid gap-1 rounded-[20px] border p-4 text-left transition-all ${chart === k ? "border-brand bg-brand/[0.07] shadow-[0_18px_40px_-28px_rgba(178,30,44,0.9)]" : "border-line bg-surface hover:-translate-y-0.5 hover:border-faint"}`}>
            <span className="text-[11px] uppercase tracking-[0.1em] text-faint">{label}</span>
            <span className="tabular font-heading text-[25px] leading-tight">{FMT[k](now)}</span>
            <span className="flex items-center gap-2 text-[12px] text-faint">
              {d ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneOf(d.good)}`}>{d.text}</span> : <span>–</span>}
              <span className="truncate">was {FMT[k](value(view.compare, k))}</span>
            </span>
            <Spark pts={view.daily.map((x) => value(x, k))} on={chart === k} />
          </button>
        );
      })}
    </div>
  );
}

/** Day by day: the period as a filled line, the period before as a dashed shadow; hover or tap a day */
function Trend({ view, metric }: { view: View; metric: Key }) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const now = view.daily.map((d) => value(d, metric));
  const was = view.before.map((d) => value(d, metric));
  const n = now.length;
  const max = Math.max(...now.map((v) => v ?? 0), ...was.map((v) => v ?? 0), 0) || 1;
  const W = 1000;
  const H = 260;
  const xOf = (i: number, len: number) => (len <= 1 ? W / 2 : (i / (len - 1)) * W);
  const yOf = (v: number | null) => H - 12 - ((v ?? 0) / max) * (H - 40);
  const line = (vals: (number | null)[]) => vals.map((v, i) => `${i ? "L" : "M"}${xOf(i, vals.length).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const label = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const shown = at != null ? view.daily[at] : null;
  const total = ["spend", "results", "revenue", "clicks", "impressions"].includes(metric);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 1) return;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1)))));
  };
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-heading text-[17px]">{({ spend: "Spend", results: view.conversion, cpr: `Cost per ${one(view.conversion)}`, revenue: "Revenue", roas: "Return on ad spend", ctr: "Click-through rate", cpc: "Cost per click", clicks: "Link clicks", cpm: "Cost per 1,000 views", impressions: "Impressions" } as Record<Key, string>)[metric]}, day by day</p>
          <p className="text-[12px] text-faint">
            <span className="mr-3 inline-flex items-center gap-1.5">
              <span className="h-[3px] w-4 rounded-full bg-brand" /> These dates
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0 w-4 border-t-2 border-dashed border-faint" /> The {n} days before
            </span>
          </p>
        </div>
        <p className="tabular text-[13.5px]">
          {shown ? (
            <>
              <span className="text-muted">{label(shown.date)} · </span>
              <b>{FMT[metric](value(shown, metric))}</b>
              {was[at!] != null && <span className="text-faint"> (was {FMT[metric](was[at!])})</span>}
            </>
          ) : (
            <span className="text-faint">{total ? `${FMT[metric](value(view.main, metric))} in all` : `${FMT[metric](value(view.main, metric))} overall`}</span>
          )}
        </p>
      </div>
      {n ? (
        <div ref={box} className="relative touch-none" onMouseMove={(e) => move(e.clientX)} onMouseLeave={() => setAt(null)} onTouchMove={(e) => move(e.touches[0].clientX)} onTouchStart={(e) => move(e.touches[0].clientX)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-52 w-full md:h-64" aria-hidden>
            <defs>
              <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#c8102e" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#c8102e" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1="0" x2={W} y1={H - 12 - g * (H - 40)} y2={H - 12 - g * (H - 40)} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {was.length > 1 && <path d={line(was.slice(-n))} fill="none" strokeDasharray="6 6" strokeWidth="2" vectorEffect="non-scaling-stroke" className="stroke-faint/70" />}
            {n > 1 && <path d={`${line(now)} L${W},${H} L0,${H} Z`} fill="url(#area)" />}
            <path d={line(now)} fill="none" stroke="#c8102e" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {at != null && <line x1={xOf(at, n)} x2={xOf(at, n)} y1="0" y2={H} className="stroke-fg/30" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          </svg>
          {at != null && <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-brand shadow" style={{ left: `${(xOf(at, n) / W) * 100}%`, top: `${(yOf(now[at]) / H) * 100}%` }} />}
          <div className="mt-1 flex justify-between text-[11px] text-faint">
            <span>{label(view.daily[0].date)}</span>
            {n > 2 && <span>{label(view.daily[Math.floor(n / 2)].date)}</span>}
            <span>{label(view.daily[n - 1].date)}</span>
          </div>
        </div>
      ) : (
        <p className="py-12 text-center text-[13px] text-faint">No days with data in these dates.</p>
      )}
    </section>
  );
}

/** Where the money went: each platform's share of spend, with what it brought */
function Split({ view }: { view: View }) {
  const total = view.split.reduce((a, b) => a + b.spend, 0) || 1;
  return (
    <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <p className="font-heading text-[17px]">Where your budget went</p>
      <div className="flex h-4 overflow-hidden rounded-full bg-surface-2">
        {view.split.map((s, i) => (
          <span key={s.platform} className={i === 0 ? "bg-brand" : "bg-[#5b8def]"} style={{ width: `${(s.spend / total) * 100}%` }} />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {view.split.map((s, i) => (
          <div key={s.platform} className="flex items-center gap-3 rounded-[16px] border border-line bg-bg p-3.5">
            <span className={`h-3 w-3 shrink-0 rounded-full ${i === 0 ? "bg-brand" : "bg-[#5b8def]"}`} />
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-[15px]">{platformName(s.platform)}</span>
              <span className="block text-[12.5px] text-muted">
                {money(s.spend)} · {Math.round((s.spend / total) * 100)}% of spend · {num(s.results)} results · {money(s.results ? s.spend / s.results : null)} each
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Campaigns({ view, roas }: { view: View; roas: boolean }) {
  const [all, setAll] = useState(false);
  if (!view.campaigns.length) return null;
  const rows = all ? view.campaigns : view.campaigns.slice(0, 8);
  const top = Math.max(...view.campaigns.map((c) => c.spend)) || 1;
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <p className="font-heading text-[17px]">Campaigns</p>
      <div className="grid gap-1.5">
        {rows.map((c) => (
          <div key={`${c.platform}-${c.name}`} className="relative overflow-hidden rounded-[14px] border border-line bg-bg px-3.5 py-3">
            {/* The bar behind each row is its share of spend */}
            <span aria-hidden className="absolute inset-y-0 left-0 bg-brand/[0.07]" style={{ width: `${(c.spend / top) * 100}%` }} />
            <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="min-w-0 flex-1 text-[13.5px]">
                {view.key === "all" && <span className="mr-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted">{c.platform === "google" ? "Google" : "Meta"}</span>}
                {c.name}
              </span>
              <span className="tabular text-[13px]">{money(c.spend)}</span>
              <span className="tabular w-28 text-right text-[13px]">
                {num(c.results)} <span className="text-faint">{(c.result ?? "results").toLowerCase()}</span>
              </span>
              <span className="tabular w-20 text-right text-[13px] text-muted">{money(c.costPerResult)}</span>
              {roas && <span className="tabular w-14 text-right text-[13px] text-muted">{mult(c.roas)}</span>}
            </div>
          </div>
        ))}
      </div>
      {view.campaigns.length > 8 && (
        <button type="button" onClick={() => setAll(!all)} className="justify-self-start text-[13px] text-brand-text hover:underline">
          {all ? "Show fewer" : `All ${view.campaigns.length} campaigns`}
        </button>
      )}
    </section>
  );
}

function TopAds({ view }: { view: View }) {
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <p className="font-heading text-[17px]">Your best ads</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {view.topAds.slice(0, 6).map((a, i) => (
          <a key={a.id} href={a.link ?? undefined} target="_blank" rel="noreferrer" className="group grid content-start gap-2 overflow-hidden rounded-[18px] border border-line bg-bg transition-transform hover:-translate-y-0.5">
            <span className="relative block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {a.image ? <img src={a.image} alt="" className="aspect-[4/5] w-full object-cover" loading="lazy" /> : <span className="block aspect-[4/5] w-full bg-surface-2" />}
              <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white">#{i + 1}</span>
            </span>
            <span className="grid gap-1 px-3.5 pb-3.5">
              <span className="line-clamp-2 text-[13px] leading-snug">{a.name}</span>
              <span className="tabular text-[12px] text-muted">
                {num(a.results)} {view.conversion.toLowerCase()} · {money(a.costPerResult)} each
              </span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function Ask({ slug, range, initial }: { slug: string; range: { start: string; end: string }; initial: Asked[] }) {
  const [asked, setAsked] = useState(initial);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await askAboutNumbers(slug, text, range);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.row) setAsked([...asked, r.row as Asked]);
    setQ("");
  };
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-brand text-white" aria-hidden>
          ✦
        </span>
        <div>
          <p className="font-heading text-[17px]">Ask about your numbers</p>
          <p className="text-[13px] text-muted">Answered from the dates you&rsquo;re looking at. If it needs your team, your media buyer hears it today.</p>
        </div>
      </div>
      {asked.length > 0 && (
        <div className="grid gap-3">
          {asked.map((a) => (
            <div key={a.id} className="grid gap-1.5">
              <p className="max-w-[85%] justify-self-end rounded-[18px] bg-fg px-3.5 py-2 text-[14px] text-bg">{a.question}</p>
              <p className="max-w-[92%] rounded-[18px] bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed">{a.answer}</p>
              {a.flagged && <p className="text-[11.5px] text-faint">Your media buyer has been told.</p>}
            </div>
          ))}
        </div>
      )}
      {busy && (
        <p className="flex items-center gap-2 text-[13px] text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Looking at your numbers…
        </p>
      )}
      {!asked.length && (
        <div className="flex flex-wrap gap-1.5">
          {["How are we doing this month?", "Why did my cost go up?", "Which ad is working best?", "Is Google or Meta doing better?"].map((s) => (
            <button key={s} type="button" onClick={() => void send(s)} disabled={busy} className="min-h-10 rounded-full border border-line px-3 text-[12.5px] text-muted hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(q);
        }}
        className="flex items-end gap-2 rounded-[20px] border border-line bg-bg p-1.5 focus-within:border-brand-text/60"
      >
        <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={1} placeholder="e.g. Why did conversions drop last week?" className="min-h-11 w-full resize-none bg-transparent px-2 py-2.5 text-[15px] outline-none [field-sizing:content]" />
        <button type="submit" disabled={busy || !q.trim()} className="h-11 shrink-0 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-40">
          Ask
        </button>
      </form>
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </section>
  );
}
