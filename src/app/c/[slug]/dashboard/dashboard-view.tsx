"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LogoLoader } from "@/components/logo-loader";
import type { DashboardHistory, DashboardPart } from "@/lib/client-dashboard";
import { askAboutNumbers, dashboardFor, dashboardHistoryFor } from "./actions";

// The client's dashboard: every account together first (Meta and Google as one business), then each on its own.
// Every day of their accounts is read once, so any dates (a preset, a range, since we started) draw instantly; each
// range's campaigns and best ads follow from the server, the common ranges fetched ahead. The conversation ("Ask about
// your numbers") docks on the right on a computer, always there; on a phone it's a button that opens it.

type Asked = { id: string; question: string; answer: string; flagged: boolean; created_at: string };
type Key = "spend" | "results" | "cpr" | "revenue" | "roas" | "ctr" | "cpc" | "clicks" | "cpm" | "impressions";
type Totals = { spend: number; results: number; revenue: number; clicks: number; impressions: number };
type Day = Totals & { date: string };
type Range = { start: string; end: string };
type View = {
  key: string;
  label: string;
  conversion: string;
  target: number | null;
  roasKpi: boolean;
  main: Totals;
  compare: Totals;
  daily: Day[];
  split: { platform: string; spend: number; results: number }[];
  campaigns: (DashboardPart["campaigns"][number] & { platform: string })[] | null;
  topAds: DashboardPart["topAds"] | null;
};

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: string, n: number) => ymd(new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY));
const span = (r: Range) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / DAY) + 1;
const nyNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const ago = (n: number) => {
  const d = nyNow();
  d.setDate(d.getDate() - n);
  return ymd(d);
};
const keyOf = (r: Range) => `${r.start}:${r.end}`;
const before = (r: Range): Range => ({ start: shift(r.start, -span(r)), end: shift(r.start, -1) });

const PRESETS: { key: string; label: string; short: string; range: (start: string) => Range }[] = [
  { key: "7", label: "7 days", short: "7D", range: () => ({ start: ago(7), end: ago(1) }) },
  { key: "30", label: "30 days", short: "30D", range: () => ({ start: ago(30), end: ago(1) }) },
  { key: "60", label: "60 days", short: "60D", range: () => ({ start: ago(60), end: ago(1) }) },
  { key: "90", label: "90 days", short: "90D", range: () => ({ start: ago(90), end: ago(1) }) },
  { key: "mtd", label: "This month", short: "MTD", range: () => ({ start: ymd(new Date(nyNow().getFullYear(), nyNow().getMonth(), 1, 12)), end: ago(1) }) },
  {
    key: "last",
    label: "Last month",
    short: "Last mo",
    range: () => {
      const t = nyNow();
      return { start: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1, 12)), end: ymd(new Date(t.getFullYear(), t.getMonth(), 0, 12)) };
    },
  },
  { key: "start", label: "Since we started", short: "Since start", range: (start) => ({ start, end: ago(1) }) },
];

const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 })}`);
const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}%`);
const mult = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(2)}x`);
const one = (conv: string) => conv.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");
const FMT: Record<Key, (n: number | null) => string> = { spend: money, results: num, cpr: money, revenue: money, roas: mult, ctr: pct, cpc: money, clicks: num, cpm: money, impressions: num };
const BETTER: Record<Key, "up" | "down" | "none"> = { spend: "none", results: "up", cpr: "down", revenue: "up", roas: "up", ctr: "up", cpc: "down", clicks: "up", cpm: "down", impressions: "up" };
const MONEY: Key[] = ["spend", "cpr", "revenue", "cpc", "cpm"];
/** Short numbers for the chart's labels */
function compact(k: Key, n: number | null) {
  if (n == null || !Number.isFinite(n)) return "";
  if (k === "roas") return `${n.toFixed(1)}x`;
  if (k === "ctr") return `${n.toFixed(1)}%`;
  const s = Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : Math.abs(n) >= 100 || Number.isInteger(n) ? `${Math.round(n)}` : n.toFixed(1);
  return MONEY.includes(k) ? `$${s}` : s;
}

function value(t: Totals, k: Key): number | null {
  return { spend: t.spend, results: t.results, cpr: t.results ? t.spend / t.results : null, revenue: t.revenue, roas: t.spend ? t.revenue / t.spend : null, ctr: t.impressions ? (t.clicks / t.impressions) * 100 : null, cpc: t.clicks ? t.spend / t.clicks : null, clicks: t.clicks, cpm: t.impressions ? (t.spend / t.impressions) * 1000 : null, impressions: t.impressions }[k];
}
const ZERO: Totals = { spend: 0, results: 0, revenue: 0, clicks: 0, impressions: 0 };
const sum = (list: Totals[]): Totals => list.reduce((a, b) => ({ spend: a.spend + b.spend, results: a.results + b.results, revenue: a.revenue + b.revenue, clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions }), ZERO);
const totals = (p: DashboardPart["main"]): Totals => ({ spend: p.spend, results: p.results, revenue: p.revenue, clicks: p.clicks, impressions: p.impressions });
const platformName = (p: string) => (p === "google" ? "Google Ads" : p === "tiktok" ? "TikTok Ads" : "Meta Ads");
const dateLabel = (d: string, year = false) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
const rangeLabel = (r: Range) => `${dateLabel(r.start, r.start.slice(0, 4) !== r.end.slice(0, 4))} – ${dateLabel(r.end, true)}`;

/** Every day in a range, from the history (days without spend as zero), for the chosen accounts */
function daysOf(history: DashboardHistory, key: string, r: Range): Day[] {
  const parts = key === "all" ? history.parts : history.parts.filter((p) => p.platform === key);
  const by = new Map<string, Totals>();
  for (const p of parts) for (const d of p.daily) if (d.date >= r.start && d.date <= r.end) by.set(d.date, sum([by.get(d.date) ?? ZERO, d]));
  const out: Day[] = [];
  for (let d = r.start; d <= r.end && out.length < 800; d = shift(d, 1)) out.push({ date: d, ...(by.get(d) ?? ZERO) });
  return out;
}

function viewOf(history: DashboardHistory, key: string, r: Range, detail: DashboardPart[] | undefined): View {
  const chosen = key === "all" ? history.parts : history.parts.filter((p) => p.platform === key);
  const exact = detail ? (key === "all" ? detail : detail.filter((p) => p.platform === key)) : null;
  const daily = daysOf(history, key, r);
  const sameConversion = new Set(chosen.map((p) => p.conversion)).size === 1;
  return {
    key,
    label: key === "all" ? "All accounts" : platformName(key),
    conversion: sameConversion ? (chosen[0]?.conversion ?? "Results") : "Results",
    target: chosen.length === 1 ? chosen[0].target : null,
    roasKpi: chosen.some((p) => p.roasKpi),
    // The range's own numbers once they're in (counted exactly as the reports count them); the history until then
    main: exact?.length ? sum(exact.map((p) => totals(p.main))) : sum(daily),
    compare: exact?.length ? sum(exact.map((p) => totals(p.compare))) : sum(daysOf(history, key, before(r))),
    daily,
    split: chosen.map((p) => {
      const t = sum(daysOf(history, p.platform, r));
      return { platform: p.platform, spend: t.spend, results: t.results };
    }),
    campaigns: exact ? exact.flatMap((p) => p.campaigns.map((c) => ({ ...c, platform: p.platform }))).sort((a, b) => b.spend - a.spend) : null,
    topAds: exact ? exact.flatMap((p) => p.topAds) : null,
  };
}

function useCount(target: number, ms = 600) {
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

export function MetaLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-label="Meta" role="img">
      <path d="M2.5 14.6c0-4.4 2.3-8.1 5.1-8.1 2 0 3.5 1.5 5.4 4.6l1.1 1.8c1.8 2.9 2.9 4.1 4.2 4.1 1.6 0 2.7-1.6 2.7-4.1 0-3-1.5-5.6-3.6-5.6-1.6 0-2.9 1.3-4.6 4.1" fill="none" stroke="#0866FF" strokeWidth="2.3" strokeLinecap="round" />
      <path d="M12.6 10.9c-1.8-2.8-3-4-4.4-4-2.2 0-3.6 3.3-3.6 6.6 0 2 .8 3.7 2.4 3.7 1.5 0 2.6-1.2 4.6-4.6" fill="none" stroke="#0866FF" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}
export function GoogleAdsLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-label="Google Ads" role="img">
      <line x1="12" y1="5" x2="5.5" y2="17" stroke="#FBBC04" strokeWidth="5.6" strokeLinecap="round" />
      <line x1="12" y1="5" x2="18.5" y2="17" stroke="#4285F4" strokeWidth="5.6" strokeLinecap="round" />
      <circle cx="5.5" cy="17.4" r="3.1" fill="#34A853" />
    </svg>
  );
}
const Logo = ({ platform, className }: { platform: string; className?: string }) => (platform === "google" ? <GoogleAdsLogo className={className} /> : <MetaLogo className={className} />);

/** What their own store or CRM recorded: this month, and the last 30 days against the 30 before */
export type BusinessStrip = { store: boolean; crm: boolean; month: { newCustomers: number; subscriptions: number; revenue: number; leads: number; booked: number; won: number }; last30: { newCustomers: number; leads: number; fromMeta: number; fromGoogle: number }; prior30: { newCustomers: number; leads: number } };

export function DashboardView({ slug, brand, asked: initial, demo, business = null }: { slug: string; brand: string; asked: Asked[]; business?: BusinessStrip | null; /** Sample numbers instead of the live ones (design previews) */ demo?: { history: DashboardHistory; detail: DashboardPart[] } }) {
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState<Range>(PRESETS[1].range(""));
  const [history, setHistory] = useState<DashboardHistory | null>(demo?.history ?? null);
  const [details, setDetails] = useState<Record<string, DashboardPart[]>>(demo ? { [keyOf(PRESETS[1].range(""))]: demo.detail } : {});
  const asking = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState("all");
  const [chart, setChart] = useState<Key>("results");
  const [asked, setAsked] = useState(initial);
  const [sheet, setSheet] = useState(false);

  // Each range's campaigns and best ads: fetched once, kept
  const fetchDetail = (r: Range) => {
    const k = keyOf(r);
    if (demo || asking.current.has(k)) return Promise.resolve();
    asking.current.add(k);
    return dashboardFor(slug, r).then((res) => {
      if (res.ok) setDetails((d) => ({ ...d, [k]: res.parts }));
      else asking.current.delete(k);
    });
  };

  useEffect(() => {
    if (demo) return;
    let live = true;
    void dashboardHistoryFor(slug).then((r) => {
      if (!live) return;
      if (r.ok) setHistory(r.history);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [slug, demo]);
  useEffect(() => {
    void fetchDetail(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);
  // The common ranges, fetched ahead one at a time, so switching to one is instant
  useEffect(() => {
    if (!history) return;
    let live = true;
    void (async () => {
      for (const p of PRESETS) {
        if (!live) return;
        await fetchDetail(p.range(history.start));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  // The conversation's sheet on a phone lives in the URL, so back closes it
  useEffect(() => {
    const sync = () => setSheet(new URLSearchParams(window.location.search).get("ask") === "1");
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const openSheet = (open: boolean) => {
    const u = new URL(window.location.href);
    if (open) {
      u.searchParams.set("ask", "1");
      window.history.pushState(null, "", u);
      setSheet(true);
    } else if (u.searchParams.get("ask") === "1") window.history.back();
    else setSheet(false);
  };

  const parts = history?.parts ?? [];
  const keys = parts.length > 1 ? ["all", ...parts.map((p) => p.platform)] : parts.map((p) => p.platform);
  const key = keys.includes(which) ? which : (keys[0] ?? "all");
  const detail = details[keyOf(range)];
  const view = useMemo(() => (history?.parts.length ? viewOf(history, key, range, detail) : null), [history, key, range, detail]);
  const roas = view ? view.main.revenue > 0 || view.compare.revenue > 0 || view.roasKpi : false;
  const pick = (p: (typeof PRESETS)[number]) => {
    setPreset(p.key);
    setRange(p.range(history?.start ?? ago(30)));
  };

  const talk = <Ask slug={slug} range={range} asked={asked} setAsked={setAsked} />;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-7">
      <div className="grid min-w-0 content-start gap-5">
        <DateBar range={range} setRange={(r) => (setPreset("custom"), setRange(r))} preset={preset} pick={pick} keys={keys} which={key} setWhich={setWhich} start={history?.start ?? null} />

        {error && <p className="rounded-[14px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-[13.5px] text-bad">{error}</p>}
        {!history && !error && <Skeleton />}
        {history && !view && <p className="rounded-[24px] border border-dashed border-line p-12 text-center text-[14px] text-muted">No ad account with results yet. It shows here the moment your first ads run.</p>}

        {view && history && (
          <>
            <Hero brand={brand} view={view} roas={roas} range={range} />
            {business && <Business b={business} />}
            <Tiles view={view} roas={roas} chart={chart} setChart={setChart} />
            <Trend history={history} view={view} metric={chart} range={range} />
            {view.key === "all" && view.split.length > 1 && <Split view={view} />}
            <Campaigns view={view} roas={roas} />
            <TopAds view={view} brand={brand} />
          </>
        )}
      </div>

      {/* The conversation: docked on the right on a computer, always there */}
      <aside className="hidden xl:block">
        <div className="sticky top-6 flex h-[calc(100dvh-3rem)] flex-col overflow-hidden rounded-[24px] border border-line bg-surface">{talk}</div>
      </aside>

      {/* On a phone or a smaller screen: a button that opens it */}
      <button type="button" onClick={() => openSheet(true)} className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-brand pl-3 pr-5 text-[14px] font-medium text-white shadow-[0_14px_40px_-12px_rgba(178,30,44,0.8)] lg:bottom-8 lg:right-8 xl:hidden">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15">✦</span> Ask about your numbers
      </button>
      {sheet && (
        <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true" aria-label="Ask about your numbers">
          <button type="button" aria-label="Close" onClick={() => openSheet(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="pb-safe absolute inset-x-0 bottom-0 flex h-[88dvh] flex-col overflow-hidden rounded-t-[28px] border-t border-line bg-surface md:inset-y-4 md:left-auto md:right-4 md:h-auto md:w-[440px] md:rounded-[24px] md:border">
            <button type="button" onClick={() => openSheet(false)} className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
              ✕
            </button>
            {talk}
          </div>
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid min-h-[55vh] place-items-center" aria-busy="true">
      <LogoLoader size="lg" />
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

/** The dates, big and plain: which days these are and what they're compared with; presets a tap away; any range */
function DateBar({ range, setRange, preset, pick, keys, which, setWhich, start }: { range: Range; setRange: (r: Range) => void; preset: string; pick: (p: (typeof PRESETS)[number]) => void; keys: string[]; which: string; setWhich: (k: string) => void; start: string | null }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const b = before(range);
  return (
    <div className="z-20 -mx-4 grid gap-3 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur-xl md:-mx-8 md:px-8 lg:sticky lg:top-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <button type="button" onClick={() => (setDraft(range), setOpen(!open))} className="flex min-h-12 items-center gap-3 rounded-[16px] border border-brand/50 bg-brand/[0.08] px-4 py-2 text-left transition-colors hover:border-brand" aria-expanded={open}>
            <span className="text-brand-text">
              <CalendarIcon />
            </span>
            <span className="grid">
              <span className="font-heading text-[17px] leading-tight md:text-[19px]">{rangeLabel(range)}</span>
              <span className="text-[12px] text-muted">
                {span(range)} days · compared with {rangeLabel(b)}
              </span>
            </span>
            <span className="text-faint" aria-hidden>
              ▾
            </span>
          </button>
          {open && (
            <div className="absolute left-0 top-full z-30 mt-2 grid w-[min(92vw,340px)] gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
              <p className="text-[12px] uppercase tracking-[0.12em] text-faint">Any dates</p>
              <label className="grid gap-1 text-[12.5px] text-muted">
                From
                <input type="date" value={draft.start} max={draft.end} min={ago(740)} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg" />
              </label>
              <label className="grid gap-1 text-[12.5px] text-muted">
                To
                <input type="date" value={draft.end} min={draft.start} max={ago(0)} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg" />
              </label>
              <button
                type="button"
                disabled={!draft.start || !draft.end || draft.start > draft.end}
                onClick={() => {
                  setRange(draft);
                  setOpen(false);
                }}
                className="h-11 rounded-full bg-brand text-[14px] font-medium text-white disabled:opacity-40"
              >
                Show these dates
              </button>
            </div>
          )}
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-surface-2 p-1 [scrollbar-width:none]">
          {PRESETS.filter((p) => p.key !== "start" || start).map((p) => (
            <button key={p.key} type="button" onClick={() => pick(p)} className={`h-10 shrink-0 rounded-full px-3.5 text-[13px] transition-colors ${preset === p.key ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg"}`}>
              {p.label}
            </button>
          ))}
        </div>
        {keys.length > 1 && (
          <div className="flex rounded-full border border-line p-1 2xl:ml-auto">
            {keys.map((k) => (
              <button key={k} type="button" onClick={() => setWhich(k)} className={`flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors ${which === k ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg"}`}>
                {k !== "all" && <Logo platform={k} />}
                {k === "all" ? "All accounts" : platformName(k)}
              </button>
            ))}
          </div>
        )}
      </div>
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

/** How it went, in one compact line */
function Hero({ brand, view, roas, range }: { brand: string; view: View; roas: boolean; range: Range }) {
  const lead: Key = roas ? "revenue" : "results";
  const big = useCount(value(view.main, lead) ?? 0);
  const d = delta(value(view.main, lead), value(view.compare, lead), "up");
  return (
    <section className="relative isolate flex flex-wrap items-center gap-x-8 gap-y-3 overflow-hidden rounded-[22px] border border-line bg-deep px-5 py-4 md:px-7 md:py-5">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 -z-10 h-72 w-72 rounded-full bg-brand/25 blur-[100px]" />
      <div className="grid gap-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
          {brand} · {view.label}
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tabular font-heading text-[38px] leading-none tracking-tight md:text-[46px]">{roas ? money(big) : num(Math.round(big))}</span>
          <span className="text-[15px] text-muted">{roas ? "in revenue" : view.conversion.toLowerCase()}</span>
          {d && <span className={`rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold ${toneOf(d.good)}`}>{d.text} vs before</span>}
        </div>
      </div>
      <p className="max-w-xl flex-1 text-[14px] leading-relaxed text-muted md:min-w-[280px]">
        {span(range)} days: <b className="text-fg">{money(view.main.spend)}</b> in ads
        {roas ? (
          <>
            , a <b className="text-fg">{mult(value(view.main, "roas"))}</b> return
          </>
        ) : (
          <>
            , <b className="text-fg">{money(value(view.main, "cpr"))}</b> per {one(view.conversion)}
            {view.target != null && !view.roasKpi && <> (target {money(view.target)})</>}
          </>
        )}
        , seen <b className="text-fg">{num(view.main.impressions)}</b> times, <b className="text-fg">{num(view.main.clicks)}</b> clicks.
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

const LABELS = (conv: string): Record<Key, string> => ({ spend: "Spend", results: conv, cpr: `Cost per ${one(conv)}`, revenue: "Revenue", roas: "Return on ad spend", ctr: "Click-through rate", cpc: "Cost per click", clicks: "Link clicks", cpm: "Cost per 1,000 views", impressions: "Impressions" });

function Tiles({ view, roas, chart, setChart }: { view: View; roas: boolean; chart: Key; setChart: (k: Key) => void }) {
  const keys: Key[] = ["spend", "results", "cpr", ...(roas ? (["revenue", "roas"] as Key[]) : []), "ctr", "cpc", "clicks", ...(roas ? [] : (["cpm", "impressions"] as Key[]))];
  const names = LABELS(view.conversion);
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {keys.map((k) => {
        const now = value(view.main, k);
        const d = delta(now, value(view.compare, k), BETTER[k]);
        return (
          <button key={k} type="button" onClick={() => setChart(k)} className={`group grid gap-1 rounded-[20px] border p-4 text-left transition-all ${chart === k ? "border-brand bg-brand/[0.07] shadow-[0_18px_40px_-28px_rgba(178,30,44,0.9)]" : "border-line bg-surface hover:-translate-y-0.5 hover:border-faint"}`}>
            <span className="text-[11px] uppercase tracking-[0.1em] text-faint">{names[k]}</span>
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

/** Days grouped into weeks or months when there are many, so every point can carry its number */
function bucket(days: Day[]): { label: string; from: string; to: string; t: Totals }[] {
  const size = days.length > 400 ? "month" : days.length > 120 ? "week" : "day";
  if (size === "day") return days.map((d) => ({ label: dateLabel(d.date), from: d.date, to: d.date, t: d }));
  const out: { label: string; from: string; to: string; t: Totals }[] = [];
  for (const d of days) {
    const k = size === "month" ? d.date.slice(0, 7) : null;
    const last = out.at(-1);
    const same = last && (size === "month" ? last.from.slice(0, 7) === k : span({ start: last.from, end: d.date }) <= 7);
    if (same) {
      last.to = d.date;
      last.t = sum([last.t, d]);
    } else out.push({ label: size === "month" ? new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : `Wk of ${dateLabel(d.date)}`, from: d.date, to: d.date, t: d });
  }
  return out;
}

/** Day by day, with every point's number on it; its own quick ranges (7, 30, 60, 90 days, since we started) */
function Trend({ history, view, metric, range }: { history: DashboardHistory; view: View; metric: Key; range: Range }) {
  const [win, setWin] = useState<string>("page");
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const wins = [{ key: "page", label: "Your dates" }, ...PRESETS.filter((p) => ["7", "30", "60", "90", "start"].includes(p.key)).map((p) => ({ key: p.key, label: p.short }))];
  const r = win === "page" ? range : (PRESETS.find((p) => p.key === win)?.range(history.start) ?? range);
  const pts = bucket(win === "page" ? view.daily : daysOf(history, view.key, r));
  const prev = win === "start" ? [] : bucket(daysOf(history, view.key, before(r)));
  const now = pts.map((p) => value(p.t, metric));
  const was = prev.map((p) => value(p.t, metric));
  const n = pts.length;
  const max = Math.max(...now.map((v) => v ?? 0), ...was.map((v) => v ?? 0), 0) || 1;
  const W = 1000;
  const H = 300;
  const TOP = 34;
  const xOf = (i: number, len: number) => (len <= 1 ? W / 2 : 14 + (i / (len - 1)) * (W - 28));
  const yOf = (v: number | null) => H - 14 - ((v ?? 0) / max) * (H - 14 - TOP);
  const line = (vals: (number | null)[]) => vals.map((v, i) => `${i ? "L" : "M"}${xOf(i, vals.length).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  // Every point's number when they fit; else every few, always the highest
  const every = Math.max(1, Math.ceil(n / 31));
  const top = now.indexOf(Math.max(...now.map((v) => v ?? 0)));
  const labelled = (i: number) => n <= 31 || i % every === 0 || i === top || i === n - 1;
  const ticks = Math.min(n, 7);
  const shown = at != null ? pts[at] : null;
  const move = (clientX: number) => {
    const b = box.current?.getBoundingClientRect();
    if (!b || n < 1) return;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((clientX - b.left) / b.width) * (n - 1)))));
  };
  const total = ["spend", "results", "revenue", "clicks", "impressions"].includes(metric);
  const all = sum(pts.map((p) => p.t));
  return (
    <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="font-heading text-[17px]">
            {LABELS(view.conversion)[metric]}, {n && pts[0].from !== pts[0].to ? (pts.length > 1 && span({ start: pts[0].from, end: pts[1].from }) > 8 ? "month by month" : "week by week") : "day by day"}
          </p>
          <p className="text-[12px] text-faint">
            <span className="mr-3 inline-flex items-center gap-1.5">
              <span className="h-[3px] w-4 rounded-full bg-brand" /> {rangeLabel(r)}
            </span>
            {prev.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed border-faint" /> The {span(r)} days before
              </span>
            )}
          </p>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-surface-2 p-1 [scrollbar-width:none]">
          {wins.map((w) => (
            <button key={w.key} type="button" onClick={() => setWin(w.key)} className={`h-9 max-md:h-11 shrink-0 rounded-full px-3 text-[12.5px] transition-colors ${win === w.key ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg"}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <p className="tabular -mt-1 text-[14px]">
        {shown ? (
          <>
            <span className="text-muted">{shown.from === shown.to ? dateLabel(shown.from, true) : `${dateLabel(shown.from)} – ${dateLabel(shown.to, true)}`} · </span>
            <b>{FMT[metric](value(shown.t, metric))}</b>
            {was[at!] != null && <span className="text-faint"> (before: {FMT[metric](was[at!])})</span>}
          </>
        ) : (
          <span className="text-muted">
            <b className="text-fg">{FMT[metric](value(all, metric))}</b> {total ? "in all" : "overall"}
          </span>
        )}
      </p>
      {n ? (
        <div ref={box} className="relative touch-none select-none" onMouseMove={(e) => move(e.clientX)} onMouseLeave={() => setAt(null)} onTouchMove={(e) => move(e.touches[0].clientX)} onTouchStart={(e) => move(e.touches[0].clientX)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-64 w-full md:h-80" aria-hidden>
            <defs>
              <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#c8102e" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#c8102e" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line key={g} x1="0" x2={W} y1={H - 14 - g * (H - 14 - TOP)} y2={H - 14 - g * (H - 14 - TOP)} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {was.length > 1 && <path d={line(was.slice(-n))} fill="none" strokeDasharray="6 6" strokeWidth="2" vectorEffect="non-scaling-stroke" className="stroke-faint/60" />}
            {n > 1 && <path d={`${line(now)} L${xOf(n - 1, n)},${H} L${xOf(0, n)},${H} Z`} fill="url(#area)" />}
            <path d={line(now)} fill="none" stroke="#c8102e" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {at != null && <line x1={xOf(at, n)} x2={xOf(at, n)} y1="0" y2={H} className="stroke-fg/30" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          </svg>
          {/* The points and their numbers, drawn over the chart so the text stays crisp */}
          {now.map((v, i) =>
            labelled(i) ? (
              <span key={i} className="pointer-events-none absolute -translate-x-1/2" style={{ left: `${(xOf(i, n) / W) * 100}%`, top: `${(yOf(v) / H) * 100}%` }}>
                <span className={`absolute left-1/2 top-0 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-surface ${at === i ? "scale-150 bg-fg" : "bg-brand"}`} />
                <span className={`tabular absolute bottom-[7px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[6px] px-1 text-[11px] font-semibold md:text-[12px] ${at === i ? "bg-fg text-bg" : i === top ? "text-fg" : "text-muted"}`}>{compact(metric, v)}</span>
              </span>
            ) : null,
          )}
          <div className="relative mt-2 h-4 text-[11px] text-faint">
            {Array.from({ length: ticks }, (_, j) => Math.round((j / Math.max(1, ticks - 1)) * (n - 1))).map((i, j) => (
              <span key={j} className={`absolute whitespace-nowrap ${j === 0 ? "" : j === ticks - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${(xOf(i, n) / W) * 100}%` }}>
                {pts[i].label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="py-12 text-center text-[13px] text-faint">No days with data in these dates.</p>
      )}
      {win === "start" && <p className="text-[12px] text-faint">Since we started with you on {dateLabel(history.start, true)}.</p>}
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
        {view.split.map((s) => (
          <span key={s.platform} className={s.platform === "google" ? "bg-[#34A853]" : "bg-[#0866FF]"} style={{ width: `${(s.spend / total) * 100}%` }} />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {view.split.map((s) => (
          <div key={s.platform} className="flex items-center gap-3 rounded-[16px] border border-line bg-bg p-3.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-white">
              <Logo platform={s.platform} className="h-6 w-6" />
            </span>
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

function Loading({ h }: { h: string }) {
  return <div className={`${h} animate-pulse rounded-[16px] bg-surface-2/60`} />;
}

/** Their store or CRM, this month: the customers and leads that really came in, and how many from Meta and Google */
function Business({ b }: { b: BusinessStrip }) {
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  const vs = (a: number, p: number) => (p ? Math.round(((a - p) / p) * 100) : null);
  const items: [string, string, number | null][] = [
    ...(b.store
      ? ([
          ["New customers this month", n(b.month.newCustomers), vs(b.last30.newCustomers, b.prior30.newCustomers)],
          ["Subscriptions started", n(b.month.subscriptions), null],
          ["Store revenue this month", `$${n(b.month.revenue)}`, null],
        ] as [string, string, number | null][])
      : []),
    ...(b.crm
      ? ([
          ["Leads this month", n(b.month.leads), vs(b.last30.leads, b.prior30.leads)],
          ["Booked", n(b.month.booked), null],
          ["Won", n(b.month.won), null],
        ] as [string, string, number | null][])
      : []),
  ];
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-heading text-[17px]">{b.store ? "From your store" : "From your CRM"}</p>
        <p className="text-[12px] text-faint">
          Last 30 days: {n(b.last30.fromMeta)} from Meta, {n(b.last30.fromGoogle)} from Google
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {items.map(([k, v, d]) => (
          <div key={k} className="rounded-[16px] bg-bg p-4">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">{k}</p>
            <p className="tabular mt-1 font-heading text-[24px] leading-tight">{v}</p>
            {d != null && <p className={`mt-0.5 text-[12px] ${d >= 0 ? "text-ok" : "text-bad"}`}>{d >= 0 ? "▲" : "▼"} {Math.abs(d)}% vs the 30 days before</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Campaigns({ view, roas }: { view: View; roas: boolean }) {
  const [all, setAll] = useState(false);
  if (view.campaigns && !view.campaigns.length) return null;
  const list = view.campaigns ?? [];
  const rows = all ? list : list.slice(0, 8);
  const top = Math.max(...list.map((c) => c.spend), 0) || 1;
  const cols = roas ? "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_90px_120px_96px_64px]" : "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_90px_120px_96px]";
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <p className="font-heading text-[17px]">Campaigns</p>
      {!view.campaigns ? (
        <div className="grid gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <Loading key={i} h="h-14" />
          ))}
        </div>
      ) : (
        <>
          <div className={`hidden gap-4 px-3.5 text-[11px] uppercase tracking-[0.1em] text-faint md:grid ${cols}`}>
            <span>Campaign</span>
            <span className="text-right">Spend</span>
            <span className="text-right">Results</span>
            <span className="text-right">Cost each</span>
            {roas && <span className="text-right">ROAS</span>}
          </div>
          <div className="grid gap-1.5">
            {rows.map((c) => (
              <div key={`${c.platform}-${c.name}`} className="relative overflow-hidden rounded-[14px] border border-line bg-bg px-3.5 py-3">
                {/* The bar behind each row is its share of spend */}
                <span aria-hidden className={`absolute inset-y-0 left-0 ${c.platform === "google" ? "bg-[#34A853]/[0.09]" : "bg-[#0866FF]/[0.09]"}`} style={{ width: `${(c.spend / top) * 100}%` }} />
                <div className={`relative grid items-center gap-x-4 gap-y-1 ${cols}`}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-white" title={platformName(c.platform)}>
                      <Logo platform={c.platform} className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 truncate text-[13.5px]">{c.name}</span>
                  </span>
                  <span className="tabular text-right text-[13px] max-md:hidden">{money(c.spend)}</span>
                  <span className="tabular text-right text-[13px] max-md:hidden">
                    {num(c.results)} <span className="text-faint">{(c.result ?? "results").toLowerCase()}</span>
                  </span>
                  <span className="tabular text-right text-[13px] text-muted max-md:hidden">{money(c.costPerResult)}</span>
                  {roas && <span className="tabular text-right text-[13px] text-muted max-md:hidden">{mult(c.roas)}</span>}
                  {/* A phone: the numbers under the name */}
                  <span className="tabular col-span-2 pl-[38px] text-[12px] text-muted md:hidden">
                    {money(c.spend)} · {num(c.results)} {(c.result ?? "results").toLowerCase()} · {money(c.costPerResult)} each{roas ? ` · ${mult(c.roas)}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {list.length > 8 && (
            <button type="button" onClick={() => setAll(!all)} className="justify-self-start text-[13px] text-brand-text hover:underline">
              {all ? "Show fewer" : `All ${list.length} campaigns`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const CTA: Record<string, string> = { SHOP_NOW: "Shop now", LEARN_MORE: "Learn more", SIGN_UP: "Sign up", ORDER_NOW: "Order now", BOOK_TRAVEL: "Book now", BOOK_NOW: "Book now", GET_OFFER: "Get offer", CONTACT_US: "Contact us", SUBSCRIBE: "Subscribe", DOWNLOAD: "Download", APPLY_NOW: "Apply now", GET_QUOTE: "Get quote", BUY_NOW: "Buy now", SEE_MENU: "See menu", MESSAGE_PAGE: "Send message", CALL_NOW: "Call now", WATCH_MORE: "Watch more", GET_DIRECTIONS: "Get directions" };
const ctaLabel = (t: string | null) => (!t || t === "NO_BUTTON" ? null : (CTA[t] ?? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " ")));
const domainOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};

/** One ad as it runs in the feed: the page, the copy, the creative, the headline and the button to where it goes */
function AdPreview({ ad, rank, brand, conversion }: { ad: DashboardPart["topAds"][number]; rank: number; brand: string; conversion: string }) {
  const [more, setMore] = useState(false);
  const cta = ctaLabel(ad.cta);
  const domain = domainOf(ad.url);
  const long = (ad.body ?? "").length > 140;
  return (
    <article className="grid content-start gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="rounded-full bg-brand px-2.5 py-0.5 font-semibold text-white">#{rank}</span>
        <span className="tabular rounded-full bg-surface-2 px-2.5 py-0.5 text-fg">
          {num(ad.results)} {conversion.toLowerCase()}
        </span>
        <span className="tabular rounded-full bg-surface-2 px-2.5 py-0.5 text-muted">{money(ad.costPerResult)} each</span>
        {ad.ctr != null && <span className="tabular rounded-full bg-surface-2 px-2.5 py-0.5 text-muted">{pct(ad.ctr)} CTR</span>}
      </div>
      {/* The feed post, in Facebook's own light look */}
      <div className="overflow-hidden rounded-[14px] border border-black/10 bg-white text-[#050505] shadow-[0_20px_50px_-30px_rgba(0,0,0,0.7)]">
        <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#b21e2c] text-[14px] font-bold text-white">{brand.charAt(0)}</span>
          <span className="grid min-w-0 leading-tight">
            <span className="truncate text-[13.5px] font-semibold">{brand}</span>
            <span className="text-[12px] text-[#65676B]">Sponsored · 🌐</span>
          </span>
        </div>
        {ad.body && (
          <p className="whitespace-pre-line px-3 pb-2.5 text-[13.5px] leading-snug">
            {long && !more ? `${ad.body.slice(0, 140).trimEnd()}… ` : ad.body}
            {long && !more && (
              <button type="button" onClick={() => setMore(true)} className="font-semibold text-[#65676B] hover:underline">
                See more
              </button>
            )}
          </p>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {ad.image ? <img src={ad.image} alt="" className="aspect-[4/5] w-full bg-[#f0f2f5] object-cover" loading="lazy" /> : <span className="block aspect-[4/5] w-full bg-[#f0f2f5]" />}
        {(ad.headline || cta || domain) && (
          <div className="flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5">
            <span className="grid min-w-0 flex-1 leading-tight">
              {domain && <span className="truncate text-[11.5px] uppercase text-[#65676B]">{domain}</span>}
              {ad.headline && <span className="line-clamp-2 text-[14px] font-semibold">{ad.headline}</span>}
            </span>
            {cta &&
              (ad.url ? (
                <a href={ad.url} target="_blank" rel="noreferrer" className="shrink-0 rounded-[6px] bg-[#e4e6eb] px-3 py-2 text-[13.5px] font-semibold hover:bg-[#d8dadf]">
                  {cta}
                </a>
              ) : (
                <span className="shrink-0 rounded-[6px] bg-[#e4e6eb] px-3 py-2 text-[13.5px] font-semibold">{cta}</span>
              ))}
          </div>
        )}
      </div>
      {ad.link && (
        <a href={ad.link} target="_blank" rel="noreferrer" className="justify-self-start text-[12.5px] text-brand-text hover:underline">
          See it live on Facebook ↗
        </a>
      )}
    </article>
  );
}

function TopAds({ view, brand }: { view: View; brand: string }) {
  if (view.topAds && !view.topAds.length) return null;
  return (
    <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div>
        <p className="font-heading text-[17px]">Your best ads</p>
        <p className="text-[12.5px] text-muted">As people see them, ranked by what they brought in these dates.</p>
      </div>
      {!view.topAds ? (
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Loading key={i} h="h-[520px]" />
          ))}
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 2xl:grid-cols-3">
          {view.topAds.slice(0, 6).map((a, i) => (
            <AdPreview key={a.id} ad={a} rank={i + 1} brand={brand} conversion={view.conversion} />
          ))}
        </div>
      )}
    </section>
  );
}

const SUGGESTED = ["How are we doing this month?", "Why did my cost go up?", "Which ad is working best?", "Is Google or Meta doing better?"];

/** The conversation: roomy, its messages scrolling above a box that stays put */
function Ask({ slug, range, asked, setAsked }: { slug: string; range: Range; asked: Asked[]; setAsked: (a: Asked[]) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [asked.length, busy]);
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
    <>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4 pr-14 xl:pr-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white" aria-hidden>
          ✦
        </span>
        <div className="min-w-0">
          <p className="font-heading text-[16px]">Ask about your numbers</p>
          <p className="text-[12.5px] leading-snug text-muted">About {rangeLabel(range)}. If it needs your team, your media buyer hears it today.</p>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 py-5">
        {asked.length === 0 && !busy && (
          <div className="grid gap-2">
            <p className="text-[13px] text-muted">Ask anything about your results, in your own words. A few to start:</p>
            {SUGGESTED.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} disabled={busy} className="min-h-11 rounded-[14px] border border-line px-3.5 py-2 text-left text-[13.5px] text-muted transition-colors hover:border-faint hover:text-fg">
                {s}
              </button>
            ))}
          </div>
        )}
        {asked.map((a) => (
          <div key={a.id} className="grid gap-2">
            <p className="max-w-[88%] justify-self-end rounded-[18px] rounded-br-[6px] bg-fg px-4 py-2.5 text-[14px] leading-relaxed text-bg">{a.question}</p>
            <p className="max-w-[94%] rounded-[18px] rounded-bl-[6px] bg-surface-2 px-4 py-3 text-[14px] leading-relaxed">{a.answer}</p>
            {a.flagged && <p className="text-[11.5px] text-faint">Your media buyer has been told.</p>}
          </div>
        ))}
        {busy && (
          <p className="flex items-center gap-2 text-[13px] text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Looking at your numbers…
          </p>
        )}
        {error && <p className="text-[13px] text-bad">{error}</p>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(q);
        }}
        className="border-t border-line p-3"
      >
        <div className="flex items-end gap-2 rounded-[20px] border border-line bg-bg p-1.5 focus-within:border-brand-text/60">
          <textarea data-chat
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(q);
              }
            }}
            rows={1}
            placeholder="e.g. Why did conversions drop last week?"
            className="max-h-40 min-h-11 w-full resize-none bg-transparent px-2.5 py-2.5 text-[15px] outline-none [field-sizing:content]"
          />
          <button type="submit" disabled={busy || !q.trim()} className="h-11 shrink-0 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-40">
            Ask
          </button>
        </div>
      </form>
    </>
  );
}
